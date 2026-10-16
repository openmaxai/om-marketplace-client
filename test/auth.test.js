import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { FAKE_KEY, VALID_ENV, mode, tmpHome } from './helpers.js';
import { startFakeMarket } from './fake/market.js';
import { createAuth, memberIdFromJwt } from '../src/auth.js';
import { MarketError } from '../src/http.js';

const ORG = VALID_ENV.COCO_ORG_ID;
const ORG2 = '1c2d3e4f-5555-4a6b-8c7d-dddddddddddd';
const MEMBER = VALID_ENV.COCO_MEMBER_ID;

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
  assert.equal(mode(path.join(tokenDir, `${ORG}.json`)), 0o600);
  const again = createAuth({ bffUrl: fake.url, apiKey: FAKE_KEY, tokenDir });
  assert.equal(await again.getAccessToken(ORG), token);
  assert.equal(fake.auth().length, 1);
  assert.deepEqual(fs.readdirSync(tokenDir), [`${ORG}.json`]);
});

test('exchange failures are typed and never carry the API key; org ids are validated', async (t) => {
  const { fake } = await setup(t);
  const bad = createAuth({ bffUrl: fake.url, apiKey: `${FAKE_KEY}x` });
  const err = await bad.getAccessToken(ORG).catch((e) => e);
  assert.ok(err instanceof MarketError);
  assert.equal(err.status, 401);
  assert.ok(!err.message.includes(FAKE_KEY) && !err.stack.includes(FAKE_KEY));
  for (const org of ['../x', ORG.toUpperCase(), '', undefined]) {
    await assert.rejects(bad.getAccessToken(org), TypeError);
  }
  fake.script('POST', '/auth/agent/token', { status: 200, json: { token: 'x' } });
  await assert.rejects(bad.getAccessToken(ORG), { code: 'RESPONSE_INVALID' });
});

test('401-triggered refresh is allowed once per org per 10 minutes', async (t) => {
  let clock = 0;
  const { auth } = await setup(t, { auth: { now: () => clock } });
  assert.equal(auth.consume401Refresh(ORG), true);
  assert.equal(auth.consume401Refresh(ORG), false);
  assert.equal(auth.consume401Refresh(ORG2), true);
  clock += 10 * 60_000;
  assert.equal(auth.consume401Refresh(ORG), true);
});
