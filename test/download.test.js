import { test } from 'node:test';
import assert from 'node:assert/strict';
import { marketHarness } from './fake/market.js';
import { startFakeStorage } from './fake/storage.js';
import { skillPackage } from './fake/package.js';
import { AGENT, ORG, U } from './fake/pull.js';
import { createMarketApi } from '../src/market-api.js';
import { checkPackageUrl, downloadPackage, downloadUrlAllowed } from '../src/download.js';
import { MarketError } from '../src/http.js';
import { InstallFailure } from '../src/failure.js';
import { ConfigError, emulatorOrigin } from '../src/config.js';

const RID = U(7);
const SUB = `/agents/${AGENT}/packages/${RID}`;
const C03 = `/api/v1/orgs/${ORG}${SUB}`;
const pkg = skillPackage();
const later = () => new Date(Date.now() + 300_000).toISOString();

test('package_url must be exactly the C-03 path of this org, agent and request on the market origin', () => {
  const bffUrl = 'https://bff.example.test';
  const ctx = { bffUrl, orgId: ORG, agentId: AGENT, requestId: RID };
  assert.equal(checkPackageUrl(`${bffUrl}${C03}`, ctx), SUB);
  for (const bad of [`https://evil.example.test${C03}`, `http://bff.example.test${C03}`, `${bffUrl}${C03}?x=1`, `${bffUrl}${C03}#f`,
    `${bffUrl}${C03}/`, `${bffUrl}/api/v1/orgs/other${SUB}`, `${bffUrl}/api/v1/orgs/${ORG}/agents/${AGENT}/packages/${U(8)}`,
    `https://u@bff.example.test${C03}`, `${bffUrl}/api/v1/orgs/${ORG}/x/..${SUB}`, null]) {
    assert.throws(() => checkPackageUrl(bad, ctx), (e) => e instanceof InstallFailure && e.code === 'CLIENT_INTERNAL', String(bad));
  }
});

test('download hosts: storage.googleapis.com over https, the emulator only when configured', () => {
  assert.equal(downloadUrlAllowed('https://storage.googleapis.com/b/o?X-Goog-Signature=ab'), true);
  for (const bad of ['http://storage.googleapis.com/b/o', 'https://storage.googleapis.com:8443/b/o', 'https://x.storage.googleapis.com/o',
    'https://a@storage.googleapis.com/o', 'https://storage.googleapis.com/o#f', 'http://127.0.0.1:4443/b/o', 'not a url']) {
    assert.equal(downloadUrlAllowed(bad), false, bad);
  }
  assert.equal(downloadUrlAllowed('http://127.0.0.1:4443/b/o', 'http://127.0.0.1:4443'), true);
  assert.equal(downloadUrlAllowed('http://127.0.0.1:4444/b/o', 'http://127.0.0.1:4443'), false);
});

test('the emulator origin is honoured only for a loopback http market', () => {
  assert.equal(emulatorOrigin('http://127.0.0.1:4443', 'http://127.0.0.1:8080'), 'http://127.0.0.1:4443');
  for (const [raw, bff] of [['http://127.0.0.1:4443', 'https://bff.example.test'], ['http://10.0.0.1:4443', 'http://127.0.0.1:8080'],
    ['http://127.0.0.1:4443/path', 'http://127.0.0.1:8080'], ['ftp://127.0.0.1', 'http://localhost:8080']]) {
    assert.throws(() => emulatorOrigin(raw, bff), ConfigError);
  }
});

async function harness(t) {
  const h = await marketHarness(t);
  const storage = await startFakeStorage();
  t.after(storage.close);
  const api = createMarketApi({ http: h.http });
  const link = (url, over = {}) => ({ status: 200, json: { download_url: url, expires_at: later(), sha256: pkg.sha, size: pkg.size, ...over } });
  const run = (over = {}) => downloadPackage({
    api, orgId: ORG, subPath: SUB, sha: pkg.sha, size: pkg.size, emulatorOrigin: storage.origin, sleep: async () => {}, ...over,
  });
  return { ...h, storage, link, run };
}

