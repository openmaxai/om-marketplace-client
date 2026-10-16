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


test('install runs C-02, C-03, download, land and C-06 and records the inventory', async (t) => {
  const { h } = await installed(t);
  const [c02] = c02s(h);
  const rid = c02.json.request_id;
  assert.deepEqual(c02.json, { request_id: rid, skill_id: SKILL, skill_version_id: VID(1), op: 'install', intent_id: c02.json.intent_id, market: MARKET });
  assert.deepEqual(h.results().map((r) => r.json), [{ status: 'succeeded', installed_sha256: h.versions[1].sha }]);
  assert.equal(h.storage.requests[0].headers.authorization, undefined);
  assert.equal(fs.readFileSync(path.join(h.target, 'docs/guide.md'), 'utf8'), 'guide\n');
  const rec = h.state.read('installs', {})[SKILL];
  assert.deepEqual([rec.org_id, rec.version_no, rec.state, rec.skill_version_id, rec.rollback], [ORG, 1, 'enabled', VID(1), null]);
  assert.deepEqual(queueOf(h), []);
  assert.equal(h.state.journal.get(rid).phase, 'reported');
});

test('upgrade lands the higher version, keeps the old one in the rollback area, and stays disabled when disabled', async (t) => {
  const { h, s } = await installed(t, { versions: { 1: skillPackage(), 2: v2(), 3: v3() } });
  await h.queue(['upgrade', 2], ['disable'], ['upgrade', 3]);
  assert.deepEqual(await s.runRound(), ['succeeded', 'done', 'succeeded']);
  assert.equal(c02s(h)[1].json.op, 'upgrade');
  const rec = h.state.read('installs', {})[SKILL];
  assert.deepEqual([rec.version_no, rec.state, rec.rollback], [3, 'disabled', { version_no: 2, skill_version_id: VID(2) }]);
  assert.equal(fs.existsSync(h.target), false);
  assert.equal(h.marker(path.join(h.dataDir, 'disabled', 'market--demo-skill')).version_no, 3);
  assert.deepEqual(fs.readdirSync(path.join(h.dataDir, 'rollback', 'demo-skill')), ['2']);
});

test('upgrade monotonicity: not higher is refused; a lower version is allowed only when the installed one is revoked', async (t) => {
  const { h, s } = await installed(t, { versions: { 1: skillPackage(), 2: v2() } });
  await h.queue(['upgrade', 2]);
  await s.runRound();
  await h.queue(['upgrade', 1]);
  assert.deepEqual(await s.runRound(), ['failed']);
  assert.deepEqual(h.results().at(-1).json, { status: 'failed', error_code: 'INSTALL_TARGET_CONFLICT', error_message: 'not_higher' });
  assert.equal(h.marker().version_no, 2);
  h.state.write('revoked', { skill_version_id: [VID(2)] });
  await h.queue(['upgrade', 1]);
  assert.deepEqual(await s.runRound(), ['succeeded']);
  assert.equal(h.marker().version_no, 1);
  assert.deepEqual(quarantined(h), { [`2-${VID(2)}`]: 2 });
});

test('C-02 201 with a bad shape is reported as CLIENT_INTERNAL', async (t) => {
  const h = await skillHarness(t);
  h.over.c02.push((req) => ({ status: 201, json: { request_id: req.json.request_id, status: 'running' } }));
  await h.queue(['install', 1]);
  assert.deepEqual(await h.make().runRound(), ['failed']);
  assert.deepEqual(h.results().map((r) => r.json), [{ status: 'failed', error_code: 'CLIENT_INTERNAL', error_message: 'install_response_invalid' }]);
});

test('C-02 200 ALREADY_INSTALLED closes the intent without download or result', async (t) => {
  const h = await skillHarness(t);
  h.over.c02.push((req) => ({ status: 200, json: { request_id: req.json.request_id, status: 'succeeded', code: 'ALREADY_INSTALLED' } }));
  await h.queue(['install', 1]);
  assert.deepEqual(await h.make().runRound(), ['closed']);
  assert.deepEqual([h.results().length, h.storage.requests.length, queueOf(h).length], [0, 0, 0]);
  assert.match(h.lines.join('\n'), /missing locally/);
});

