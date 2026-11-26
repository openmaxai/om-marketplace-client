import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AGENT, ORG, U, pullHarness } from './fake/pull.js';
import { tmpHome } from './helpers.js';
import { Crash, crashingState } from './fake/skills.js';
import {
  ACTIVATION_CHECK_MS, CONFIRM_WAIT_MS, DAILY_REQUESTS, DAILY_WELCOME_REQUESTS, IDLE_MIN_SECONDS, WELCOME_MAX_HOLD_MS, WELCOME_REQUEST_INTERVAL_MS, MAX_REQUESTS, NEW_SESSION_TEXT, REQUEST_COOLDOWN_MS,
  DAILY_HOOKS_REQUESTS, HOOKS_REQUEST_INTERVAL_MS, HOOKS_SESSION_TEXT, HOOKS_SETTLE_MS, QUICK_IDLE_SECONDS,
  DAILY_RETRY_REQUESTS, DAILY_UPDATE_REQUESTS, DAILY_API_ERROR_REFUNDS, HOURLY_UPDATE_REQUESTS, UPDATE_REQUEST_INTERVAL_MS, CONTROL_ACK_DEADLINE_S, CONTROL_MAX_AGE_MS, PENDING_ALERT, PENDING_ALERT_MS, STATUS_MAX_AGE_MS, STUCK_ALERT, CONTROL_TIMEOUT_MS, ControlError, createControl, createActivation, readRuntimeStatus,
} from '../src/activation.js';
import { createReconciler } from '../src/reconcile.js';
import { createStarter } from '../src/starter.js';
import { MARKER_FILE, readMarker } from '../src/shard-emitter.js';
import { ensureDeclarations, shardsDir } from '../src/shards.js';
import { fakeZylos, writeSlotHooks } from './fake/zylos.js';

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const A1 = U(41);
const A2 = U(42);
const A3 = U(43);
const S1 = sha('bundle-1');
const S2 = sha('bundle-2');
const S3 = sha('bundle-3');
const C10 = `/api/v1/orgs/${ORG}/agents/${AGENT}/reconcile`;
const recordAll = (outcome = 'recorded') => (req) => ({ status: 200, json: { results: req.json.items.map((_, index) => ({ index, outcome })) } });
const problem = (status, code) => ({ status, problem: { status, code } });

// The activation with a fake runtime status file, a fake control queue, a fake openmax turn check and the real urgent
// reconcile path against the fake market.
// The fake control queue delivers a request at once unless `deliver` is false; `statuses` maps control id to state.
async function harness(t, { turn = () => false, imAvailable = true, enqueueError = null, deliver = true, state: wrap = (s) => s } = {}) {
  const h = await pullHarness(t, { orgs: {} });
  const statusFile = path.join(tmpHome(), 'agent-status.json');
  const controls = [];
  const im = { available: () => imAvailable, openTurn: async () => { const r = turn(); if (r instanceof Error) throw r; return r; } };
  const reconcile = createReconciler({ api: h.api, state: h.state, orgs: h.orgs, skills: null, logger: h.logger, now: h.now });
  const statuses = new Map();
  const acks = [];
  const control = {
    async enqueue() {
      if (enqueueError) throw enqueueError;
      controls.push(h.clock.t);
      statuses.set(controls.length, deliver ? 'done' : 'pending');
      return { id: controls.length };
    },
    async get(id) { return statuses.get(id) ?? 'not_found'; },
    async ack(id) { acks.push(id); if (statuses.get(id) === 'pending') statuses.set(id, 'done'); },
  };
  const withEnqueue = (enqueue) => ({ ...control, enqueue });
  const make = (state = wrap(h.state), extra = {}) => createActivation({
    state, dataDir: h.dataDir, zylosDir: tmpHome(), logger: h.logger, im, flush: () => reconcile.flushUrgent(), now: h.now, statusFile, control, ...extra,
  });
  // Writes the status file, modified ageMs before the fake now.
  const status = (over = {}, ageMs = 1000) => {
    fs.writeFileSync(statusFile, JSON.stringify({ state: 'idle', active_tools: 0, idle_seconds: 600, ...over }));
    const at = (h.clock.t - ageMs) / 1000;
    fs.utimesSync(statusFile, at, at);
  };
  const adopt = (id, bundleSha, st = 'active') => h.state.update('adoptions', {}, (d) => { d[id] = { adoption_id: id, org_id: ORG, state: st, bundle_sha256: bundleSha }; });
  const marker = (items, at = h.clock.t) => fs.writeFileSync(path.join(h.dataDir, MARKER_FILE), JSON.stringify({ at: new Date(at).toISOString(), items }));
  const advance = (ms) => { h.clock.t += ms; };
  const reports = () => h.fake.requests.filter((r) => r.path === C10).map((r) => r.json.items);
  const pending = () => h.state.read('activation', null)?.pending ?? null;
  const alert = () => Boolean(h.state.read('status', { alerts: {} }).alerts[STUCK_ALERT]);
  // Ticks twice, one check interval apart, keeping the status file fresh.
  const twoTicks = async (a, over = {}) => {
    status(over);
    const first = await a.tick();
    advance(ACTIVATION_CHECK_MS);
    status(over);
    return [first, await a.tick()];
  };
  return { ...h, statusFile, controls, statuses, acks, control, withEnqueue, reconcile, make, status, adopt, marker, advance, reports, pending, alert, twoTicks };
}

const written = (f, a, id = A1, s = S1) => {
  f.adopt(id, s);
  a.recordWrite({ adoptionId: id, renderedSha: s, at: new Date(f.clock.t).toISOString() });
};

test('an idle Agent is asked for one new session after two agreeing samples; the request goes through the control queue', async (t) => {
  const f = await harness(t);
  const a = f.make();
  written(f, a);
  assert.deepEqual(await f.twoTicks(a), ['sampled', 'requested']);
  assert.equal(f.controls.length, 1);
  const p = f.pending();
  assert.equal(p.request_count, 1);
  assert.deepEqual(p.targets, [{ adoption_id: A1, rendered_sha256: S1 }]);
  f.advance(ACTIVATION_CHECK_MS);
  f.status();
  assert.equal(await a.tick(), 'waiting');
  assert.equal(f.controls.length, 1);
});

for (const [name, over, opts] of [
  ['state busy', { state: 'busy' }],
  ['state offline', { state: 'offline' }],
  ['state stopped', { state: 'stopped' }],
  ['a tool running', { active_tools: 1 }],
  ['active_tools missing', { active_tools: undefined }],
  ['idle less than 5 minutes', { idle_seconds: IDLE_MIN_SECONDS - 1 }],
  ['idle_seconds missing', { idle_seconds: undefined }],
  ['runtime health not ok', { health: 'rate_limited' }],
  ['an open OpenMax turn', {}, { turn: () => true }],
  ['the OpenMax turn state unreadable', {}, { turn: () => new Error('no activity store') }],
]) {
  test(`no new session is requested with ${name}`, async (t) => {
    const f = await harness(t, opts);
    const a = f.make();
    written(f, a);
    for (let i = 0; i < 4; i++) {
      f.status(over);
      assert.equal(await a.tick(), 'busy');
      f.advance(ACTIVATION_CHECK_MS);
    }
    assert.deepEqual(f.controls, []);
  });
}

test('no new session is requested with a missing or stale status file', async (t) => {
  const f = await harness(t);
  const a = f.make();
  written(f, a);
  assert.equal(await a.tick(), 'busy');
  for (let i = 0; i < 3; i++) {
    f.status({}, STATUS_MAX_AGE_MS);
    assert.equal(await a.tick(), 'busy');
    f.advance(ACTIVATION_CHECK_MS);
  }
  fs.writeFileSync(f.statusFile, '{not json');
  assert.equal(await a.tick(), 'busy');
  assert.deepEqual(f.controls, []);
  assert.equal(readRuntimeStatus(path.join(tmpHome(), 'none.json')), null);
});

test('without the openmax component only the runtime status counts', async (t) => {
  const f = await harness(t, { imAvailable: false, turn: () => true });
  const a = f.make();
  written(f, a);
  assert.deepEqual(await f.twoTicks(a), ['sampled', 'requested']);
});

test('two samples must be consecutive and agree: a busy sample or a long gap starts over', async (t) => {
  const f = await harness(t);
  const a = f.make();
  written(f, a);
  f.status();
  assert.equal(await a.tick(), 'sampled');
  f.advance(ACTIVATION_CHECK_MS);
  f.status({ state: 'busy' });
  assert.equal(await a.tick(), 'busy');
  f.advance(ACTIVATION_CHECK_MS);
  f.status();
  assert.equal(await a.tick(), 'sampled');
  f.advance(5 * ACTIVATION_CHECK_MS);
  f.status();
  assert.equal(await a.tick(), 'sampled');
  f.advance(ACTIVATION_CHECK_MS);
  f.status();
  assert.equal(await a.tick(), 'requested');
  assert.equal(f.controls.length, 1);
});

test('writes and uninstalls merge into one pending record (debounce) and share one request', async (t) => {
  const f = await harness(t);
  const a = f.make();
  written(f, a, A1, S1);
  f.advance(1000);
  written(f, a, A2, S2);
  f.advance(1000);
  a.recordRemove({ adoptionId: A3, at: new Date(f.clock.t).toISOString() });
  f.advance(1000);
  // A newer write of A1 replaces its target; an uninstall of A2 moves it to removed.
  written(f, a, A1, S3);
  a.recordRemove({ adoptionId: A2, at: new Date(f.clock.t).toISOString() });
  const p = f.pending();
  assert.deepEqual(p.targets, [{ adoption_id: A1, rendered_sha256: S3 }]);
  assert.deepEqual(p.removed, [A3, A2]);
  assert.equal(p.pending_since, '2026-10-16T00:00:00.000Z');
  assert.equal(p.written_at, new Date(f.clock.t).toISOString());
  // A write of a removed adoption takes it back out of removed.
  written(f, a, A3, S2);
  assert.deepEqual(f.pending().removed, [A2]);
  assert.deepEqual(await f.twoTicks(a), ['sampled', 'requested']);
  assert.equal(f.controls.length, 1);
  // The same change recorded again (a resent report) changes nothing.
  const before = JSON.stringify(f.pending());
  a.recordWrite({ adoptionId: A3, renderedSha: S2, at: '2026-10-16T00:00:01.000Z' });
  assert.equal(JSON.stringify(f.pending()), before);
});

test('cooldown: 30 minutes between requests followed by a session; daily cap: at most 4 a day', async (t) => {
  const f = await harness(t);
  const a = f.make();
  f.fake.script('POST', C10, ...Array.from({ length: DAILY_REQUESTS + 2 }, () => recordAll()));
  f.clock.t = Date.parse('2026-10-16T00:10:00Z');
  const times = [];
  for (let n = 0; n < DAILY_REQUESTS + 2; n++) {
    if (n > 0) {
      // The last request brought its session.
      f.advance(1000);
      f.marker([{ adoption_id: U(100 + n - 1), rendered_sha256: sha(n - 1) }]);
      assert.equal(await a.tick(), 'confirmed');
      f.advance(1000);
    }
    written(f, a, U(100 + n), sha(n));
    let r;
    for (let i = 0; i < 4000 && r !== 'requested'; i++) {
      f.status();
      r = await a.tick();
      if (r !== 'requested') f.advance(ACTIVATION_CHECK_MS);
    }
    times.push([n, r === 'requested' ? new Date(f.clock.t).toISOString() : null]);
    if (n === 0) continue;
    const gap = f.clock.t - f.controls.at(-2);
    if (r === 'requested') assert.ok(gap >= REQUEST_COOLDOWN_MS, `gap ${gap}`);
  }
  const perDay = {};
  for (const c of f.controls) perDay[new Date(c).toISOString().slice(0, 10)] = (perDay[new Date(c).toISOString().slice(0, 10)] ?? 0) + 1;
  assert.ok(Object.values(perDay).every((n) => n <= DAILY_REQUESTS), JSON.stringify(perDay));
  assert.equal(perDay['2026-10-16'], DAILY_REQUESTS);
  // The 5th request waits for the next UTC day.
  assert.ok(f.controls[DAILY_REQUESTS] >= Date.parse('2026-10-17T00:00:00Z'), JSON.stringify(times));
});

test('cooldown and daily cap hold over a restart', async (t) => {
  const f = await harness(t);
  written(f, f.make());
  assert.deepEqual(await f.twoTicks(f.make()), ['sampled', 'requested']);
  // Confirmed by a session, then a new write: the next request waits out the cooldown, also in a new process.
  f.advance(60_000);
  f.marker([{ adoption_id: A1, rendered_sha256: S1 }]);
  f.fake.script('POST', C10, recordAll());
  assert.equal(await f.make().tick(), 'confirmed');
  written(f, f.make(), A2, S2);
  const b = f.make();
  assert.deepEqual(await f.twoTicks(b), ['sampled', 'cooldown']);
  f.advance(REQUEST_COOLDOWN_MS);
  assert.deepEqual(await f.twoTicks(f.make()), ['sampled', 'requested']);
  assert.equal(f.controls.length, 2);
});

