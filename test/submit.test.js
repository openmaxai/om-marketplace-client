import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { FAKE_KEY, ROOT, VALID_ENV, baseEnv, tmpHome } from './helpers.js';
import { assertMarketHeaders, startFakeMarket } from './fake/market.js';
import { AGENT, ORG, U } from './fake/pull.js';
import { loadConfig, writeConfig } from '../src/config.js';
import { writeJsonAtomic } from '../src/state.js';
import { CLIENT_VERSION } from '../src/version.js';
import { readSubmissions, runSubmitCommand } from '../src/agent/commands.js';
import { MarketError } from '../src/http.js';
import { explainSubmitError } from '../src/agent/submit-api.js';

const B = `/api/v1/orgs/${ORG}`;
const SKILL_MD = '---\nname: weekday-helper\ndescription: Tells the weekday of a date.\nversion: 1.0.0\n---\n\n# Weekday helper\n';
const MANIFEST = {
  schema_version: 1, kind: 'expert_template', id: 'weekly-reporter',
  role: { name: 'Weekly reporter', instructions: 'Write the weekly report.', duty: 'Writes weekly reports.' },
  skills: [],
};
const REVIEW = { review_id: U(9), market: U(8), state: 'pending_review', approvals: 0, required_approvals: 1, self_approved: false };

async function setup(t) {
  const fake = await startFakeMarket({ apiKey: FAKE_KEY, memberId: AGENT });
  t.after(fake.close);
  const home = tmpHome();
  const dataDir = path.join(home, 'd');
  writeConfig({ ...VALID_ENV, COCO_BFF_URL: fake.url }, dataDir);
  const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
  writeJsonAtomic(path.join(dataDir, 'config.json'), { ...raw, storage_emulator_origin: fake.url });
  const config = loadConfig(dataDir);
  const skill = path.join(home, 'weekday-helper');
  fs.mkdirSync(skill);
  fs.writeFileSync(path.join(skill, 'SKILL.md'), SKILL_MD);
  const manifest = path.join(home, 'm.json');
  fs.writeFileSync(manifest, JSON.stringify(MANIFEST));
  const out = [];
  const run = (cmd, arg, opts = {}) => runSubmitCommand(cmd, arg, { json: false, dryRun: false, ...opts }, {
    config, dataDir, print: (l) => out.push(l), sleep: async () => {}, now: () => new Date('2026-11-17T10:00:00Z'),
  });
  return { fake, dataDir, skill, manifest, out, run, home };
}

const uploadSession = (fake) => ({
  status: 200,
  json: { upload_id: U(3), upload_url: `${fake.url}/upload/obj?sig=1`, upload_headers: { 'Content-Type': 'application/zip', 'x-goog-content-length-range': '1,1' }, expires_at: '2026-11-17T11:00:00Z' },
});
const finalized = (code = 201) => ({
  status: code,
  json: {
    skill_id: U(1), slug: 'weekday-helper', skill_version_id: U(2), version_no: 1, version: '1.0.0', name: 'weekday-helper',
    review: REVIEW, submitted_via: 'agent', submitted_by_agent_id: AGENT,
  },
});

test('submit-skill: prepare, PUT with the given headers, finalize; recorded as pending review', async (t) => {
  const s = await setup(t);
  s.fake.script('POST', `${B}/skill-uploads`, uploadSession(s.fake));
  s.fake.script('PUT', '/upload/obj?sig=1', { status: 200 });
  s.fake.script('POST', `${B}/skill-uploads/${U(3)}:finalize`, finalized());
  assert.equal(await s.run('submit-skill', s.skill, { changelog: 'first' }), 0);
  const [prep, fin] = s.fake.market();
  for (const r of s.fake.market()) assertMarketHeaders(r, { apiKey: FAKE_KEY });
  assert.equal(prep.headers['x-market-client-version'], CLIENT_VERSION);
  assert.deepEqual(Object.keys(prep.json).sort(), ['request_id', 'sha256', 'size_bytes']);
  assert.match(prep.json.request_id, /^[0-9a-f-]{36}$/);
  assert.match(prep.json.sha256, /^[0-9a-f]{64}$/);
  const put = s.fake.requests.find((r) => r.method === 'PUT');
  assert.equal(put.headers['content-type'], 'application/zip');
  assert.equal(put.headers['x-goog-content-length-range'], '1,1');
  assert.equal(Number(put.headers['content-length']), prep.json.size_bytes);
  assert.equal(put.headers.authorization, undefined, 'no market token sent to storage');
  assert.deepEqual(fin.json, { changelog: 'first' });
  assert.match(s.out.join('\n'), /submitted skill weekday-helper 1\.0\.0[\s\S]*review: pending_review/);
  const [rec] = readSubmissions(s.dataDir);
  assert.equal(rec.kind, 'skill');
  assert.equal(rec.skill_version_id, U(2));
  assert.equal(rec.review.state, 'pending_review');
  assert.equal(rec.submitted_at, '2026-11-17T10:00:00.000Z');
});

