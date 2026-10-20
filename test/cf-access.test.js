import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { CF_ENV, FAKE_CF_ID, FAKE_CF_SECRET, FAKE_KEY, VALID_ENV, baseEnv, runHook, tmpHome } from './helpers.js';
import { marketHarness, startFakeMarket } from './fake/market.js';
import { startFakeStorage } from './fake/storage.js';
import { skillPackage } from './fake/package.js';
import { AGENT, ORG, U } from './fake/pull.js';
import { createLogger } from '../src/logger.js';
import { createAuth } from '../src/auth.js';
import { createMarketApi } from '../src/market-api.js';
import { downloadPackage } from '../src/download.js';
import { MarketError, cfAccessHeaders, createMarketHttp } from '../src/http.js';
import { ConfigError, EXIT_CONFIG, buildConfig, cfAccessFromConfig, loadConfig, validateConfig, writeConfig } from '../src/config.js';

const CF = { clientId: FAKE_CF_ID, clientSecret: FAKE_CF_SECRET };
const REV = `/api/v1/orgs/${ORG}/revocations:query`;
const SUB = `/agents/${AGENT}/packages/${U(7)}`;
const C03 = `/api/v1/orgs/${ORG}${SUB}`;
const pkg = skillPackage();
const ACCESS_302 = { status: 302, headers: { location: 'https://team.cloudflareaccess.com/cdn-cgi/access/login/x' } };

const hasCf = (rec) => rec.headers['cf-access-client-id'] === FAKE_CF_ID && rec.headers['cf-access-client-secret'] === FAKE_CF_SECRET;
const noCf = (rec) => rec.headers['cf-access-client-id'] === undefined && rec.headers['cf-access-client-secret'] === undefined;

test('config: both or neither Cloudflare Access value; omitted from config.json when unset', () => {
  const plain = buildConfig({ ...VALID_ENV });
  assert.ok(!('cf_access_client_id' in plain) && !('cf_access_client_secret' in plain));
  assert.equal(cfAccessFromConfig(plain), null);
  const withCf = buildConfig({ ...VALID_ENV, ...CF_ENV });
  assert.deepEqual(cfAccessFromConfig(withCf), CF);
  for (const half of [{ COCO_CF_ACCESS_CLIENT_ID: FAKE_CF_ID }, { COCO_CF_ACCESS_CLIENT_SECRET: FAKE_CF_SECRET }]) {
    assert.throws(() => buildConfig({ ...VALID_ENV, ...half }), (e) => e instanceof ConfigError && /set together/.test(e.message)
      && !e.message.includes(FAKE_CF_SECRET));
  }
  assert.throws(() => buildConfig({ ...VALID_ENV, ...CF_ENV, COCO_CF_ACCESS_CLIENT_SECRET: 'has space' }), ConfigError);
  assert.throws(() => buildConfig({ ...VALID_ENV, ...CF_ENV, COCO_CF_ACCESS_CLIENT_ID: 'bad\nvalue' }), ConfigError);

  const dataDir = path.join(tmpHome(), 'd');
  writeConfig({ ...VALID_ENV, ...CF_ENV }, dataDir);
  assert.deepEqual(cfAccessFromConfig(loadConfig(dataDir)), CF);
  const stored = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
  const { cf_access_client_secret: _s, ...oneSided } = stored;
  assert.throws(() => validateConfig({ ...oneSided, orgs: undefined }), ConfigError);
});

test('post-install and configure write the token without printing the secret; a half pair is EX_CONFIG', () => {
  const dataDir = path.join(tmpHome(), 'd');
  const ok = runHook('post-install.js', { env: { ...baseEnv(dataDir), ...VALID_ENV, ...CF_ENV } });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /cf_access=configured/);
  const half = runHook('configure.js', { env: baseEnv(dataDir), input: JSON.stringify({ ...VALID_ENV, COCO_CF_ACCESS_CLIENT_SECRET: FAKE_CF_SECRET }) });
  assert.equal(half.status, EXIT_CONFIG);
  for (const r of [ok, half]) {
    assert.ok(!r.stdout.includes(FAKE_CF_SECRET) && !r.stderr.includes(FAKE_CF_SECRET), 'secret printed');
    assert.ok(!r.stdout.includes(FAKE_KEY) && !r.stderr.includes(FAKE_KEY), 'key printed');
  }
  assert.deepEqual(cfAccessFromConfig(loadConfig(dataDir)), CF);
});