test('3 requests without a new session raise template_activation_stuck; a natural session still confirms', async (t) => {
  const f = await harness(t);
  const a = f.make();
  written(f, a);
  for (let n = 1; n <= MAX_REQUESTS; n++) {
    let r;
    for (let i = 0; i < 200 && r !== 'requested'; i++) {
      f.status();
      r = await a.tick();
      f.advance(ACTIVATION_CHECK_MS);
    }
    assert.equal(r, 'requested');
    assert.equal(f.pending().request_count, n);
    // No session within the confirm wait.
    f.status();
    assert.equal(await a.tick(), 'waiting');
    f.advance(CONFIRM_WAIT_MS);
  }
  f.advance(REQUEST_COOLDOWN_MS);
  f.status();
  assert.equal(await a.tick(), 'stuck');
  assert.equal(f.alert(), true);
  f.advance(24 * 60 * 60 * 1000);
  f.status();
  assert.equal(await a.tick(), 'stuck');
  assert.equal(f.controls.length, MAX_REQUESTS);
  assert.notEqual(f.pending(), null);
  f.marker([{ adoption_id: A1, rendered_sha256: S1 }]);
  f.fake.script('POST', C10, recordAll());
  assert.equal(await a.tick(), 'confirmed');
  assert.equal(f.alert(), false);
  assert.equal(f.pending(), null);
  assert.deepEqual(f.reports(), [[{ kind: 'template_activated', adoption_id: A1, rendered_sha256: S1 }]]);
});

test('a failed control enqueue is not counted and is tried again at the next idle check', async (t) => {
  const f = await harness(t, { enqueueError: new Error('control enqueue failed (exit 1)') });
  const a = f.make();
  written(f, a);
  assert.deepEqual(await f.twoTicks(a), ['sampled', 'enqueue_failed']);
  assert.equal(f.pending().request_count, 0);
  assert.equal(f.pending().requested_at, null);
  assert.deepEqual(f.state.read('activation', null).requests, []);
});

test('marker: every target sha listed and every removed adoption absent confirms; template_activated is reported at once', async (t) => {
  const f = await harness(t);
  const a = f.make();
  written(f, a, A1, S1);
  written(f, a, A2, S2);
  a.recordRemove({ adoptionId: A3, at: new Date(f.clock.t).toISOString() });
  f.fake.script('POST', C10, recordAll());
  // A marker from before the write says nothing.
  f.marker([{ adoption_id: A1, rendered_sha256: S1 }, { adoption_id: A2, rendered_sha256: S2 }], f.clock.t - 1);
  f.status({ state: 'busy' });
  assert.equal(await a.tick(), 'busy');
  f.advance(1000);
  f.marker([{ adoption_id: A2, rendered_sha256: S2 }, { adoption_id: A1, rendered_sha256: S1 }, { adoption_id: U(99), rendered_sha256: S3 }]);
  assert.equal(await a.tick(), 'confirmed');
  assert.deepEqual(f.reports(), [[
    { kind: 'template_activated', adoption_id: A1, rendered_sha256: S1 },
    { kind: 'template_activated', adoption_id: A2, rendered_sha256: S2 },
  ]]);
  assert.equal(f.pending(), null);
  assert.deepEqual(f.state.read('reconcile_urgent', null).items, []);
  assert.deepEqual(f.controls, []);
});

test('marker: a sha mismatch or a missing target is reported as template_inject_missing and not retried', async (t) => {
  const f = await harness(t);
  const a = f.make();
  written(f, a, A1, S1);
  written(f, a, A2, S2);
  f.fake.script('POST', C10, recordAll());
  f.advance(1000);
  f.marker([{ adoption_id: A1, rendered_sha256: S3 }]);
  assert.equal(await a.tick(), 'confirmed');
  assert.deepEqual(f.reports(), [[
    { kind: 'template_inject_missing', adoption_id: A1, rendered_sha256: S1 },
    { kind: 'template_inject_missing', adoption_id: A2, rendered_sha256: S2 },
  ]]);
  assert.equal(f.pending(), null);
  f.advance(CONFIRM_WAIT_MS);
  assert.deepEqual(await f.twoTicks(a), ['none', 'none']);
  assert.deepEqual(f.controls, []);
});

test('marker: a mismatch and a match are reported together, never both kinds for one adoption', async (t) => {
  const f = await harness(t);
  const a = f.make();
  written(f, a, A1, S1);
  written(f, a, A2, S2);
  f.fake.script('POST', C10, recordAll());
  f.advance(1000);
  f.marker([{ adoption_id: A1, rendered_sha256: S1 }, { adoption_id: A2, rendered_sha256: S3 }]);
  assert.equal(await a.tick(), 'confirmed');
  const [items] = f.reports();
  assert.deepEqual(items.map((i) => [i.kind, i.adoption_id]).sort(), [['template_activated', A1], ['template_inject_missing', A2]]);
});

test('uninstall: a removed adoption still listed is not confirmed; the next session that drops it is', async (t) => {
  const f = await harness(t);
  const a = f.make();
  a.recordRemove({ adoptionId: A3, at: new Date(f.clock.t).toISOString() });
  f.advance(1000);
  f.marker([{ adoption_id: A3, rendered_sha256: S3 }]);
  f.status({ state: 'busy' });
  assert.equal(await a.tick(), 'unconfirmed');
  // The used-up marker is not read again: the idle checks go on.
  assert.equal(await a.tick(), 'busy');
  f.advance(1000);
  f.marker([]);
  assert.equal(await a.tick(), 'confirmed');
  assert.equal(f.pending(), null);
  assert.deepEqual(f.reports(), []);
});

test('a target revoked or replaced meanwhile is dropped from the record', async (t) => {
  const f = await harness(t);
  const a = f.make();
  written(f, a, A1, S1);
  written(f, a, A2, S2);
  f.adopt(A1, S1, 'quarantined');
  f.status({ state: 'busy' });
  assert.equal(await a.tick(), 'busy');
  assert.deepEqual(f.pending().targets, [{ adoption_id: A2, rendered_sha256: S2 }]);
  f.adopt(A2, S3);
  assert.equal(await a.tick(), 'none');
  assert.equal(f.pending(), null);
});

test('readMarker accepts only {at, items[]}', () => {
  const d = tmpHome();
  const put = (v) => fs.writeFileSync(path.join(d, MARKER_FILE), typeof v === 'string' ? v : JSON.stringify(v));
  assert.equal(readMarker(d), null);
  put('{');
  assert.equal(readMarker(d), null);
  put({ at: 'x', items: [] });
  assert.equal(readMarker(d), null);
  put({ at: '2026-10-16T00:00:00Z', items: {} });
  assert.equal(readMarker(d), null);
  put({ at: '2026-10-16T00:00:00Z', items: [null, 1, { adoption_id: A1, rendered_sha256: S1 }] });
  assert.deepEqual(readMarker(d), { at: Date.parse('2026-10-16T00:00:00Z'), items: [{ adoption_id: A1, rendered_sha256: S1 }] });
});

test('restart: the pending record, its request and the history survive; the next process confirms', async (t) => {
  const f = await harness(t);
  written(f, f.make());
  // Samples are not carried over a restart.
  f.status();
  assert.equal(await f.make().tick(), 'sampled');
  f.advance(ACTIVATION_CHECK_MS);
  f.status();
  assert.equal(await f.make().tick(), 'sampled');
  const a = f.make();
  assert.deepEqual(await f.twoTicks(a), ['sampled', 'requested']);
  // A new process within the confirm wait waits instead of asking again.
  f.advance(ACTIVATION_CHECK_MS);
  f.status();
  assert.equal(await f.make().tick(), 'waiting');
  f.advance(60_000);
  f.marker([{ adoption_id: A1, rendered_sha256: S1 }]);
  f.fake.script('POST', C10, recordAll());
  assert.equal(await f.make().tick(), 'confirmed');
  assert.equal(f.controls.length, 1);
  assert.equal(f.reports().length, 1);
});

test('a natural session confirms without any request', async (t) => {
  const f = await harness(t);
  const a = f.make();
  written(f, a);
  f.advance(1000);
  f.marker([{ adoption_id: A1, rendered_sha256: S1 }]);
  f.fake.script('POST', C10, recordAll());
  assert.equal(await a.tick(), 'confirmed');
  assert.deepEqual(f.controls, []);
  assert.equal(f.reports().length, 1);
});

test('immediate report: an undelivered report survives a restart and is resent by the next round; skipped is final', async (t) => {
  const f = await harness(t);
  const a = f.make();
  written(f, a);
  f.advance(1000);
  f.marker([{ adoption_id: A1, rendered_sha256: S1 }]);
  f.fake.script('POST', C10, problem(503, 'UNAVAILABLE'), recordAll('skipped'));
  assert.equal(await a.tick(), 'confirmed');
  assert.equal(f.reports().length, 1);
  assert.equal(f.state.read('reconcile_urgent', null).items.length, 1);
  assert.equal(f.pending(), null);
  // A new process: the poll round's reconcile step sends what is queued first.
  const r2 = createReconciler({ api: f.api, state: f.state, orgs: f.orgs, skills: null, logger: f.logger, now: f.now, every: Infinity });
  await r2.flushUrgent();
  assert.equal(f.reports().length, 2);
  assert.deepEqual(f.reports()[0], f.reports()[1]);
  assert.deepEqual(f.state.read('reconcile_urgent', null).items, []);
  await r2.flushUrgent();
  assert.equal(f.reports().length, 2);
});

test('immediate report: a refused batch is not resent', async (t) => {
  const f = await harness(t);
  const a = f.make();
  written(f, a);
  f.advance(1000);
  f.marker([{ adoption_id: A1, rendered_sha256: S1 }]);
  f.fake.script('POST', C10, problem(403, 'FORBIDDEN'));
  assert.equal(await a.tick(), 'confirmed');
  await f.reconcile.flushUrgent();
  assert.equal(f.reports().length, 1);
  assert.deepEqual(f.state.read('reconcile_urgent', null).items, []);
});

test('welcome: an Agent idle 30 s with no open turn is asked at once and the message is held until the session', async (t) => {
  const f = await harness(t);
  const a = f.make();
  written(f, a);
  f.status({ idle_seconds: 30 });
  assert.equal(await a.welcome(A1), f.clock.t + WELCOME_MAX_HOLD_MS);
  assert.equal(f.controls.length, 1);
  // Asked again (a resent report) while the request is on its way: no second request, same kind of hold.
  assert.equal(await a.welcome(A1), f.clock.t + WELCOME_MAX_HOLD_MS);
  assert.equal(f.controls.length, 1);
  assert.equal(a.isPending(A1), true);
  assert.equal(a.isPending(A2), false);
});

for (const [name, over, opts] of [
  ['idle under 30 s', { idle_seconds: 29 }],
  ['busy', { state: 'busy' }],
  ['an open turn', {}, { turn: () => true }],
]) {
  test(`welcome: ${name} means no request now; the message is held until the template is in a session`, async (t) => {
    const f = await harness(t, opts);
    const a = f.make();
    written(f, a);
    f.status(over);
    assert.equal(await a.welcome(A1), f.clock.t + WELCOME_MAX_HOLD_MS);
    assert.deepEqual(f.controls, []);
    assert.deepEqual(f.pending().welcome, [A1]);
  });
}

for (const [name, opts, write] of [
  ['no runtime status', {}, false],
  ['a stale runtime status', {}, 'stale'],
  ['the OpenMax turn state unreadable', { turn: () => new Error('no activity store') }, true],
]) {
  test(`welcome: ${name} means no request and no wait`, async (t) => {
    const f = await harness(t, opts);
    const a = f.make();
    written(f, a);
    if (write === 'stale') f.status({ idle_seconds: 30 }, STATUS_MAX_AGE_MS);
    else if (write) f.status({ idle_seconds: 30 });
    assert.equal(await a.welcome(A1), null);
    assert.deepEqual(f.controls, []);
    assert.equal(f.pending().welcome, undefined);
  });
}

test('welcome: an adoption without a pending write is not held', async (t) => {
  const f = await harness(t);
  f.status();
  assert.equal(await f.make().welcome(A1), null);
});

test('the control queue: enqueue (new-session text, held until idle, no ack suffix, 6 h ack deadline, state honoured), get, ack', async () => {
  const calls = [];
  const answer = { enqueue: [null, 'OK: enqueued control 7\n', ''], get: [null, 'status=pending\n', ''], ack: [null, 'OK: control 7 marked as done\n', ''] };
  const run = (file, args, opts, cb) => { calls.push({ file, args, opts }); cb(...answer[args[1]]); };
  const c = createControl('/z', { run });
  assert.deepEqual(await c.enqueue(), { id: 7 });
  assert.equal(calls[0].file, process.execPath);
  assert.deepEqual(calls[0].args, [
    '/z/.claude/skills/comm-bridge/scripts/c4-control.js', 'enqueue', '--content', NEW_SESSION_TEXT, '--block-queue-until-idle', '--no-ack-suffix',
    '--ack-deadline', String(CONTROL_ACK_DEADLINE_S),
  ]);
  assert.equal(CONTROL_ACK_DEADLINE_S, 6 * 60 * 60);
  assert.equal(calls[0].opts.timeout, CONTROL_TIMEOUT_MS);
  assert.match(NEW_SESSION_TEXT, /^Agent Market templates were updated .* Start a new session now with the new-session skill\. Do not check whether one is needed\.$/);
  assert.doesNotMatch(NEW_SESSION_TEXT, /please|\?/);
  assert.ok(!calls[0].args.includes('--bypass-state'));
  assert.equal(await c.get(7), 'pending');
  assert.deepEqual(calls[1].args.slice(1), ['get', '--id', '7']);
  await c.ack(7);
  assert.deepEqual(calls[2].args.slice(1), ['ack', '--id', '7']);
  const fail = (err, stdout = '', stderr = '') => createControl('/z', { run: (f, a, o, cb) => cb(err, stdout, stderr) });
  const exit1 = Object.assign(new Error('x'), { code: 1 });
  await assert.rejects(fail(exit1, '', 'Error: boom').enqueue(), (e) => e instanceof ControlError && !e.unknown && /exit 1/.test(e.message));
  await assert.rejects(fail(Object.assign(new Error('t'), { killed: true, signal: 'SIGTERM' })).enqueue(), (e) => e.unknown && /timed out/.test(e.message));
  await assert.rejects(fail(null, 'nothing').enqueue(), (e) => e.unknown && /no readable confirmation/.test(e.message));
  assert.equal(await fail(exit1, '', 'Error: not found\n').get(9), 'not_found');
  await assert.rejects(fail(exit1, '', 'Error: db locked').get(9), ControlError);
});

