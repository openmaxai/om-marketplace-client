import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AGENT, ORG, ORG2, U } from './fake/pull.js';
import { fakeCursor } from './fake/market.js';
import { skillMd, skillPackage } from './fake/package.js';
import { buildZip } from './fake/zip.js';
import { B, C02, MARKET, SKILL, VID, problem, skillHarness } from './fake/skills.js';
import { createRevocationPuller } from '../src/revocations.js';
import { inspectInWorker } from '../src/inspect.js';
import { MAX_PACKAGE_BYTES, MAX_PACKAGE_FILES } from '../src/pkg/zip.js';
import { alerts, c02s, downloads, f503, failure, installed, qdir, queueOf, quarantined, v2, v3 } from './fake/skill-cases.js';

test('a package_url that is not this request\'s C-03 path fails CLIENT_INTERNAL without a download', async (t) => {
  const h = await skillHarness(t);
  h.patch.c02 = (rid) => ({ package_url: `https://evil.example.test${B}/agents/${AGENT}/packages/${rid}` });
  await h.queue(['install', 1]);
  assert.deepEqual(await h.make().runRound(), ['failed']);
  assert.deepEqual(h.results().map((r) => r.json), [failure('CLIENT_INTERNAL', 'package_url_invalid')]);
  assert.equal(downloads(h), 0);
});

test('C-03 SHELF_RESPONSE_INVALID is reported as is', async (t) => {
  const h = await skillHarness(t);
  h.over.c03.push(problem(409, 'SHELF_RESPONSE_INVALID'));
  await h.queue(['install', 1]);
  assert.deepEqual(await h.make().runRound(), ['failed']);
  assert.deepEqual(h.results().map((r) => r.json), [failure('SHELF_RESPONSE_INVALID', 'shelf_response_invalid')]);
});

test('a worker out of memory is reported once as CLIENT_INTERNAL and the process keeps running', async (t) => {
  const h = await skillHarness(t);
  const workerUrl = new URL('./fake/oom-worker.js', import.meta.url);
  await h.queue(['install', 1]);
  const s = h.make(h.state, { inspect: (b, o) => inspectInWorker(b, { ...o, workerUrl, resourceLimits: { maxOldGenerationSizeMb: 16 } }) });
  assert.deepEqual(await s.runRound(), ['failed']);
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(h.results().map((r) => r.json), [failure('CLIENT_INTERNAL', 'inspect_out_of_memory')]);
  assert.equal((await inspectInWorker(h.versions[1].zip)).meta.name, 'demo-skill');
});

test('C-03 200 with a different sha256 or size is CLIENT_INTERNAL', async (t) => {
  const h = await skillHarness(t);
  h.over.c03.push({ status: 200, json: { download_url: 'https://storage.googleapis.com/x', expires_at: '2026-10-16T00:05:00Z', sha256: 'ab'.repeat(32), size: 1 } });
  await h.queue(['install', 1]);
  assert.deepEqual(await h.make().runRound(), ['failed']);
  assert.deepEqual(h.results()[0].json, { status: 'failed', error_code: 'CLIENT_INTERNAL', error_message: 'download_metadata_mismatch' });
});

for (const [p, code, msg] of [
  [problem(404, 'VERSION_NOT_FOUND'), 'CLIENT_INTERNAL', 'download_unavailable'],
  [problem(409, 'NOT_APPROVED'), 'CLIENT_INTERNAL', 'download_unavailable'],
  [problem(409, 'VERSION_REVOKED'), 'VERSION_REVOKED', 'version_revoked'],
]) {
  test(`C-03 ${p.status} ${p.problem.code} reports ${code}`, async (t) => {
    const h = await skillHarness(t);
    h.over.c03.push(p);
    await h.queue(['install', 1]);
    assert.deepEqual(await h.make().runRound(), ['failed']);
    assert.deepEqual(h.results()[0].json, { status: 'failed', error_code: code, error_message: msg });
  });
}

for (const [p, c07, outcome, results] of [
  [problem(404, 'NOT_FOUND'), { status: 'failed', error_code: 'INSTALL_TIMEOUT' }, 'closed', []],
  [problem(403, 'AGENT_NOT_SELF'), problem(404, 'NOT_FOUND'), 'closed', []],
  [problem(404, 'NOT_FOUND'), null, 'failed', ['CLIENT_INTERNAL']],
]) {
  test(`C-03 ${p.problem.code} asks C-07 instead of retrying (${c07?.status ?? 'running'})`, async (t) => {
    const h = await skillHarness(t);
    h.over.c03.push(p);
    if (c07?.problem) h.over.c07.push(c07);
    else if (c07) h.over.c07.push((req) => ({ status: 200, json: { request_id: req.path.split('/').at(-1), op: 'install', skill_id: SKILL, ...c07, created_at: '2026-10-16T00:00:00Z' } }));
    await h.queue(['install', 1]);
    assert.deepEqual(await h.make().runRound(), [outcome]);
    assert.deepEqual(h.results().map((r) => r.json.error_code), results);
    assert.equal(h.sent('/packages/' + c02s(h)[0].json.request_id).length, 1);
    assert.deepEqual(queueOf(h), []);
  });
}