for (const [p, alert] of [
  [problem(404, 'VERSION_NOT_FOUND'), /VERSION_NOT_FOUND/],
  [problem(409, 'VERSION_REVOKED'), /VERSION_REVOKED/],
  [problem(409, 'NOT_APPROVED'), /NOT_APPROVED/],
  [problem(409, 'SKILL_ALREADY_INSTALLED', { installed_by_org_id: ORG2 }), new RegExp(`already installed by org ${ORG2}`)],
  [problem(403, 'INSTALLED_BY_OTHER_ORG', { installed_by_org_id: ORG2 }), new RegExp(`already installed by org ${ORG2}`)],
  [problem(403, 'AGENT_NOT_SELF'), /AGENT_NOT_SELF/],
  [problem(409, 'REQUEST_ID_CONFLICT'), /REQUEST_ID_CONFLICT/],
  [problem(400, 'VALIDATION_FAILED', { reason: 'not_higher' }), null],
  [problem(400, 'VALIDATION_FAILED', { reason: 'not_installed' }), null],
  [problem(409, 'INTENT_NOT_PENDING'), null],
  [problem(409, 'INTENT_EXPIRED'), null],
]) {
  test(`C-02 ${p.status} ${p.problem.code}${p.problem.reason ? ` ${p.problem.reason}` : ''} closes the intent, no result, no retry`, async (t) => {
    const h = await skillHarness(t);
    h.over.c02.push(p);
    await h.queue(['install', 1]);
    const s = h.make();
    assert.deepEqual(await s.runRound(), ['closed']);
    assert.deepEqual(await s.runRound(), []);
    assert.deepEqual([c02s(h).length, h.results().length, queueOf(h).length, h.storage.requests.length], [1, 0, 0, 0]);
    if (alert) assert.match(alerts(h), alert);
    else assert.equal(alerts(h), '');
  });
}

test('C-02 INTENT_OUT_OF_ORDER holds the org back for the round and replays the same body next round', async (t) => {
  const h = await skillHarness(t);
  h.over.c02.push(problem(409, 'INTENT_OUT_OF_ORDER'));
  await h.queue(['install', 1], ['disable']);
  const s = h.make();
  assert.deepEqual(await s.runRound(), ['deferred']);
  assert.equal(h.sent(':set-enabled').length, 0);
  assert.deepEqual(await s.runRound(), ['succeeded', 'done']);
  const [a, b] = c02s(h);
  assert.equal(a.body, b.body);
});

for (const p of [problem(429, 'RATE_LIMITED', {}), f503]) {
  test(`C-02 ${p.status} is retried with the same request id and body after C-07 finds no request`, async (t) => {
    const h = await skillHarness(t);
    h.over.c02.push(p);
    await h.queue(['install', 1]);
    const s = h.make();
    assert.deepEqual(await s.runRound(), ['deferred']);
    assert.deepEqual(await s.runRound(), ['succeeded']);
    const [a, b] = c02s(h);
    assert.equal(a.body, b.body);
    assert.equal(h.sent(`/install-requests/${a.json.request_id}`).length, 1);
  });
}

test('C-02 CLIENT_VERSION_TOO_OLD enters too-old mode and stops executing intents', async (t) => {
  const h = await skillHarness(t);
  h.over.c02.push(problem(409, 'CLIENT_VERSION_TOO_OLD', { reason: 'below_minimum', min_version: '9.0.0' }));
  await h.queue(['install', 1], ['disable']);
  const s = h.make();
  assert.deepEqual(await s.runRound(), ['deferred']);
  assert.equal(h.state.read('gate', {}).too_old.min_version, '9.0.0');
  assert.deepEqual(await s.runRound(), []);
});