// Crash safety: a crash at any state write around the confirmation or the report neither loses nor duplicates the
// template_activated report (one identical report; a resend only when the crash came after the market took it).
const at = (kind, name, when) => (k, n) => (k === kind && n === name ? when : false);
for (const [name, point, sentBeforeCrash] of [
  ['before the report is queued', at('update', 'reconcile_urgent', 'before'), false],
  ['after the report is queued', at('update', 'reconcile_urgent', 'after'), false],
  ['before the record is cleared', at('update', 'activation', 'before'), false],
  ['after the record is cleared', at('update', 'activation', 'after'), false],
]) {
  test(`crash ${name}: the restarted client reports template_activated exactly once`, async (t) => {
    const f = await harness(t);
    written(f, f.make());
    f.advance(1000);
    f.marker([{ adoption_id: A1, rendered_sha256: S1 }]);
    f.fake.script('POST', C10, recordAll(), recordAll());
    // Crash at the first matching write after the confirmation starts.
    let armed = true;
    const crashing = crashingState(f.state, (k, n) => (armed ? point(k, n) : false));
    await assert.rejects(f.make(crashing).tick(), Crash);
    armed = false;
    assert.equal(f.reports().length, sentBeforeCrash ? 1 : 0);
    const r2 = createReconciler({ api: f.api, state: f.state, orgs: f.orgs, skills: null, logger: f.logger, now: f.now });
    const b = createActivation({
      state: f.state, dataDir: f.dataDir, zylosDir: tmpHome(), logger: f.logger, flush: () => r2.flushUrgent(), now: f.now, statusFile: f.statusFile,
      control: { enqueue: async () => { throw new Error('not expected'); }, get: async () => 'not_found', ack: async () => {} },
    });
    await b.tick();
    await r2.flushUrgent();
    await b.tick();
    assert.deepEqual(f.reports(), [[{ kind: 'template_activated', adoption_id: A1, rendered_sha256: S1 }]]);
    assert.equal(f.pending(), null);
    assert.deepEqual(f.state.read('reconcile_urgent', null).items, []);
  });
}

test('crash after the market took the report, before it was settled: resent once, unchanged', async (t) => {
  const f = await harness(t);
  written(f, f.make());
  f.advance(1000);
  f.marker([{ adoption_id: A1, rendered_sha256: S1 }]);
  f.fake.script('POST', C10, recordAll(), recordAll());
  let seen = 0;
  // The second reconcile_urgent update is the settle after the answer.
  const crashing = crashingState(f.state, (k, n) => (k === 'update' && n === 'reconcile_urgent' && ++seen === 2 ? 'before' : false));
  const r1 = createReconciler({ api: f.api, state: crashing, orgs: f.orgs, skills: null, logger: f.logger, now: f.now });
  const a = createActivation({
    state: crashing, dataDir: f.dataDir, zylosDir: tmpHome(), logger: f.logger, flush: () => r1.flushUrgent(), now: f.now, statusFile: f.statusFile,
    control: f.control,
  });
  await a.tick();
  assert.equal(f.reports().length, 1);
  const r2 = createReconciler({ api: f.api, state: f.state, orgs: f.orgs, skills: null, logger: f.logger, now: f.now });
  await r2.flushUrgent();
  await r2.flushUrgent();
  assert.equal(f.reports().length, 2);
  assert.deepEqual(f.reports()[0], f.reports()[1]);
  assert.deepEqual(f.state.read('reconcile_urgent', null).items, []);
});

for (const [name, when, controlsAfterCrash] of [
  ['before the request is enqueued', 'before', 0],
  ['after the request is enqueued', 'after', 1],
]) {
  test(`crash ${name}: no second request within the confirm wait, and one more only after it`, async (t) => {
    const f = await harness(t);
    written(f, f.make());
    // 'before': killed right after the request was counted; 'after': killed once the control queue took it.
    let killed = false;
    const crashing = crashingState(f.state, (k, n) => (killed ? 'before' : when === 'before' && k === 'update' && n === 'activation' ? 'after' : false));
    const a = f.make(crashing, {
      control: f.withEnqueue(async () => {
        f.controls.push(f.clock.t);
        killed = true;
        throw new Crash('killed');
      }),
    });
    f.status();
    await a.tick();
    f.advance(ACTIVATION_CHECK_MS);
    f.status();
    await assert.rejects(a.tick(), Crash);
    assert.equal(f.controls.length, controlsAfterCrash);
    assert.equal(f.pending().request_count, 1);
    const b = f.make();
    for (let i = 0; i < CONFIRM_WAIT_MS / ACTIVATION_CHECK_MS - 1; i++) {
      f.advance(ACTIVATION_CHECK_MS);
      f.status();
      await b.tick();
    }
    assert.equal(f.controls.length, controlsAfterCrash);
    // No session followed the counted request: one more after the confirm wait, without the cooldown.
    f.advance(ACTIVATION_CHECK_MS);
    assert.deepEqual(await f.twoTicks(b), ['sampled', 'requested']);
    assert.equal(f.controls.length, controlsAfterCrash + 1);
    assert.equal(f.pending().request_count, 2);
  });
}

test('the marker is compared on the rendered bundle sha: a session listing another sha is inject missing', async (t) => {
  const f = await harness(t);
  const a = f.make();
  written(f, a, A1, S1);
  f.advance(1000);
  // e.g. the inject.md sha instead of the bundle sha.
  f.marker([{ adoption_id: A1, rendered_sha256: sha('# Demo\n') }]);
  f.fake.script('POST', C10, recordAll());
  assert.equal(await a.tick(), 'confirmed');
  assert.deepEqual(f.reports(), [[{ kind: 'template_inject_missing', adoption_id: A1, rendered_sha256: S1 }]]);
});

test('an inject_missing reported for an adoption drops its waiting activation', async (t) => {
  const f = await harness(t);
  const a = f.make();
  written(f, a, A1, S1);
  written(f, a, A2, S2);
  a.dropTarget(A1);
  assert.deepEqual(f.pending().targets, [{ adoption_id: A2, rendered_sha256: S2 }]);
  a.dropTarget(A2);
  assert.equal(f.pending(), null);
  f.advance(1000);
  f.marker([{ adoption_id: A1, rendered_sha256: S1 }]);
  assert.equal(await a.tick(), 'none');
  assert.deepEqual(f.reports(), []);
});

test('a request still queued is never stacked: no new request until it left the queue, then the wait counts from delivery', async (t) => {
  const f = await harness(t, { deliver: false });
  const a = f.make();
  written(f, a);
  assert.deepEqual(await f.twoTicks(a), ['sampled', 'requested']);
  assert.equal(f.pending().control_id, 1);
  // Hours later, still pending in the control queue (e.g. the runtime held it): waiting, nothing new.
  for (let i = 0; i < 10; i++) {
    f.advance(REQUEST_COOLDOWN_MS);
    f.status();
    assert.equal(await a.tick(), 'waiting');
  }
  assert.equal(await a.welcome(A1), f.clock.t + WELCOME_MAX_HOLD_MS);
  assert.equal(f.controls.length, 1);
  // Delivered: given CONFIRM_WAIT_MS from then.
  f.statuses.set(1, 'done');
  f.status();
  assert.equal(await a.tick(), 'waiting');
  assert.equal(f.pending().control_id, null);
  f.advance(CONFIRM_WAIT_MS - ACTIVATION_CHECK_MS);
  f.status();
  assert.equal(await a.tick(), 'waiting');
  f.advance(2 * ACTIVATION_CHECK_MS);
  // The held starter message asks at once on its own budget.
  assert.deepEqual(await f.twoTicks(a), ['requested', 'waiting']);
  assert.equal(f.controls.length, 2);
  assert.equal(f.state.read('activation', null).welcome_requests.length, 1);
});

test('a control state that cannot be read counts as still queued', async (t) => {
  const f = await harness(t, { deliver: false });
  const a = f.make();
  written(f, a);
  assert.deepEqual(await f.twoTicks(a), ['sampled', 'requested']);
  const b = f.make(f.state, { control: { ...f.control, get: async () => { throw new ControlError('control status unavailable (exit 1)'); } } });
  f.advance(REQUEST_COOLDOWN_MS + CONFIRM_WAIT_MS);
  assert.deepEqual(await f.twoTicks(b), ['waiting', 'waiting']);
  assert.equal(f.controls.length, 1);
});

test('a session confirming the record withdraws its request still queued', async (t) => {
  const f = await harness(t, { deliver: false });
  const a = f.make();
  written(f, a);
  assert.deepEqual(await f.twoTicks(a), ['sampled', 'requested']);
  f.advance(1000);
  f.marker([{ adoption_id: A1, rendered_sha256: S1 }]);
  f.fake.script('POST', C10, recordAll());
  assert.equal(await a.tick(), 'confirmed');
  assert.deepEqual(f.acks, [1]);
  assert.equal(f.statuses.get(1), 'done');
});

test('a timed-out enqueue stays counted and is not repeated before the confirm wait', async (t) => {
  let attempts = 0;
  const f = await harness(t);
  const timedOut = f.withEnqueue(async () => { attempts += 1; throw new ControlError('control enqueue timed out', { unknown: true }); });
  const a = f.make(f.state, { control: timedOut });
  written(f, a);
  assert.deepEqual(await f.twoTicks(a), ['sampled', 'requested']);
  const p = f.pending();
  assert.equal(p.request_count, 1);
  assert.equal(p.control_id, null);
  assert.equal(f.state.read('activation', null).requests.length, 1);
  for (let i = 0; i < CONFIRM_WAIT_MS / ACTIVATION_CHECK_MS - 1; i++) {
    f.advance(ACTIVATION_CHECK_MS);
    f.status();
    assert.notEqual(await a.tick(), 'requested');
  }
  assert.equal(attempts, 1);
});

test('welcome and tick at the same time give exactly one control', async (t) => {
  const f = await harness(t);
  let release;
  const gate = new Promise((r) => { release = r; });
  const slow = f.withEnqueue(async () => {
    await gate;
    f.controls.push(f.clock.t);
    return { id: f.controls.length };
  });
  const a = f.make(f.state, { control: slow });
  written(f, a);
  f.status();
  assert.equal(await a.tick(), 'sampled');
  f.advance(ACTIVATION_CHECK_MS);
  f.status();
  const both = Promise.all([a.tick(), a.welcome(A1)]);
  await new Promise((r) => { setImmediate(r); });
  release();
  const [r, hold] = await both;
  assert.equal(f.controls.length, 1);
  // Whichever came first made the request; the other one saw it.
  assert.ok(['requested', 'waiting', 'sampled'].includes(r), r);
  assert.equal(hold, f.clock.t + WELCOME_MAX_HOLD_MS);
  assert.equal(f.pending().request_count, 1);
  // Counted once, in the list of whichever made it.
  const doc = f.state.read('activation', null);
  assert.equal(doc.requests.length + doc.welcome_requests.length, 1);
});

test('a refused enqueue does not restore an old request count over the reset of a write merged meanwhile', async (t) => {
  const f = await harness(t);
  const a = f.make();
  written(f, a);
  // Two requests made and delivered, no session.
  for (let n = 0; n < 2; n++) {
    assert.deepEqual(await f.twoTicks(a), ['sampled', 'requested']);
    f.status();
    await a.tick();
    f.advance(REQUEST_COOLDOWN_MS + CONFIRM_WAIT_MS);
  }
  assert.equal(f.pending().request_count, 2);
  const b = f.make(f.state, {
    control: f.withEnqueue(async () => {
      written(f, b, A2, S2);
      throw new ControlError('control enqueue failed (exit 1)');
    }),
  });
  assert.deepEqual(await f.twoTicks(b), ['sampled', 'enqueue_failed']);
  const p = f.pending();
  assert.equal(p.request_count, 0);
  assert.deepEqual(p.targets.map((x) => x.adoption_id), [A1, A2]);
});

