import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { isCanonicalUuid, isSha256Hex } from './ids.js';
import { enqueueUrgent } from './reconcile.js';
import { readMarker } from './shard-emitter.js';
import { readSlots, writeSlots } from './shards.js';

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
// New-session requests for the starter message of a user's adoption have their own budget, apart from the automatic
// one: at least this long between two (adoptions closer together share one request) ...
export const WELCOME_REQUEST_INTERVAL_MS = 2 * 60 * 1000;
// ... and at most this many per UTC day (loop protection).
export const DAILY_WELCOME_REQUESTS = 12;
// How long a delivered request is given to show up as a new session before it is made again.
export const CONFIRM_WAIT_MS = 15 * 60 * 1000;
export const MAX_REQUESTS = 3;
// Longest time a starter message waits for the session it asked for.
export const WELCOME_HOLD_MS = 3 * 60 * 1000;
// Longest time a starter message waits for its session when no request could be made for it. The hold comes before
// the claim, so it never shortens the send window after the claim (STARTER_SEND_BY_MS) or the market's grace.
export const WELCOME_MAX_HOLD_MS = 24 * 60 * 60 * 1000;
export const PENDING_ALERT_MS = 24 * 60 * 60 * 1000;
export const STUCK_ALERT = 'template_activation_stuck';
export const PENDING_ALERT = 'template_activation_pending_24h';
export const NEW_SESSION_TEXT = 'Agent Market templates were updated; please use the new-session skill to start a new session.';
export const CONTROL_TIMEOUT_MS = 15_000;
// The control queue gives up a request not delivered (or left running) after this; passed as its ack deadline. With
// --no-ack-suffix the runtime marks a submitted request done itself, so the deadline only ends one that is stuck.
export const CONTROL_ACK_DEADLINE_S = 6 * 60 * 60;
// A control id older than this (from the request) is taken as gone, whatever the queue still says.
export const CONTROL_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_SAMPLE_GAP_MS = 2.5 * ACTIVATION_CHECK_MS;
const HISTORY_KEEP_MS = 2 * 24 * 60 * 60 * 1000;
// Control queue states in which the request may still be delivered.
const OUTSTANDING = new Set(['pending', 'running']);
const EPOCH = new Date(0).toISOString();
const EMPTY = Object.freeze({ pending: null, passive: null, requests: [], welcome_requests: [], backfilled: false });

export const defaultStatusFile = (zylosDir) => path.join(zylosDir, 'activity-monitor', 'agent-status.json');
export const controlScript = (zylosDir) => path.join(zylosDir, '.claude', 'skills', 'comm-bridge', 'scripts', 'c4-control.js');

// A control queue call that failed; unknown means the request may have been queued all the same (timeout, an answer
// that could not be read).
export class ControlError extends Error {
  constructor(message, { unknown = false } = {}) {
    super(message);
    this.name = 'ControlError';
    this.unknown = unknown;
  }
}

// The zylos control queue through comm-bridge's c4-control.js. enqueue() queues the new-session request (delivered
// once the Agent is idle, no ack expected, the runtime state honoured) and resolves to its control id; get(id) answers
// its status (pending, running, done, failed, timeout, superseded, or not_found); ack(id) marks it done, so a request
// still pending is never delivered.
export function createControl(zylosDir, { run = execFile, timeoutMs = CONTROL_TIMEOUT_MS } = {}) {
  const script = controlScript(zylosDir);
  const call = (args) => new Promise((resolve, reject) => {
    run(process.execPath, [script, ...args], { timeout: timeoutMs, windowsHide: true, maxBuffer: 64 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(Object.assign(err, { stdout: String(stdout ?? ''), stderr: String(stderr ?? '') }));
      return resolve(String(stdout ?? ''));
    });
  });
  return {
    async enqueue() {
      let out;
      try {
        out = await call([
          'enqueue', '--content', NEW_SESSION_TEXT, '--block-queue-until-idle', '--no-ack-suffix', '--ack-deadline', String(CONTROL_ACK_DEADLINE_S),
        ]);
      } catch (err) {
        if (err.killed || err.signal) throw new ControlError('control enqueue timed out', { unknown: true });
        throw new ControlError(`control enqueue failed (exit ${err.code ?? 'unknown'})`);
      }
      const m = /OK: enqueued control (\d+)/.exec(out);
      if (!m) throw new ControlError('control enqueue gave no readable confirmation', { unknown: true });
      return { id: Number(m[1]) };
    },
    async get(id) {
      try {
        const m = /status=(\w+)/.exec(await call(['get', '--id', String(id)]));
        if (!m) throw new ControlError('control status unreadable');
        return m[1];
      } catch (err) {
        if (/not found/.test(err.stderr ?? '')) return 'not_found';
        throw err instanceof ControlError ? err : new ControlError(`control status unavailable (${err.killed ? 'timed out' : `exit ${err.code}`})`);
      }
    },
    async ack(id) {
      await call(['ack', '--id', String(id)]);
    },
  };
}

