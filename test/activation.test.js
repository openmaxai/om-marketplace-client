import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AGENT, ORG, U, pullHarness } from './fake/pull.js';
import { tmpHome } from './helpers.js';
import { Crash, crashingState } from './fake/skills.js';
import {
  ACTIVATION_CHECK_MS, CONFIRM_WAIT_MS, DAILY_REQUESTS, IDLE_MIN_SECONDS, MAX_REQUESTS, NEW_SESSION_TEXT, REQUEST_COOLDOWN_MS,
  STATUS_MAX_AGE_MS, STUCK_ALERT, WELCOME_HOLD_MS, controlEnqueue, createActivation, readRuntimeStatus,
} from '../src/activation.js';
import { createReconciler } from '../src/reconcile.js';
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
async function harness(t, { turn = () => false, imAvailable = true, enqueueError = null, state: wrap = (s) => s } = {}) {
  const h = await pullHarness(t, { orgs: {} });
  const statusFile = path.join(tmpHome(), 'agent-status.json');
  const controls = [];
  const im = { available: () => imAvailable, openTurn: async () => { const r = turn(); if (r instanceof Error) throw r; return r; } };
  const reconcile = createReconciler({ api: h.api, state: h.state, orgs: h.orgs, skills: null, logger: h.logger, now: h.now });
  const enqueue = async () => {
    if (enqueueError) throw enqueueError;
    controls.push(h.clock.t);
  };
  const make = (state = wrap(h.state), extra = {}) => createActivation({
    state, dataDir: h.dataDir, zylosDir: tmpHome(), logger: h.logger, im, flush: () => reconcile.flushUrgent(), now: h.now, statusFile, enqueue, ...extra,
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
  return { ...h, statusFile, controls, reconcile, make, status, adopt, marker, advance, reports, pending, alert, twoTicks };
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
  test(`welcome: ${name} means no request and no wait`, async (t) => {
    const f = await harness(t, opts);
    const a = f.make();
    written(f, a);
    f.status(over);
    assert.equal(await a.welcome(A1), null);
    assert.deepEqual(f.controls, []);
  });
}

test('welcome: an adoption without a pending write is not held', async (t) => {
  const f = await harness(t);
  f.status();
  assert.equal(await f.make().welcome(A1), null);
});

test('the control queue request: new-session text, held until idle, no ack suffix, no deadline, state honoured', async () => {
  const calls = [];
  const run = (file, args, opts, cb) => { calls.push({ file, args, opts }); cb(null, 'OK: enqueued control 7\n', ''); };
  await controlEnqueue('/z', { run })();
  assert.equal(calls[0].file, process.execPath);
  assert.deepEqual(calls[0].args, [
    '/z/.claude/skills/comm-bridge/scripts/c4-control.js', 'enqueue', '--content', NEW_SESSION_TEXT, '--block-queue-until-idle', '--no-ack-suffix',
  ]);
  assert.equal(NEW_SESSION_TEXT, 'Agent Market templates were updated; please use the new-session skill to start a new session.');
  assert.ok(!calls[0].args.includes('--bypass-state') && !calls[0].args.includes('--ack-deadline'));
  await assert.rejects(controlEnqueue('/z', { run: (f, a, o, cb) => cb(Object.assign(new Error('x'), { code: 1 }), '', 'err') })(), /exit 1/);
  await assert.rejects(controlEnqueue('/z', { run: (f, a, o, cb) => cb(null, 'nothing', '') })(), /no confirmation/);
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
      enqueue: async () => { throw new Error('not expected'); },
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
    enqueue: async () => {},
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
      enqueue: async () => {
        f.controls.push(f.clock.t);
        killed = true;
        throw new Crash('killed');
      },
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
