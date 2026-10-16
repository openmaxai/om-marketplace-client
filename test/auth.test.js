import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { FAKE_KEY, VALID_ENV, mode, tmpHome } from './helpers.js';
import { startFakeMarket } from './fake/market.js';
import { createAuth, memberIdFromJwt } from '../src/auth.js';
import { MarketError } from '../src/http.js';

const ORG = VALID_ENV.COCO_ORG_ID;
const ORG2 = '1c2d3e4f-5555-4a6b-8c7d-dddddddddddd';
const MEMBER = VALID_ENV.COCO_MEMBER_ID;
const NEW_KEY = 'cwsk_TEST_ROTATED_9e2b4c7a1d0f3e55'; // gitleaks:allow (fake test fixture)
const cacheName = (org) => `${crypto.createHash('sha256').update(org).digest('hex')}.json`;

const silent = { debug() {}, info() {}, warn() {}, error() {} };

async function setup(t, opts = {}) {
  const fake = await startFakeMarket({ apiKey: FAKE_KEY, memberId: MEMBER, ...opts.fake });
  t.after(fake.close);
  const auth = createAuth({ bffUrl: fake.url, apiKey: FAKE_KEY, ...opts.auth });
  return { fake, auth };
}

test('exchange sends the API key and org_id, caches per org, decodes member_id', async (t) => {
  const { fake, auth } = await setup(t);
  const token = await auth.getAccessToken(ORG);
  assert.equal(await auth.getAccessToken(ORG), token);
  assert.equal(await auth.memberId(ORG), MEMBER);
  assert.equal(memberIdFromJwt(token), MEMBER);
  const [req] = fake.auth();
  assert.equal(fake.auth().length, 1);
  assert.equal(req.path, '/auth/agent/token');
  assert.equal(req.headers.authorization, `Bearer ${FAKE_KEY}`);
  assert.deepEqual(req.json, { org_id: ORG });
  assert.notEqual(await auth.getAccessToken(ORG2), token);
  assert.deepEqual(fake.auth().map((r) => r.json.org_id), [ORG, ORG2]);
});

test('concurrent callers share one exchange per org; wrapped {data} responses are accepted', async (t) => {
  const { fake, auth } = await setup(t);
  fake.script('POST', '/auth/agent/token', { status: 200, delayMs: 20, json: { data: {
    access_token: 'a.b.c', access_token_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
  } } });
  const tokens = await Promise.all([auth.getAccessToken(ORG), auth.getAccessToken(ORG), auth.getAccessToken(ORG)]);
  assert.deepEqual(tokens, ['a.b.c', 'a.b.c', 'a.b.c']);
  assert.equal(fake.auth().length, 1);
});

test('refresh when under 60 s remain uses the access token, not the API key', async (t) => {
  let clock = Date.now();
  const { fake, auth } = await setup(t, { auth: { now: () => clock } });
  const first = await auth.getAccessToken(ORG);
  clock += 3_600_000 - 30_000;
  const second = await auth.getAccessToken(ORG);
  assert.notEqual(second, first);
  const req = fake.auth()[1];
  assert.equal(req.path, '/auth/refresh');
  assert.equal(req.headers.authorization, `Bearer ${first}`);
  assert.deepEqual(req.json, { refresh_token: fake.issued.refresh[0], org_id: ORG });
});

test('a failed refresh falls back to the API key exchange', async (t) => {
  const { fake, auth } = await setup(t);
  await auth.getAccessToken(ORG);
  fake.script('POST', '/auth/refresh', { status: 500, raw: 'boom' });
  const token = await auth.refresh(ORG);
  assert.deepEqual(fake.auth().map((r) => r.path), ['/auth/agent/token', '/auth/refresh', '/auth/agent/token']);
  assert.equal(token, fake.issued.access[1]);
});