// The runtime status as {state, active_tools, idle_seconds, health}, or null when the file is missing, unreadable or
// older than STATUS_MAX_AGE_MS.
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
const isList = Array.isArray;

// State document `activation`: {pending, passive, requests, welcome_requests, backfilled}.
// pending is the one record of this Agent, {pending_since, written_at, targets: [{adoption_id, rendered_sha256}],
// removed: [adoption_id], requested_at, request_count, control_id, delivered_at, seen_at, welcome: [adoption_id]} or
// null. written_at is the last change merged in; control_id the control queue item of the last request (null once it
// left the queue or when the enqueue's outcome is unknown); delivered_at when it was first seen delivered; seen_at the
// last marker that did not confirm the record; welcome the adoptions whose starter message is held until the record is
// confirmed because no request could be made for it at once (the check then keeps trying on the starter budget).
// passive holds the adoptions written before 0.6.0 ({targets, seen_at}); they are confirmed by the next session that
// shows them but never cause a request. requests lists the times of automatic new-session requests, welcome_requests
// those made for starter messages; each has its own budget and neither counts against the other.
// im: the openmax IM (available(), openTurn()); flush(): sends the urgent reconcile queue; control: the control queue.
export function createActivation({
  state, dataDir, zylosDir, logger, im = null, flush = async () => null, now = Date.now,
  statusFile = defaultStatusFile(zylosDir), control = createControl(zylosDir),
}) {
  const iso = () => new Date(now()).toISOString();
  const normalize = (d) => {
    const p = d?.pending;
    const pending = p && typeof p === 'object' && isList(p.targets) && isList(p.removed) && Number.isFinite(Date.parse(p.written_at)) ? p : null;
    const q = d?.passive;
    return {
      pending,
      passive: q && typeof q === 'object' && isList(q.targets) && q.targets.length ? q : null,
      requests: isList(d?.requests) ? d.requests.filter((x) => Number.isFinite(Date.parse(x))) : [],
      welcome_requests: isList(d?.welcome_requests) ? d.welcome_requests.filter((x) => Number.isFinite(Date.parse(x))) : [],
      backfilled: d?.backfilled === true,
    };
  };
  const read = () => normalize(state.read('activation', EMPTY));
  const save = (fn) => state.update('activation', EMPTY, (raw) => {
    const d = normalize(raw);
    fn(d);
    if (d.passive && !d.passive.targets.length) d.passive = null;
    return d;
  });
  let sampledAt = null;
  let turnWarned = false;

  function clearAlerts() {
    state.clearAlert(STUCK_ALERT);
    state.clearAlert(PENDING_ALERT);
  }

  // A control queue request no longer needed (its record was confirmed or dropped) is acked while it is still pending,
  // so it is never delivered; with force it is acked whatever its state (one given up after CONTROL_MAX_AGE_MS).
  // Best effort.
  async function cancel(id, force = false) {
    if (!Number.isSafeInteger(id)) return;
    try {
      if (force || (await control.get(id)) === 'pending') {
        await control.ack(id);
        logger.info(`activation: new-session request ${id} is no longer needed; withdrawn`);
      }
    } catch (err) {
      logger.debug(`activation: new-session request ${id} not withdrawn (${err.message})`);
    }
  }

  // The adoptions written before 0.6.0 had no activation record. Once per state: every active adoption in a slot is
  // seeded as a passive target on its bundle sha256, and a slot without bundle_sha256 gets it from the adoption record,
  // so the next marker names it.
  function backfill() {
    if (read().backfilled) return;
    let slots;
    try { slots = readSlots(dataDir); } catch (err) {
      logger.warn(`activation: earlier adoptions not seeded: ${err.message}`);
      return;
    }
    const adoptions = state.read('adoptions', {});
    const targets = [];
    let filled = false;
    for (const s of Object.values(slots ?? {})) {
      const rec = s && adoptions[s.adoption_id];
      if (rec?.state !== 'active' || !isSha256Hex(rec.bundle_sha256)) continue;
      if (!s.bundle_sha256) {
        s.bundle_sha256 = rec.bundle_sha256;
        filled = true;
      }
      if (s.bundle_sha256 === rec.bundle_sha256) targets.push({ adoption_id: s.adoption_id, rendered_sha256: rec.bundle_sha256 });
    }
    if (filled) writeSlots(dataDir, slots);
    save((d) => {
      const written = new Set((d.pending?.targets ?? []).map((t) => t.adoption_id));
      const fresh = targets.filter((t) => !written.has(t.adoption_id));
      if (fresh.length) d.passive = { targets: fresh, seen_at: EPOCH };
      d.backfilled = true;
    });
    if (targets.length) logger.info(`activation: ${targets.length} earlier template adoption(s) wait for the next session to be confirmed`);
  }

  // Merges a change into the pending record (one per Agent), so changes that come close together share one session.
  // The adoption leaves the passive targets.
  function merge(adoptionId, at, fn) {
    const t = Number.isFinite(Date.parse(at)) ? at : iso();
    let changed = false;
    save((d) => {
      if (d.passive) d.passive.targets = d.passive.targets.filter((x) => x.adoption_id !== adoptionId);
      const p = d.pending ?? {
        pending_since: t, written_at: t, targets: [], removed: [], requested_at: null, request_count: 0, control_id: null, delivered_at: null,
      };
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

  // True when the Agent may be asked for a new session: the runtime status (fresh) shows it healthy and idle for
  // minIdle seconds with no tool running, and no OpenMax turn is open (also one that ended with a reply within the
  // last 10 minutes). The control queue holds requests while the runtime is not healthy.
  async function idle(minIdle) {
    const s = readRuntimeStatus(statusFile, now());
    if (!s || s.state !== 'idle' || s.active_tools !== 0 || !(Number(s.idle_seconds) >= minIdle) || (s.health ?? 'ok') !== 'ok') return false;
    if (!im?.available()) return true;
    try {
      return !(await im.openTurn());
    } catch (err) {
      if (!turnWarned) logger.warn(`activation: OpenMax turn state unreadable (${err.message}); no new session is requested while it is`);
      turnWarned = true;
      return false;
    }
  }

  // The interval since the last request of the list has passed and its daily cap is not reached: the automatic budget
  // by default, the starter message budget with welcome.
  function allowed(requests, welcome = false) {
    const [gap, cap] = welcome ? [WELCOME_REQUEST_INTERVAL_MS, DAILY_WELCOME_REQUESTS] : [REQUEST_COOLDOWN_MS, DAILY_REQUESTS];
    const t = now();
    const last = Math.max(-Infinity, ...requests.map((x) => Date.parse(x)).filter((x) => x <= t));
    return t - last >= gap && requests.filter((x) => utcDay(Date.parse(x)) === utcDay(t)).length < cap;
  }

  // True while the record's last request may still bring a session that has every change merged so far: it is still in
  // the control queue, or was delivered less than CONFIRM_WAIT_MS ago, and no session has started since it was made. A
  // change written now rides on it; once a session started after the request, that session may predate the change.
  function inFlight(p, marker = readMarker(dataDir)) {
    if (!p || (!p.requested_at && !Number.isSafeInteger(p.control_id))) return false;
    const asked = Date.parse(p.requested_at);
    if (marker && Number.isFinite(asked) && marker.at > asked) return false;
    return Number.isSafeInteger(p.control_id) || now() - Math.max(asked, Date.parse(p.delivered_at ?? '') || 0) < CONFIRM_WAIT_MS;
  }

  // True while a starter message is held until the record is confirmed.
  const welcomeWaits = (p) => isList(p?.welcome) && p.welcome.some((id) => p.targets.some((x) => x.adoption_id === id));

  // Follows the last request in the control queue: 'outstanding' while it may still be delivered (also when its state
  // cannot be read), otherwise its id is dropped (the first time it is seen delivered is kept as delivered_at).
  async function followControl(p) {
    if (!Number.isSafeInteger(p?.control_id)) return 'none';
    if (now() - Date.parse(p.requested_at) >= CONTROL_MAX_AGE_MS || !Number.isFinite(Date.parse(p.requested_at))) {
      logger.warn(`activation: new-session request ${p.control_id} still not settled after a day; no longer waited for`);
      await cancel(p.control_id, true);
      save((d) => { if (d.pending?.control_id === p.control_id) d.pending.control_id = null; });
      return 'gone';
    }
    let st;
    try {
      st = await control.get(p.control_id);
    } catch (err) {
      logger.debug(`activation: new-session request ${p.control_id} state unreadable (${err.message})`);
      return 'outstanding';
    }
    if (OUTSTANDING.has(st)) return 'outstanding';
    save((d) => {
      if (d.pending?.control_id !== p.control_id) return;
      d.pending.control_id = null;
      if (st === 'done') d.pending.delivered_at = iso();
    });
    return 'gone';
  }

  // True when a request may be made now; checked again inside the update that counts it. A request for a starter
  // message (welcome) is checked on its own budget and is not made while the last one is still in flight; it does not
  // wait CONFIRM_WAIT_MS after a request whose session already started.
  function mayRequest(d, welcome = false) {
    const p = d.pending;
    if (!p || Number.isSafeInteger(p.control_id) || p.request_count >= MAX_REQUESTS) return false;
    if (welcome) return allowed(d.welcome_requests, true) && !inFlight(p);
    if (!allowed(d.requests)) return false;
    return !(p.requested_at && now() - Math.max(Date.parse(p.requested_at), Date.parse(p.delivered_at ?? '') || 0) < CONFIRM_WAIT_MS);
  }

  // Requests run one at a time (tick and welcome); each is a check-and-set: the request is counted inside the update
  // that checks it may be made, so a request that lost to another one is skipped. It is counted before it is enqueued
  // (a crash in between loses it rather than enqueueing it twice). A refused enqueue is taken back unless a newer
  // change reset the count meanwhile; one whose outcome is unknown (timeout) stays counted and is waited for.
  // welcome: the request is for a starter message and counted in welcome_requests instead of requests.
  let chain = Promise.resolve();
  function request(why, welcome = false) {
    const list = welcome ? 'welcome_requests' : 'requests';
    const run = async () => {
      if ((await followControl(read().pending)) === 'outstanding') return 'waiting';
      const at = iso();
      let taken = null;
      save((d) => {
        if (!mayRequest(d, welcome)) return;
        taken = { requested_at: d.pending.requested_at, delivered_at: d.pending.delivered_at ?? null, count: d.pending.request_count + 1 };
        Object.assign(d.pending, { requested_at: at, request_count: taken.count, control_id: null, delivered_at: null });
        d[list] = [...d[list].filter((x) => now() - Date.parse(x) < HISTORY_KEEP_MS), at];
      });
      if (!taken) return 'skipped';
      sampledAt = null;
      let id = null;
      try {
        ({ id } = await control.enqueue());
      } catch (err) {
        if (err.unknown) {
          logger.warn(`activation: new session requested, outcome unknown (${err.message}); waiting for it`);
          return 'requested';
        }
        save((d) => {
          if (d.pending?.requested_at !== at) return;
          d.pending.requested_at = taken.requested_at;
          d.pending.delivered_at = taken.delivered_at;
          if (d.pending.request_count === taken.count) d.pending.request_count = taken.count - 1;
          d[list] = d[list].filter((x) => x !== at);
        });
        logger.warn(`activation: new session not requested: ${err.message}`);
        return 'enqueue_failed';
      }
      if (Number.isSafeInteger(id)) save((d) => { if (d.pending?.requested_at === at) d.pending.control_id = id; });
      logger.info(`activation: new session requested (${why}${id ? `, control ${id}` : ''})`);
      return 'requested';
    };
    const p = chain.then(run, run);
    chain = p.catch(() => {});
    return p;
  }

  const entryOf = (adoptions, tag) => (kind, t) => ({
    key: `${kind}:${t.adoption_id}:${t.rendered_sha256}:${tag}`,
    org_id: adoptions[t.adoption_id]?.org_id,
    item: { kind, adoption_id: t.adoption_id, rendered_sha256: t.rendered_sha256 },
  });
  function queue(entries) {
    for (const e of entries.filter((x) => !x.org_id)) logger.warn(`activation: adoption ${e.item.adoption_id} has no org; not reported`);
    enqueueUrgent(state, entries.filter((e) => e.org_id), { now, logger });
  }

  // Reports the record against the marker of a session that started after its last change. A target listed with its
  // sha is activated; one missing or listed with another sha is reported as template_inject_missing and not retried.
  // The record is confirmed when every removed adoption is absent too; otherwise the rest stays pending.
  async function confirm(p, marker) {
    const listed = new Map(marker.items.map((i) => [i.adoption_id, i.rendered_sha256]));
    const entry = entryOf(state.read('adoptions', {}), p.written_at);
    const entries = [];
    const missing = p.targets.filter((t) => listed.get(t.adoption_id) !== t.rendered_sha256);
    const removedGone = p.removed.every((id) => !listed.has(id));
    for (const t of missing) entries.push(entry('template_inject_missing', t));
    if (removedGone) for (const t of p.targets.filter((x) => !missing.includes(x))) entries.push(entry('template_activated', t));
    for (const t of missing) logger.warn(`activation: the session did not get template adoption ${t.adoption_id}; reported as inject missing`);
    // The reports are queued before the record changes; the same keys are ignored when a crash repeats this.
    queue(entries);
    // The control id is read inside the update, so a request made meanwhile (a starter message) is withdrawn too.
    let controlId = null;
    save((d) => {
      if (!d.pending || d.pending.written_at !== p.written_at) return;
      if (removedGone) {
        controlId = d.pending.control_id ?? null;
        d.pending = null;
        return;
      }
      d.pending.targets = d.pending.targets.filter((t) => !missing.some((m) => m.adoption_id === t.adoption_id));
      // This marker is used up; the next session is waited for.
      d.pending.seen_at = new Date(marker.at).toISOString();
    });
    if (removedGone) {
      clearAlerts();
      logger.info(`activation: confirmed by the session started at ${new Date(marker.at).toISOString()}`);
      await cancel(controlId);
    }
    if (entries.length) await flush();
    return removedGone ? 'confirmed' : 'unconfirmed';
  }

  // Passive targets (written before 0.6.0) are activated by any newer marker that lists them with their sha; one not
  // listed waits for the next session; none is ever reported as missing.
  async function confirmPassive(marker) {
    const q = read().passive;
    if (!q || !marker || !(marker.at > Date.parse(q.seen_at ?? EPOCH))) return;
    const adoptions = state.read('adoptions', {});
    const live = (t) => adoptions[t.adoption_id]?.state === 'active' && adoptions[t.adoption_id].bundle_sha256 === t.rendered_sha256;
    const listed = new Map(marker.items.map((i) => [i.adoption_id, i.rendered_sha256]));
    const shown = q.targets.filter((t) => live(t) && listed.get(t.adoption_id) === t.rendered_sha256);
    queue(shown.map((t) => entryOf(adoptions, 'earlier')('template_activated', t)));
    save((d) => {
      if (!d.passive) return;
      d.passive.targets = d.passive.targets.filter((t) => live(t) && !shown.some((x) => x.adoption_id === t.adoption_id));
      d.passive.seen_at = new Date(marker.at).toISOString();
    });
    if (shown.length) await flush();
  }

  // Drops targets whose adoption is no longer active on that bundle (revoked, replaced or removed meanwhile); a record
  // left with nothing is dropped, and its request withdrawn.
  async function prune() {
    const adoptions = state.read('adoptions', {});
    const live = (t) => validTarget(t) && adoptions[t.adoption_id]?.state === 'active' && adoptions[t.adoption_id].bundle_sha256 === t.rendered_sha256;
    const d = read();
    if (!d.pending || d.pending.targets.every(live)) return d.pending;
    save((x) => {
      x.pending.targets = x.pending.targets.filter(live);
      if (!x.pending.targets.length && !x.pending.removed.length) x.pending = null;
    });
    const p = read().pending;
    if (!p) {
      clearAlerts();
      await cancel(d.pending.control_id);
    }
    return p;
  }

  async function tick() {
    const marker = readMarker(dataDir);
    await confirmPassive(marker);
    const p = await prune();
    if (!p) {
      sampledAt = null;
      state.clearAlert(PENDING_ALERT);
      return 'none';
    }
    const t = now();
    if (t - Date.parse(p.pending_since) >= PENDING_ALERT_MS) {
      const msg = `template activation pending since ${p.pending_since}`;
      if (state.setAlert(PENDING_ALERT, msg)) logger.warn(`activation: ${msg}`);
    }
    if (marker && marker.at > Date.parse(p.written_at) && !(marker.at <= Date.parse(p.seen_at))) return confirm(p, marker);
    if ((await followControl(p)) === 'outstanding') return 'waiting';
    const cur = read().pending;
    if (!cur) return 'none';
    // A held starter message: asked for on the starter budget as soon as it allows and the Agent is idle
    // QUICK_IDLE_SECONDS; otherwise the automatic rules below apply.
    if (welcomeWaits(cur) && mayRequest(read(), true) && (await idle(QUICK_IDLE_SECONDS))) {
      const r = await request('starter message', true);
      if (r !== 'skipped') return r;
    }
    if (cur.requested_at && t - Math.max(Date.parse(cur.requested_at), Date.parse(cur.delivered_at ?? '') || 0) < CONFIRM_WAIT_MS) return 'waiting';
    if (cur.request_count >= MAX_REQUESTS) {
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
    const r = await request('idle');
    return r === 'skipped' ? 'waiting' : r;
  }

  try {
    backfill();
  } catch (err) {
    logger.error(`activation: earlier adoptions not seeded: ${err.message}`);
  }

  return {
    ACTIVATION_CHECK_MS,
    // A template write the market accepted: the adoption must show up with this rendered bundle. A rewrite of the
    // bundle the current session already shows (per the latest marker, with no change of it waiting) needs no session:
    // it is reported as activated at once.
    recordWrite({ adoptionId, renderedSha, at }) {
      if (!validTarget({ adoption_id: adoptionId, rendered_sha256: renderedSha })) return 'invalid';
      const p = read().pending;
      const waiting = p?.targets.some((x) => x.adoption_id === adoptionId) || p?.removed.includes(adoptionId);
      const marker = readMarker(dataDir);
      if (!waiting && marker?.items.some((i) => i.adoption_id === adoptionId && i.rendered_sha256 === renderedSha)) {
        save((d) => { if (d.passive) d.passive.targets = d.passive.targets.filter((x) => x.adoption_id !== adoptionId); });
        queue([entryOf(state.read('adoptions', {}), `shown:${new Date(marker.at).toISOString()}`)('template_activated',
          { adoption_id: adoptionId, rendered_sha256: renderedSha })]);
        logger.info(`activation: adoption ${adoptionId} is already in the current session`);
        Promise.resolve().then(flush).catch(() => {});
        return 'active';
      }
      merge(adoptionId, at, (q) => {
        const cur = q.targets.find((x) => x.adoption_id === adoptionId);
        if (cur?.rendered_sha256 === renderedSha && Date.parse(at) <= Date.parse(q.written_at)) return;
        q.targets = [...q.targets.filter((x) => x.adoption_id !== adoptionId), { adoption_id: adoptionId, rendered_sha256: renderedSha }];
        q.removed = q.removed.filter((x) => x !== adoptionId);
      });
      return 'pending';
    },
    // A template uninstall that took the adoption out of its slot: it must be gone from the next session.
    recordRemove({ adoptionId, at }) {
      if (!isCanonicalUuid(adoptionId)) return;
      merge(adoptionId, at, (q) => {
        if (q.removed.includes(adoptionId) && Date.parse(at) <= Date.parse(q.written_at)) return;
        q.targets = q.targets.filter((x) => x.adoption_id !== adoptionId);
        q.removed = [...q.removed.filter((x) => x !== adoptionId), adoptionId];
      });
    },
    // template_inject_missing was reported for the adoption: its waiting activation is dropped, so no
    // template_activated can follow it.
    dropTarget(adoptionId) {
      const d = read();
      const inPending = d.pending?.targets.some((x) => x.adoption_id === adoptionId);
      const inPassive = d.passive?.targets.some((x) => x.adoption_id === adoptionId);
      if (!inPending && !inPassive) return;
      save((x) => {
        if (x.passive) x.passive.targets = x.passive.targets.filter((t) => t.adoption_id !== adoptionId);
        if (!x.pending) return;
        x.pending.targets = x.pending.targets.filter((t) => t.adoption_id !== adoptionId);
        if (!x.pending.targets.length && !x.pending.removed.length) x.pending = null;
      });
      if (inPending && !read().pending) {
        clearAlerts();
        cancel(d.pending.control_id).catch(() => {});
      }
      logger.info(`activation: adoption ${adoptionId} was reported as inject missing; its activation is no longer awaited`);
    },
    // True while a write of the adoption waits for a session.
    isPending: (adoptionId) => Boolean(read().pending?.targets.some((x) => x.adoption_id === adoptionId)),
    // For a starter message of a just written adoption; returns the time the message may wait until, or null to send it
    // as before. A request still in flight is joined (WELCOME_HOLD_MS). Otherwise, when the Agent has been idle
    // QUICK_IDLE_SECONDS with no open turn, a new session is requested at once on the starter budget, not the automatic
    // one (WELCOME_HOLD_MS). When that budget does not allow it (WELCOME_REQUEST_INTERVAL_MS since the last one, or
    // DAILY_WELCOME_REQUESTS reached), the message is held until the record is confirmed (WELCOME_MAX_HOLD_MS at most),
    // and the check asks for the session once a rule allows it.
    async welcome(adoptionId) {
      const has = (p) => Boolean(p?.targets.some((x) => x.adoption_id === adoptionId));
      const p = read().pending;
      if (!has(p)) return null;
      if (inFlight(p)) return now() + WELCOME_HOLD_MS;
      if (!(await idle(QUICK_IDLE_SECONDS))) return null;
      const r = await request('starter message', true);
      // Held also when another request won meanwhile.
      const q = read().pending;
      if (!has(q)) return null;
      if (inFlight(q)) return now() + WELCOME_HOLD_MS;
      if (r === 'enqueue_failed') return null;
      save((d) => {
        if (has(d.pending)) d.pending.welcome = [...new Set([...(isList(d.pending.welcome) ? d.pending.welcome : []), adoptionId])];
      });
      logger.info(`activation: no new session may be requested now for the starter message of adoption ${adoptionId}; it waits until the template is in a session`);
      return now() + WELCOME_MAX_HOLD_MS;
    },
    // Runs every ACTIVATION_CHECK_MS: confirms from the marker, or asks for a new session once the Agent is idle.
    tick,
  };
}
