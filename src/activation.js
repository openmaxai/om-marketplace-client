import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { isCanonicalUuid, isSha256Hex } from './ids.js';
import { enqueueUrgent } from './reconcile.js';
import { readMarker } from './shard-emitter.js';

// Template content reaches the Agent only through the session-start shards, so a written template takes effect when a
// session next starts. The client asks for a new session itself once the Agent is idle, confirms from the shard
// marker (injected.json) that the session was given the template, and reports template_activated to the market.

export const ACTIVATION_CHECK_MS = 30 * 1000;
// The runtime status must show this much idle time, in two consecutive samples.
export const IDLE_MIN_SECONDS = 300;
// Idle time enough to ask for a session at once when a starter message waits on the write.
export const QUICK_IDLE_SECONDS = 30;
// An older status file says nothing about the runtime now.
export const STATUS_MAX_AGE_MS = 60 * 1000;
export const REQUEST_COOLDOWN_MS = 30 * 60 * 1000;
// Automatic new-session requests per UTC day.
export const DAILY_REQUESTS = 4;
// How long a request is given to show up as a new session before it is made again.
export const CONFIRM_WAIT_MS = 15 * 60 * 1000;
export const MAX_REQUESTS = 3;
// Longest time a starter message waits for the session it asked for.
export const WELCOME_HOLD_MS = 3 * 60 * 1000;
export const STUCK_ALERT = 'template_activation_stuck';
export const NEW_SESSION_TEXT = 'Agent Market templates were updated; please use the new-session skill to start a new session.';
const MAX_SAMPLE_GAP_MS = 2.5 * ACTIVATION_CHECK_MS;
const HISTORY_KEEP_MS = 2 * 24 * 60 * 60 * 1000;
const EMPTY = Object.freeze({ pending: null, requests: [] });

export const defaultStatusFile = (zylosDir) => path.join(zylosDir, 'activity-monitor', 'agent-status.json');
export const controlScript = (zylosDir) => path.join(zylosDir, '.claude', 'skills', 'comm-bridge', 'scripts', 'c4-control.js');

// Enqueues the new-session request on the zylos control queue: delivered once the Agent is idle, no ack expected, the
// runtime state honoured; the Agent starts the session through its new-session skill.
export function controlEnqueue(zylosDir, { run = execFile, timeoutMs = 15_000 } = {}) {
  const script = controlScript(zylosDir);
  return () => new Promise((resolve, reject) => {
    run(process.execPath, [script, 'enqueue', '--content', NEW_SESSION_TEXT, '--block-queue-until-idle', '--no-ack-suffix'], {
      timeout: timeoutMs, windowsHide: true, maxBuffer: 64 * 1024,
    }, (err, stdout) => {
      if (err) return reject(new Error(`control enqueue failed (${err.killed ? 'timed out' : `exit ${err.code ?? 'unknown'}`})`));
      if (!/OK: enqueued control \d+/.test(String(stdout))) return reject(new Error('control enqueue gave no confirmation'));
      return resolve();
    });
  });
}

// The runtime status as {state, active_tools, idle_seconds}, or null when the file is missing, unreadable or older
// than STATUS_MAX_AGE_MS.
export function readRuntimeStatus(file, now = Date.now()) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || now - st.mtimeMs >= STATUS_MAX_AGE_MS) return null;
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    return s && typeof s === 'object' && !Array.isArray(s) ? s : null;
  } catch {
    return null;
  }
}

const utcDay = (t) => new Date(t).toISOString().slice(0, 10);
const validTarget = (x) => x && isCanonicalUuid(x.adoption_id) && isSha256Hex(x.rendered_sha256);

