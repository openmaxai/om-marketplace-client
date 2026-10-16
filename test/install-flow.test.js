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
import { POLICY_SHA256 } from '../src/policy/pin.js';

const SKILL = U(1);
const VERSION = U(2);
const MARKET = U(3);
const INTENT = U(4);
const B = `/api/v1/orgs/${ORG}`;

// Fake market and storage through C-01, C-02 and C-03; `served` is what storage answers for the package.
const f503 = { status: 503, problem: { code: 'DEPENDENCY_UNAVAILABLE' } };
const echo = (req) => ({ status: 200, json: { request_id: req.path.split('/')[5], status: req.json.status, error_code: req.json.error_code } });

// c02 and c06 list answers given before the scripted C-02 and in place of the echoed C-06.
async function flow(t, { pkg = skillPackage(), served = pkg.zip, c02 = [], c06 = [echo] } = {}) {
  const h = await pullHarness(t, { orgs: {} });
  const storage = await startFakeStorage();
  t.after(storage.close);
  const skillsDir = path.join(path.dirname(h.dataDir), 'skills');
  fs.mkdirSync(skillsDir);
  h.fake.script('POST', `${B}/agents/${AGENT}/install-intents:query`, { status: 200, json: {
    items: [{ id: INTENT, org_id: ORG, op: 'install', skill_id: SKILL, skill_version_id: VERSION, template_id: null, source_market_id: MARKET,
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
      skill_md: { name: 'demo-skill', description: 'A test skill' }, status: 'running',
    } };
  });
  await createIntentPuller({ api: h.api, state: h.state, orgs: h.orgs, logger: h.logger, now: h.now }).pull();
  const installer = createInstaller({
    api: h.api, state: h.state, orgs: h.orgs, logger: h.logger, bffUrl: h.fake.url, skillsDir, dataDir: h.dataDir,
    emulatorOrigin: storage.origin, now: h.now, sleep: async () => {},
  });
  const results = () => h.fake.requests.filter((r) => r.path.endsWith('/result'));
  return { ...h, storage, skillsDir, installer, pkg, results };
}

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
