import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VALID_ENV } from './helpers.js';
import { marketHarness, startFakeMarket } from './fake/market.js';
import { MAX_RETRY_AFTER_MS, MarketError, backoffMs, createMarketHttp, parseRetryAfter } from '../src/http.js';

const ORG = VALID_ENV.COCO_ORG_ID;
const PATH = `/api/v1/orgs/${ORG}/revocations:query`;

const call = (http) => http.request('POST', ORG, '/revocations:query', {}).catch((e) => e);

test('every market call carries the version header and bearer token, success and error alike', async (t) => {
  const { fake, http } = await marketHarness(t);
  fake.script('POST', PATH, { status: 200, json: { ok: true } }, fake.problem(400, 'VALIDATION_FAILED'), fake.problem(404, 'NOT_FOUND'));
  const r = await http.request('POST', ORG, '/revocations:query', {});
  assert.deepEqual(r.data, { ok: true });
  assert.equal((await call(http)).code, 'VALIDATION_FAILED');
  assert.equal((await call(http)).status, 404);
  assert.equal(fake.market().length, 3);
  assert.equal(fake.market()[0].headers.authorization, `Bearer ${fake.issued.access[0]}`);
  assert.equal(fake.market()[0].headers['content-type'], 'application/json');
});

test('problem+json is parsed into a typed MarketError', async (t) => {
  const { fake, http } = await marketHarness(t);
  const other = '2e3f4a5b-6666-4c7d-9e8f-eeeeeeeeeeee';
  fake.script('POST', PATH,
    { status: 409, problem: { code: 'CLIENT_VERSION_TOO_OLD', reason: 'below_minimum', min_version: '0.2.0' } },
    { status: 403, problem: { code: 'INSTALLED_BY_OTHER_ORG', installed_by_org_id: other, details: { a: 1 } } },
    { status: 400, problem: { code: 'VALIDATION_FAILED', errors: [{ field: 'limit' }] } },
    { status: 500, raw: '<html>oops</html>', headers: { 'content-type': 'text/html' } });
  const tooOld = await call(http);
  assert.ok(tooOld instanceof MarketError);
  assert.deepEqual([tooOld.status, tooOld.code, tooOld.reason, tooOld.min_version, tooOld.transient],
    [409, 'CLIENT_VERSION_TOO_OLD', 'below_minimum', '0.2.0', false]);
  const byOther = await call(http);
  assert.deepEqual([byOther.code, byOther.installed_by_org_id, byOther.details], ['INSTALLED_BY_OTHER_ORG', other, { a: 1 }]);
  assert.deepEqual((await call(http)).errors, [{ field: 'limit' }]);
  const html = await call(http);
  assert.deepEqual([html.status, html.code, html.transient], [500, null, true]);
});

test('MEMBER_LEFT_ORG is surfaced and logged without trying another org', async (t) => {
  const { fake, http, lines } = await marketHarness(t);
  fake.script('POST', PATH, fake.problem(403, 'MEMBER_LEFT_ORG'));
  const err = await call(http);
  assert.deepEqual([err.status, err.code], [403, 'MEMBER_LEFT_ORG']);
  assert.equal(fake.market().length, 1);
  assert.equal(fake.auth().length, 1);
  assert.ok(lines.some((l) => l.includes('[warn]') && l.includes('MEMBER_LEFT_ORG')));
});

test('401 refreshes the token and retries exactly once', async (t) => {
  const { fake, http } = await marketHarness(t);
  fake.script('POST', PATH, fake.problem(401, 'PRINCIPAL_INVALID'), { status: 200, json: {} });
  assert.equal((await http.request('POST', ORG, '/revocations:query', {})).status, 200);
  assert.deepEqual(fake.auth().map((r) => r.path), ['/auth/agent/token', '/auth/refresh']);
  const [first, second] = fake.market();
  assert.equal(first.headers.authorization, `Bearer ${fake.issued.access[0]}`);
  assert.equal(second.headers.authorization, `Bearer ${fake.issued.access[1]}`);
  assert.equal(first.body, second.body);

  fake.script('POST', PATH, fake.problem(401, 'PRINCIPAL_INVALID'), fake.problem(401, 'PRINCIPAL_INVALID'));
  const err = await call(http);
  assert.equal(err.status, 401);
  assert.equal(fake.market().length, 3, 'no second refresh inside the throttle window');
  assert.equal(fake.auth().length, 2);
});

test('a second 401 after the refresh is returned, not retried again', async (t) => {
  const { fake, http } = await marketHarness(t);
  fake.script('POST', PATH, fake.problem(401, 'PRINCIPAL_INVALID'), fake.problem(401, 'PRINCIPAL_INVALID'));
  assert.equal((await call(http)).code, 'PRINCIPAL_INVALID');
  assert.equal(fake.market().length, 2);
});