test('C-03 MEMBER_LEFT_ORG marks the org and defers', async (t) => {
  const h = await skillHarness(t);
  h.over.c03.push(problem(403, 'MEMBER_LEFT_ORG', { reason: 'member_departed' }));
  await h.queue(['install', 1]);
  assert.deepEqual(await h.make().runRound(), ['deferred']);
  assert.equal(h.orgs.membership(ORG), 'invalid');
  assert.equal(h.results().length, 0);
});

test('C-03 429 and 503 are retried; a persistent 503 defers and the next round replays C-02 for a fresh URL', async (t) => {
  const h = await skillHarness(t);
  h.over.c03.push(problem(429, 'RATE_LIMITED'), f503, f503, f503);
  await h.queue(['install', 1]);
  const s = h.make();
  assert.deepEqual(await s.runRound(), ['deferred']);
  assert.deepEqual(await s.runRound(), ['succeeded']);
  assert.equal(c02s(h).length, 2);
  assert.equal(c02s(h)[0].body, c02s(h)[1].body);
});

test('C-06 200 failed INSTALL_TIMEOUT keeps what landed', async (t) => {
  const h = await skillHarness(t);
  h.over.c06.push((req) => ({ status: 200, json: { request_id: req.path.split('/')[6], status: 'failed', error_code: 'INSTALL_TIMEOUT' } }));
  await h.queue(['install', 1]);
  assert.deepEqual(await h.make().runRound(), ['succeeded']);
  assert.equal(h.marker().version_no, 1);
  assert.equal(h.state.read('installs', {})[SKILL].version_no, 1);
});

for (const code of ['PACKAGE_MISMATCH', 'VERSION_REVOKED']) {
  test(`C-06 200 failed ${code} after a reported success rolls the landing back`, async (t) => {
    const { h, s } = await installed(t, { versions: { 1: skillPackage(), 2: v2() } });
    h.over.c06.push((req) => ({ status: 200, json: { request_id: req.path.split('/')[6], status: 'failed', error_code: code } }));
    await h.queue(['upgrade', 2]);
    await s.runRound();
    assert.equal(h.marker().version_no, 1);
    assert.equal(h.state.read('installs', {})[SKILL].version_no, 1);
    // A version the market calls revoked is quarantined even before C-11 says so; anything else is discarded.
    assert.deepEqual(quarantined(h), code === 'VERSION_REVOKED' ? { [`2-${VID(2)}`]: 2 } : {});
    assert.deepEqual(h.state.outbox.list(), []);
    h.over.c06.push((req) => ({ status: 200, json: { request_id: req.path.split('/')[6], status: 'failed', error_code: code } }));
    await s.uninstall(SKILL);
    await h.queue(['install', 2]);
    await s.runRound();
    assert.equal(fs.existsSync(h.target), false);
    assert.equal(h.state.read('installs', {})[SKILL], undefined);
  });
}

for (const p of [problem(400, 'VALIDATION_FAILED'), problem(404, 'NOT_FOUND'), problem(409, 'REQUEST_ID_CONFLICT')]) {
  test(`C-06 ${p.status} ${p.problem.code} drops the report with an alert and keeps the landing`, async (t) => {
    const h = await skillHarness(t);
    h.over.c06.push(p);
    await h.queue(['install', 1]);
    assert.deepEqual(await h.make().runRound(), ['succeeded']);
    assert.deepEqual([h.state.outbox.list().length, queueOf(h).length], [0, 0]);
    assert.match(alerts(h), new RegExp(p.problem.code));
    assert.equal(h.marker().version_no, 1);
  });
}

test('C-06 503 keeps the report in the outbox and resends it unchanged before anything else', async (t) => {
  const h = await skillHarness(t);
  h.over.c06.push(f503);
  await h.queue(['install', 1]);
  const s = h.make();
  assert.deepEqual(await s.runRound(), ['deferred']);
  assert.equal(h.state.outbox.list().length, 1);
  assert.deepEqual(await s.runRound(), []);
  const [a, b] = h.results();
  assert.equal(a.body, b.body);
  assert.deepEqual([h.state.outbox.list().length, queueOf(h).length, c02s(h).length], [0, 0, 1]);
});

test('an unsafe package is PACKAGE_UNSAFE and a wrong storage sha256 is PACKAGE_MISMATCH; nothing lands', async (t) => {
  const zip = buildZip([{ name: 'SKILL.md', data: skillMd('demo-skill', 'hooks: x\n') }]);
  const bad = { zip, sha: crypto.createHash('sha256').update(zip).digest('hex'), size: zip.length, manifest: [] };
  const h = await skillHarness(t, { versions: { 1: bad } });
  await h.queue(['install', 1]);
  assert.deepEqual(await h.make().runRound(), ['failed']);
  assert.match(h.results()[0].json.error_message, /^SKILL_FRONTMATTER_KEY_NOT_ALLOWED at line \d+$/);
  assert.deepEqual(fs.readdirSync(h.skillsDir), []);
  const pkg = skillPackage();
  const altered = Buffer.from(pkg.zip);
  altered[12] ^= 1;
  const m = await skillHarness(t, { versions: { 1: { ...pkg, zip: altered } } });
  await m.queue(['install', 1]);
  assert.deepEqual(await m.make().runRound(), ['failed']);
  assert.deepEqual(m.results().map((r) => r.json), [failure('PACKAGE_MISMATCH', 'sha256_mismatch')]);
  assert.deepEqual(fs.readdirSync(m.skillsDir), []);
});