test('tokens persist 0600 in a 0700 dir and are reused by a new instance', async (t) => {
  const tokenDir = path.join(tmpHome(), 'tokens');
  const { fake, auth } = await setup(t, { auth: { tokenDir } });
  const token = await auth.getAccessToken(ORG);
  assert.equal(mode(tokenDir), 0o700);
  assert.equal(mode(path.join(tokenDir, cacheName(ORG))), 0o600);
  const again = createAuth({ bffUrl: fake.url, apiKey: FAKE_KEY, tokenDir });
  assert.equal(await again.getAccessToken(ORG), token);
  assert.equal(fake.auth().length, 1);
  assert.deepEqual(fs.readdirSync(tokenDir), [cacheName(ORG)]);
  const saved = JSON.parse(fs.readFileSync(path.join(tokenDir, cacheName(ORG)), 'utf8'));
  assert.equal(saved.bff_origin, fake.url);
  assert.equal(saved.api_key_sha256, crypto.createHash('sha256').update(FAKE_KEY).digest('hex'));
  assert.ok(!JSON.stringify(saved).includes(FAKE_KEY));
});

test('the cache file name is sha256(org_id), so any server-charset org id stays inside tokenDir', async (t) => {
  const tokenDir = path.join(tmpHome(), 'tokens');
  const { fake, auth } = await setup(t, { auth: { tokenDir } });
  for (const org of ['org-1', 'a:b@c', '...']) await auth.getAccessToken(org);
  assert.deepEqual(fs.readdirSync(tokenDir).sort(), ['org-1', 'a:b@c', '...'].map(cacheName).sort());
  assert.deepEqual(fake.auth().map((r) => r.json.org_id), ['org-1', 'a:b@c', '...']);
  for (const org of ['.', '..']) await assert.rejects(auth.getAccessToken(org), TypeError, org);
  assert.equal(fake.auth().length, 3);
});

test('a cache written for another BFF origin is discarded and never sent there', async (t) => {
  const tokenDir = path.join(tmpHome(), 'tokens');
  const { fake: a, auth } = await setup(t, { auth: { tokenDir } });
  await auth.getAccessToken(ORG);
  const b = await startFakeMarket({ apiKey: FAKE_KEY, memberId: MEMBER });
  t.after(b.close);
  const warn = [];
  const other = createAuth({ bffUrl: b.url, apiKey: FAKE_KEY, tokenDir, logger: { ...silent, warn: (l) => warn.push(l) } });
  const token = await other.getAccessToken(ORG);
  assert.equal(token, b.issued.access[0]);
  assert.deepEqual(b.auth().map((r) => [r.path, r.headers.authorization]), [['/auth/agent/token', `Bearer ${FAKE_KEY}`]]);
  for (const r of b.requests) {
    for (const s of [...a.issued.access, ...a.issued.refresh]) assert.ok(!r.body.includes(s) && !r.headers.authorization.includes(s));
  }
  assert.ok(warn.some((l) => l.includes('another BFF origin')));
  const saved = JSON.parse(fs.readFileSync(path.join(tokenDir, cacheName(ORG)), 'utf8'));
  assert.equal(saved.bff_origin, b.url);
});

test('an API key rotation discards the cached tokens and exchanges the new key', async (t) => {
  const tokenDir = path.join(tmpHome(), 'tokens');
  const { fake, auth } = await setup(t, { fake: { apiKey: [FAKE_KEY, NEW_KEY] }, auth: { tokenDir } });
  const old = await auth.getAccessToken(ORG);
  const rotated = createAuth({ bffUrl: fake.url, apiKey: NEW_KEY, tokenDir });
  const token = await rotated.getAccessToken(ORG);
  assert.notEqual(token, old);
  assert.deepEqual(fake.auth().map((r) => [r.path, r.headers.authorization]),
    [['/auth/agent/token', `Bearer ${FAKE_KEY}`], ['/auth/agent/token', `Bearer ${NEW_KEY}`]]);
  const saved = JSON.parse(fs.readFileSync(path.join(tokenDir, cacheName(ORG)), 'utf8'));
  assert.equal(saved.api_key_sha256, crypto.createHash('sha256').update(NEW_KEY).digest('hex'));
});