test('a record pending for 24 hours raises its own alert, cleared when it is confirmed', async (t) => {
  const f = await harness(t);
  const a = f.make();
  written(f, a);
  const alerts = () => f.state.read('status', { alerts: {} }).alerts;
  f.status({ state: 'busy' });
  assert.equal(await a.tick(), 'busy');
  assert.equal(alerts()[PENDING_ALERT], undefined);
  f.advance(PENDING_ALERT_MS);
  f.status({ state: 'busy' });
  assert.equal(await a.tick(), 'busy');
  assert.ok(alerts()[PENDING_ALERT]);
  assert.equal(alerts()[STUCK_ALERT], undefined);
  f.marker([{ adoption_id: A1, rendered_sha256: S1 }]);
  f.fake.script('POST', C10, recordAll());
  f.advance(1000);
  assert.equal(await a.tick(), 'confirmed');
  assert.equal(alerts()[PENDING_ALERT], undefined);
});

test('an unreadable OpenMax turn state is warned about once and counts as busy', async (t) => {
  const f = await harness(t, { turn: () => new Error('Cannot find module run-store.js') });
  const a = f.make();
  written(f, a);
  for (let i = 0; i < 3; i++) {
    f.status();
    assert.equal(await a.tick(), 'busy');
  }
  assert.equal(f.lines.filter((l) => /OpenMax turn state unreadable/.test(l) && /WARN/i.test(l)).length, 1);
});

test('a rewrite of the bundle the current session already shows needs no session and is reported at once', async (t) => {
  const f = await harness(t);
  const a = f.make();
  f.adopt(A1, S1);
  f.marker([{ adoption_id: A1, rendered_sha256: S1 }]);
  f.advance(1000);
  f.fake.script('POST', C10, recordAll());
  assert.equal(a.recordWrite({ adoptionId: A1, renderedSha: S1, at: new Date(f.clock.t).toISOString() }), 'active');
  assert.equal(f.pending(), null);
  await f.reconcile.flushUrgent();
  assert.deepEqual(f.reports(), [[{ kind: 'template_activated', adoption_id: A1, rendered_sha256: S1 }]]);
  assert.deepEqual(await f.twoTicks(a), ['none', 'none']);
  assert.deepEqual(f.controls, []);
  // Another bundle is a change.
  f.adopt(A1, S2);
  assert.equal(a.recordWrite({ adoptionId: A1, renderedSha: S2, at: new Date(f.clock.t).toISOString() }), 'pending');
  assert.deepEqual(f.pending().targets, [{ adoption_id: A1, rendered_sha256: S2 }]);
});

test('requests are one at a time: two starter messages and an idle check at once give one control', async (t) => {
  const f = await harness(t);
  let release;
  const gate = new Promise((r) => { release = r; });
  const a = f.make(f.state, {
    control: f.withEnqueue(async () => {
      await gate;
      f.controls.push(f.clock.t);
      return { id: f.controls.length };
    }),
  });
  written(f, a, A1, S1);
  written(f, a, A2, S2);
  f.status();
  const all = Promise.all([a.welcome(A1), a.welcome(A2), a.tick(), a.tick()]);
  await new Promise((r) => { setImmediate(r); });
  release();
  const [h1, h2] = await all;
  assert.equal(f.controls.length, 1);
  assert.equal(h1, f.clock.t + WELCOME_MAX_HOLD_MS);
  assert.equal(h2, f.clock.t + WELCOME_MAX_HOLD_MS);
  assert.equal(f.pending().request_count, 1);
});

for (const [name, stuckState] of [
  ['left running', (f) => { f.statuses.set(1, 'running'); return f.control; }],
  ['unreadable', (f) => ({ ...f.control, get: async () => { throw new ControlError('control status unavailable (exit 1)'); } })],
]) {
  test(`a request ${name} for good is given up after a day and the next request follows`, async (t) => {
    const f = await harness(t, { deliver: false });
    written(f, f.make());
    assert.deepEqual(await f.twoTicks(f.make()), ['sampled', 'requested']);
    const a = f.make(f.state, { control: stuckState(f) });
    for (let i = 0; i < 47; i++) {
      f.advance(REQUEST_COOLDOWN_MS);
      f.status();
      assert.equal(await a.tick(), 'waiting');
    }
    assert.equal(f.controls.length, 1);
    f.advance(REQUEST_COOLDOWN_MS);
    const r = await f.twoTicks(a);
    assert.ok(r.includes('requested'), JSON.stringify(r));
    assert.ok(f.acks.includes(1), 'the stale request is acked');
    assert.equal(f.controls.length, 2);
    assert.equal(f.pending().request_count, 2);
    assert.ok(CONTROL_MAX_AGE_MS <= 24 * 60 * 60 * 1000);
  });
}

test('a request left running at the last allowed request ends in the stuck alert, not in waiting for ever', async (t) => {
  const f = await harness(t, { deliver: false });
  const a = f.make();
  written(f, a);
  for (let n = 1; n <= MAX_REQUESTS; n++) {
    let r;
    for (let i = 0; i < 400 && r !== 'requested'; i++) {
      f.status();
      r = await a.tick();
      f.advance(ACTIVATION_CHECK_MS);
    }
    assert.equal(r, 'requested');
    f.statuses.set(n, n < MAX_REQUESTS ? 'done' : 'running');
    f.status();
    await a.tick();
    f.advance(CONFIRM_WAIT_MS + REQUEST_COOLDOWN_MS);
  }
  f.status();
  assert.equal(await a.tick(), 'waiting');
  f.advance(CONTROL_MAX_AGE_MS);
  f.status();
  assert.equal(await a.tick(), 'stuck');
  assert.equal(f.alert(), true);
  assert.equal(f.controls.length, MAX_REQUESTS);
});

test('confirm withdraws the request recorded at the time of its update, also one made after the record was read', async (t) => {
  const f = await harness(t, { deliver: false });
  written(f, f.make());
  f.advance(1000);
  f.marker([{ adoption_id: A1, rendered_sha256: S1 }]);
  f.fake.script('POST', C10, recordAll());
  f.statuses.set(5, 'pending');
  // A starter message's request lands right after the check read the record (reads: start-up, passive targets, record).
  let reads = 0;
  const racing = {
    ...f.state,
    read: (name, fb) => {
      const r = f.state.read(name, fb);
      if (name === 'activation' && ++reads === 3) {
        f.state.update('activation', {}, (d) => { Object.assign(d.pending, { control_id: 5, requested_at: new Date(f.clock.t).toISOString() }); return d; });
      }
      return r;
    },
  };
  assert.equal(await f.make(racing).tick(), 'confirmed');
  assert.deepEqual(f.acks, [5]);
  assert.equal(f.statuses.get(5), 'done');
});

// Starter messages wired to the activation as templates.js does: welcome() decides the hold, the job is queued with it,
// and the real starter claims and sends once its template is confirmed (or the hold ends). The IM is a fake that
// records the client message ids sent.
const ADOPTER = '0b6f4f3e-2222-4c2a-9d1e-aaaaaaaaaaaa';
const starterPath = (id, op) => `/api/v1/orgs/${ORG}/agents/${AGENT}/adoptions/${id}:${op}`;
function starterOf(f, a) {
  const sent = [];
  const im = {
    available: () => true,
    createDm: async () => 'cv-1',
    getConversation: async () => ({ id: 'cv-1', type: 'DM' }),
    memberList: async () => [{ member_id: AGENT, display_name: 'Agent' }, { member_id: ADOPTER, display_name: 'Ann' }],
    supportsNoRun: () => true,
    supportsStructured: () => true,
    sendStructured: async (p) => { sent.push(p.clientMsgId); return { id: 'm' }; },
    sendText: async (p) => { sent.push(p.clientMsgId); return { id: 'm' }; },
  };
  const content = async () => ({ templateName: 'Weekly', firstGuide: 'Tell me your projects.', starterTasks: [{ title: 'Report', prompt: 'Write it' }] });
  const starter = createStarter({ api: f.api, state: f.state, orgs: f.orgs, logger: f.logger, im, now: f.now, content, activation: a });
  const adopted = async (id, s) => {
    written(f, a, id, s);
    f.fake.script('POST', starterPath(id, 'claim-starter'), {
      status: 200, json: { adoption_id: id, result: 'claimed', starter_state: 'claimed', claimed_at: new Date(f.clock.t).toISOString() },
    });
    f.fake.script('POST', starterPath(id, 'mark-starter-shown'), {
      status: 200, json: { adoption_id: id, result: 'sent', result_at: new Date(f.clock.t).toISOString(), starter_tasks_shown_at: new Date(f.clock.t).toISOString() },
    });
    const holdUntil = await a.welcome(id);
    starter.enqueue({ orgId: ORG, adoptionId: id, adoptedBy: ADOPTER, holdUntil });
    return holdUntil;
  };
  const claims = () => f.fake.requests.filter((r) => r.path.endsWith(':claim-starter')).length;
  return { starter, sent, adopted, claims };
}

// A session that shows the adoptions starts now and the check confirms it.
async function session(f, a, items) {
  f.advance(1000);
  f.marker(items.map(([adoption_id, rendered_sha256]) => ({ adoption_id, rendered_sha256 })));
  f.fake.script('POST', C10, recordAll());
  assert.equal(await a.tick(), 'confirmed');
}

test('welcome: 10 minutes after a request, a new adoption is asked for at once, not held back by the 30-minute cooldown', async (t) => {
  const f = await harness(t);
  const a = f.make();
  written(f, a, A1, S1);
  assert.deepEqual(await f.twoTicks(a), ['sampled', 'requested']);
  await session(f, a, [[A1, S1]]);
  f.advance(10 * 60 * 1000);
  written(f, a, A2, S2);
  f.status({ idle_seconds: 30 });
  assert.equal(await a.welcome(A2), f.clock.t + WELCOME_MAX_HOLD_MS);
  assert.equal(f.controls.length, 2);
  const doc = f.state.read('activation', null);
  assert.equal(doc.requests.length, 1);
  assert.equal(doc.welcome_requests.length, 1);
});

test('welcome: two adoptions within 2 minutes share one new-session request; both messages go out after its session', async (t) => {
  const f = await harness(t);
  const a = f.make();
  const s = starterOf(f, a);
  f.status({ idle_seconds: 30 });
  assert.equal(await s.adopted(A1, S1), f.clock.t + WELCOME_MAX_HOLD_MS);
  f.advance(60 * 1000);
  f.status({ idle_seconds: 30 });
  // The first request has not brought its session yet: the second adoption rides on it.
  assert.equal(await s.adopted(A2, S2), f.clock.t + WELCOME_MAX_HOLD_MS);
  assert.equal(f.controls.length, 1);
  await s.starter.runAll();
  assert.deepEqual(s.sent, []);
  await session(f, a, [[A1, S1], [A2, S2]]);
  await s.starter.runWaiting();
  assert.deepEqual(s.sent, [`mkt-starter-${A1}`, `mkt-starter-${A2}`]);
  assert.equal(f.controls.length, 1);
  assert.equal(f.state.read('activation', null).welcome_requests.length, 1);
});

test('welcome: inside the 2-minute interval with no request to join, the message is held and the session asked for after it', async (t) => {
  const f = await harness(t);
  const a = f.make();
  const s = starterOf(f, a);
  f.status({ idle_seconds: 30 });
  await s.adopted(A1, S1);
  await session(f, a, [[A1, S1]]);
  await s.starter.runWaiting();
  assert.deepEqual(s.sent, [`mkt-starter-${A1}`]);
  // The first session already started, so it cannot carry A2: a new request is needed but the interval holds it.
  f.advance(30 * 1000);
  f.status({ idle_seconds: 30 });
  assert.equal(await s.adopted(A2, S2), f.clock.t + WELCOME_MAX_HOLD_MS);
  assert.equal(f.controls.length, 1);
  assert.deepEqual(f.pending().welcome, [A2]);
  const t0 = f.state.read('activation', null).welcome_requests[0];
  while (f.clock.t - Date.parse(t0) < WELCOME_REQUEST_INTERVAL_MS - ACTIVATION_CHECK_MS) {
    f.advance(ACTIVATION_CHECK_MS);
    f.status({ idle_seconds: 30 });
    assert.equal(await a.tick(), 'busy');
    await s.starter.runWaiting();
  }
  f.advance(ACTIVATION_CHECK_MS);
  f.status({ idle_seconds: 30 });
  assert.equal(await a.tick(), 'requested');
  assert.equal(f.controls.length, 2);
  assert.deepEqual(s.sent, [`mkt-starter-${A1}`]);
  await session(f, a, [[A1, S1], [A2, S2]]);
  await s.starter.runWaiting();
  assert.deepEqual(s.sent, [`mkt-starter-${A1}`, `mkt-starter-${A2}`]);
});

