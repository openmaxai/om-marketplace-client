import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AGENT, ORG, U, pullHarness } from './fake/pull.js';
import { startFakeStorage } from './fake/storage.js';
import { skillMd, skillPackage } from './fake/package.js';
import { buildZip } from './fake/zip.js';
import { createIntentPuller } from '../src/intents.js';
import { createInstaller } from '../src/install.js';
import { inspectInWorker } from '../src/inspect.js';
import { MAX_PACKAGE_BYTES, MAX_PACKAGE_FILES } from '../src/pkg/zip.js';
import { POLICY_SHA256 } from '../src/policy/pin.js';

const SKILL = U(1);
const VERSION = U(2);
const MARKET = U(3);
const INTENT = U(4);
const B = `/api/v1/orgs/${ORG}`;

// Fake market and storage through C-01, C-02 and C-03; `served` is what storage answers for the package.
const f503 = { status: 503, problem: { code: 'DEPENDENCY_UNAVAILABLE' } };
const echo = (req) => ({ status: 200, json: { request_id: req.path.split('/')[5], status: req.json.status, error_code: req.json.error_code } });

// c02 and c06 list answers given before the scripted C-02 and in place of the echoed C-06; c02Over replaces fields of the
// scripted C-02 answer; version is the intent's skill_version_id (null lets the market pick).
async function flow(t, {
  pkg = skillPackage(), served = pkg.zip, c02 = [], c06 = [echo], c02Over = () => ({}), version = VERSION, revoked = null, inspect,
} = {}) {
  const h = await pullHarness(t, { orgs: {} });
  const storage = await startFakeStorage();
  t.after(storage.close);
  const skillsDir = path.join(path.dirname(h.dataDir), 'skills');
  fs.mkdirSync(skillsDir);
  h.fake.script('POST', `${B}/agents/${AGENT}/install-intents:query`, { status: 200, json: {
    items: [{ id: INTENT, org_id: ORG, op: 'install', skill_id: SKILL, skill_version_id: version, template_id: null, source_market_id: MARKET,
      adoption_id: null, discard_local_changes: false, expires_at: '2026-10-17T00:00:00Z', seq: 1 }],
    has_more: false, next_after_seq: 1, policy_sha256: POLICY_SHA256,
  } });
  h.fake.script('POST', `${B}/agents/${AGENT}/install-requests`, ...c02, (req) => {
    const rid = req.json.request_id;
    const sub = `${B}/agents/${AGENT}/packages/${rid}`;
    h.fake.script('POST', `${B}/install-requests/${rid}/result`, ...c06);
    h.fake.script('GET', sub, { status: 200, json: {
      download_url: storage.serve(`/b/${rid}`, { status: 200, body: served }), expires_at: '2026-10-16T00:05:00Z', sha256: pkg.sha, size: pkg.size,
    } });
    return { status: 201, json: {
      request_id: rid, install_id: U(5), skill_id: SKILL, slug: 'demo-skill', skill_version_id: VERSION, version_no: 1, source_market_id: MARKET,
      package_url: `${h.fake.url}${sub}`, package_sha256: pkg.sha, size_bytes: pkg.size, file_manifest: pkg.manifest,
      skill_md: { name: 'demo-skill', description: 'A test skill' }, status: 'running', ...c02Over(rid),
    } };
  });
  await createIntentPuller({ api: h.api, state: h.state, orgs: h.orgs, logger: h.logger, now: h.now }).pull();
  if (revoked) h.state.write('revoked', revoked);
  const installer = createInstaller({
    api: h.api, state: h.state, orgs: h.orgs, logger: h.logger, bffUrl: h.fake.url, skillsDir, dataDir: h.dataDir,
    emulatorOrigin: storage.origin, now: h.now, sleep: async () => {}, ...(inspect ? { inspect } : {}),
  });
  const results = () => h.fake.requests.filter((r) => r.path.endsWith('/result'));
  const downloads = () => h.fake.requests.filter((r) => r.path.includes('/packages/')).length + storage.requests.length;
  return { ...h, storage, skillsDir, installer, pkg, results, downloads };
}

const failure = (code, message) => ({ status: 'failed', error_code: code, error_message: message });

test('one queued install intent runs end to end: C-01, C-02, C-03, download, inspect, land, C-06', async (t) => {
  const f = await flow(t);
  assert.equal(await f.installer.runNext(), 'succeeded');
  const [c02] = f.fake.requests.filter((r) => r.path.endsWith('/install-requests'));
  const rid = c02.json.request_id;
  assert.deepEqual(c02.json, { request_id: rid, skill_id: SKILL, skill_version_id: VERSION, op: 'install', intent_id: INTENT, market: MARKET });
  assert.match(rid, /^[0-9a-f]{8}-[0-9a-f]{4}-7/);
  assert.deepEqual(f.results().map((r) => [r.path, r.json]), [[`${B}/install-requests/${rid}/result`, { status: 'succeeded', installed_sha256: f.pkg.sha }]]);
  assert.equal(f.storage.requests[0].headers.authorization, undefined);
  assert.equal(fs.readFileSync(path.join(f.skillsDir, 'market--demo-skill', 'docs/guide.md'), 'utf8'), 'guide\n');
  assert.deepEqual(f.state.read('intents', null).queue, []);
  assert.equal(f.state.journal.get(rid).phase, 'reported');
  assert.equal(await f.installer.runNext(), null);
});

test('a wrong sha256 from storage is reported as PACKAGE_MISMATCH and nothing lands', async (t) => {
  const pkg = skillPackage();
  const served = Buffer.from(pkg.zip);
  served[12] ^= 1;
  const f = await flow(t, { pkg, served });
  assert.equal(await f.installer.runNext(), 'failed');
  assert.deepEqual(f.results().map((r) => r.json), [{ status: 'failed', error_code: 'PACKAGE_MISMATCH', error_message: 'sha256_mismatch' }]);
  assert.deepEqual(fs.readdirSync(f.skillsDir), []);
});