test('a token file with group/other bits or another owner is discarded with a warning', async (t) => {
  const tokenDir = path.join(tmpHome(), 'tokens');
  const { fake, auth } = await setup(t, { auth: { tokenDir } });
  await auth.getAccessToken(ORG);
  const file = path.join(tokenDir, cacheName(ORG));
  fs.chmodSync(file, 0o644);
  const warn = [];
  const logger = { ...silent, warn: (l) => warn.push(l) };
  await createAuth({ bffUrl: fake.url, apiKey: FAKE_KEY, tokenDir, logger }).getAccessToken(ORG);
  assert.equal(fake.auth().length, 2);
  assert.equal(mode(file), 0o600);
  await createAuth({ bffUrl: fake.url, apiKey: FAKE_KEY, tokenDir, logger, uid: process.getuid() + 1 }).getAccessToken(ORG);
  assert.equal(fake.auth().length, 3);
  assert.ok(warn.some((l) => l.includes('group/other')));
  assert.ok(warn.some((l) => l.includes('not owned')));
});

test('a symlinked token dir is refused and its target is not touched', async (t) => {
  const home = tmpHome();
  const target = path.join(home, 'elsewhere');
  fs.mkdirSync(target, { mode: 0o755 });
  fs.chmodSync(target, 0o755);
  const tokenDir = path.join(home, 'tokens');
  fs.symlinkSync(target, tokenDir);
  const warn = [];
  const { auth } = await setup(t, { auth: { tokenDir, logger: { ...silent, warn: (l) => warn.push(l) } } });
  await auth.getAccessToken(ORG);
  assert.equal(mode(target), 0o755);
  assert.deepEqual(fs.readdirSync(target), []);
  assert.ok(warn.some((l) => l.includes('token cache write failed')));
});

test('createAuth enforces the BFF URL rules', () => {
  for (const bffUrl of ['http://bff.example.test', 'https://u:p@bff.example.test', 'https://bff.example.test/x']) {
    assert.throws(() => createAuth({ bffUrl, apiKey: FAKE_KEY }), { name: 'ConfigError' }, bffUrl);
  }
});

test('exchange failures are typed and never carry the API key; org ids are validated', async (t) => {
  const { fake } = await setup(t);
  const bad = createAuth({ bffUrl: fake.url, apiKey: `${FAKE_KEY}x` });
  const err = await bad.getAccessToken(ORG).catch((e) => e);
  assert.ok(err instanceof MarketError);
  assert.equal(err.status, 401);
  assert.ok(!err.message.includes(FAKE_KEY) && !err.stack.includes(FAKE_KEY));
  for (const org of ['../x', '.', '..', 'a/b', '', undefined]) {
    await assert.rejects(bad.getAccessToken(org), TypeError);
  }
  fake.script('POST', '/auth/agent/token', { status: 200, json: { token: 'x' } });
  await assert.rejects(bad.getAccessToken(ORG), { code: 'RESPONSE_INVALID' });
});

test('401-triggered renewal is allowed once per org per 10 minutes unless the token already changed', async (t) => {
  let clock = Date.now();
  const { fake, auth } = await setup(t, { auth: { now: () => clock } });
  const first = await auth.getAccessToken(ORG);
  assert.equal(await auth.renewAfter401(ORG, first), true);
  const second = await auth.getAccessToken(ORG);
  assert.notEqual(second, first);
  assert.equal(await auth.renewAfter401(ORG, first), true, 'stale token: retry with the current one');
  assert.equal(await auth.renewAfter401(ORG, second), false, 'window held');
  assert.equal(fake.auth().length, 2);
  await auth.getAccessToken(ORG2);
  assert.equal(await auth.renewAfter401(ORG2, await auth.getAccessToken(ORG2)), true);
  clock += 10 * 60_000;
  assert.equal(await auth.renewAfter401(ORG, second), true);
});