test('welcome: with the daily starter cap reached the message is held and sent once after the session', async (t) => {
  const f = await harness(t);
  f.advance(12 * 60 * 60 * 1000);
  const today = Array.from({ length: DAILY_WELCOME_REQUESTS }, (_, i) => new Date(f.clock.t - (i + 1) * 10 * 60 * 1000).toISOString());
  f.state.update('activation', {}, (d) => ({ ...d, welcome_requests: today }));
  const a = f.make();
  const s = starterOf(f, a);
  f.status({ idle_seconds: 30 });
  assert.equal(await s.adopted(A1, S1), f.clock.t + WELCOME_MAX_HOLD_MS);
  assert.deepEqual(f.controls, []);
  // Busy for 10 minutes: no request, no claim, no send.
  for (let i = 0; i < 20; i++) {
    f.advance(ACTIVATION_CHECK_MS);
    f.status({ state: 'busy' });
    assert.equal(await a.tick(), 'busy');
    await s.starter.runWaiting();
  }
  assert.equal(s.claims(), 0);
  assert.deepEqual(s.sent, []);
  // The automatic rules still apply: an Agent idle 5 minutes is asked on the automatic budget.
  assert.deepEqual(await f.twoTicks(a), ['sampled', 'requested']);
  const doc = f.state.read('activation', null);
  assert.equal(doc.requests.length, 1);
  assert.equal(doc.welcome_requests.length, DAILY_WELCOME_REQUESTS);
  await s.starter.runWaiting();
  assert.deepEqual(s.sent, []);
  await session(f, a, [[A1, S1]]);
  await s.starter.runWaiting();
  await s.starter.runAll();
  assert.deepEqual(s.sent, [`mkt-starter-${A1}`]);
  assert.equal(s.claims(), 1);
  assert.deepEqual(f.state.read('starters', {}), {});
});

test('welcome: starter requests leave the automatic budget alone, and the automatic budget does not block them', async (t) => {
  const f = await harness(t);
  f.advance(12 * 60 * 60 * 1000);
  const a = f.make();
  // Five starter requests, 5 minutes apart, each confirmed.
  const ids = [A1, A2, A3, U(44), U(45)];
  for (const [i, id] of ids.entries()) {
    written(f, a, id, sha(`b${i}`));
    f.status({ idle_seconds: 30 });
    assert.equal(await a.welcome(id), f.clock.t + WELCOME_MAX_HOLD_MS);
    await session(f, a, [[id, sha(`b${i}`)]]);
    f.advance(5 * 60 * 1000);
  }
  assert.equal(f.controls.length, ids.length);
  // The automatic request is still allowed at once: no cooldown, nothing used of its 4 a day.
  written(f, a, U(46), sha('auto'));
  assert.deepEqual(await f.twoTicks(a), ['sampled', 'requested']);
  let doc = f.state.read('activation', null);
  assert.deepEqual([doc.requests.length, doc.welcome_requests.length], [1, ids.length]);
  await session(f, a, [[U(46), sha('auto')]]);
  // Vice versa: the automatic budget used up for the day and in its cooldown; a starter request is still made.
  const used = Array.from({ length: DAILY_REQUESTS }, (_, i) => new Date(f.clock.t - i * 1000).toISOString());
  f.state.update('activation', {}, (d) => ({ ...d, requests: used }));
  f.advance(5 * 60 * 1000);
  written(f, a, U(47), sha('w'));
  f.status({ idle_seconds: 30 });
  assert.equal(await a.welcome(U(47)), f.clock.t + WELCOME_MAX_HOLD_MS);
  doc = f.state.read('activation', null);
  assert.deepEqual([doc.requests.length, doc.welcome_requests.length], [DAILY_REQUESTS, ids.length + 1]);
  await session(f, a, [[U(47), sha('w')]]);
  written(f, a, U(48), sha('x'));
  assert.deepEqual(await f.twoTicks(a), ['sampled', 'cooldown']);
});

test('welcome: a restart during the hold keeps the message; it is sent once after the session', async (t) => {
  const f = await harness(t);
  const a = f.make();
  const s = starterOf(f, a);
  f.status({ idle_seconds: 30 });
  await s.adopted(A1, S1);
  await session(f, a, [[A1, S1]]);
  await s.starter.runWaiting();
  f.advance(30 * 1000);
  f.status({ idle_seconds: 30 });
  assert.equal(await s.adopted(A2, S2), f.clock.t + WELCOME_MAX_HOLD_MS);
  // Restart: new activation and starter on the same state.
  const b = f.make();
  const s2 = starterOf(f, b);
  await s2.starter.runAll();
  assert.deepEqual(s2.sent, []);
  let r;
  for (let i = 0; i < 10 && r !== 'requested'; i++) {
    f.advance(ACTIVATION_CHECK_MS);
    f.status({ idle_seconds: 30 });
    r = await b.tick();
    await s2.starter.runWaiting();
  }
  assert.equal(r, 'requested');
  assert.deepEqual(s2.sent, []);
  await session(f, b, [[A1, S1], [A2, S2]]);
  await s2.starter.runWaiting();
  const s3 = starterOf(f, f.make());
  await s3.starter.runAll();
  assert.deepEqual([...s.sent, ...s2.sent, ...s3.sent], [`mkt-starter-${A1}`, `mkt-starter-${A2}`]);
  assert.equal(f.fake.requests.filter((x) => x.path === starterPath(A2, 'claim-starter')).length, 1);
});

test('welcome: busy at adoption, the message is held; once idle one starter request is made and the message sent once after the session', async (t) => {
  const f = await harness(t);
  const a = f.make();
  const s = starterOf(f, a);
  f.status({ state: 'busy' });
  assert.equal(await s.adopted(A1, S1), f.clock.t + WELCOME_MAX_HOLD_MS);
  assert.deepEqual(f.controls, []);
  for (let i = 0; i < 6; i++) {
    f.advance(ACTIVATION_CHECK_MS);
    f.status({ state: 'busy' });
    assert.equal(await a.tick(), 'busy');
    await s.starter.runWaiting();
  }
  await s.starter.runAll();
  assert.equal(s.claims(), 0);
  f.advance(ACTIVATION_CHECK_MS);
  f.status({ idle_seconds: 30 });
  assert.equal(await a.tick(), 'requested');
  assert.equal(f.controls.length, 1);
  const doc = f.state.read('activation', null);
  assert.deepEqual([doc.requests.length, doc.welcome_requests.length], [0, 1]);
  f.advance(ACTIVATION_CHECK_MS);
  f.status({ idle_seconds: 60 });
  assert.equal(await a.tick(), 'waiting');
  await s.starter.runWaiting();
  assert.deepEqual(s.sent, []);
  await session(f, a, [[A1, S1]]);
  await s.starter.runWaiting();
  await s.starter.runAll();
  assert.deepEqual(s.sent, [`mkt-starter-${A1}`]);
  assert.equal(s.claims(), 1);
  assert.equal(f.controls.length, 1);
});

test('welcome: busy at adoption and a restart during the hold; the message is sent once after the session', async (t) => {
  const f = await harness(t);
  const a = f.make();
  const s = starterOf(f, a);
  f.status({ state: 'busy' });
  assert.equal(await s.adopted(A1, S1), f.clock.t + WELCOME_MAX_HOLD_MS);
  const b = f.make();
  const s2 = starterOf(f, b);
  await s2.starter.runAll();
  assert.deepEqual(s2.sent, []);
  f.advance(ACTIVATION_CHECK_MS);
  f.status({ idle_seconds: 30 });
  assert.equal(await b.tick(), 'requested');
  await session(f, b, [[A1, S1]]);
  await s2.starter.runWaiting();
  const s3 = starterOf(f, f.make());
  await s3.starter.runAll();
  assert.deepEqual([...s.sent, ...s2.sent, ...s3.sent], [`mkt-starter-${A1}`]);
  assert.equal(f.fake.requests.filter((x) => x.path === starterPath(A1, 'claim-starter')).length, 1);
  assert.equal(f.controls.length, 1);
});

// Ticks every check interval with the Agent idle until a request is made or maxMs passed; the time it took.
async function untilRequested(f, a, maxMs, over = {}) {
  const from = f.clock.t;
  while (f.clock.t - from <= maxMs) {
    f.status(over);
    if ((await a.tick()) === 'requested') return f.clock.t - from;
    f.advance(ACTIVATION_CHECK_MS);
  }
  return null;
}

test('retry: a delivered request with no session after it is made again after the confirm wait, not the 30-minute cooldown', async (t) => {
  const f = await harness(t);
  const a = f.make();
  written(f, a);
  assert.deepEqual(await f.twoTicks(a), ['sampled', 'requested']);
  // The Agent took the request but started no session (no newer marker).
  const took = await untilRequested(f, a, REQUEST_COOLDOWN_MS);
  assert.ok(took >= CONFIRM_WAIT_MS && took <= CONFIRM_WAIT_MS + 2 * ACTIVATION_CHECK_MS, `took ${took}`);
  const doc = f.state.read('activation', null);
  assert.deepEqual([doc.requests.length, doc.retry_requests.length, doc.pending.request_count], [1, 1, 2]);
  await session(f, a, [[A1, S1]]);
  assert.equal(f.pending(), null);
});

test('retry: an unconfirmed request is never treated as done; a session older than the request does not confirm a later change', async (t) => {
  const f = await harness(t);
  const a = f.make();
  f.marker([{ adoption_id: A1, rendered_sha256: S2 }]);
  f.advance(1000);
  written(f, a, A1, S1);
  assert.deepEqual(await f.twoTicks(a), ['sampled', 'requested']);
  for (let i = 0; i < CONFIRM_WAIT_MS / ACTIVATION_CHECK_MS - 1; i++) {
    f.advance(ACTIVATION_CHECK_MS);
    f.status();
    assert.equal(await a.tick(), 'waiting');
  }
  assert.equal(a.isPending(A1), true);
  assert.deepEqual(f.reports(), []);
});

test('retry: retries have their own daily cap', async (t) => {
  const f = await harness(t);
  const a = f.make();
  f.advance(60 * 60 * 1000);
  const today = Array.from({ length: DAILY_RETRY_REQUESTS }, (_, i) => new Date(f.clock.t - (i + 1) * 60 * 1000).toISOString());
  f.state.update('activation', {}, (d) => ({ ...d, retry_requests: today }));
  written(f, a);
  assert.deepEqual(await f.twoTicks(a), ['sampled', 'requested']);
  f.advance(ACTIVATION_CHECK_MS);
  f.status();
  assert.equal(await a.tick(), 'waiting');
  f.advance(CONFIRM_WAIT_MS);
  assert.deepEqual(await f.twoTicks(a), ['sampled', 'cooldown']);
  assert.equal(f.controls.length, 1);
  // The next UTC day allows it again.
  f.clock.t = Date.parse('2026-10-17T00:00:00Z');
  assert.equal(await untilRequested(f, a, 2 * ACTIVATION_CHECK_MS) !== null, true);
  assert.equal(f.controls.length, 2);
});

test('remove then hire: the change written after an unconfirmed request is asked for again within minutes', async (t) => {
  const f = await harness(t);
  const a = f.make();
  f.adopt(A1, S1);
  f.marker([{ adoption_id: A1, rendered_sha256: S1 }]);
  f.advance(1000);
  f.adopt(A1, S1, 'removed');
  a.recordRemove({ adoptionId: A1, at: new Date(f.clock.t).toISOString() });
  assert.deepEqual(await f.twoTicks(a), ['sampled', 'requested']);
  // Delivered at the next check; hired two minutes later, and no session follows the removal's request.
  f.advance(ACTIVATION_CHECK_MS);
  f.status();
  assert.equal(await a.tick(), 'waiting');
  f.advance(2 * 60 * 1000);
  written(f, a, A2, S2);
  const took = await untilRequested(f, a, REQUEST_COOLDOWN_MS);
  assert.ok(took !== null && took <= CONFIRM_WAIT_MS - 2 * 60 * 1000 + 2 * ACTIVATION_CHECK_MS, `took ${took}`);
  assert.equal(f.controls.length, 2);
  await session(f, a, [[A2, S2]]);
  assert.deepEqual(f.reports(), [[{ kind: 'template_activated', adoption_id: A2, rendered_sha256: S2 }]]);
});

test('remove then hire with a starter message: the message is held until the session, never released early', async (t) => {
  const f = await harness(t);
  const a = f.make();
  const s = starterOf(f, a);
  f.adopt(A1, S1);
  f.marker([{ adoption_id: A1, rendered_sha256: S1 }]);
  f.advance(1000);
  f.adopt(A1, S1, 'removed');
  a.recordRemove({ adoptionId: A1, at: new Date(f.clock.t).toISOString() });
  assert.deepEqual(await f.twoTicks(a), ['sampled', 'requested']);
  f.advance(60 * 1000);
  // The removal's request is still in flight: joined, held until the session.
  assert.equal(await s.adopted(A2, S2), f.clock.t + WELCOME_MAX_HOLD_MS);
  assert.equal(f.controls.length, 1);
  assert.deepEqual(f.pending().welcome, [A2]);
  // No session for a while: nothing claimed or sent, and the session is asked for again on the starter budget.
  for (let i = 0; i < 40; i++) {
    f.advance(ACTIVATION_CHECK_MS);
    f.status({ idle_seconds: 30 });
    await a.tick();
    await s.starter.runWaiting();
  }
  assert.equal(s.claims(), 0);
  assert.deepEqual(s.sent, []);
  assert.ok(f.controls.length >= 2);
  assert.ok(f.controls[1] - f.controls[0] <= CONFIRM_WAIT_MS + 2 * 60 * 1000, JSON.stringify(f.controls));
  assert.ok(f.state.read('activation', null).welcome_requests.length >= 1);
  await session(f, a, [[A2, S2]]);
  await s.starter.runWaiting();
  assert.deepEqual(s.sent, [`mkt-starter-${A2}`]);
});