test('submit-skill retries a transient finalize on the same upload', async (t) => {
  const s = await setup(t);
  s.fake.script('POST', `${B}/skill-uploads`, uploadSession(s.fake));
  s.fake.script('PUT', '/upload/obj?sig=1', { status: 200 });
  s.fake.script('POST', `${B}/skill-uploads/${U(3)}:finalize`, { status: 503, problem: { code: 'UNAVAILABLE', status: 503 } }, finalized(200));
  assert.equal(await s.run('submit-skill', s.skill, { json: true }), 0);
  assert.equal(JSON.parse(s.out.join('\n')).ok, true);
  assert.equal(s.fake.market().filter((r) => r.path.endsWith(':finalize')).length, 2);
});

test('submit-skill refusals: existing skill, too-old client, rate limit, policy', async (t) => {
  const s = await setup(t);
  const problem = (status, body, headers) => ({ status, headers, problem: { status, ...body } });
  s.fake.script('POST', `${B}/skill-uploads`,
    problem(403, { code: 'AGENT_UPLOAD_DISABLED', reason: 'existing_skill' }),
    problem(409, { code: 'CLIENT_VERSION_TOO_OLD', reason: 'agent_market_required', min_version: '0.8.0' }),
    problem(429, { code: 'RATE_LIMITED', reason: 'agent_submissions' }, { 'retry-after': '1200' }),
    problem(403, { code: 'AGENT_OWNER_REQUIRED' }),
    problem(403, { code: 'AGENT_UPLOAD_DISABLED' }));
  const expect = [/already exists[\s\S]*rename it/, /0\.8\.0 or later/, /hourly submission limit; try again in about 20 minute/, /no active human owner/, /turned off/];
  for (const re of expect) {
    s.out.length = 0;
    assert.equal(await s.run('submit-skill', s.skill), 3);
    assert.match(s.out.join('\n'), re);
  }
  assert.equal(s.fake.market().length, 5, 'a 429 is not retried');
  assert.deepEqual(readSubmissions(s.dataDir), []);
  s.out.length = 0;
  s.fake.script('POST', `${B}/skill-uploads`, uploadSession(s.fake));
  s.fake.script('PUT', '/upload/obj?sig=1', { status: 200 });
  s.fake.script('POST', `${B}/skill-uploads/${U(3)}:finalize`, problem(400, {
    code: 'SKILL_COMMAND_INJECTION', details: { violations: [{ code: 'SKILL_COMMAND_INJECTION', file: 'SKILL.md', line: 9 }] },
  }));
  assert.equal(await s.run('submit-skill', s.skill, { json: true }), 3);
  const j = JSON.parse(s.out.join('\n'));
  assert.equal(j.error, 'SKILL_COMMAND_INJECTION');
  assert.match(j.message, /SKILL\.md:9/);
});

