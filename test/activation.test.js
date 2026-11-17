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
  CONTROL_ACK_DEADLINE_S, CONTROL_MAX_AGE_MS, PENDING_ALERT, PENDING_ALERT_MS, STATUS_MAX_AGE_MS, STUCK_ALERT, WELCOME_HOLD_MS, CONTROL_TIMEOUT_MS, ControlError, createControl, createActivation, readRuntimeStatus,
} from '../src/activation.js';
import { createReconciler } from '../src/reconcile.js';
import { createStarter } from '../src/starter.js';
import { MARKER_FILE, readMarker } from '../src/shard-emitter.js';

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

test('cooldown: 30 minutes between requests; daily cap: at most 4 a day', async (t) => {
  const f = await harness(t);
  const a = f.make();
  f.clock.t = Date.parse('2026-10-16T00:10:00Z');
  const times = [];
  for (let n = 0; n < DAILY_REQUESTS + 2; n++) {
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
    // No session within 15 minutes.
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
  // A new process within the 15 minutes waits instead of asking again.
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

test('welcome: an Agent idle 30 s with no open turn is asked at once and the message may wait 3 minutes', async (t) => {
  const f = await harness(t);
  const a = f.make();
  written(f, a);
  f.status({ idle_seconds: 30 });
  assert.equal(await a.welcome(A1), f.clock.t + WELCOME_HOLD_MS);
  assert.equal(f.controls.length, 1);
  // Asked again (a resent report) while the request is on its way: no second request, same kind of hold.
  assert.equal(await a.welcome(A1), f.clock.t + WELCOME_HOLD_MS);
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
  assert.equal(NEW_SESSION_TEXT, 'Agent Market templates were updated; please use the new-session skill to start a new session.');
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
  test(`crash ${name}: no second request within 15 minutes, and one more only after the wait and cooldown`, async (t) => {
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
    for (let i = 0; i < 25; i++) {
      f.advance(ACTIVATION_CHECK_MS);
      f.status();
      await b.tick();
    }
    assert.equal(f.controls.length, controlsAfterCrash);
    // The counted request also holds the cooldown.
    f.advance(REQUEST_COOLDOWN_MS);
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
  assert.equal(await a.welcome(A1), f.clock.t + WELCOME_HOLD_MS);
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
  assert.deepEqual(await f.twoTicks(a), ['sampled', 'requested']);
  assert.equal(f.controls.length, 2);
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
  for (let i = 0; i < 25; i++) {
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
  assert.equal(hold, f.clock.t + WELCOME_HOLD_MS);
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
  assert.equal(h1, f.clock.t + WELCOME_HOLD_MS);
  assert.equal(h2, f.clock.t + WELCOME_HOLD_MS);
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
  assert.equal(await a.welcome(A2), f.clock.t + WELCOME_HOLD_MS);
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
  assert.equal(await s.adopted(A1, S1), f.clock.t + WELCOME_HOLD_MS);
  f.advance(60 * 1000);
  f.status({ idle_seconds: 30 });
  // The first request has not brought its session yet: the second adoption rides on it.
  assert.equal(await s.adopted(A2, S2), f.clock.t + WELCOME_HOLD_MS);
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

test('welcome: with the daily starter cap reached the message is held past 3 minutes and sent once after the session', async (t) => {
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
    assert.equal(await a.welcome(id), f.clock.t + WELCOME_HOLD_MS);
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
  assert.equal(await a.welcome(U(47)), f.clock.t + WELCOME_HOLD_MS);
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