test('cfAccessHeaders: only for the configured origin, nothing when unconfigured', () => {
  const o = 'https://bff.example.test';
  assert.deepEqual(cfAccessHeaders(CF, `${o}/auth/agent/token`, o),
    { 'CF-Access-Client-Id': FAKE_CF_ID, 'CF-Access-Client-Secret': FAKE_CF_SECRET });
  for (const other of ['https://storage.googleapis.com/b/o', 'https://bff.example.test:8443/x', 'http://bff.example.test/x', 'https://evil.example.test/x']) {
    assert.deepEqual(cfAccessHeaders(CF, other, o), {}, other);
  }
  assert.deepEqual(cfAccessHeaders(null, `${o}/x`, o), {});
});

test('token exchange, refresh and market calls carry the headers; the secret is never logged', async (t) => {
  const { fake, http, auth } = await marketHarness(t, { cfAccess: CF });
  fake.script('POST', REV, fake.problem(401, 'PRINCIPAL_INVALID'), { status: 200, json: {} });
  await http.request('POST', ORG, '/revocations:query', {});
  assert.deepEqual(fake.auth().map((r) => r.path), ['/auth/agent/token', '/auth/refresh']);
  assert.ok(fake.requests.length >= 4);
  for (const r of fake.requests) assert.ok(hasCf(r), r.path);
  assert.ok(await auth.memberId(ORG));
});

test('without configuration no Cloudflare Access header is sent', async (t) => {
  const { fake, http } = await marketHarness(t);
  await http.request('POST', ORG, '/revocations:query', {});
  assert.equal(fake.requests.length, 2);
  for (const r of fake.requests) assert.ok(noCf(r), r.path);
});

test('package_url (C-03) carries the headers, the storage download_url never does', async (t) => {
  const { fake, http } = await marketHarness(t, { cfAccess: CF });
  const storage = await startFakeStorage();
  t.after(storage.close);
  const url = storage.serve('/b/p1', { status: 200, body: pkg.zip });
  fake.script('GET', C03, { status: 200, json: { download_url: url, expires_at: new Date(Date.now() + 300_000).toISOString(), sha256: pkg.sha, size: pkg.size } });
  const bytes = await downloadPackage({
    api: createMarketApi({ http }), orgId: ORG, subPath: SUB, sha: pkg.sha, size: pkg.size, emulatorOrigin: storage.origin, sleep: async () => {},
  });
  assert.deepEqual(bytes, pkg.zip);
  assert.ok(hasCf(fake.market().find((r) => r.path === C03)));
  assert.equal(storage.requests.length, 1);
  assert.ok(noCf(storage.requests[0]));
});

test('a redirect to Cloudflare Access is ACCESS_REQUIRED, not followed, logged without the secret', async (t) => {
  const { fake, http, lines } = await marketHarness(t, { cfAccess: CF });
  fake.script('POST', REV, ACCESS_302);
  const err = await http.request('POST', ORG, '/revocations:query', {}).catch((e) => e);
  assert.ok(err instanceof MarketError);
  assert.deepEqual([err.code, err.status, err.transient], ['ACCESS_REQUIRED', 302, true]);
  assert.match(err.message, /Cloudflare Access service token/);
  assert.ok(!err.message.includes(FAKE_CF_SECRET) && !JSON.stringify(err).includes(FAKE_CF_SECRET));
  assert.ok(lines.some((l) => l.includes('[error]') && l.includes('Cloudflare Access')));
  assert.equal(fake.requests.filter((r) => r.path === REV).length, 1);

  fake.script('POST', REV, { status: 302, headers: { location: 'https://elsewhere.example.test/' } });
  assert.equal((await http.request('POST', ORG, '/revocations:query', {}).catch((e) => e)).code, 'REDIRECT_REFUSED');
  fake.script('POST', REV, { status: 302, headers: { location: 'https://cloudflareaccess.com.evil.test/' } });
  assert.equal((await http.request('POST', ORG, '/revocations:query', {}).catch((e) => e)).code, 'REDIRECT_REFUSED');
});

test('an Access redirect on the token exchange is ACCESS_REQUIRED too', async (t) => {
  const fake = await startFakeMarket({ apiKey: FAKE_KEY, memberId: VALID_ENV.COCO_MEMBER_ID });
  t.after(fake.close);
  const lines = [];
  const logger = createLogger('debug', { log: (l) => lines.push(l), error: (l) => lines.push(l) });
  fake.script('POST', '/auth/agent/token', ACCESS_302);
  const auth = createAuth({ bffUrl: fake.url, apiKey: FAKE_KEY, logger });
  const http = createMarketHttp({ bffUrl: fake.url, auth, logger });
  const err = await http.request('POST', ORG, '/revocations:query', {}).catch((e) => e);
  assert.equal(err.code, 'ACCESS_REQUIRED');
  assert.equal(fake.market().length, 0);
  assert.ok(lines.some((l) => l.includes('[error]') && l.includes('Cloudflare Access')));
  assert.ok(noCf(fake.auth()[0]));
});