// Ticks the check and the starter every interval with the Agent idle and no session, until fn() holds or maxMs passed;
// the tick results seen.
async function declineUntil(f, a, s, fn, maxMs = 2 * 60 * 60 * 1000) {
  const seen = [];
  for (const from = f.clock.t; f.clock.t - from <= maxMs && !fn(seen); f.advance(ACTIVATION_CHECK_MS)) {
    f.status();
    seen.push(await a.tick());
    await s.starter.runWaiting();
  }
  return seen;
}

test('stuck: a held starter message is released when the change goes stuck, not before, and sent once', async (t) => {
  const f = await harness(t);
  const a = f.make();
  const s = starterOf(f, a);
  f.status({ idle_seconds: 30 });
  assert.equal(await s.adopted(A1, S1), f.clock.t + WELCOME_MAX_HOLD_MS);
  assert.equal(f.controls.length, 1);
  // Requests remain: held while each of them goes unanswered. The first send comes in the interval of the stuck tick.
  const before = await declineUntil(f, a, s, () => s.sent.length > 0);
  assert.equal(before.at(-1), 'stuck');
  assert.equal(f.controls.length, MAX_REQUESTS);
  assert.equal(before.filter((r) => r === 'stuck').length, 1);
  assert.equal(f.alert(), true);
  // Until the stuck tick nothing was claimed; the starter run of that same interval sent it.
  assert.deepEqual(s.sent, [`mkt-starter-${A1}`]);
  assert.equal(s.claims(), 1);
  assert.equal(a.isPending(A1), false);
  assert.notEqual(f.pending(), null);
  for (let i = 0; i < 10; i++) {
    f.advance(ACTIVATION_CHECK_MS);
    f.status();
    assert.equal(await a.tick(), 'stuck');
    await s.starter.runWaiting();
  }
  assert.deepEqual(s.sent, [`mkt-starter-${A1}`]);
});

test('stuck: held while requests remain, even past the confirm waits', async (t) => {
  const f = await harness(t);
  const a = f.make();
  const s = starterOf(f, a);
  f.status({ idle_seconds: 30 });
  await s.adopted(A1, S1);
  const seen = await declineUntil(f, a, s, () => f.controls.length === MAX_REQUESTS);
  assert.ok(!seen.includes('stuck'));
  // The last request is still given its confirm wait.
  for (let i = 0; i < CONFIRM_WAIT_MS / ACTIVATION_CHECK_MS - 1; i++) {
    f.advance(ACTIVATION_CHECK_MS);
    f.status();
    assert.equal(await a.tick(), 'waiting');
    await s.starter.runWaiting();
  }
  assert.equal(a.isPending(A1), true);
  assert.equal(s.claims(), 0);
  assert.deepEqual(s.sent, []);
});

test('stuck: a new change after stuck is held again until confirmed; the released message is not sent again', async (t) => {
  const f = await harness(t);
  const a = f.make();
  const s = starterOf(f, a);
  f.status({ idle_seconds: 30 });
  await s.adopted(A1, S1);
  await declineUntil(f, a, s, (seen) => seen.at(-1) === 'stuck');
  assert.deepEqual(s.sent, [`mkt-starter-${A1}`]);
  // A new adoption merges into the stuck record: it gets its own requests and its message is held.
  f.advance(ACTIVATION_CHECK_MS);
  f.status({ idle_seconds: 30 });
  assert.equal(await s.adopted(A2, S2), f.clock.t + WELCOME_MAX_HOLD_MS);
  assert.equal(f.pending().request_count, 1);
  assert.equal(f.pending().stuck_at, undefined);
  assert.equal(a.isPending(A2), true);
  await declineUntil(f, a, s, () => f.controls.length === MAX_REQUESTS + 2);
  assert.deepEqual(s.sent, [`mkt-starter-${A1}`]);
  await session(f, a, [[A1, S1], [A2, S2]]);
  await s.starter.runWaiting();
  assert.deepEqual(s.sent, [`mkt-starter-${A1}`, `mkt-starter-${A2}`]);
  assert.equal(s.claims(), 2);
});

test('stuck: a new change after stuck that goes stuck itself releases its own message', async (t) => {
  const f = await harness(t);
  const a = f.make();
  const s = starterOf(f, a);
  f.status({ idle_seconds: 30 });
  await s.adopted(A1, S1);
  await declineUntil(f, a, s, (seen) => seen.at(-1) === 'stuck');
  f.advance(ACTIVATION_CHECK_MS);
  f.status({ idle_seconds: 30 });
  await s.adopted(A2, S2);
  const seen = await declineUntil(f, a, s, (r) => r.at(-1) === 'stuck');
  assert.equal(seen.at(-1), 'stuck');
  assert.equal(f.controls.length, 2 * MAX_REQUESTS);
  assert.deepEqual(s.sent, [`mkt-starter-${A1}`, `mkt-starter-${A2}`]);
});

// A write the user ordered (template update or switch).
const userWritten = (f, a, id = A1, s = S1) => {
  f.adopt(id, s);
  a.recordWrite({ adoptionId: id, renderedSha: s, at: new Date(f.clock.t).toISOString(), userInitiated: true });
};

test('update: a user-ordered write is asked for at once on an Agent idle 30 s, not held back by the 30-minute cooldown', async (t) => {
  const f = await harness(t);
  const a = f.make();
  // An automatic request 10 minutes earlier, confirmed: its cooldown runs.
  written(f, a, A1, S1);
  assert.deepEqual(await f.twoTicks(a), ['sampled', 'requested']);
  await session(f, a, [[A1, S1]]);
  f.advance(10 * 60 * 1000);
  userWritten(f, a, A1, S2);
  f.status({ idle_seconds: 30 });
  assert.equal(await a.tick(), 'requested');
  assert.equal(f.controls.length, 2);
  const doc = f.state.read('activation', null);
  assert.deepEqual([doc.requests.length, doc.update_requests.length, doc.welcome_requests.length], [1, 1, 0]);
  await session(f, a, [[A1, S2]]);
  assert.equal(f.pending(), null);
});

test('update: an automatic write keeps the idle path (5 minutes idle, two samples)', async (t) => {
  const f = await harness(t);
  const a = f.make();
  written(f, a);
  f.status({ idle_seconds: 30 });
  assert.equal(await a.tick(), 'busy');
  assert.deepEqual(await f.twoTicks(a), ['sampled', 'requested']);
  const doc = f.state.read('activation', null);
  assert.deepEqual([doc.requests.length, doc.update_requests.length], [1, 0]);
});

for (const [name, over, opts] of [
  ['a busy runtime', { state: 'busy' }],
  ['a tool running', { active_tools: 1 }],
  ['idle less than 30 s', { idle_seconds: 29 }],
  ['an open OpenMax turn', {}, { turn: () => true }],
  ['the OpenMax turn state unreadable', {}, { turn: () => new Error('no activity store') }],
]) {
  test(`update: no quick request with ${name}`, async (t) => {
    const f = await harness(t, opts);
    const a = f.make();
    userWritten(f, a);
    for (let i = 0; i < 4; i++) {
      f.status({ idle_seconds: 30, ...over });
      assert.equal(await a.tick(), 'busy');
      f.advance(ACTIVATION_CHECK_MS);
    }
    assert.deepEqual(f.controls, []);
  });
}

test('update: writes within the interval share one request', async (t) => {
  const f = await harness(t);
  const a = f.make();
  userWritten(f, a, A1, S1);
  f.status({ idle_seconds: 30 });
  assert.equal(await a.tick(), 'requested');
  f.advance(60 * 1000);
  userWritten(f, a, A2, S2);
  f.status({ idle_seconds: 30 });
  assert.equal(await a.tick(), 'waiting');
  assert.equal(f.controls.length, 1);
  await session(f, a, [[A1, S1], [A2, S2]]);
  assert.equal(f.state.read('activation', null).update_requests.length, 1);
});

test('update: a write inside the interval after a confirmed request waits for the interval, then is asked for', async (t) => {
  const f = await harness(t);
  const a = f.make();
  userWritten(f, a, A1, S1);
  f.status({ idle_seconds: 30 });
  assert.equal(await a.tick(), 'requested');
  await session(f, a, [[A1, S1]]);
  f.advance(ACTIVATION_CHECK_MS);
  userWritten(f, a, A1, S2);
  const t0 = Date.parse(f.state.read('activation', null).update_requests[0]);
  while (f.clock.t - t0 < UPDATE_REQUEST_INTERVAL_MS) {
    f.status({ idle_seconds: 30 });
    assert.equal(await a.tick(), 'busy');
    f.advance(ACTIVATION_CHECK_MS);
  }
  f.status({ idle_seconds: 30 });
  assert.equal(await a.tick(), 'requested');
  assert.equal(f.controls.length, 2);
});

test(`update: at most ${HOURLY_UPDATE_REQUESTS} quick requests an hour; past it the change falls back to the idle path`, async (t) => {
  const f = await harness(t);
  const a = f.make();
  for (let i = 0; i < HOURLY_UPDATE_REQUESTS; i++) {
    userWritten(f, a, A1, sha(`u${i}`));
    f.status({ idle_seconds: 30 });
    assert.equal(await a.tick(), 'requested');
    await session(f, a, [[A1, sha(`u${i}`)]]);
    f.advance(5 * 60 * 1000);
  }
  userWritten(f, a, A1, sha('over'));
  f.status({ idle_seconds: 30 });
  assert.equal(await a.tick(), 'busy');
  assert.equal(f.controls.length, HOURLY_UPDATE_REQUESTS);
  // The automatic rules still apply: 5 minutes idle, two samples, on the automatic budget.
  assert.deepEqual(await f.twoTicks(a), ['sampled', 'requested']);
  let doc = f.state.read('activation', null);
  assert.deepEqual([doc.update_requests.length, doc.requests.length], [HOURLY_UPDATE_REQUESTS, 1]);
  await session(f, a, [[A1, sha('over')]]);
  // An hour after the first quick request the budget allows one again.
  const first = Date.parse(doc.update_requests[0]);
  f.clock.t = first + 60 * 60 * 1000;
  userWritten(f, a, A1, sha('later'));
  f.status({ idle_seconds: 30 });
  assert.equal(await a.tick(), 'requested');
  doc = f.state.read('activation', null);
  assert.equal(doc.update_requests.length, HOURLY_UPDATE_REQUESTS + 1);
});

test(`update: at most ${DAILY_UPDATE_REQUESTS} quick requests a UTC day`, async (t) => {
  const f = await harness(t);
  f.advance(20 * 60 * 60 * 1000);
  const a = f.make();
  const used = Array.from({ length: DAILY_UPDATE_REQUESTS }, (_, i) => new Date(f.clock.t - (2 + i) * 60 * 60 * 1000 / 2).toISOString());
  f.state.update('activation', {}, (d) => ({ ...d, update_requests: used }));
  userWritten(f, a);
  f.status({ idle_seconds: 30 });
  assert.equal(await a.tick(), 'busy');
  assert.deepEqual(f.controls, []);
  // The next UTC day the quick path is back.
  f.clock.t = Date.parse('2026-10-17T00:00:30Z');
  f.status({ idle_seconds: 30 });
  assert.equal(await a.tick(), 'requested');
});

test('update: the automatic budget used up does not block a quick request, and a quick request leaves it alone', async (t) => {
  const f = await harness(t);
  f.advance(12 * 60 * 60 * 1000);
  const a = f.make();
  const used = Array.from({ length: DAILY_REQUESTS }, (_, i) => new Date(f.clock.t - i * 1000).toISOString());
  f.state.update('activation', {}, (d) => ({ ...d, requests: used }));
  userWritten(f, a);
  f.status({ idle_seconds: 30 });
  assert.equal(await a.tick(), 'requested');
  const doc = f.state.read('activation', null);
  assert.deepEqual([doc.requests.length, doc.update_requests.length], [DAILY_REQUESTS, 1]);
});

test('update: a quick request with no session after it is made again after the confirm wait, up to MAX_REQUESTS', async (t) => {
  const f = await harness(t);
  const a = f.make();
  userWritten(f, a);
  f.status({ idle_seconds: 30 });
  assert.equal(await a.tick(), 'requested');
  f.advance(ACTIVATION_CHECK_MS);
  f.status({ idle_seconds: 30 });
  assert.equal(await a.tick(), 'waiting');
  f.advance(CONFIRM_WAIT_MS);
  f.status({ idle_seconds: 30 });
  assert.equal(await a.tick(), 'requested');
  assert.equal(f.controls.length, 2);
  assert.equal(f.pending().request_count, 2);
});

test('update: the user mark survives a restart', async (t) => {
  const f = await harness(t);
  userWritten(f, f.make());
  const b = f.make();
  f.status({ idle_seconds: 30 });
  assert.equal(await b.tick(), 'requested');
  assert.equal(f.pending().user, true);
});

// A request the runtime could not serve because of a model API problem is not counted toward MAX_REQUESTS.

// One quick request, then the runtime reports `health` for the whole confirm wait; returns the tick after it.
async function failedRequest(f, a, health = 'rate_limited') {
  f.status({ idle_seconds: 30 });
  assert.equal(await a.tick(), 'requested');
  f.advance(ACTIVATION_CHECK_MS);
  f.status({ idle_seconds: 30, health });
  assert.equal(await a.tick(), 'waiting');
  f.advance(CONFIRM_WAIT_MS);
  f.status({ idle_seconds: 30, health });
  return a.tick();
}

