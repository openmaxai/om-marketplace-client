import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { skillPackage } from './fake/package.js';
import { C02, Crash, SKILL, VID, crashingState, problem, skillHarness } from './fake/skills.js';
import { quarantined } from './fake/skill-cases.js';

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

test('a version revoked while the process was down after landing is reported VERSION_REVOKED and the old one comes back', async (t) => {
  const { h, rid } = await crashUpgrade(t, write('update', 'installs', 'before'));
  assert.equal(h.marker().version_no, 2);
  h.state.write('revoked', { skill_version_id: [VID(2)] });
  assert.deepEqual(await h.make().runRound(), ['failed']);
  assert.deepEqual(h.sent(`/install-requests/${rid}/result`).map((r) => r.json),
    [{ status: 'failed', error_code: 'VERSION_REVOKED', error_message: 'version_revoked' }]);
  assert.equal(h.marker().version_no, 1);
  const rec = h.state.read('installs', {})[SKILL];
  assert.deepEqual([rec.version_no, rec.state], [1, 'enabled']);
  const q = path.join(h.dataDir, 'quarantine', 'market--demo-skill');
  assert.deepEqual(fs.readdirSync(q), [`2-${VID(2)}`]);
});

// rmSync that deletes the marker first and then dies, like a recursive delete killed part way.
function dyingRm(t) {
  const real = fs.rmSync;
  let dead = false;
  t.mock.method(fs, 'rmSync', (p, opts) => {
    if (dead || !fs.existsSync(path.join(p, '.market-managed'))) return real(p, opts);
    dead = true;
    fs.unlinkSync(path.join(p, '.market-managed'));
    throw new Crash('rm');
  });
  return () => t.mock.restoreAll();
}

test('an uninstall dying inside the recursive delete leaves nothing in skills/ and finishes on restart', async (t) => {
  const h = await skillHarness(t);
  await h.queue(['install', 1]);
  await h.make().runRound();
  await h.queue(['uninstall']);
  const restore = dyingRm(t);
  assert.deepEqual(await h.make().runRound(), ['deferred']);
  restore();
  assert.equal(fs.existsSync(h.target), false);
  assert.deepEqual(await h.make().runRound(), ['done']);
  assert.equal(h.state.read('installs', {})[SKILL], undefined);
  assert.deepEqual(fs.readdirSync(path.join(h.dataDir, 'trash')), []);
});

test('a rollback dying inside the delete of the refused version still restores the old one on restart', async (t) => {
  const h = await skillHarness(t, { versions: { 1: skillPackage(), 2: skillPackage('demo-skill', { 'docs/guide.md': 'v2\n' }) } });
  await h.queue(['install', 1]);
  await h.make().runRound();
  let restore = () => {};
  h.over.c06.push((req) => {
    const r = h.reqs.get(req.path.split('/')[6]);
    Object.assign(r, { status: 'failed', result: req.body, reply: { request_id: req.path.split('/')[6], status: 'failed', error_code: 'PACKAGE_MISMATCH' } });
    restore = dyingRm(t);
    return { status: 200, json: r.reply };
  });
  await h.queue(['upgrade', 2]);
  assert.deepEqual(await h.make().runRound(), ['deferred']);
  restore();
  assert.notEqual(h.marker()?.version_no, 2);
  assert.deepEqual(await h.make().runRound(), []);
  assert.equal(h.marker().version_no, 1);
  assert.equal(fs.readFileSync(path.join(h.target, 'docs/guide.md'), 'utf8'), 'guide\n');
  assert.equal(h.state.read('installs', {})[SKILL].version_no, 1);
  assert.deepEqual(fs.readdirSync(path.join(h.dataDir, 'rollback', 'demo-skill')), []);
});

const revokedResult = (message = 'version_revoked') => ({ status: 'failed', error_code: 'VERSION_REVOKED', error_message: message });
const alertText = (h) => Object.keys(h.state.read('status', { alerts: {} }).alerts).join('\n');
// The journal holds C-02's answer (after) or only the request (before: the market accepted C-02, the answer was lost).
const accepted = (when) => (kind, _id, rec) => (kind === 'journal' && rec?.phase === 'accepted' ? when : false);

// One result body, sent `sends` times unchanged.
function assertRevokedOnce(h, rid, message = 'version_revoked', sends = 1) {
  const results = h.sent(`/install-requests/${rid}/result`);
  assert.deepEqual(results.map((r) => r.json), Array(sends).fill(revokedResult(message)));
  assert.ok(results.every((r) => r.body === results[0].body));
  assert.equal(h.reqs.get(rid).status, 'failed');
  assert.equal(h.marker().version_no, 1);
  assert.equal(fs.readFileSync(path.join(h.target, 'docs/guide.md'), 'utf8'), 'guide\n');
  const rec = h.state.read('installs', {})[SKILL];
  assert.deepEqual([rec.version_no, rec.state], [1, 'enabled']);
  assert.deepEqual([h.state.outbox.list(), h.state.read('intents', null).queue], [[], []]);
  assert.equal(h.state.journal.get(rid).phase, 'reported');
  assert.equal(h.storage.requests.length, 1, 'only v1 was downloaded');
}