// State document `activation`: {pending, requests}. pending is the one record of this Agent, {pending_since,
// written_at, targets: [{adoption_id, rendered_sha256}], removed: [adoption_id], requested_at, request_count, seen_at?}
// or null (written_at: the last change merged in; seen_at: the last marker that did not confirm it); requests lists the times of automatic new-session requests (cooldown and daily cap).
// im: the openmax IM (available(), openTurn()); flush(): sends the urgent reconcile queue; enqueue(): the control
// queue request.
export function createActivation({
  state, dataDir, zylosDir, logger, im = null, flush = async () => null, now = Date.now,
  statusFile = defaultStatusFile(zylosDir), enqueue = controlEnqueue(zylosDir),
}) {
  const iso = () => new Date(now()).toISOString();
  const normalize = (d) => {
    const p = d?.pending;
    const pending = p && typeof p === 'object' && Array.isArray(p.targets) && Array.isArray(p.removed) && Number.isFinite(Date.parse(p.written_at))
      ? p : null;
    return { pending, requests: Array.isArray(d?.requests) ? d.requests.filter((x) => Number.isFinite(Date.parse(x))) : [] };
  };
  const read = () => normalize(state.read('activation', EMPTY));
  const save = (fn) => state.update('activation', EMPTY, (raw) => {
    const d = normalize(raw);
    fn(d);
    return d;
  });
  let sampledAt = null;

  // Merges a change into the pending record (one per Agent), so changes that come close together share one session.
  function merge(at, fn) {
    const t = Number.isFinite(Date.parse(at)) ? at : iso();
    let changed = false;
    save((d) => {
      const p = d.pending ?? { pending_since: t, written_at: t, targets: [], removed: [], requested_at: null, request_count: 0 };
      const before = JSON.stringify(p);
      fn(p);
      if (JSON.stringify(p) === before) return;
      if (Date.parse(t) > Date.parse(p.written_at)) p.written_at = t;
      // A new change gets its own requests.
      p.request_count = 0;
      d.pending = p;
      changed = true;
    });
    if (changed) state.clearAlert(STUCK_ALERT);
  }

  // True when the Agent may be asked for a new session: the runtime status (fresh) shows it idle for minIdle seconds
  // with no tool running, and no OpenMax turn is open (also one that ended with a reply within the last 10 minutes).
  async function idle(minIdle) {
    const s = readRuntimeStatus(statusFile, now());
    if (!s || s.state !== 'idle' || s.active_tools !== 0 || !(Number(s.idle_seconds) >= minIdle)) return false;
    if (!im?.available()) return true;
    try {
      return !(await im.openTurn());
    } catch (err) {
      logger.debug(`activation: OpenMax turn state unreadable (${err.message})`);
      return false;
    }
  }

  // The cooldown since the last automatic request has passed and the daily cap is not reached.
  function allowed(requests) {
    const t = now();
    const last = Math.max(-Infinity, ...requests.map((x) => Date.parse(x)).filter((x) => x <= t));
    return t - last >= REQUEST_COOLDOWN_MS && requests.filter((x) => utcDay(Date.parse(x)) === utcDay(t)).length < DAILY_REQUESTS;
  }

  // Counts the request before it is enqueued (a crash in between loses one request, which is made again after
  // CONFIRM_WAIT_MS, rather than enqueueing it twice); a failed enqueue is not counted.
  async function request(why) {
    const at = iso();
    let prev = null;
    save((d) => {
      if (!d.pending) return;
      prev = { requested_at: d.pending.requested_at, request_count: d.pending.request_count };
      d.pending.requested_at = at;
      d.pending.request_count += 1;
      d.requests = [...d.requests.filter((x) => now() - Date.parse(x) < HISTORY_KEEP_MS), at];
    });
    sampledAt = null;
    try {
      await enqueue();
    } catch (err) {
      save((d) => {
        if (d.pending?.requested_at === at) Object.assign(d.pending, prev);
        d.requests = d.requests.filter((x) => x !== at);
      });
      logger.warn(`activation: new session not requested: ${err.message}`);
      return 'enqueue_failed';
    }
    logger.info(`activation: new session requested (${why})`);
    return 'requested';
  }

  // Reports the record against the marker of a session that started after its last change. A target listed with its
  // sha is activated; one missing or listed with another sha is reported as template_inject_missing and not retried.
  // The record is confirmed when every removed adoption is absent too; otherwise the rest stays pending.
  async function confirm(p, marker) {
    const listed = new Map(marker.items.map((i) => [i.adoption_id, i.rendered_sha256]));
    const adoptions = state.read('adoptions', {});
    const entries = [];
    const entry = (kind, t) => ({
      key: `${kind}:${t.adoption_id}:${t.rendered_sha256}:${p.written_at}`,
      org_id: adoptions[t.adoption_id]?.org_id,
      item: { kind, adoption_id: t.adoption_id, rendered_sha256: t.rendered_sha256 },
    });
    const missing = p.targets.filter((t) => listed.get(t.adoption_id) !== t.rendered_sha256);
    const removedGone = p.removed.every((id) => !listed.has(id));
    for (const t of missing) entries.push(entry('template_inject_missing', t));
    if (removedGone) for (const t of p.targets.filter((x) => !missing.includes(x))) entries.push(entry('template_activated', t));
    for (const t of missing) logger.warn(`activation: the session did not get template adoption ${t.adoption_id}; reported as inject missing`);
    for (const e of entries.filter((x) => !x.org_id)) logger.warn(`activation: adoption ${e.item.adoption_id} has no org; not reported`);
    // The reports are queued before the record changes; the same keys are ignored when a crash repeats this.
    enqueueUrgent(state, entries.filter((e) => e.org_id));
    save((d) => {
      if (!d.pending || d.pending.written_at !== p.written_at) return;
      if (removedGone) {
        d.pending = null;
        return;
      }
      d.pending.targets = d.pending.targets.filter((t) => !missing.some((m) => m.adoption_id === t.adoption_id));
      // This marker is used up; the next session is waited for.
      d.pending.seen_at = new Date(marker.at).toISOString();
    });
    if (removedGone) {
      state.clearAlert(STUCK_ALERT);
      logger.info(`activation: confirmed by the session started at ${new Date(marker.at).toISOString()}`);
    }
    if (entries.length) await flush();
    return removedGone ? 'confirmed' : 'unconfirmed';
  }

  // Drops targets whose adoption is no longer active on that bundle (revoked, replaced or removed meanwhile); a record
  // left with nothing is dropped.
  function prune() {
    const adoptions = state.read('adoptions', {});
    const live = (t) => validTarget(t) && adoptions[t.adoption_id]?.state === 'active' && adoptions[t.adoption_id].bundle_sha256 === t.rendered_sha256;
    const d = read();
    if (!d.pending || d.pending.targets.every(live)) return d.pending;
    save((x) => {
      x.pending.targets = x.pending.targets.filter(live);
      if (!x.pending.targets.length && !x.pending.removed.length) x.pending = null;
    });
    const p = read().pending;
    if (!p) state.clearAlert(STUCK_ALERT);
    return p;
  }

  async function tick() {
    const p = prune();
    if (!p) {
      sampledAt = null;
      return 'none';
    }
    const marker = readMarker(dataDir);
    if (marker && marker.at > Date.parse(p.written_at) && !(marker.at <= Date.parse(p.seen_at))) return confirm(p, marker);
    const t = now();
    if (p.requested_at && t - Date.parse(p.requested_at) < CONFIRM_WAIT_MS) return 'waiting';
    if (p.request_count >= MAX_REQUESTS) {
      const msg = `template activation not confirmed after ${MAX_REQUESTS} new-session requests; waiting for the next session`;
      if (state.setAlert(STUCK_ALERT, msg)) logger.warn(`activation: ${msg}`);
      return 'stuck';
    }
    if (!(await idle(IDLE_MIN_SECONDS))) {
      sampledAt = null;
      return 'busy';
    }
    const agreed = sampledAt !== null && t - sampledAt <= MAX_SAMPLE_GAP_MS;
    sampledAt = t;
    if (!agreed) return 'sampled';
    if (!allowed(read().requests)) return 'cooldown';
    return request('idle');
  }

  return {
    ACTIVATION_CHECK_MS,
    // A template write the market accepted: the adoption must show up with this rendered bundle.
    recordWrite({ adoptionId, renderedSha, at }) {
      if (!validTarget({ adoption_id: adoptionId, rendered_sha256: renderedSha })) return;
      merge(at, (p) => {
        const cur = p.targets.find((x) => x.adoption_id === adoptionId);
        if (cur?.rendered_sha256 === renderedSha && Date.parse(at) <= Date.parse(p.written_at)) return;
        p.targets = [...p.targets.filter((x) => x.adoption_id !== adoptionId), { adoption_id: adoptionId, rendered_sha256: renderedSha }];
        p.removed = p.removed.filter((x) => x !== adoptionId);
      });
    },
    // A template uninstall that took the adoption out of its slot: it must be gone from the next session.
    recordRemove({ adoptionId, at }) {
      if (!isCanonicalUuid(adoptionId)) return;
      merge(at, (p) => {
        if (p.removed.includes(adoptionId) && Date.parse(at) <= Date.parse(p.written_at)) return;
        p.targets = p.targets.filter((x) => x.adoption_id !== adoptionId);
        p.removed = [...p.removed.filter((x) => x !== adoptionId), adoptionId];
      });
    },
    // template_inject_missing was reported for the adoption: its waiting activation is dropped, so no
    // template_activated can follow it.
    dropTarget(adoptionId) {
      if (!read().pending?.targets.some((x) => x.adoption_id === adoptionId)) return;
      save((d) => {
        d.pending.targets = d.pending.targets.filter((x) => x.adoption_id !== adoptionId);
        if (!d.pending.targets.length && !d.pending.removed.length) d.pending = null;
      });
      if (!read().pending) state.clearAlert(STUCK_ALERT);
      logger.info(`activation: adoption ${adoptionId} was reported as inject missing; its activation is no longer awaited`);
    },
    // True while a write of the adoption waits for a session.
    isPending: (adoptionId) => Boolean(read().pending?.targets.some((x) => x.adoption_id === adoptionId)),
    // For a starter message of a just written adoption: when the Agent has been idle QUICK_IDLE_SECONDS with no open
    // turn, a new session is requested at once (or one is already on its way) and the time the message may wait
    // until is returned; null means send it as before.
    async welcome(adoptionId) {
      const d = read();
      const p = d.pending;
      if (!p?.targets.some((x) => x.adoption_id === adoptionId)) return null;
      const hold = now() + WELCOME_HOLD_MS;
      if (p.requested_at && now() - Date.parse(p.requested_at) < CONFIRM_WAIT_MS) return hold;
      if (p.request_count >= MAX_REQUESTS || !allowed(d.requests) || !(await idle(QUICK_IDLE_SECONDS))) return null;
      return (await request('starter message')) === 'requested' ? hold : null;
    },
    // Runs every ACTIVATION_CHECK_MS: confirms from the marker, or asks for a new session once the Agent is idle.
    tick,
  };
}