test('api error: a request followed by a model API problem is given back, so the change never goes stuck', async (t) => {
  const f = await harness(t);
  const a = f.make();
  userWritten(f, a);
  for (let i = 0; i < MAX_REQUESTS + 2; i++) {
    // While the runtime is unhealthy nothing is asked for; the request is not counted.
    assert.equal(await failedRequest(f, a), 'busy');
    assert.equal(f.pending().request_count, 0);
    assert.equal(f.pending().stuck_at, undefined);
    // Past the quick budget's hourly cap (3 in any 60 minutes).
    f.advance(20 * 60 * 1000);
  }
  assert.equal(f.alert(), false);
  assert.equal(f.state.read('activation', null).api_error_refunds.length, MAX_REQUESTS + 2);
  // Healthy again: asked for at once, and the session confirms it.
  f.status({ idle_seconds: 30 });
  assert.equal(await a.tick(), 'requested');
  await session(f, a, [[A1, S1]]);
  assert.equal(f.pending(), null);
});

for (const health of ['unavailable', 'auth_failed']) {
  test(`api error: health ${health} gives the request back too`, async (t) => {
    const f = await harness(t);
    const a = f.make();
    userWritten(f, a);
    await failedRequest(f, a, health);
    assert.equal(f.pending().request_count, 0);
  });
}

test('api error: a request with a healthy runtime and no session still counts, up to stuck', async (t) => {
  const f = await harness(t);
  const a = f.make();
  userWritten(f, a);
  for (let i = 1; i <= MAX_REQUESTS; i++) {
    f.status({ idle_seconds: 30 });
    assert.equal(await a.tick(), 'requested');
    assert.equal(f.pending().request_count, i);
    // The confirm wait runs from when the request is first seen delivered.
    f.advance(ACTIVATION_CHECK_MS);
    f.status({ idle_seconds: 30 });
    assert.equal(await a.tick(), 'waiting');
    f.advance(CONFIRM_WAIT_MS);
  }
  f.status({ idle_seconds: 30 });
  assert.equal(await a.tick(), 'stuck');
  assert.equal(f.alert(), true);
  assert.equal(f.state.read('activation', null).api_error_refunds.length, 0);
});

test('api error: a problem reported before the request does not give it back', async (t) => {
  const f = await harness(t);
  const a = f.make();
  userWritten(f, a);
  f.status({ idle_seconds: 30, health: 'rate_limited' });
  assert.equal(await a.tick(), 'busy');
  f.advance(ACTIVATION_CHECK_MS);
  f.status({ idle_seconds: 30 });
  assert.equal(await a.tick(), 'requested');
  f.advance(ACTIVATION_CHECK_MS);
  f.status({ idle_seconds: 30 });
  assert.equal(await a.tick(), 'waiting');
  f.advance(CONFIRM_WAIT_MS);
  f.status({ idle_seconds: 30 });
  assert.equal(await a.tick(), 'requested');
  assert.equal(f.pending().request_count, 2);
});

test('api error: a session after the request confirms it; nothing is given back', async (t) => {
  const f = await harness(t);
  const a = f.make();
  userWritten(f, a);
  f.status({ idle_seconds: 30 });
  assert.equal(await a.tick(), 'requested');
  f.advance(ACTIVATION_CHECK_MS);
  await session(f, a, [[A1, S1]]);
  assert.equal(f.pending(), null);
  assert.equal(f.state.read('activation', null).api_error_refunds.length, 0);
});

test(`api error: at most ${DAILY_API_ERROR_REFUNDS} requests are given back a UTC day; past it they count`, async (t) => {
  const f = await harness(t);
  const a = f.make();
  userWritten(f, a);
  const day = new Date(f.clock.t).toISOString().slice(0, 10);
  f.state.update('activation', {}, (d) => {
    d.api_error_refunds = Array.from({ length: DAILY_API_ERROR_REFUNDS }, () => `${day}T00:00:00.000Z`);
  });
  await failedRequest(f, a);
  assert.equal(f.pending().request_count, 1);
});

// Puts the record through MAX_REQUESTS automatic requests with a healthy runtime and no session, up to stuck.
async function toStuck(f, a) {
  for (let i = 1; i <= MAX_REQUESTS; i++) {
    f.status({ idle_seconds: 30 });
    assert.equal(await a.tick(), 'requested');
    f.advance(ACTIVATION_CHECK_MS);
    f.status({ idle_seconds: 30 });
    assert.equal(await a.tick(), 'waiting');
    f.advance(CONFIRM_WAIT_MS);
  }
  f.status({ idle_seconds: 30 });
  assert.equal(await a.tick(), 'stuck');
}

test('api error: a stuck change gets nothing back from a later problem; it stays stuck', async (t) => {
  const f = await harness(t);
  const a = f.make();
  userWritten(f, a);
  await toStuck(f, a);
  const stuckAt = f.pending().stuck_at;
  for (let i = 0; i < 3; i++) {
    f.advance(60 * 60 * 1000);
    f.status({ idle_seconds: 30, health: 'rate_limited' });
    await a.tick();
    f.advance(CONFIRM_WAIT_MS);
    f.status({ idle_seconds: 30 });
    assert.equal(await a.tick(), 'stuck');
  }
  assert.equal(f.pending().request_count, MAX_REQUESTS);
  assert.equal(f.pending().stuck_at, stuckAt);
  assert.equal(f.pending().api_error_at, undefined);
  assert.equal(f.alert(), true);
  assert.equal(f.controls.length, MAX_REQUESTS);
  assert.equal(f.state.read('activation', null).api_error_refunds.length, 0);
});

test('api error: a problem only after the confirm wait does not give back a request that failed while healthy', async (t) => {
  const f = await harness(t);
  const a = f.make();
  userWritten(f, a);
  f.status({ idle_seconds: 30 });
  assert.equal(await a.tick(), 'requested');
  f.advance(ACTIVATION_CHECK_MS);
  f.status({ idle_seconds: 30 });
  assert.equal(await a.tick(), 'waiting');
  // Healthy for the whole wait; the problem starts after it.
  f.advance(CONFIRM_WAIT_MS);
  f.status({ idle_seconds: 30, health: 'rate_limited' });
  assert.equal(await a.tick(), 'busy');
  f.advance(ACTIVATION_CHECK_MS);
  f.status({ idle_seconds: 30, health: 'rate_limited' });
  assert.equal(await a.tick(), 'busy');
  assert.equal(f.pending().request_count, 1);
  assert.equal(f.pending().api_error_at, undefined);
  assert.equal(f.state.read('activation', null).api_error_refunds.length, 0);
});

test('api error: a problem while the request is still queued does not give it back once it is delivered and fails healthy', async (t) => {
  const f = await harness(t, { deliver: false });
  const a = f.make();
  userWritten(f, a);
  f.status({ idle_seconds: 30 });
  assert.equal(await a.tick(), 'requested');
  // Still in the queue while the runtime is rate limited.
  f.advance(ACTIVATION_CHECK_MS);
  f.status({ idle_seconds: 30, health: 'rate_limited' });
  assert.equal(await a.tick(), 'waiting');
  assert.equal(f.pending().api_error_at, undefined);
  // Healthy again, then delivered; no session follows within the wait.
  f.advance(ACTIVATION_CHECK_MS);
  f.statuses.set(1, 'done');
  f.status({ idle_seconds: 30 });
  assert.equal(await a.tick(), 'waiting');
  assert.ok(f.pending().delivered_at);
  f.advance(CONFIRM_WAIT_MS);
  f.status({ idle_seconds: 30 });
  await a.tick();
  assert.equal(f.state.read('activation', null).api_error_refunds.length, 0);
  assert.equal(f.controls.length, 2);
  assert.equal(f.pending().request_count, 2);
});

test('api error: the request is given back before the quick request a user-ordered write makes when the wait ends', async (t) => {
  const f = await harness(t);
  const a = f.make();
  userWritten(f, a);
  f.status({ idle_seconds: 30 });
  assert.equal(await a.tick(), 'requested');
  f.advance(ACTIVATION_CHECK_MS);
  f.status({ idle_seconds: 30, health: 'rate_limited' });
  assert.equal(await a.tick(), 'waiting');
  assert.ok(f.pending().api_error_at);
  // A short rate limit: healthy again when the wait ends, so the quick budget asks again at once.
  f.advance(CONFIRM_WAIT_MS);
  f.status({ idle_seconds: 30 });
  assert.equal(await a.tick(), 'requested');
  assert.equal(f.controls.length, 2);
  assert.equal(f.pending().request_count, 1);
  assert.equal(f.state.read('activation', null).api_error_refunds.length, 1);
});

test('api error: a starter message asked for after the wait ends gets the request back before its own request', async (t) => {
  const f = await harness(t);
  const a = f.make();
  written(f, a);
  f.status({ idle_seconds: 30 });
  assert.equal(await a.welcome(A1), f.clock.t + WELCOME_MAX_HOLD_MS);
  f.advance(ACTIVATION_CHECK_MS);
  f.status({ idle_seconds: 30, health: 'rate_limited' });
  assert.equal(await a.tick(), 'waiting');
  assert.ok(f.pending().api_error_at);
  // Healthy again; the starter message is asked for again before the next tick.
  f.advance(CONFIRM_WAIT_MS);
  f.status({ idle_seconds: 30 });
  assert.equal(await a.welcome(A1), f.clock.t + WELCOME_MAX_HOLD_MS);
  assert.equal(f.controls.length, 2);
  assert.equal(f.pending().request_count, 1);
  assert.equal(f.state.read('activation', null).api_error_refunds.length, 1);
});

test('api error: a status file without a health field is no information; the request counts', async (t) => {
  const f = await harness(t);
  const a = f.make();
  userWritten(f, a);
  f.status({ idle_seconds: 30 });
  assert.equal(await a.tick(), 'requested');
  f.advance(ACTIVATION_CHECK_MS);
  f.status({ idle_seconds: 30 });
  assert.equal(await a.tick(), 'waiting');
  f.advance(CONFIRM_WAIT_MS);
  f.status({ idle_seconds: 30 });
  assert.equal(await a.tick(), 'requested');
  assert.equal(f.pending().api_error_at, undefined);
  assert.equal(f.state.read('activation', null).api_error_refunds.length, 0);
  assert.equal(f.pending().request_count, 2);
});

test('api error: a stale status file (older than 60 s) is no information; the request counts', async (t) => {
  const f = await harness(t);
  const a = f.make();
  userWritten(f, a);
  f.status({ idle_seconds: 30 });
  assert.equal(await a.tick(), 'requested');
  f.advance(ACTIVATION_CHECK_MS);
  f.status({ idle_seconds: 30, health: 'rate_limited' }, STATUS_MAX_AGE_MS + 1000);
  assert.equal(await a.tick(), 'waiting');
  f.advance(CONFIRM_WAIT_MS);
  f.status({ idle_seconds: 30, health: 'rate_limited' }, STATUS_MAX_AGE_MS + 1000);
  await a.tick();
  assert.equal(f.pending().api_error_at, undefined);
  assert.equal(f.pending().request_count, 1);
  assert.equal(f.state.read('activation', null).api_error_refunds.length, 0);
});

test('api error: api_error_at and api_error_refunds survive a restart; the new instance gives the request back', async (t) => {
  const f = await harness(t);
  const a = f.make();
  userWritten(f, a);
  f.status({ idle_seconds: 30 });
  assert.equal(await a.tick(), 'requested');
  f.advance(ACTIVATION_CHECK_MS);
  f.status({ idle_seconds: 30, health: 'unavailable' });
  assert.equal(await a.tick(), 'waiting');
  const at = f.pending().api_error_at;
  assert.ok(at);
  // Restarted: a new instance over the same state.
  const b = f.make();
  assert.equal(f.pending().api_error_at, at);
  f.advance(CONFIRM_WAIT_MS);
  f.status({ idle_seconds: 30, health: 'unavailable' });
  assert.equal(await b.tick(), 'busy');
  assert.equal(f.pending().request_count, 0);
  assert.equal(f.state.read('activation', null).api_error_refunds.length, 1);
});

