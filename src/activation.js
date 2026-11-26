import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { isCanonicalUuid, isSha256Hex } from './ids.js';
import { enqueueUrgent } from './reconcile.js';
import { readMarker } from './shard-emitter.js';
import { declarationsInPlace, declarationsReady, readSlots, writeSlots } from './shards.js';

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
// A template update or switch the user ordered (a write order without a starter message) is asked for the same way, on
// a budget of its own: at least this long between two (changes closer together share one request), ...
export const UPDATE_REQUEST_INTERVAL_MS = 2 * 60 * 1000;
// ... at most this many in any 60 minutes ...
export const HOURLY_UPDATE_REQUESTS = 3;
export const UPDATE_REQUEST_WINDOW_MS = 60 * 60 * 1000;
// ... and this many per UTC day. Past these the change waits for the automatic rules (IDLE_MIN_SECONDS,
// REQUEST_COOLDOWN_MS, DAILY_REQUESTS).
export const DAILY_UPDATE_REQUESTS = 12;
// A template write held because the Codex slot hooks are missing (Codex loads them only when a session starts) is
// asked for the same way, on a budget of its own: at least this long between two (writes held together share one
// request), ...
export const HOOKS_REQUEST_INTERVAL_MS = 2 * 60 * 1000;
// ... and at most this many per UTC day (loop protection).
export const DAILY_HOOKS_REQUESTS = 12;
// The hooks are taken as still missing only once a session started at least this long ago (its launch adds them).
export const HOOKS_SETTLE_MS = 60 * 1000;
// Most requests given back per UTC day after a model API problem (refundApiError); past it they count as before.
export const DAILY_API_ERROR_REFUNDS = 12;
// How long a delivered request is given to show up as a new session before it is made again.
export const CONFIRM_WAIT_MS = 5 * 60 * 1000;
// A request made while no session followed the last one (a retry) does not wait REQUEST_COOLDOWN_MS; at most this
// many per UTC day, counted apart from DAILY_REQUESTS.
export const DAILY_RETRY_REQUESTS = 12;
export const MAX_REQUESTS = 3;
// Longest time a starter message waits for its template to be in a session. The hold comes before the claim, so it
// never shortens the send window after the claim (STARTER_SEND_BY_MS) or the market's grace.
export const WELCOME_MAX_HOLD_MS = 24 * 60 * 60 * 1000;
export const PENDING_ALERT_MS = 24 * 60 * 60 * 1000;
export const STUCK_ALERT = 'template_activation_stuck';
export const PENDING_ALERT = 'template_activation_pending_24h';
export const NEW_SESSION_TEXT = 'Agent Market templates were updated and the market client has verified, from the injected template hashes, '
  + 'that the current session does not match them. Start a new session now with the new-session skill. Do not check whether one is needed.';
export const HOOKS_SESSION_TEXT = 'An Agent Market template is waiting for its session-start hooks, which Codex loads only when a session starts. '
  + 'Start a new session now with the new-session skill. Do not check whether one is needed.';
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
const EMPTY = Object.freeze({
  pending: null, passive: null, hooks: null, requests: [], welcome_requests: [], update_requests: [], hooks_requests: [], retry_requests: [],
  api_error_refunds: [], backfilled: false,
});

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