test('the version and package sha the market selected are checked against the revoked set before downloading', async (t) => {
  for (const [revoked, message] of [
    [{ skill_version_id: [VID(1)] }, 'version_revoked'],
    [{ package_sha256: ['sha'] }, 'sha_blocked'],
    [{ sha_block: ['sha'] }, 'sha_blocked'],
  ]) {
    const h = await skillHarness(t);
    await h.queue(['install']);
    const key = Object.keys(revoked)[0];
    h.state.write('revoked', { [key]: revoked[key].map((v) => (v === 'sha' ? h.versions[1].sha : v)) });
    assert.deepEqual(await h.make().runRound(), ['failed'], message);
    assert.equal(c02s(h)[0].json.skill_version_id, undefined);
    assert.deepEqual(h.results().map((r) => r.json), [failure('VERSION_REVOKED', message)]);
    assert.equal(downloads(h), 0);
    assert.deepEqual(fs.readdirSync(h.skillsDir), []);
    assert.deepEqual(queueOf(h), []);
  }
});

test('a package over the size or file caps is PACKAGE_UNSAFE before downloading', async (t) => {
  const pkg = skillPackage();
  const big = pkg.manifest.map((e, i) => (i === 0 ? { ...e, size: MAX_PACKAGE_BYTES } : e));
  const many = Array.from({ length: MAX_PACKAGE_FILES + 1 }, (_, i) => ({ path: `f${i}`, size: 1, sha256: 'a'.repeat(64) }));
  for (const [over, message] of [
    [{ size_bytes: MAX_PACKAGE_BYTES + 1 }, 'too_large'],
    [{ file_manifest: big }, 'too_large'],
    [{ file_manifest: many }, 'too_many_files'],
  ]) {
    const h = await skillHarness(t, { versions: { 1: pkg } });
    h.patch.c02 = () => over;
    await h.queue(['install', 1]);
    assert.deepEqual(await h.make().runRound(), ['failed'], message);
    assert.deepEqual(h.results().map((r) => r.json), [failure('PACKAGE_UNSAFE', message)]);
    assert.equal(downloads(h), 0);
  }
  const edge = await skillHarness(t, { versions: { 1: pkg } });
  edge.patch.c02 = () => ({ size_bytes: MAX_PACKAGE_BYTES });
  await edge.queue(['install', 1]);
  assert.deepEqual(await edge.make().runRound(), ['failed']);
  assert.deepEqual(edge.results().map((r) => r.json.error_message), ['download_metadata_mismatch']);
});

test('the caps are inclusive: exactly 200 files and a manifest of exactly 20 MiB pass, one more is refused', async (t) => {
  const pkg = skillPackage();
  const rest = pkg.manifest.slice(1).reduce((n, e) => n + e.size, 0);
  const total = (extra) => pkg.manifest.map((e, i) => (i === 0 ? { ...e, size: MAX_PACKAGE_BYTES - rest + extra } : e));
  const files = (n) => Array.from({ length: n }, (_, i) => ({ path: `f${i}`, size: 1, sha256: 'a'.repeat(64) }));
  for (const [manifest, refused] of [
    [total(0), null], [total(1), 'too_large'], [files(MAX_PACKAGE_FILES), null], [files(MAX_PACKAGE_FILES + 1), 'too_many_files'],
  ]) {
    const h = await skillHarness(t, { versions: { 1: pkg } });
    h.patch.c02 = () => ({ file_manifest: manifest });
    await h.queue(['install', 1]);
    assert.deepEqual(await h.make().runRound(), ['failed']);
    const why = `${manifest.length} files, ${manifest.reduce((n, e) => n + e.size, 0)} bytes`;
    if (refused) {
      assert.deepEqual(h.results().map((r) => r.json), [failure('PACKAGE_UNSAFE', refused)], why);
      assert.equal(downloads(h), 0, why);
    } else {
      assert.deepEqual(h.results().map((r) => r.json), [failure('PACKAGE_MISMATCH', 'file_manifest_mismatch')], why);
      assert.ok(downloads(h) > 0, why);
    }
  }
});