const failsWith = (code, reason) => (e) => e instanceof InstallFailure && e.code === code && e.reason === reason;

test('downloads exactly the package bytes without credentials', async (t) => {
  const { fake, storage, link, run } = await harness(t);
  fake.script('GET', C03, link(storage.serve('/b/p1', { status: 200, body: pkg.zip })));
  assert.deepEqual(await run(), pkg.zip);
  const [req] = storage.requests;
  assert.equal(req.headers.authorization, undefined);
  assert.equal(req.headers['x-market-client-version'], undefined);
  assert.equal(req.headers['accept-encoding'], 'identity');
});

test('storage 403 gets one fresh URL; a second 403 fails CLIENT_INTERNAL', async (t) => {
  const { fake, storage, link, run } = await harness(t);
  fake.script('GET', C03, link(storage.serve('/b/a', { status: 403 })), link(storage.serve('/b/b', { status: 200, body: pkg.zip })));
  assert.deepEqual(await run(), pkg.zip);
  fake.script('GET', C03, link(storage.serve('/b/c', { status: 403 })), link(storage.serve('/b/d', { status: 403 })));
  await assert.rejects(run(), failsWith('CLIENT_INTERNAL', 'download_url_expired'));
});

test('an expired URL is replaced before the download starts', async (t) => {
  const { fake, storage, link, run } = await harness(t);
  const stale = storage.serve('/b/stale', { status: 200, body: pkg.zip });
  fake.script('GET', C03, link(stale, { expires_at: new Date(Date.now() - 1000).toISOString() }),
    link(storage.serve('/b/fresh', { status: 200, body: pkg.zip })));
  assert.deepEqual(await run(), pkg.zip);
  assert.deepEqual(storage.requests.map((r) => r.path), ['/b/fresh']);
});

test('redirects are refused and not followed', async (t) => {
  const { fake, storage, link, run } = await harness(t);
  const target = storage.serve('/b/target', { status: 200, body: pkg.zip });
  fake.script('GET', C03, link(storage.serve('/b/r', { status: 302, headers: { location: target } })));
  await assert.rejects(run(), failsWith('CLIENT_INTERNAL', 'download_redirect'));
  assert.deepEqual(storage.requests.map((r) => r.path), ['/b/r']);
});

test('short, long and altered bodies are PACKAGE_MISMATCH', async (t) => {
  const { fake, storage, link, run } = await harness(t);
  const altered = Buffer.from(pkg.zip);
  altered[10] ^= 1;
  const cases = [[pkg.zip.subarray(1), 'size_mismatch'], [Buffer.concat([pkg.zip, Buffer.from('x')]), 'size_mismatch'], [altered, 'sha256_mismatch']];
  for (const [i, [body, reason]] of cases.entries()) {
    fake.script('GET', C03, link(storage.serve(`/b/m${i}`, { status: 200, body })));
    await assert.rejects(run(), failsWith('PACKAGE_MISMATCH', reason));
  }
  fake.script('GET', C03, link(storage.serve('/b/chunked', { status: 200, body: Buffer.concat([pkg.zip, pkg.zip]), headers: { 'transfer-encoding': 'chunked' } })));
  await assert.rejects(run(), failsWith('PACKAGE_MISMATCH', 'size_mismatch'));
});

test('C-03 metadata or host that does not match fails CLIENT_INTERNAL without downloading', async (t) => {
  const { fake, storage, link, run } = await harness(t);
  const url = storage.serve('/b/x', { status: 200, body: pkg.zip });
  fake.script('GET', C03, link(url, { sha256: 'a'.repeat(64) }), link(url, { size: pkg.size + 1 }), link('https://evil.example.test/b/x'));
  await assert.rejects(run(), failsWith('CLIENT_INTERNAL', 'download_metadata_mismatch'));
  await assert.rejects(run(), failsWith('CLIENT_INTERNAL', 'download_metadata_mismatch'));
  await assert.rejects(run(), failsWith('CLIENT_INTERNAL', 'download_host_refused'));
  assert.equal(storage.requests.length, 0);
});