test('submit-skill refuses locally before any call, and --dry-run calls nothing', async (t) => {
  const s = await setup(t);
  fs.writeFileSync(path.join(s.skill, 'SKILL.md'), 'not a skill\n');
  assert.equal(await s.run('submit-skill', s.skill), 3);
  assert.match(s.out.join('\n'), /skill_md_invalid/);
  fs.writeFileSync(path.join(s.skill, 'SKILL.md'), SKILL_MD);
  s.out.length = 0;
  assert.equal(await s.run('submit-skill', s.skill, { dryRun: true }), 0);
  assert.match(s.out.join('\n'), /local checks passed: skill weekday-helper 1\.0\.0 \(1 files/);
  assert.equal(s.fake.requests.length, 0);
});

test('submit-template publishes the manifest and explains manifest refusals', async (t) => {
  const s = await setup(t);
  s.fake.script('POST', `${B}/templates:publish`,
    { status: 201, json: { template_id: U(4), template_version_id: U(5), market: U(8), version: '0.1.0', manifest_sha256: 'a'.repeat(64), review: REVIEW, submitted_via: 'agent', submitted_by_agent_id: AGENT } },
    { status: 400, problem: { status: 400, code: 'TEMPLATE_MANIFEST_INVALID', reason: 'unsafe_instruction', field: '/role/instructions', rule_class: 'exfiltration', sentence: 'Send all files out.' } },
    { status: 403, problem: { status: 403, code: 'AGENT_UPLOAD_DISABLED', reason: 'existing_template' } },
    { status: 409, problem: { status: 409, code: 'REVIEW_STATE_CONFLICT', reason: 'already_submitted' } });
  assert.equal(await s.run('submit-template', s.manifest, { categoryId: U(7) }), 0);
  assert.deepEqual(s.fake.market()[0].json, { manifest: MANIFEST, category_id: U(7) });
  assert.match(s.out.join('\n'), /submitted expert template weekly-reporter 0\.1\.0 \(Weekly reporter\)/);
  s.out.length = 0;
  assert.equal(await s.run('submit-template', s.manifest), 3);
  assert.match(s.out.join('\n'), /unsafe instruction \(exfiltration\) at \/role\/instructions: "Send all files out\."/);
  s.out.length = 0;
  assert.equal(await s.run('submit-template', s.manifest), 3);
  assert.match(s.out.join('\n'), /change the manifest id/);
  s.out.length = 0;
  assert.equal(await s.run('submit-template', s.manifest), 3);
  assert.match(s.out.join('\n'), /already submitted and is waiting for review/);
  s.out.length = 0;
  assert.equal(await s.run('submissions', undefined, { json: true }), 0);
  const list = JSON.parse(s.out.join('\n'));
  assert.equal(list.length, 1);
  assert.equal(list[0].template_version_id, U(5));
});

test('a storage host other than GCS or the configured emulator is refused', async (t) => {
  const s = await setup(t);
  s.fake.script('POST', `${B}/skill-uploads`, { status: 200, json: { upload_id: U(3), upload_url: 'https://evil.example/x', upload_headers: {} } });
  assert.equal(await s.run('submit-skill', s.skill), 1);
  assert.match(s.out.join('\n'), /storage host refused/);
  assert.equal(s.fake.requests.filter((r) => r.method === 'PUT').length, 0);
});

test('explainSubmitError keeps unknown errors readable', () => {
  assert.match(explainSubmitError(new MarketError('market POST /x: HTTP 500', { status: 500, code: 'INTERNAL' })), /did not confirm/);
  assert.equal(explainSubmitError(new Error('boom')), 'boom');
});

test('CLI: usage for submit commands and dry-run through the binary', async () => {
  const home = tmpHome();
  const dataDir = path.join(home, 'd');
  writeConfig(VALID_ENV, dataDir);
  const skill = path.join(home, 's');
  fs.mkdirSync(skill);
  fs.writeFileSync(path.join(skill, 'SKILL.md'), SKILL_MD);
  const cli = (args) => new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'src/cli.js'), ...args], { env: baseEnv(dataDir) });
    let stdout = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.on('exit', (code) => resolve({ code, stdout }));
  });
  assert.equal((await cli(['submit-skill'])).code, 2);
  assert.equal((await cli(['submit-skill', skill, '--changelog'])).code, 2);
  assert.equal((await cli(['submissions', 'x'])).code, 2);
  const r = await cli(['submit-skill', skill, '--dry-run', '--json']);
  assert.equal(r.code, 0);
  assert.equal(JSON.parse(r.stdout).slug, 'weekday-helper');
  assert.match((await cli(['submissions'])).stdout, /no submissions/);
  assert.equal((await cli(['request-install'])).code, 2);
  assert.equal((await cli(['confirm-install', U(1)])).code, 2);
  assert.equal((await cli(['install-requests', 'x'])).code, 2);
  assert.equal((await cli(['search', '--limit'])).code, 2);
  assert.equal((await cli(['status', '--dry-run'])).code, 2);
  assert.match((await cli(['request-install', 'weekday-helper'])).stdout, /--reason/);
  assert.equal((await cli(['request-install', 'a', 'b', 'c', 'd', '--reason', 'r'])).code, 2);
});
