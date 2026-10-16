import http from 'node:http';
import assert from 'node:assert/strict';
import { CLIENT_VERSION } from '../../src/version.js';
import { createAuth } from '../../src/auth.js';
import { createMarketHttp } from '../../src/http.js';
import { createLogger } from '../../src/logger.js';
import { FAKE_KEY, VALID_ENV } from '../helpers.js';

export function fakeJwt(claims) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${enc({ alg: 'none', typ: 'JWT' })}.${enc(claims)}.fake-signature`;
}

// Revocation log epoch of the fake deployment; cursors are written like the server's FormatRevocationCursor.
export const REVOCATION_EPOCH = '5f0c9e2a-7b1d-4c3e-9a8f-0123456789ab';
export const fakeCursor = (seq, epoch = REVOCATION_EPOCH) => `${epoch}:${seq}`;

// Fake BFF on 127.0.0.1. Token endpoints mint fake JWTs by default; script(method, path, ...responses) queues
// responses ({status, json, problem, headers, delayMs, raw}) or functions of the recorded request, consumed in order.
// apiKey may be a list of accepted keys. Unscripted revocations:query answers an empty page with a real-shaped cursor.
export async function startFakeMarket({ apiKey, memberId, ttlSec = 3600 } = {}) {
  const keys = [].concat(apiKey ?? []);
  const requests = [];
  const scripts = new Map();
  const issued = { access: [], refresh: [] };

  const mint = (orgId) => {
    const n = issued.access.length + 1;
    const exp = Math.floor(Date.now() / 1000) + ttlSec;
    const pair = {
      access_token: fakeJwt({ member_id: memberId, org_id: orgId, n, exp }),
      access_token_expires_at: new Date(exp * 1000).toISOString(),
      refresh_token: `fake-refresh-${n}`,
      refresh_token_expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    };
    issued.access.push(pair.access_token);
    issued.refresh.push(pair.refresh_token);
    return { status: 200, json: pair };
  };
  const problem = (status, code) => ({ status, problem: { type: 'about:blank', title: code, status, code } });

  const defaults = {
    'POST /auth/agent/token': (req) => (keys.some((k) => req.headers.authorization === `Bearer ${k}`) && req.json?.org_id
      ? mint(req.json.org_id) : problem(401, 'UNAUTHENTICATED')),
    'POST /auth/refresh': (req) => (issued.refresh.includes(req.json?.refresh_token)
      && issued.access.includes(req.headers.authorization?.slice(7))
      ? mint(req.json.org_id) : problem(401, 'UNAUTHENTICATED')),
  };
  const revocationsDefault = (req) => ({
    status: 200, json: { items: [], next_cursor: req.json?.cursor ?? fakeCursor(0), has_more: false },
  });

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      let json = null;
      try { json = body ? JSON.parse(body) : null; } catch { /* recorded as text */ }
      const rec = { method: req.method, path: req.url, headers: req.headers, rawHeaders: req.rawHeaders, body, json };
      requests.push(rec);
      const key = `${req.method} ${req.url}`;
      let step = scripts.get(key)?.shift() ?? defaults[key]
        ?? (/^POST \/api\/v1\/orgs\/[^/]+\/revocations:query$/.test(key) ? revocationsDefault : problem(404, 'NOT_FOUND'));
      if (typeof step === 'function') step = step(rec);
      if (step.delayMs) await new Promise((r) => setTimeout(r, step.delayMs));
      const headers = { ...step.headers };
      let out = step.raw ?? '';
      if (step.problem) {
        headers['content-type'] ??= 'application/problem+json';
        out = JSON.stringify(step.problem);
      } else if (step.json !== undefined) {
        headers['content-type'] ??= 'application/json';
        out = JSON.stringify(step.json);
      }
      res.writeHead(step.status ?? 200, headers);
      res.end(out);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;

  return {
    url,
    requests,
    issued,
    problem,
    script(method, path, ...steps) {
      const key = `${method} ${path}`;
      scripts.set(key, [...(scripts.get(key) ?? []), ...steps]);
    },
    market: () => requests.filter((r) => r.path.startsWith('/api/')),
    auth: () => requests.filter((r) => r.path.startsWith('/auth/')),
    close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }),
  };
}

// Every market request: exactly one version header, a bearer JWT, no identity headers, never the API key.
export function assertMarketHeaders(rec, { apiKey }) {
  const names = [];
  for (let i = 0; i < rec.rawHeaders.length; i += 2) names.push(rec.rawHeaders[i].toLowerCase());
  assert.equal(names.filter((n) => n === 'x-market-client-version').length, 1, 'one version header');
  assert.equal(rec.headers['x-market-client-version'], CLIENT_VERSION);
  assert.match(rec.headers.authorization, /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
  assert.ok(!rec.headers.authorization.includes(apiKey), 'API key sent to the market');
  assert.ok(!names.includes('x-principal-bin'), 'X-Principal-Bin sent');
  assert.ok(!names.some((n) => n.startsWith('x-caller-')), 'X-Caller-* sent');
}

// Fake market plus auth and http wired with a capturing debug logger.
export async function marketHarness(t, { timeoutMs } = {}) {
  const fake = await startFakeMarket({ apiKey: FAKE_KEY, memberId: VALID_ENV.COCO_MEMBER_ID });
  t.after(fake.close);
  const lines = [];
  const logger = createLogger('debug', { log: (l) => lines.push(l), error: (l) => lines.push(l) });
  const auth = createAuth({ bffUrl: fake.url, apiKey: FAKE_KEY, logger });
  const http = createMarketHttp({ bffUrl: fake.url, auth, logger, timeoutMs });
  // Every recorded market request is checked, and no credential ever reaches the log.
  t.after(() => {
    for (const r of fake.market()) assertMarketHeaders(r, { apiKey: FAKE_KEY });
    const log = lines.join('\n');
    for (const s of [FAKE_KEY, ...fake.issued.access, ...fake.issued.refresh]) assert.ok(!log.includes(s), 'secret logged');
  });
  return { fake, auth, http, lines };
}