test('C-03 SHELF_RESPONSE_INVALID is reported as itself', async (t) => {
  const { fake, run } = await harness(t);
  fake.script('GET', C03, fake.problem(409, 'SHELF_RESPONSE_INVALID'));
  await assert.rejects(run(), failsWith('SHELF_RESPONSE_INVALID', 'shelf_response_invalid'));
});

test('a content-length other than the size is refused even when the body is right', async (t) => {
  const { fake, storage, link, run } = await harness(t);
  fake.script('GET', C03, link(`${storage.origin}/b/cl`));
  const fetchImpl = async () => new Response(pkg.zip, { headers: { 'content-length': String(pkg.size + 1) } });
  await assert.rejects(run({ fetchImpl }), failsWith('PACKAGE_MISMATCH', 'size_mismatch'));
});

test('an oversized body is cut off while streaming, not read to the end', async (t) => {
  const { fake, storage, link, run } = await harness(t);
  fake.script('GET', C03, link(`${storage.origin}/b/endless`));
  let pulls = 0;
  const body = new ReadableStream({
    pull(c) {
      if (++pulls > 100) return c.error(new Error('read too far'));
      c.enqueue(new Uint8Array(pkg.size));
    },
  }, { highWaterMark: 0 });
  await assert.rejects(run({ fetchImpl: async () => new Response(body) }), failsWith('PACKAGE_MISMATCH', 'size_mismatch'));
  assert.ok(pulls <= 3, `${pulls} chunks read`);
});

test('the whole download, retries included, stops at the deadline', async (t) => {
  const { fake, storage, link, run } = await harness(t);
  fake.script('GET', C03, link(`${storage.origin}/b/slow`));
  const signals = [];
  const fetchImpl = (url, { signal }) => {
    signals.push(signal);
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
  };
  const t0 = Date.now();
  await assert.rejects(run({ fetchImpl, deadlineMs: 200 }), (e) => e instanceof MarketError && e.transient);
  assert.ok(Date.now() - t0 < 2000);
  assert.equal(signals.length, 1);
  assert.ok(signals[0].aborted);
});

test('no storage request starts once the deadline has passed', async (t) => {
  const { storage, link } = await harness(t);
  const api = { packageDownload: async () => { await new Promise((r) => setTimeout(r, 150)); return link(`${storage.origin}/b/late`).json; } };
  let fetched = 0;
  const fetchImpl = async () => { fetched++; return new Response(pkg.zip); };
  await assert.rejects(downloadPackage({
    api, orgId: ORG, subPath: SUB, sha: pkg.sha, size: pkg.size, emulatorOrigin: storage.origin, fetchImpl, deadlineMs: 100,
  }), (e) => e instanceof MarketError && e.transient);
  assert.equal(fetched, 0);
});

test('C-03 errors: revoked, re-judged, transient retried, request ended rethrown', async (t) => {
  const { fake, storage, link, run } = await harness(t);
  fake.script('GET', C03, fake.problem(409, 'VERSION_REVOKED'), fake.problem(409, 'NOT_APPROVED'),
    fake.problem(503, 'DEPENDENCY_UNAVAILABLE'), { ...fake.problem(429, 'RATE_LIMITED'), headers: { 'retry-after': '1' } },
    link(storage.serve('/b/ok', { status: 200, body: pkg.zip })), fake.problem(404, 'NOT_FOUND'));
  await assert.rejects(run(), failsWith('VERSION_REVOKED', 'version_revoked'));
  await assert.rejects(run(), failsWith('CLIENT_INTERNAL', 'download_unavailable'));
  const waits = [];
  assert.deepEqual(await run({ sleep: async (ms) => { waits.push(ms); } }), pkg.zip);
  assert.ok(waits.length === 2 && waits[1] >= 1000);
  await assert.rejects(run(), (e) => e.name === 'MarketError' && e.code === 'NOT_FOUND');
});
