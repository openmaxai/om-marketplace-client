import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { FAKE_KEY, VALID_ENV, tmpHome } from './helpers.js';
import { startFakeMarket } from './fake/market.js';
import { AGENT, ORG, U } from './fake/pull.js';
import { createAuth } from '../src/auth.js';
import { createMarketHttp } from '../src/http.js';
import { MAX_BACKOFF_MS, WATCH_INTERVAL_MS, addWatch, createProposalWatch, watchDir } from '../src/agent/proposal-watch.js';
import { buildTasks } from '../src/app.js';

const A = `/api/v1/orgs/${ORG}/agents/${AGENT}`;
const SILENT = { debug() {}, info() {}, warn() {}, error() {} };
const view = (id, state, over = {}) => ({
  proposal_id: id, agent_id: AGENT, state, candidates: [{ skill_id: U(1), name: 'S', selected: state === 'confirmed' ? true : null, intent_id: state === 'confirmed' ? U(30) : null }],
  created_at: '2026-11-17T10:00:00Z', expires_at: '2026-11-18T10:00:00Z', confirmed_via: state === 'confirmed' ? 'card' : null, ...over,
});

async function setup(t, start = Date.parse('2026-11-17T10:00:00Z')) {
  const fake = await startFakeMarket({ apiKey: FAKE_KEY, memberId: AGENT });
  t.after(fake.close);
  const auth = createAuth({ bffUrl: fake.url, apiKey: VALID_ENV.COCO_API_KEY });
  const http = createMarketHttp({ bffUrl: fake.url, auth });
  const dataDir = path.join(tmpHome(), 'd');
  const clock = { now: start };
  const watch = createProposalWatch({ http, dataDir, logger: SILENT, now: () => clock.now });
  const add = (n, expires = '2026-11-18T10:00:00Z') => addWatch(dataDir, { proposal_id: U(n), org_id: ORG, agent_id: AGENT, expires_at: expires }, clock.now);
  const watched = () => { try { return fs.readdirSync(watchDir(dataDir)).sort(); } catch { return []; } };
  const gets = () => fake.market().filter((r) => r.method === 'GET').length;
  return { fake, watch, add, watched, gets, clock, dataDir };
}

test('nothing pending: no market call', async (t) => {
  const s = await setup(t);
  let pulled = 0;
  assert.equal(await s.watch.tick({ onConfirmed: () => { pulled++; } }), 0);
  assert.equal(s.fake.requests.length, 0);
  assert.equal(pulled, 0);
});

test('a card confirmation pulls once; pending stays watched; declined and gone are dropped', async (t) => {
  const s = await setup(t);
  for (const n of [10, 11, 12, 13]) s.add(n);
  s.fake.script('GET', `${A}/install-proposals/${U(10)}`, { status: 200, json: view(U(10), 'confirmed') });
  s.fake.script('GET', `${A}/install-proposals/${U(11)}`, { status: 200, json: view(U(11), 'pending_confirmation') });
  s.fake.script('GET', `${A}/install-proposals/${U(12)}`, { status: 200, json: view(U(12), 'declined') });
  s.fake.script('GET', `${A}/install-proposals/${U(13)}`, { status: 404, problem: { status: 404, code: 'NOT_FOUND' } });
  let pulled = 0;
  assert.equal(await s.watch.tick({ onConfirmed: () => { pulled++; } }), 1);
  assert.equal(pulled, 1);
  assert.deepEqual(s.watched(), [`${U(11)}.json`]);
});

test('errors back off exponentially up to the cap, then a success resets', async (t) => {
  const s = await setup(t);
  s.add(10);
  const p = `${A}/install-proposals/${U(10)}`;
  const err = { status: 503, problem: { status: 503, code: 'UNAVAILABLE' } };
  s.fake.script('GET', p, ...Array(8).fill(err), { status: 200, json: view(U(10), 'pending_confirmation') });
  const read = () => JSON.parse(fs.readFileSync(path.join(watchDir(s.dataDir), `${U(10)}.json`), 'utf8'));
  await s.watch.tick();
  assert.equal(read().next_at - s.clock.now, 2 * WATCH_INTERVAL_MS);
  await s.watch.tick();
  assert.equal(s.gets(), 1, 'not checked again before next_at');
  for (let i = 0; i < 7; i++) {
    s.clock.now = read().next_at;
    await s.watch.tick();
  }
  assert.equal(read().failures, 8);
  assert.equal(read().next_at - s.clock.now, MAX_BACKOFF_MS);
  s.clock.now = read().next_at;
  await s.watch.tick();
  assert.deepEqual([read().failures, read().next_at], [0, 0]);
});

test('an expired request is dropped without a call', async (t) => {
  const s = await setup(t);
  s.add(10, '2026-11-17T10:01:00Z');
  s.clock.now = Date.parse('2026-11-17T10:04:00Z');
  await s.watch.tick();
  assert.deepEqual(s.watched(), []);
  assert.equal(s.fake.requests.length, 0);
});

test('the service runs the watch every ~15 s and runs the poll round on a confirmation', async () => {
  let ticks = 0;
  let polled = 0;
  const proposals = { tick: async ({ onConfirmed }) => { ticks++; onConfirmed(); } };
  const task = buildTasks(SILENT, { proposals }, null, { pollNow: () => { polled++; } }).find((x) => x.name === 'proposals');
  assert.equal(task.baseMs, 15_000);
  await task.run();
  assert.deepEqual([ticks, polled], [1, 1]);
});
