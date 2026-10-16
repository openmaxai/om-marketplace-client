import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { skillPackage } from './fake/package.js';
import { C02, SKILL, crashingState, skillHarness } from './fake/skills.js';

const phase = (p) => (kind, _id, rec) => (kind === 'journal' && rec?.phase === p ? 'after' : false);
const write = (k, name, when) => (kind, n) => (kind === k && n === name ? when : false);

// Installs v1, then dies at `at` while upgrading to v2, then restarts with a fresh instance on the same state.
async function crashUpgrade(t, at) {
  const h = await skillHarness(t, { versions: { 1: skillPackage(), 2: skillPackage('demo-skill', { 'docs/guide.md': 'v2\n' }) } });
  await h.queue(['install', 1]);
  assert.deepEqual(await h.make().runRound(), ['succeeded']);
  await h.queue(['upgrade', 2]);
  assert.deepEqual(await h.make(crashingState(h.state, at)).runRound(), ['deferred']);
  const rid = h.state.read('intents', null).queue[0]?.request_id;
  return { h, rid };
}

function assertUpgraded(h) {
  assert.equal(h.marker().version_no, 2);
  assert.equal(fs.readFileSync(path.join(h.target, 'docs/guide.md'), 'utf8'), 'v2\n');
  const rec = h.state.read('installs', {})[SKILL];
  assert.deepEqual([rec.version_no, rec.state, rec.rollback?.version_no], [2, 'enabled', 1]);
  assert.deepEqual(fs.readdirSync(path.join(h.dataDir, 'rollback', 'demo-skill')), ['1']);
  const upgrades = h.sent(C02).filter((r) => r.json.op === 'upgrade');
  assert.ok(upgrades.every((r) => r.body === upgrades[0].body));
  const rid = upgrades[0].json.request_id;
  assert.equal(h.reqs.get(rid).status, 'succeeded');
  const results = h.sent(`/install-requests/${rid}/result`);
  assert.ok(results.length >= 1 && results.every((r) => r.body === results[0].body));
  assert.deepEqual([h.state.outbox.list(), h.state.read('intents', null).queue], [[], []]);
  assert.ok(['reported', 'closed'].includes(h.state.journal.get(rid).phase));
}

for (const [name, at, outcome, c02] of [
  ['requested', phase('requested'), ['succeeded'], 1],
  ['accepted', phase('accepted'), ['succeeded'], 2],
  ['landing', phase('landing'), ['succeeded'], 2],
  ['landed, before the inventory', write('update', 'installs', 'before'), ['succeeded'], 1],
  ['landed', phase('landed'), ['succeeded'], 1],
  ['outbox written', (kind) => (kind === 'outbox' ? 'after' : false), [], 1],
  ['reporting', phase('reporting'), [], 1],
  ['reported', phase('reported'), ['closed'], 1],
]) {
  test(`a crash after phase ${name} resumes on restart and finishes the upgrade once`, async (t) => {
    const { h } = await crashUpgrade(t, at);
    assert.deepEqual(await h.make().runRound(), outcome);
    assertUpgraded(h);
    assert.equal(h.sent(C02).filter((r) => r.json.op === 'upgrade').length, c02);
    assert.deepEqual(await h.make().runRound(), []);
  });
}

test('a crash inside landing after the old version left puts it back when the market has ended the request', async (t) => {
  const { h, rid } = await crashUpgrade(t, phase('landing'));
  fs.mkdirSync(path.join(h.dataDir, 'rollback', 'demo-skill'), { recursive: true });
  fs.renameSync(h.target, path.join(h.dataDir, 'rollback', 'demo-skill', '1'));
  Object.assign(h.reqs.get(rid), { status: 'failed' });
  assert.deepEqual(await h.make().runRound(), ['closed']);
  assert.equal(h.marker().version_no, 1);
  assert.equal(h.state.read('installs', {})[SKILL].version_no, 1);
  assert.equal(h.sent(`/install-requests/${rid}/result`).length, 0);
});

for (const [name, at] of [
  ['requested', phase('requested')],
  ['the local move', write('update', 'installs', 'after')],
  ['reporting', phase('reporting')],
]) {
  test(`a crash after ${name} of a disable resumes and reports it once with the same body`, async (t) => {
    const h = await skillHarness(t);
    await h.queue(['install', 1]);
    await h.make().runRound();
    await h.queue(['disable']);
    assert.deepEqual(await h.make(crashingState(h.state, at)).runRound(), ['deferred']);
    await h.make().runRound();
    const sent = h.sent(':set-enabled');
    assert.ok(sent.length >= 1 && sent.every((r) => r.body === sent[0].body));
    assert.equal(h.state.read('installs', {})[SKILL].state, 'disabled');
    assert.equal(h.marker(path.join(h.dataDir, 'disabled', 'market--demo-skill')).version_no, 1);
    assert.deepEqual([h.state.outbox.list(), h.state.read('intents', null).queue], [[], []]);
  });
}

test('a crash after a refused success was rolled back but before the outbox entry went rolls back again idempotently', async (t) => {
  const h = await skillHarness(t, { versions: { 1: skillPackage(), 2: skillPackage('demo-skill', { 'docs/guide.md': 'v2\n' }) } });
  await h.queue(['install', 1]);
  await h.make().runRound();
  await h.queue(['upgrade', 2]);
  h.over.c06.push((req) => {
    const r = h.reqs.get(req.path.split('/')[6]);
    Object.assign(r, { status: 'failed', result: req.body, reply: { request_id: req.path.split('/')[6], status: 'failed', error_code: 'PACKAGE_MISMATCH' } });
    return { status: 200, json: r.reply };
  });
  const removeOutbox = (kind, _id, rec) => (kind === 'outbox' && rec === undefined ? 'before' : false);
  assert.deepEqual(await h.make(crashingState(h.state, removeOutbox)).runRound(), ['deferred']);
  assert.equal(h.marker().version_no, 1);
  assert.deepEqual(await h.make().runRound(), []);
  assert.equal(h.marker().version_no, 1);
  assert.equal(h.state.read('installs', {})[SKILL].version_no, 1);
  assert.deepEqual([h.state.outbox.list(), h.state.read('intents', null).queue], [[], []]);
});