test('Retry-After is parsed, capped, and honoured by backoff', async (t) => {
  const { fake, http } = await marketHarness(t);
  fake.script('POST', PATH, { ...fake.problem(429, 'RATE_LIMITED'), headers: { 'retry-after': '7' } });
  const err = await call(http);
  assert.deepEqual([err.code, err.retryAfterMs, err.transient], ['RATE_LIMITED', 7000, true]);
  assert.equal(backoffMs(err, 0, () => 0), 7000);
  assert.equal(backoffMs(null, 3, () => 1), 8000);
  const now = Date.parse('2026-10-16T00:00:00Z');
  assert.equal(parseRetryAfter('Fri, 16 Oct 2026 00:00:30 GMT', now), 30_000);
  assert.equal(parseRetryAfter('Thu, 15 Oct 2026 00:00:00 GMT', now), 0);
  assert.equal(parseRetryAfter('999999999', now), MAX_RETRY_AFTER_MS);
  for (const v of [null, '', '-1', '1.5', 'soon']) assert.equal(parseRetryAfter(v, now), null, String(v));
});

test('redirects are refused and never followed', async (t) => {
  const { fake, http } = await marketHarness(t);
  const elsewhere = await startFakeMarket({});
  t.after(elsewhere.close);
  fake.script('POST', PATH, { status: 302, headers: { location: `${elsewhere.url}/steal` } },
    { status: 307, headers: { location: PATH } });
  assert.equal((await call(http)).code, 'REDIRECT_REFUSED');
  assert.equal((await call(http)).code, 'REDIRECT_REFUSED');
  assert.equal(elsewhere.requests.length, 0);
  assert.equal(fake.market().length, 2);
});

test('timeouts, network errors and oversized bodies are typed', async (t) => {
  const { fake, http } = await marketHarness(t, { timeoutMs: 200 });
  fake.script('POST', PATH, { status: 200, json: {}, delayMs: 500 },
    { status: 200, raw: 'x'.repeat(1024 * 1024 + 1), headers: { 'content-type': 'application/json' } });
  const slow = await call(http);
  assert.deepEqual([slow.code, slow.transient], ['TIMEOUT', true]);
  assert.equal((await call(http)).code, 'RESPONSE_TOO_LARGE');
  const auth = { getAccessToken: async () => 'a.b.c', renewAfter401: async () => false };
  const dead = createMarketHttp({ bffUrl: 'http://127.0.0.1:1', auth });
  assert.deepEqual(await call(dead).then((e) => [e.code, e.transient]), ['NETWORK_ERROR', true]);
});

test('paths and org ids are validated before anything is sent', async (t) => {
  const { fake, http } = await marketHarness(t);
  for (const [org, p] of [[ORG, '/../x'], [ORG, 'x'], [ORG, '//evil.test/x'], [ORG, '/a?b=1'], [ORG, '/%2e%2e/x'],
    [ORG, '/%2E%2E/x'], [ORG, '/a%2Fb'], [ORG, '/a%zz'], ['../x', '/x'], ['.', '/x'], ['..', '/x'], ['a/b', '/x'], ['', '/x']]) {
    await assert.rejects(http.request('GET', org, p), TypeError, `${org} ${p}`);
  }
  assert.equal(fake.requests.length, 0);
});

test('createMarketHttp enforces the BFF URL rules', () => {
  const auth = { getAccessToken: async () => 'a.b.c', renewAfter401: async () => false };
  for (const bffUrl of ['http://bff.example.test', 'ftp://127.0.0.1', 'https://u:p@bff.example.test', 'https://bff.example.test/x']) {
    assert.throws(() => createMarketHttp({ bffUrl, auth }), { name: 'ConfigError' }, bffUrl);
  }
});

test('concurrent 401s share one renewal and both requests succeed', async (t) => {
  const { fake, http } = await marketHarness(t);
  await http.request('POST', ORG, '/revocations:query', {});
  const unauthorized = fake.problem(401, 'PRINCIPAL_INVALID');
  fake.script('POST', PATH, unauthorized, unauthorized, { status: 200, json: {} }, { status: 200, json: {} });
  const [a, b] = await Promise.all([call(http), call(http)]);
  assert.deepEqual([a.status, b.status], [200, 200]);
  assert.deepEqual(fake.auth().map((r) => r.path), ['/auth/agent/token', '/auth/refresh']);
});

test('a 401 on a token already replaced retries without using the renewal window', async (t) => {
  const { fake, http } = await marketHarness(t);
  await http.request('POST', ORG, '/revocations:query', {});
  const unauthorized = fake.problem(401, 'PRINCIPAL_INVALID');
  fake.script('POST', PATH, unauthorized, { ...unauthorized, delayMs: 200 }, { status: 200, json: {} }, { status: 200, json: {} });
  const [a, b] = await Promise.all([call(http), call(http)]);
  assert.deepEqual([a.status, b.status], [200, 200]);
  assert.equal(fake.auth().length, 2, 'one renewal');
  const stale = `Bearer ${fake.issued.access[0]}`;
  const fresh = `Bearer ${fake.issued.access[1]}`;
  assert.deepEqual(fake.market().slice(1).map((r) => r.headers.authorization).sort(), [stale, stale, fresh, fresh].sort());
});