test('api error: the daily cap counts the current UTC day only', async (t) => {
  const f = await harness(t);
  const a = f.make();
  userWritten(f, a);
  // A full cap the UTC day before does not hold back today's refund.
  const yesterday = new Date(f.clock.t - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  f.state.update('activation', {}, (d) => {
    d.api_error_refunds = Array.from({ length: DAILY_API_ERROR_REFUNDS }, () => `${yesterday}T23:59:59.000Z`);
  });
  await failedRequest(f, a);
  assert.equal(f.pending().request_count, 0);
  assert.equal(f.state.read('activation', null).api_error_refunds.length, DAILY_API_ERROR_REFUNDS + 1);
});

// Writes over the pending record (fields set or, for undefined, removed).
function seed(f, over) {
  f.state.update('activation', {}, (d) => {
    for (const [k, v] of Object.entries(over)) if (v === undefined) delete d.pending[k]; else d.pending[k] = v;
  });
}

test('api error: a stuck change whose refund the daily cap held back gets nothing back on the next UTC day', async (t) => {
  const f = await harness(t);
  const a = f.make();
  userWritten(f, a);
  const day = new Date(f.clock.t).toISOString().slice(0, 10);
  f.state.update('activation', {}, (d) => {
    d.api_error_refunds = Array.from({ length: DAILY_API_ERROR_REFUNDS }, () => `${day}T00:00:00.000Z`);
  });
  await toStuck(f, a);
  // The last request had a problem in its wait, but today's refunds are used up.
  seed(f, { api_error_at: new Date(Date.parse(f.pending().delivered_at) + 1000).toISOString() });
  const next = Date.parse(`${day}T00:00:00.000Z`) + 24 * 60 * 60 * 1000;
  f.clock.t = Math.max(f.clock.t, next) + 60 * 1000;
  f.status({ idle_seconds: 30 });
  assert.equal(await a.tick(), 'stuck');
  assert.equal(f.pending().request_count, MAX_REQUESTS);
  assert.equal(f.state.read('activation', null).api_error_refunds.length, DAILY_API_ERROR_REFUNDS);
});

test('api error: a problem kept before the request was delivered does not give it back', async (t) => {
  const f = await harness(t);
  const a = f.make();
  userWritten(f, a);
  f.status({ idle_seconds: 30 });
  assert.equal(await a.tick(), 'requested');
  f.advance(ACTIVATION_CHECK_MS);
  f.status({ idle_seconds: 30 });
  assert.equal(await a.tick(), 'waiting');
  const p = f.pending();
  seed(f, { api_error_at: new Date(Date.parse(p.requested_at) + 1000).toISOString() });
  assert.ok(Date.parse(f.pending().api_error_at) < Date.parse(p.delivered_at));
  f.advance(CONFIRM_WAIT_MS);
  f.status({ idle_seconds: 30, health: 'rate_limited' });
  assert.equal(await a.tick(), 'busy');
  assert.equal(f.pending().request_count, 1);
});

test('api error: after a session that was seen without confirming the record, a problem neither is kept nor gives the request back', async (t) => {
  const f = await harness(t);
  const a = f.make();
  userWritten(f, a);
  f.status({ idle_seconds: 30 });
  assert.equal(await a.tick(), 'requested');
  f.advance(ACTIVATION_CHECK_MS);
  f.status({ idle_seconds: 30 });
  assert.equal(await a.tick(), 'waiting');
  // A session started after the request and was already looked at (seen_at), without confirming the record.
  f.advance(1000);
  f.marker([]);
  seed(f, { seen_at: new Date(f.clock.t).toISOString() });
  f.advance(ACTIVATION_CHECK_MS);
  f.status({ idle_seconds: 30, health: 'rate_limited' });
  await a.tick();
  assert.equal(f.pending().api_error_at, undefined);
  // Even a problem kept in the wait is not given back once a session followed the request.
  seed(f, { api_error_at: new Date(Date.parse(f.pending().delivered_at) + 1000).toISOString() });
  f.advance(CONFIRM_WAIT_MS);
  f.status({ idle_seconds: 30, health: 'rate_limited' });
  await a.tick();
  assert.equal(f.pending().request_count, 1);
  assert.equal(f.state.read('activation', null).api_error_refunds.length, 0);
});

test('api error: a refund re-checks the record inside the update; a record that changed meanwhile gets nothing back', async (t) => {
  let race = null;
  const f = await harness(t, {
    state: (s) => ({
      ...s,
      update(key, def, fn) {
        return s.update(key, def, (d) => {
          if (race && d.pending && new Error().stack.includes('refundApiError')) { race(d); race = null; }
          return fn(d);
        });
      },
    }),
  });
  const a = f.make();
  userWritten(f, a);
  f.status({ idle_seconds: 30 });
  assert.equal(await a.tick(), 'requested');
  f.advance(ACTIVATION_CHECK_MS);
  f.status({ idle_seconds: 30, health: 'rate_limited' });
  assert.equal(await a.tick(), 'waiting');
  // Between the check and the update, the record went stuck (another instance).
  race = (d) => { d.pending.stuck_at = new Date(f.clock.t).toISOString(); };
  f.advance(CONFIRM_WAIT_MS);
  f.status({ idle_seconds: 30, health: 'rate_limited' });
  await a.tick();
  assert.equal(race, null);
  assert.equal(f.pending().request_count, 1);
  assert.equal(f.state.read('activation', null).api_error_refunds.length, 0);
});

test('api error: a problem kept after the confirm wait (a clock jump) does not give the request back', async (t) => {
  const f = await harness(t);
  const a = f.make();
  userWritten(f, a);
  f.status({ idle_seconds: 30 });
  assert.equal(await a.tick(), 'requested');
  f.advance(ACTIVATION_CHECK_MS);
  f.status({ idle_seconds: 30 });
  assert.equal(await a.tick(), 'waiting');
  seed(f, { api_error_at: new Date(Date.parse(f.pending().delivered_at) + CONFIRM_WAIT_MS + 1000).toISOString() });
  f.advance(CONFIRM_WAIT_MS + 2000);
  f.status({ idle_seconds: 30, health: 'rate_limited' });
  assert.equal(await a.tick(), 'busy');
  assert.equal(f.pending().request_count, 1);
});

// A zylos dir on Codex with the declarations in place and the slot hooks missing.
const codexZylos = () => {
  const z = fakeZylos();
  ensureDeclarations(z);
  fs.mkdirSync(path.join(z, '.zylos'), { recursive: true });
  fs.writeFileSync(path.join(z, '.zylos', 'config.json'), '{"runtime":"codex"}');
  return z;
};
// The activation on a Codex zylos dir; texts lists the content of each enqueued request.
const hooksActivation = (f, { zylosDir = codexZylos(), enqueue = null } = {}) => {
  const texts = [];
  const control = f.withEnqueue(async (content) => { texts.push(content); return (enqueue ?? f.control.enqueue)(); });
  return { a: f.make(f.state, { zylosDir, control }), zylosDir, texts };
};
const until = (f, ms = 15 * 60 * 1000) => new Date(f.clock.t + ms).toISOString();
const hooksDoc = (f) => f.state.read('activation', null);

test('hooks: a write held for the Codex slot hooks asks for one new session on its own budget', async (t) => {
  const f = await harness(t);
  const { a, texts } = hooksActivation(f);
  f.status({ idle_seconds: QUICK_IDLE_SECONDS });
  assert.equal(await a.hooksSession({ until: until(f) }), 'requested');
  assert.deepEqual(texts, [HOOKS_SESSION_TEXT]);
  const doc = hooksDoc(f);
  assert.deepEqual([doc.hooks_requests.length, doc.requests.length, doc.update_requests.length, doc.welcome_requests.length], [1, 0, 0, 0]);
  assert.equal(doc.hooks.control_id, 1);
  for (let i = 0; i < 4; i++) {
    f.advance(HOOKS_REQUEST_INTERVAL_MS);
    f.status();
    assert.equal(await a.hooksSession({ until: until(f) }), 'waiting');
    await a.tick();
  }
  assert.equal(f.controls.length, 1);
});

test('hooks: the request waits for a healthy Agent idle QUICK_IDLE_SECONDS with no open turn, and for the declarations', async (t) => {
  let open = true;
  const f = await harness(t, { turn: () => open });
  const { a, zylosDir } = hooksActivation(f);
  f.status({ idle_seconds: QUICK_IDLE_SECONDS });
  assert.equal(await a.hooksSession({ until: until(f) }), 'waiting');
  open = false;
  for (const over of [{ idle_seconds: QUICK_IDLE_SECONDS - 1 }, { health: 'rate_limited' }, { active_tools: 1 }]) {
    f.status(over);
    await a.tick();
  }
  fs.rmSync(path.join(shardsDir(zylosDir), 'market-template-1.json'));
  f.status({ idle_seconds: QUICK_IDLE_SECONDS });
  await a.tick();
  assert.equal(f.controls.length, 0);
  ensureDeclarations(zylosDir);
  await a.tick();
  assert.equal(f.controls.length, 1);
});

test('hooks: writes held together share one request, and a new record waits HOOKS_REQUEST_INTERVAL_MS', async (t) => {
  const f = await harness(t);
  const { a, zylosDir } = hooksActivation(f);
  f.status({ idle_seconds: QUICK_IDLE_SECONDS });
  assert.equal(await a.hooksSession({ until: until(f) }), 'requested');
  assert.equal(await a.hooksSession({ until: until(f, 20 * 60 * 1000) }), 'waiting');
  assert.equal(hooksDoc(f).hooks.until, until(f, 20 * 60 * 1000));
  assert.equal(f.controls.length, 1);

  // The record ends at until; the next one is asked for only after the interval.
  const b = hooksActivation(f, { zylosDir }).a;
  f.state.update('activation', {}, (d) => { d.hooks = null; });
  f.advance(HOOKS_REQUEST_INTERVAL_MS - 1000);
  f.status({ idle_seconds: QUICK_IDLE_SECONDS });
  assert.equal(await b.hooksSession({ until: until(f) }), 'waiting');
  assert.equal(f.controls.length, 1);
  f.advance(1000);
  f.status({ idle_seconds: QUICK_IDLE_SECONDS });
  assert.equal(await b.tick(), 'none');
  assert.equal(f.controls.length, 2);
});

test('hooks: no request past DAILY_HOOKS_REQUESTS or when the enqueue is refused, and none from the automatic budget', async (t) => {
  const f = await harness(t);
  const { a } = hooksActivation(f);
  f.advance(60 * 60 * 1000);
  f.state.update('activation', {}, (d) => {
    d.hooks_requests = Array.from({ length: DAILY_HOOKS_REQUESTS }, (_, i) => new Date(f.clock.t - (i + 1) * 60 * 1000).toISOString());
  });
  f.advance(HOOKS_REQUEST_INTERVAL_MS);
  for (let i = 0; i < 3; i++) {
    f.status({ idle_seconds: 600 });
    assert.equal(await a.hooksSession({ until: until(f) }), 'waiting');
    await a.tick();
    f.advance(ACTIVATION_CHECK_MS);
  }
  assert.deepEqual([f.controls.length, hooksDoc(f).requests.length], [0, 0]);

  const g = await harness(t);
  const { a: b } = hooksActivation(g, { enqueue: async () => { throw new ControlError('control enqueue failed (exit 1)'); } });
  g.status({ idle_seconds: QUICK_IDLE_SECONDS });
  assert.equal(await b.hooksSession({ until: until(g) }), 'waiting');
  assert.ok(hooksDoc(g).hooks.given_up_at);
  assert.deepEqual(hooksDoc(g).hooks_requests, []);
  g.advance(HOOKS_REQUEST_INTERVAL_MS);
  g.status({ idle_seconds: QUICK_IDLE_SECONDS });
  assert.equal(await b.hooksSession({ until: until(g) }), 'waiting');
  await b.tick();
  assert.ok(g.lines.filter((l) => /new session not requested/.test(l)).length === 1);
});

test('hooks: once they appear the record ends, the request is withdrawn and onHooksReady is called once', async (t) => {
  const f = await harness(t, { deliver: false });
  const { a, zylosDir } = hooksActivation(f);
  f.status({ idle_seconds: QUICK_IDLE_SECONDS });
  assert.equal(await a.hooksSession({ until: until(f) }), 'requested');
  writeSlotHooks(zylosDir, { runtime: 'codex' });
  let ready = 0;
  await a.tick({ onHooksReady: () => { ready += 1; } });
  await a.tick({ onHooksReady: () => { ready += 1; } });
  assert.equal(ready, 1);
  assert.equal(hooksDoc(f).hooks, null);
  assert.deepEqual(f.acks, [1]);
  assert.equal(f.controls.length, 1);
});

test('hooks: still missing after a session that followed the request: missing, and no further request', async (t) => {
  const f = await harness(t);
  const { a } = hooksActivation(f);
  f.status({ idle_seconds: QUICK_IDLE_SECONDS });
  assert.equal(await a.hooksSession({ until: until(f) }), 'requested');
  const launched = f.clock.t + 30 * 1000;
  f.advance(60 * 1000);
  f.status({ idle_seconds: QUICK_IDLE_SECONDS, runtime_launch_at: launched });
  assert.equal(await a.hooksSession({ until: until(f) }), 'waiting');
  f.advance(HOOKS_SETTLE_MS);
  f.status({ idle_seconds: QUICK_IDLE_SECONDS, runtime_launch_at: launched });
  assert.equal(await a.hooksSession({ until: until(f) }), 'missing');
  for (let i = 0; i < 4; i++) {
    f.advance(HOOKS_REQUEST_INTERVAL_MS);
    f.status({ idle_seconds: 600 });
    assert.equal(await a.hooksSession({ until: until(f) }), 'missing');
    await a.tick();
  }
  assert.equal(f.controls.length, 1);
  assert.equal(f.lines.filter((l) => /Codex slot hooks are still missing/.test(l)).length, 1);
});

test('hooks: no record without a held write; the Claude runtime is never asked for one', async (t) => {
  const f = await harness(t);
  const z = fakeZylos({ hooks: true });
  ensureDeclarations(z);
  const { a } = hooksActivation(f, { zylosDir: z });
  f.status({ idle_seconds: 600 });
  assert.equal(await a.tick(), 'none');
  assert.equal(f.controls.length, 0);
  assert.equal(hooksDoc(f)?.hooks ?? null, null);
});