for (const [p, when] of [
  [problem(404, 'VERSION_NOT_FOUND'), 'after'], [problem(409, 'VERSION_REVOKED'), 'after'],
  [problem(404, 'VERSION_NOT_FOUND'), 'before'], [problem(409, 'VERSION_REVOKED'), 'before'],
]) {
  test(`a picked upgrade whose C-02 replay after a restart gets ${p.status} ${p.problem.code} (journal ${when} accepted) is reported VERSION_REVOKED once`, async (t) => {
    const { h, rid } = await crashUpgrade(t, accepted(when));
    assert.equal(h.reqs.get(rid).status, 'running');
    h.over.c02.push(p);
    assert.deepEqual(await h.make().runRound(), ['failed']);
    assert.equal(h.sent(C02).filter((r) => r.json.op === 'upgrade').length, 2);
    assertRevokedOnce(h, rid);
    assert.equal(alertText(h), '');
    assert.deepEqual(await h.make().runRound(), []);
    assert.equal(h.sent(`/install-requests/${rid}/result`).length, 1);
  });
}

test('a C-02 replay refused as revoked for a request the market does not have is closed with an alert, not reported', async (t) => {
  const { h, rid } = await crashUpgrade(t, accepted('before'));
  h.reqs.delete(rid);
  h.over.c07.push({ status: 404, problem: { status: 404, code: 'NOT_FOUND' } });
  h.over.c02.push(problem(409, 'VERSION_REVOKED'));
  assert.deepEqual(await h.make().runRound(), ['closed']);
  assert.equal(h.sent(`/install-requests/${rid}/result`).length, 0);
  assert.match(alertText(h), /^intent:/);
});

for (const [revoked, message] of [
  [{ skill_version_id: [VID(2)] }, 'version_revoked'],
  [{ sha_block: ['v2'] }, 'sha_blocked'],
  [{ package_sha256: ['v2'] }, 'sha_blocked'],
]) {
  test(`after a restart, a running request whose stored C-02 answer is now revoked (${message}, ${Object.keys(revoked)[0]}) is reported without a replay`, async (t) => {
    const { h, rid } = await crashUpgrade(t, accepted('after'));
    const key = Object.keys(revoked)[0];
    h.state.write('revoked', { [key]: revoked[key].map((v) => (v === 'v2' ? h.versions[2].sha : v)) });
    assert.deepEqual(await h.make().runRound(), ['failed']);
    assert.equal(h.sent(C02).filter((r) => r.json.op === 'upgrade').length, 1);
    assertRevokedOnce(h, rid, message);
    assert.deepEqual(await h.make().runRound(), []);
    assert.equal(h.sent(`/install-requests/${rid}/result`).length, 1);
  });
}

test('a VERSION_REVOKED report for a replayed request survives a crash and is resent byte-identical', async (t) => {
  const { h, rid } = await crashUpgrade(t, accepted('after'));
  h.over.c02.push(problem(409, 'VERSION_REVOKED'));
  h.over.c06.push(problem(503, 'DEPENDENCY_UNAVAILABLE'));
  const outbox = (kind, _id, rec) => (kind === 'journal' && rec?.phase === 'reporting' ? 'after' : false);
  assert.deepEqual(await h.make(crashingState(h.state, outbox)).runRound(), ['deferred']);
  assert.deepEqual(h.state.outbox.list(), [rid]);
  assert.deepEqual(await h.make().runRound(), []);
  assert.deepEqual(await h.make().runRound(), []);
  assertRevokedOnce(h, rid, 'version_revoked', 2);
  assert.deepEqual(quarantined(h), {});
});

test('409 REQUEST_ID_CONFLICT to a VERSION_REVOKED report is final and only logged; to another report it still alerts', async (t) => {
  const { h, rid } = await crashUpgrade(t, accepted('after'));
  h.over.c02.push(problem(409, 'VERSION_REVOKED'));
  h.over.c06.push(problem(409, 'REQUEST_ID_CONFLICT'));
  assert.deepEqual(await h.make().runRound(), ['failed']);
  assert.deepEqual(h.state.outbox.list(), []);
  assert.equal(alertText(h), '');
  assert.match(h.lines.join('\n'), new RegExp(`result report ${rid} refused \\(REQUEST_ID_CONFLICT\\); the market already closed it`));
  assert.deepEqual(await h.make().runRound(), []);
  assert.equal(h.sent(`/install-requests/${rid}/result`).length, 1);

  const g = await skillHarness(t);
  g.over.c06.push(problem(409, 'REQUEST_ID_CONFLICT'));
  await g.queue(['install', 1]);
  const s = g.make();
  assert.deepEqual(await s.runRound(), ['succeeded']);
  assert.match(alertText(g), /^report:/);
  assert.deepEqual(await s.runRound(), []);
  assert.equal(g.results().length, 1);

  const k = await skillHarness(t);
  k.over.c06.push(problem(409, 'REQUEST_ID_CONFLICT'));
  k.state.write('revoked', { skill_version_id: [VID(1)] });
  await k.queue(['install']);
  assert.deepEqual(await k.make().runRound(), ['failed']);
  assert.equal(alertText(k), '');
  k.patch.c02 = () => ({ size_bytes: 1e9 });
  k.state.write('revoked', { skill_version_id: [] });
  k.over.c06.push(problem(409, 'REQUEST_ID_CONFLICT'));
  await k.queue(['install']);
  assert.deepEqual(await k.make().runRound(), ['failed']);
  assert.match(alertText(k), /^report:/);
});
