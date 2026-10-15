import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createScheduler, jittered, POLL_INTERVAL_MS, RECONCILE_INTERVAL_MS } from '../src/scheduler.js';
import { buildHeaders, CLIENT_VERSION, CLIENT_VERSION_HEADER } from '../src/version.js';
import fs from 'node:fs';

test('jitter stays within +/-20%', () => {
  const base = 300_000;
  assert.equal(jittered(base, () => 0), 240_000);
  assert.equal(jittered(base, () => 0.5), 300_000);
  assert.equal(jittered(base, () => 0.9999999), 360_000);
  for (let i = 0; i < 10_000; i++) {
    const v = jittered(base);
    assert.ok(v >= 240_000 && v <= 360_000, String(v));
  }
});

test('jitter clamps out-of-range random values', () => {
  assert.equal(jittered(1000, () => -5), 800);
  assert.equal(jittered(1000, () => 7), 1200);
  assert.equal(jittered(1000, () => NaN), 800);
});

test('intervals: poll ~5 min, reconcile never exceeds 60 min', () => {
  assert.equal(jittered(POLL_INTERVAL_MS, () => 0), 4 * 60_000);
  assert.equal(jittered(POLL_INTERVAL_MS, () => 1), 6 * 60_000);
  assert.ok(jittered(RECONCILE_INTERVAL_MS, () => 1) <= 60 * 60_000);
});

test('scheduler runs each task at start, reschedules with jitter, stops cleanly', async () => {
  const pending = [];
  const runs = [];
  const setTimer = (fn, ms) => { const t = { fn, ms }; pending.push(t); return t; };
  const clearTimer = (t) => { const i = pending.indexOf(t); if (i >= 0) pending.splice(i, 1); };
  const s = createScheduler(
    [{ name: 'a', baseMs: 1000, run: () => runs.push('a') }],
    { rand: () => 1, setTimer, clearTimer },
  );
  s.start();
  assert.equal(pending[0].ms, 0);
  await pending.shift().fn();
  assert.deepEqual(runs, ['a']);
  assert.equal(pending[0].ms, 1200);
  await s.stop();
  assert.equal(pending.length, 0);
});

test('a failing task is logged and rescheduled', async () => {
  const pending = [];
  const errors = [];
  const s = createScheduler(
    [{ name: 'boom', baseMs: 1000, run: () => { throw new Error('x'); } }],
    { rand: () => 0, setTimer: (fn, ms) => { const t = { fn, ms }; pending.push(t); return t; }, clearTimer: () => {},
      logger: { error: (m) => errors.push(m) } },
  );
  s.start();
  await pending.shift().fn();
  assert.match(errors[0], /boom failed/);
  assert.equal(pending[0].ms, 800);
});

test('headers carry bearer key and client version from package.json', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(CLIENT_VERSION, pkg.version);
  assert.equal(CLIENT_VERSION_HEADER, 'X-Market-Client-Version');
  const h = buildHeaders({ api_key: 'k1' }, { Accept: 'application/json' });
  assert.equal(h.Authorization, 'Bearer k1');
  assert.equal(h['X-Market-Client-Version'], pkg.version);
  assert.equal(h.Accept, 'application/json');
  assert.throws(() => buildHeaders({}));
});
