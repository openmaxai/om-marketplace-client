import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VALID_ENV } from './helpers.js';
import { marketHarness } from './fake/market.js';
import { createMarketApi } from '../src/market-api.js';
import { MarketError } from '../src/http.js';

const ORG = VALID_ENV.COCO_ORG_ID;
const AGENT = VALID_ENV.COCO_MEMBER_ID;
const INTENTS = `/api/v1/orgs/${ORG}/agents/${AGENT}/install-intents:query`;
const REVOCATIONS = `/api/v1/orgs/${ORG}/revocations:query`;
const U = (n) => `0190f000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const SHA = 'ab'.repeat(32);

const intent = (over = {}) => ({
  id: U(1), org_id: ORG, op: 'install', skill_id: U(2), skill_version_id: U(3), template_id: null,
  source_market_id: U(4), adoption_id: null, discard_local_changes: false, expires_at: '2026-10-17T00:00:00Z', seq: 5, ...over,
});
const page = (items, over = {}) => ({ items, has_more: false, next_after_seq: 9, policy_sha256: SHA, ...over });
const revocation = (over = {}) => ({
  kind: 'version_revoke', source_market_id: U(4), skill_id: U(2), skill_version_id: U(3), template_version_id: null,
  package_sha256: SHA, manifest_sha256: null, revoked_at: '2026-10-16T01:02:03.5+08:00', ...over,
});

async function setup(t) {
  const h = await marketHarness(t);
  return { ...h, api: createMarketApi({ http: h.http }) };
}

test('install-intents:query sends the pending query and returns only validated known fields', async (t) => {
  const { fake, api } = await setup(t);
  const tpl = intent({ id: U(7), op: 'write_template', skill_id: null, skill_version_id: null, template_id: U(8), adoption_id: U(9), seq: 6, bundle_sha256: SHA });
  fake.script('POST', INTENTS, { status: 200, json: page([{ ...intent(), extra: 'x' }, tpl], { has_more: true }) }, { status: 204 });
  const got = await api.pullInstallIntents({ orgId: ORG, agentId: AGENT, afterSeq: 4, limit: 50 });
  assert.deepEqual(fake.market()[0].json, { status: 'pending', after_seq: 4, limit: 50 });
  assert.deepEqual(got, page([intent(), tpl], { has_more: true }));
  assert.equal(await api.pullInstallIntents({ orgId: ORG, agentId: AGENT, afterSeq: 9 }), null);
  assert.deepEqual(fake.market()[1].json, { status: 'pending', after_seq: 9, limit: 100 });
});

test('install-intents:query rejects malformed responses as RESPONSE_INVALID', async (t) => {
  const { fake, api } = await setup(t);
  const bad = [
    page([intent()], { policy_sha256: SHA.toUpperCase() }),
    page([intent({ op: 'reinstall' })]),
    page([intent({ id: U(1).toUpperCase() })]),
    page([intent({ seq: 4 })]),
    page([intent({ seq: 6 }), intent({ seq: 6 })]),
    page([intent()], { next_after_seq: 4 }),
    page([intent({ op: 'write_template', template_id: U(8), adoption_id: U(9) })]),
    page([intent({ bundle_sha256: SHA })]),
    page([intent({ skill_id: null })]),
    page([intent({ expires_at: 'tomorrow' })]),
    page([intent({ discard_local_changes: 'no' })]),
    page(Array.from({ length: 3 }, (_, i) => intent({ seq: 5 + i })), {}),
    { items: [], has_more: false, next_after_seq: 4 },
    [],
  ];
  for (const body of bad) fake.script('POST', INTENTS, { status: 200, json: body });
  fake.script('POST', INTENTS, { status: 200, raw: 'not json', headers: { 'content-type': 'application/json' } },
    { status: 202, json: {} });
  for (let i = 0; i < bad.length + 2; i++) {
    const err = await api.pullInstallIntents({ orgId: ORG, agentId: AGENT, afterSeq: 4, limit: 2 }).catch((e) => e);
    assert.ok(err instanceof MarketError, `case ${i}`);
    assert.equal(err.code, 'RESPONSE_INVALID', `case ${i}`);
    assert.equal(err.transient, false);
  }
});

test('install-intents:query validates arguments and surfaces gate errors', async (t) => {
  const { fake, api } = await setup(t);
  for (const args of [{ agentId: 'x' }, { agentId: AGENT, afterSeq: -1 }, { agentId: AGENT, limit: 101 }, { agentId: AGENT, limit: 0 }]) {
    await assert.rejects(api.pullInstallIntents({ orgId: ORG, ...args }), TypeError);
  }
  fake.script('POST', INTENTS, { status: 409, problem: { code: 'CLIENT_VERSION_TOO_OLD', reason: 'missing', min_version: '1.0.0' } });
  await assert.rejects(api.pullInstallIntents({ orgId: ORG, agentId: AGENT }), { code: 'CLIENT_VERSION_TOO_OLD', min_version: '1.0.0' });
});

test('revocations:query sends the cursor and validates the page', async (t) => {
  const { fake, api } = await setup(t);
  const tpl = revocation({ kind: 'template_revoke', skill_id: null, skill_version_id: null, template_version_id: U(5), package_sha256: null, manifest_sha256: SHA });
  fake.script('POST', REVOCATIONS,
    { status: 200, json: { items: [revocation(), tpl], next_cursor: '3:17', has_more: true } },
    { status: 200, json: { items: [], next_cursor: null, has_more: false } });
  assert.deepEqual(await api.pullRevocations({ orgId: ORG }), { items: [revocation(), tpl], has_more: true, next_cursor: '3:17' });
  assert.deepEqual(await api.pullRevocations({ orgId: ORG, cursor: '3:17' }), { items: [], has_more: false, next_cursor: null });
  assert.deepEqual(fake.market().map((r) => r.json), [{}, { cursor: '3:17' }]);
  await assert.rejects(api.pullRevocations({ orgId: ORG, cursor: 'abc' }), TypeError);
});

test('revocations:query rejects malformed responses and surfaces CURSOR_INVALID', async (t) => {
  const { fake, api } = await setup(t);
  const ok = { next_cursor: '1:1', has_more: false };
  const bad = [
    { items: [revocation({ kind: 'unpublish' })], ...ok },
    { items: [revocation({ skill_version_id: null })], ...ok },
    { items: [revocation({ kind: 'template_revoke' })], ...ok },
    { items: [revocation({ kind: 'sha_block', package_sha256: null })], ...ok },
    { items: [revocation({ package_sha256: 'zz' })], ...ok },
    { items: [revocation({ revoked_at: 1 })], ...ok },
    { items: [], next_cursor: 'x', has_more: false },
    { items: [], next_cursor: null, has_more: true },
    { items: {}, ...ok },
  ];
  for (const body of bad) fake.script('POST', REVOCATIONS, { status: 200, json: body });
  fake.script('POST', REVOCATIONS, { status: 204 });
  for (let i = 0; i <= bad.length; i++) {
    await assert.rejects(api.pullRevocations({ orgId: ORG }), { code: 'RESPONSE_INVALID' }, `case ${i}`);
  }
  fake.script('POST', REVOCATIONS, { status: 400, problem: { code: 'CURSOR_INVALID' } });
  await assert.rejects(api.pullRevocations({ orgId: ORG, cursor: '1:1' }), { status: 400, code: 'CURSOR_INVALID' });
});