test('an unsafe package is reported as PACKAGE_UNSAFE', async (t) => {
  const zip = buildZip([{ name: 'SKILL.md', data: skillMd('demo-skill', 'hooks: x\n') }]);
  const pkg = { zip, sha: crypto.createHash('sha256').update(zip).digest('hex'), size: zip.length, manifest: [] };
  const f = await flow(t, { pkg });
  assert.equal(await f.installer.runNext(), 'failed');
  assert.deepEqual(f.results().map((r) => r.json.error_code), ['PACKAGE_UNSAFE']);
  assert.match(f.results()[0].json.error_message, /^SKILL_FRONTMATTER_KEY_NOT_ALLOWED at line \d+$/);
});

test('an undelivered result stays in the outbox and is resent unchanged before anything else', async (t) => {
  const f = await flow(t, { c06: [f503, echo] });
  assert.equal(await f.installer.runNext(), 'deferred');
  assert.equal(f.state.outbox.list().length, 1);
  assert.equal(f.state.read('intents', null).queue[0].status, 'running');
  assert.equal(await f.installer.runNext(), null);
  const sent = f.results();
  assert.equal(sent.length, 2);
  assert.equal(sent[1].body, sent[0].body);
  assert.deepEqual(f.state.outbox.list(), []);
  assert.deepEqual(f.state.read('intents', null).queue, []);
  assert.equal(f.fake.requests.filter((r) => r.path.endsWith('/install-requests')).length, 1);
});

test('a C-02 rejection closes the intent without a result; a transient one keeps the request for replay', async (t) => {
  const f = await flow(t, { c02: [f503, { status: 409, problem: { code: 'NOT_APPROVED' } }] });
  const c02 = `${B}/agents/${AGENT}/install-requests`;
  assert.equal(await f.installer.runNext(), 'deferred');
  assert.equal(await f.installer.runNext(), 'closed');
  const bodies = f.fake.requests.filter((r) => r.path === c02).map((r) => r.body);
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0], bodies[1]);
  assert.deepEqual(f.state.read('intents', null).queue, []);
  assert.deepEqual(f.results(), []);
});

test('the version and package sha the market selected are checked against the revoked set before downloading', async (t) => {
  const pkg = skillPackage();
  const cases = [
    [{ skill_version_id: [VERSION] }, 'version_revoked'],
    [{ package_sha256: [pkg.sha] }, 'sha_blocked'],
    [{ sha_block: [pkg.sha] }, 'sha_blocked'],
  ];
  for (const [revoked, message] of cases) {
    const f = await flow(t, { pkg, version: null, revoked });
    assert.equal(await f.installer.runNext(), 'failed', message);
    assert.equal(f.fake.requests.filter((r) => r.path.endsWith('/install-requests'))[0].json.skill_version_id, undefined);
    assert.deepEqual(f.results().map((r) => r.json), [failure('VERSION_REVOKED', message)]);
    assert.equal(f.downloads(), 0);
    assert.deepEqual(fs.readdirSync(f.skillsDir), []);
    assert.deepEqual(f.state.read('intents', null).queue, []);
  }
});

test('a package over the size or file caps is PACKAGE_UNSAFE before downloading', async (t) => {
  const pkg = skillPackage();
  const big = pkg.manifest.map((e, i) => (i === 0 ? { ...e, size: MAX_PACKAGE_BYTES } : e));
  const many = Array.from({ length: MAX_PACKAGE_FILES + 1 }, (_, i) => ({ path: `f${i}`, size: 1, sha256: 'a'.repeat(64) }));
  const cases = [
    [{ size_bytes: MAX_PACKAGE_BYTES + 1 }, 'too_large'],
    [{ file_manifest: big }, 'too_large'],
    [{ file_manifest: many }, 'too_many_files'],
  ];
  for (const [over, message] of cases) {
    const f = await flow(t, { pkg, c02Over: () => over });
    assert.equal(await f.installer.runNext(), 'failed', message);
    assert.deepEqual(f.results().map((r) => r.json), [failure('PACKAGE_UNSAFE', message)]);
    assert.equal(f.downloads(), 0);
  }
  const edge = await flow(t, { pkg, c02Over: () => ({ size_bytes: MAX_PACKAGE_BYTES }) });
  assert.equal(await edge.installer.runNext(), 'failed');
  assert.deepEqual(edge.results().map((r) => r.json.error_message), ['download_metadata_mismatch']);
});

test('a package_url that is not this request\'s C-03 path fails CLIENT_INTERNAL without a download', async (t) => {
  const f = await flow(t, { c02Over: (rid) => ({ package_url: `https://evil.example.test${B}/agents/${AGENT}/packages/${rid}` }) });
  assert.equal(await f.installer.runNext(), 'failed');
  assert.deepEqual(f.results().map((r) => r.json), [failure('CLIENT_INTERNAL', 'package_url_invalid')]);
  assert.equal(f.downloads(), 0);
});

test('a worker out of memory is reported once as CLIENT_INTERNAL and the process keeps running', async (t) => {
  const workerUrl = new URL('./fake/oom-worker.js', import.meta.url);
  const f = await flow(t, { inspect: (b, o) => inspectInWorker(b, { ...o, workerUrl, resourceLimits: { maxOldGenerationSizeMb: 16 } }) });
  assert.equal(await f.installer.runNext(), 'failed');
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(f.results().map((r) => r.json), [failure('CLIENT_INTERNAL', 'inspect_out_of_memory')]);
  assert.equal((await inspectInWorker(f.pkg.zip)).meta.name, 'demo-skill');
});