// The zylos control queue through comm-bridge's c4-control.js. enqueue(content) queues the new-session request
// (delivered once the Agent is idle, no ack expected, the runtime state honoured) and resolves to its control id; get(id)
// answers its status (pending, running, done, failed, timeout, superseded, or not_found); ack(id) marks it done, so a
// request still pending is never delivered.
export function createControl(zylosDir, { run = execFile, timeoutMs = CONTROL_TIMEOUT_MS } = {}) {
  const script = controlScript(zylosDir);
  const call = (args) => new Promise((resolve, reject) => {
    run(process.execPath, [script, ...args], { timeout: timeoutMs, windowsHide: true, maxBuffer: 64 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(Object.assign(err, { stdout: String(stdout ?? ''), stderr: String(stderr ?? '') }));
      return resolve(String(stdout ?? ''));
    });
  });
  return {
    async enqueue(content = NEW_SESSION_TEXT) {
      let out;
      try {
        out = await call([
          'enqueue', '--content', content, '--block-queue-until-idle', '--no-ack-suffix', '--ack-deadline', String(CONTROL_ACK_DEADLINE_S),
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

// State document `activation`: {pending, passive, hooks, requests, welcome_requests, update_requests, hooks_requests,
// retry_requests, backfilled}.
// pending is the one record of this Agent, {pending_since, written_at, targets: [{adoption_id, rendered_sha256}],
// removed: [adoption_id], requested_at, request_count, control_id, delivered_at, seen_at, welcome: [adoption_id], user,
// stuck_at} or null. written_at is the last change merged in; control_id the control queue item of the last request
// (null once it left the queue or when the enqueue's outcome is unknown); delivered_at when it was first seen
// delivered; seen_at the last marker that did not confirm the record; welcome the adoptions whose starter message is
// held until the record is confirmed (the check keeps asking on the starter budget while no request is in flight);
// user true once a write the user ordered was merged in (asked for on update_requests); api_error_at when the runtime
// reported a model API problem during the confirm wait of the last request (refundApiError); stuck_at when MAX_REQUESTS
// requests brought no session, which releases those messages.
// passive holds the adoptions written before 0.6.0 ({targets, seen_at}); they are confirmed by the next session that
// shows them but never cause a request. requests lists the times of automatic new-session requests, welcome_requests
// those made for starter messages, update_requests those made for user-ordered writes, retry_requests automatic ones
// made while no session followed the last request; each has its own budget and none counts against another.
// api_error_refunds lists the times a request was given back after a model API problem (DAILY_API_ERROR_REFUNDS).
// hooks is the one record of template writes held for the Codex slot hooks, {since, until, requested_at, request_count,
// control_id, delivered_at, given_up_at, missing_at} or null: one request at most (counted in hooks_requests), given_up_at
// when it could not be enqueued, missing_at when a session started after it and the hooks were still missing. It ends
// once the hooks are present or at until.
// im: the openmax IM (available(), openTurn()); flush(): sends the urgent reconcile queue; control: the control queue.
export function createActivation({
  state, dataDir, zylosDir, logger, im = null, flush = async () => null, now = Date.now,
  statusFile = defaultStatusFile(zylosDir), control = createControl(zylosDir),
}) {
  const iso = () => new Date(now()).toISOString();
  const times = (x) => (isList(x) ? x.filter((t) => Number.isFinite(Date.parse(t))) : []);
  const normalize = (d) => {
    const p = d?.pending;
    const pending = p && typeof p === 'object' && isList(p.targets) && isList(p.removed) && Number.isFinite(Date.parse(p.written_at)) ? p : null;
    const q = d?.passive;
    const h = d?.hooks;
    return {
      pending,
      passive: q && typeof q === 'object' && isList(q.targets) && q.targets.length ? q : null,
      hooks: h && typeof h === 'object' && Number.isFinite(Date.parse(h.since)) && Number.isFinite(Date.parse(h.until)) ? h : null,
      requests: times(d?.requests),
      welcome_requests: times(d?.welcome_requests),
      update_requests: times(d?.update_requests),
      hooks_requests: times(d?.hooks_requests),
      retry_requests: times(d?.retry_requests),
      api_error_refunds: times(d?.api_error_refunds),
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
  let imWarned = false;

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
      delete p.stuck_at;
      d.pending = p;
      changed = true;
    });
    if (changed) state.clearAlert(STUCK_ALERT);
  }

  // True when the Agent may be asked for a new session: the runtime status (fresh) shows it healthy and idle for
  // minIdle seconds with no tool running, and no OpenMax turn is open: a run openmax still lists in its active index
  // (open, or closed on its reply while its turn lasts, 10 minutes at most). A turn that has ended is no longer listed,
  // and without the openmax CLI, or with no active index, no turn is seen; then only the runtime status decides.
  // The control queue holds requests while the runtime is not healthy.
  // idleState says 'idle', 'busy', or 'unknown' when the runtime status or the turn state cannot be read.
  async function idleState(minIdle) {
    const s = readRuntimeStatus(statusFile, now());
    if (!s) return 'unknown';
    if (s.state !== 'idle' || s.active_tools !== 0 || !(Number(s.idle_seconds) >= minIdle) || (s.health ?? 'ok') !== 'ok') return 'busy';
    if (!im?.available()) {
      if (!imWarned) logger.info('activation: openmax CLI not found; OpenMax turns are not checked before a new session is requested');
      imWarned = true;
      return 'idle';
    }
    try {
      return (await im.openTurn()) ? 'busy' : 'idle';
    } catch (err) {
      if (!turnWarned) logger.warn(`activation: OpenMax turn state unreadable (${err.message}); no new session is requested while it is`);
      turnWarned = true;
      return 'unknown';
    }
  }
  const idle = async (minIdle) => (await idleState(minIdle)) === 'idle';

  // The interval since the last request of the list has passed and neither its daily nor its hourly cap is reached.
  const BUDGETS = {
    requests: [REQUEST_COOLDOWN_MS, DAILY_REQUESTS],
    welcome_requests: [WELCOME_REQUEST_INTERVAL_MS, DAILY_WELCOME_REQUESTS],
    update_requests: [UPDATE_REQUEST_INTERVAL_MS, DAILY_UPDATE_REQUESTS, HOURLY_UPDATE_REQUESTS],
    hooks_requests: [HOOKS_REQUEST_INTERVAL_MS, DAILY_HOOKS_REQUESTS],
    retry_requests: [0, DAILY_RETRY_REQUESTS],
  };
  function allowed(d, list) {
    const requests = d[list];
    const [gap, cap, hourly = Infinity] = BUDGETS[list];
    const t = now();
    const at = requests.map((x) => Date.parse(x));
    const last = Math.max(-Infinity, ...at.filter((x) => x <= t));
    return t - last >= gap && at.filter((x) => utcDay(x) === utcDay(t)).length < cap
      && at.filter((x) => t - x < UPDATE_REQUEST_WINDOW_MS).length < hourly;
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

  // True when the record has had a request and no session started after it.
  function unconfirmed(p, marker = readMarker(dataDir)) {
    const asked = Date.parse(p?.requested_at);
    return Number.isFinite(asked) && !(marker && marker.at > asked);
  }

  // The budget an automatic request of the record is counted in: a retry when no session followed the last request,
  // so none was used since.
  const autoList = (p) => (unconfirmed(p) ? 'retry_requests' : 'requests');

  // True while a starter message is held until the record is confirmed.
  const welcomeWaits = (p) => isList(p?.welcome) && p.welcome.some((id) => p.targets.some((x) => x.adoption_id === id));

  // The budgets of the quick requests: a held starter message, a write the user ordered, or a write held for the Codex
  // slot hooks.
  const QUICK = { welcome: 'welcome_requests', update: 'update_requests', hooks: 'hooks_requests' };
  // The record a request of the kind is made for.
  const recordOf = (kind) => (kind === 'hooks' ? 'hooks' : 'pending');

  // Follows the last request of the record (key) in the control queue: 'outstanding' while it may still be delivered
  // (also when its state cannot be read), otherwise its id is dropped (the first time it is seen delivered is kept as
  // delivered_at).
  async function followControl(p, key = 'pending') {
    if (!Number.isSafeInteger(p?.control_id)) return 'none';
    if (now() - Date.parse(p.requested_at) >= CONTROL_MAX_AGE_MS || !Number.isFinite(Date.parse(p.requested_at))) {
      logger.warn(`activation: new-session request ${p.control_id} still not settled after a day; no longer waited for`);
      await cancel(p.control_id, true);
      save((d) => { if (d[key]?.control_id === p.control_id) d[key].control_id = null; });
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
      if (d[key]?.control_id !== p.control_id) return;
      d[key].control_id = null;
      if (st === 'done') d[key].delivered_at = iso();
    });
    return 'gone';
  }

  // True when a request may be made now; checked again inside the update that counts it. A quick request (kind
  // 'welcome' for a starter message, 'update' for a write the user ordered) is checked on its own budget and is not made
  // while the last one is still in flight; it does not wait CONFIRM_WAIT_MS after a request whose session already
  // started. A request for the Codex slot hooks is made once per hooks record, and not while a request of the pending
  // record may still bring a session.
  function mayRequest(d, kind = null) {
    if (kind === 'hooks') {
      const h = d.hooks;
      return Boolean(h) && !h.requested_at && !h.given_up_at && !h.missing_at && !Number.isSafeInteger(h.control_id)
        && allowed(d, QUICK.hooks) && !inFlight(d.pending);
    }
    const p = d.pending;
    if (!p || Number.isSafeInteger(p.control_id) || p.request_count >= MAX_REQUESTS) return false;
    if (kind === 'update' && p.user !== true) return false;
    if (kind) return allowed(d, QUICK[kind]) && !inFlight(p);
    if (!allowed(d, autoList(p))) return false;
    return !(p.requested_at && now() - Math.max(Date.parse(p.requested_at), Date.parse(p.delivered_at ?? '') || 0) < CONFIRM_WAIT_MS);
  }

  // Requests run one at a time (tick and welcome); each is a check-and-set: the request is counted inside the update
  // that checks it may be made, so a request that lost to another one is skipped. It is counted before it is enqueued
  // (a crash in between loses it rather than enqueueing it twice). A refused enqueue is taken back unless a newer
  // change reset the count meanwhile; one whose outcome is unknown (timeout) stays counted and is waited for.
  // kind: 'welcome' counts the request in welcome_requests, 'update' in update_requests, 'hooks' (made for the hooks
  // record) in hooks_requests; otherwise it is counted in requests, or in retry_requests when no session followed the
  // last request.
  let chain = Promise.resolve();
  function request(why, kind = null) {
    const key = recordOf(kind);
    let list = null;
    const run = async () => {
      if ((await followControl(read()[key], key)) === 'outstanding') return 'waiting';
      const at = iso();
      let taken = null;
      save((d) => {
        if (!mayRequest(d, kind)) return;
        const r = d[key];
        list = kind ? QUICK[kind] : autoList(r);
        taken = { requested_at: r.requested_at, delivered_at: r.delivered_at ?? null, count: r.request_count + 1 };
        Object.assign(r, { requested_at: at, request_count: taken.count, control_id: null, delivered_at: null });
        d[list] = [...d[list].filter((x) => now() - Date.parse(x) < HISTORY_KEEP_MS), at];
      });
      if (!taken) return 'skipped';
      sampledAt = null;
      let id = null;
      try {
        ({ id } = await control.enqueue(kind === 'hooks' ? HOOKS_SESSION_TEXT : NEW_SESSION_TEXT));
      } catch (err) {
        if (err.unknown) {
          logger.warn(`activation: new session requested, outcome unknown (${err.message}); waiting for it`);
          return 'requested';
        }
        save((d) => {
          const r = d[key];
          if (r?.requested_at !== at) return;
          r.requested_at = taken.requested_at;
          r.delivered_at = taken.delivered_at;
          if (r.request_count === taken.count) r.request_count = taken.count - 1;
          d[list] = d[list].filter((x) => x !== at);
        });
        logger.warn(`activation: new session not requested: ${err.message}`);
        return 'enqueue_failed';
      }
      if (Number.isSafeInteger(id)) save((d) => { if (d[key]?.requested_at === at) d[key].control_id = id; });
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

  // When the confirm wait of the record's last request starts: when it was first seen delivered, else when it was made.
  const waitStart = (p) => Math.max(Date.parse(p.requested_at), Date.parse(p.delivered_at ?? '') || 0);

  // The runtime reported a model API problem (fresh status, health not ok) during the confirm wait of the record's last
  // request, no session since: kept as api_error_at, so the request can be given back (refundApiError). Called once the
  // request left the control queue, so a problem while it was queued, or after the wait, is not kept. A stuck record's
  // wait is over (stuck is decided only after it, and no request follows).
  function noteApiError(p, marker) {
    if (!p || !unconfirmed(p, marker) || !(p.request_count > 0)) return;
    const start = waitStart(p);
    const t = now();
    if (!(t >= start && t - start < CONFIRM_WAIT_MS) || Date.parse(p.api_error_at) >= start) return;
    const s = readRuntimeStatus(statusFile, t);
    if (!s || (s.health ?? 'ok') === 'ok') return;
    const at = iso();
    save((d) => {
      const q = d.pending;
      if (q && q.requested_at === p.requested_at && q.delivered_at === p.delivered_at && !q.stuck_at) q.api_error_at = at;
    });
    logger.debug(`activation: the runtime reports ${String(s.health).slice(0, 40)} during the confirm wait of the new-session request`);
  }

  // Once the confirm wait of an unconfirmed request is over: a request with a model API problem kept in that wait is not
  // counted (request_count back by one), at most DAILY_API_ERROR_REFUNDS a UTC day. The next request still
  // waits for an idle, healthy runtime (idleState).
  function refundApiError(p) {
    if (!p || !(p.request_count > 0) || !unconfirmed(p)) return;
    const start = waitStart(p);
    const e = Date.parse(p.api_error_at);
    if (!(e >= start && e - start < CONFIRM_WAIT_MS) || now() - start < CONFIRM_WAIT_MS) return;
    let given = false;
    save((d) => {
      const q = d.pending;
      if (!q || q.stuck_at || q.requested_at !== p.requested_at || q.api_error_at !== p.api_error_at) return;
      const t = now();
      if (d.api_error_refunds.filter((x) => utcDay(Date.parse(x)) === utcDay(t)).length >= DAILY_API_ERROR_REFUNDS) return;
      q.request_count -= 1;
      delete q.api_error_at;
      d.api_error_refunds = [...d.api_error_refunds.filter((x) => t - Date.parse(x) < HISTORY_KEEP_MS), iso()];
      given = true;
    });
    if (given) logger.info(`activation: a new-session request the runtime could not serve (model API problem) does not count toward ${MAX_REQUESTS}`);
  }

  // When a session started after time t, from the marker or the runtime's launch time; null when none is known.
  function sessionAfter(t) {
    const m = readMarker(dataDir);
    if (m && m.at > t) return m.at;
    const launched = Number(readRuntimeStatus(statusFile, now())?.runtime_launch_at);
    return launched > t ? launched : null;
  }

  // Drops the hooks record named by since (any when null) and withdraws its request.
  async function dropHooks(since = null) {
    let id = null;
    let dropped = false;
    save((d) => {
      if (!d.hooks || (since !== null && d.hooks.since !== since)) return;
      id = d.hooks.control_id ?? null;
      d.hooks = null;
      dropped = true;
    });
    await cancel(id);
    return dropped;
  }

  // One step of the hooks record: 'ready' once the hooks are present (onReady is called), 'missing' once a session
  // started after its request and they are still missing, 'requested' when a new session was asked for now, otherwise
  // 'waiting' ('none' without a record). The request waits for a healthy Agent idle QUICK_IDLE_SECONDS with no open
  // turn, and is made only while the declarations are in place, so a session start adds the hooks.
  async function hooksStep(onReady = () => {}) {
    const h = read().hooks;
    if (!h) return 'none';
    if (declarationsReady(zylosDir)) {
      if (await dropHooks(h.since)) {
        logger.info('activation: the Codex slot hooks are present; the held template write runs');
        onReady();
      }
      return 'ready';
    }
    if (Date.parse(h.until) <= now()) {
      await dropHooks(h.since);
      return 'none';
    }
    if (h.missing_at) return 'missing';
    if (h.requested_at) {
      if ((await followControl(h, 'hooks')) === 'outstanding') return 'waiting';
      const at = sessionAfter(Date.parse(h.requested_at));
      if (at === null || now() - at < HOOKS_SETTLE_MS) return 'waiting';
      save((d) => { if (d.hooks?.requested_at === h.requested_at) d.hooks.missing_at = iso(); });
      logger.warn('activation: a new session started and the Codex slot hooks are still missing; no further session is requested for them');
      return 'missing';
    }
    if (!declarationsInPlace(zylosDir) || !mayRequest(read(), 'hooks') || !(await idle(QUICK_IDLE_SECONDS))) return 'waiting';
    const r = await request('template write held for the Codex slot hooks', 'hooks');
    if (r === 'enqueue_failed') save((d) => { if (d.hooks?.since === h.since) d.hooks.given_up_at = iso(); });
    return r === 'requested' ? 'requested' : 'waiting';
  }

  // onHooksReady: called once the Codex slot hooks a template write was held for are present.
  async function tick({ onHooksReady = () => {} } = {}) {
    try {
      await hooksStep(onHooksReady);
    } catch (err) {
      logger.warn(`activation: Codex slot hooks check failed: ${err.message}`);
    }
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
    noteApiError(read().pending, marker);
    // Given back before any new request (the quick ones included), which would end the wait it was kept in. A stuck
    // record gets nothing back, even when the daily cap held back its refund and a new UTC day has begun.
    refundApiError(read().pending);
    const cur = read().pending;
    if (!cur) return 'none';
    // A held starter message: asked for on the starter budget as soon as it allows and the Agent is idle
    // QUICK_IDLE_SECONDS; otherwise the automatic rules below apply.
    if (welcomeWaits(cur) && mayRequest(read(), 'welcome') && (await idle(QUICK_IDLE_SECONDS))) {
      const r = await request('starter message', 'welcome');
      if (r !== 'skipped') return r;
    }
    // A write the user ordered (update, switch): the same, on its own budget. Past it the automatic rules apply.
    if (mayRequest(read(), 'update') && (await idle(QUICK_IDLE_SECONDS))) {
      const r = await request('template update by the user', 'update');
      if (r !== 'skipped') return r;
    }
    if (cur.requested_at && t - Math.max(Date.parse(cur.requested_at), Date.parse(cur.delivered_at ?? '') || 0) < CONFIRM_WAIT_MS) return 'waiting';
    if (read().pending?.request_count >= MAX_REQUESTS) {
      const msg = `template activation not confirmed after ${MAX_REQUESTS} new-session requests; waiting for the next session`;
      if (state.setAlert(STUCK_ALERT, msg)) logger.warn(`activation: ${msg}`);
      // Held starter messages are released: no more sessions are asked for this change.
      if (!cur.stuck_at) save((d) => { if (d.pending && d.pending.written_at === cur.written_at) d.pending.stuck_at = iso(); });
      return 'stuck';
    }
    if (!(await idle(IDLE_MIN_SECONDS))) {
      sampledAt = null;
      return 'busy';
    }
    const agreed = sampledAt !== null && t - sampledAt <= MAX_SAMPLE_GAP_MS;
    sampledAt = t;
    if (!agreed) return 'sampled';
    const retry = unconfirmed(read().pending);
    if (!mayRequest(read())) return 'cooldown';
    const r = await request(retry ? 'retry, no session followed the last request' : 'idle');
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
    // it is reported as activated at once. userInitiated: the user ordered the write (the record then takes the quick
    // requests on update_requests).
    recordWrite({ adoptionId, renderedSha, at, userInitiated = false }) {
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
        if (userInitiated) q.user = true;
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
    // True while a write of the adoption waits for a session that is still being asked for (not stuck).
    isPending: (adoptionId) => {
      const p = read().pending;
      return Boolean(p?.targets.some((x) => x.adoption_id === adoptionId) && !p.stuck_at);
    },
    // For a starter message of a just written adoption; returns the time the message may wait until, or null to send it
    // as before. The message is held until the record is confirmed (WELCOME_MAX_HOLD_MS at most), so it never comes
    // before the template is in a session. A request still in flight is joined. Otherwise, when the Agent has been idle
    // QUICK_IDLE_SECONDS with no open turn, a new session is requested at once on the starter budget, not the automatic
    // one. When the Agent is busy, the budget does not allow it (WELCOME_REQUEST_INTERVAL_MS since the last one, or
    // DAILY_WELCOME_REQUESTS reached), or a joined request brings no session within CONFIRM_WAIT_MS, the check asks for
    // the session once the Agent is idle and a rule allows it. When the runtime or turn state cannot be read, or the
    // enqueue was refused, no session could be asked for, so the message is not held.
    async welcome(adoptionId) {
      const has = (p) => Boolean(p?.targets.some((x) => x.adoption_id === adoptionId));
      const p = read().pending;
      if (!has(p)) return null;
      // A refund due since the last request's confirm wait ended comes before any new request, as in tick.
      refundApiError(p);
      let st = 'joined';
      if (!inFlight(read().pending)) {
        st = await idleState(QUICK_IDLE_SECONDS);
        if (st === 'unknown') return null;
        if (st === 'idle') {
          const r = await request('starter message', 'welcome');
          // Held also when another request won meanwhile.
          const q = read().pending;
          if (!has(q)) return null;
          st = inFlight(q) ? 'joined' : st;
          if (r === 'enqueue_failed' && st !== 'joined') return null;
        }
      }
      save((d) => {
        if (has(d.pending)) d.pending.welcome = [...new Set([...(isList(d.pending.welcome) ? d.pending.welcome : []), adoptionId])];
      });
      logger.info(st === 'joined'
        ? `activation: a new session is on its way; the starter message of adoption ${adoptionId} waits until the template is in a session`
        : st === 'busy'
          ? `activation: the Agent is busy; the starter message of adoption ${adoptionId} waits until the template is in a session`
          : `activation: no new session may be requested now for the starter message of adoption ${adoptionId}; it waits until the template is in a session`);
      return now() + WELCOME_MAX_HOLD_MS;
    },
    // A template write held because the Codex slot hooks are missing, until the time until: writes held together share
    // one record and one request (see hooksStep). Resolves to 'missing' when a session started after the request and the
    // hooks are still missing; the write then stops waiting.
    async hooksSession({ until }) {
      const end = Date.parse(until);
      if (!Number.isFinite(end)) return 'waiting';
      const at = new Date(end).toISOString();
      save((d) => {
        const h = d.hooks;
        if (!h || Date.parse(h.until) <= now()) {
          d.hooks = { since: iso(), until: at, requested_at: null, request_count: 0, control_id: null, delivered_at: null };
        } else if (!h.missing_at && end > Date.parse(h.until)) {
          h.until = at;
        }
      });
      return hooksStep();
    },
    // The Codex slot hooks are present: the hooks record ends and its request is withdrawn.
    async hooksDone() {
      if (read().hooks) await dropHooks();
    },
    // Runs every ACTIVATION_CHECK_MS: confirms from the marker, or asks for a new session once the Agent is idle.
    tick,
  };
}
