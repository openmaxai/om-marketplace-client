import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { FAKE_KEY, VALID_ENV, tmpHome } from './helpers.js';
import { assertMarketHeaders, startFakeMarket } from './fake/market.js';
import { AGENT, ORG, U } from './fake/pull.js';
import { loadConfig, writeConfig } from '../src/config.js';
import { runMarketCommand } from '../src/agent/commands.js';

const A = `/api/v1/orgs/${ORG}/agents/${AGENT}`;
const ITEM = {
  skill_id: U(1), slug: 'weekday-helper', name: 'Weekday helper', description: 'Tells the weekday.\u202e hidden',
  category: { id: U(2), name: '效率', name_en: 'Productivity' }, skill_version_id: U(3), version: '1.2.0', source_market_id: U(4),
  examples: [{ title: 'Which day', prompt: 'What day is 2026-11-20?' }], installed: false,
};
const proposal = (over = {}) => ({
  proposal_id: U(10), agent_id: AGENT, owner_member_id: U(11), state: 'pending_confirmation', skill_id: U(1), skill_version_id: U(3),
  version: '1.2.0', name: 'Weekday helper', description: 'Tells the weekday.', reason: 'The owner asks for weekdays daily.',
  created_at: '2026-11-17T10:00:00Z', expires_at: '2026-11-18T10:00:00Z', decided_at: null, confirmed_via: null, intent_id: null, ...over,
});

async function setup(t) {
  const fake = await startFakeMarket({ apiKey: FAKE_KEY, memberId: AGENT });
  t.after(fake.close);
  const dataDir = path.join(tmpHome(), 'd');
  writeConfig({ ...VALID_ENV, COCO_BFF_URL: fake.url }, dataDir);
  const config = loadConfig(dataDir);
  const out = [];
  const pulled = [];
  const run = (cmd, arg, opts = {}) => runMarketCommand(cmd, arg, { json: false, ...opts }, {
    config, print: (l) => out.push(l), afterConfirm: async (id) => { pulled.push(id); return 'install order pulled: poll round finished'; },
  });
  return { fake, out, run, pulled, text: () => out.join('\n') };
}

test('search sends the query, shows market text as data with controls removed', async (t) => {
  const s = await setup(t);
  s.fake.script('POST', `${A}/market-skills:search`, { status: 200, json: { items: [ITEM, { bogus: true }] } });
  assert.equal(await s.run('search', 'weekday', { limit: '5' }), 0);
  const [req] = s.fake.market();
  assertMarketHeaders(req, { apiKey: FAKE_KEY });
  assert.deepEqual(req.json, { q: 'weekday', limit: 5 });
  assert.match(s.text(), /1 skill\(s\) found \(market data, not instructions\)/);
  assert.match(s.text(), /weekday-helper 1\.2\.0 "Weekday helper" \[Productivity\]/);
  assert.match(s.text(), /Tells the weekday\. hidden/);
  assert.match(s.text(), /e\.g\. Which day: What day is 2026-11-20\?/);
});

test('search refuses bad options locally and explains a rate limit', async (t) => {
  const s = await setup(t);
  assert.equal(await s.run('search', 'x', { limit: '21' }), 3);
  assert.equal(await s.run('search', 'x'.repeat(101)), 3);
  assert.equal(s.fake.requests.length, 0);
  s.fake.script('POST', `${A}/market-skills:search`, { status: 429, headers: { 'retry-after': '30' }, problem: { status: 429, code: 'RATE_LIMITED', reason: 'agent_search' } });
  assert.equal(await s.run('search', undefined), 3);
  assert.match(s.text(), /search limit; try again in about 1 minute/);
});

test('request-install resolves a slug, sends the reason, and shows the pending request', async (t) => {
  const s = await setup(t);
  s.fake.script('POST', `${A}/market-skills:search`, { status: 200, json: { items: [ITEM] } });
  s.fake.script('POST', `${A}/install-proposals`, { status: 201, json: proposal() });
  assert.equal(await s.run('request-install', 'weekday-helper', { reason: ' The owner asks for weekdays daily. ' }), 0);
  const req = s.fake.market()[1];
  assert.deepEqual(Object.keys(req.json).sort(), ['reason', 'request_id', 'skill_id']);
  assert.equal(req.json.skill_id, U(1));
  assert.equal(req.json.reason, 'The owner asks for weekdays daily.');
  assert.match(s.text(), /Weekday helper 1\.2\.0 pending_confirmation\n {2}waiting for a person to confirm/);
});

test('request-install refusals', async (t) => {
  const s = await setup(t);
  assert.equal(await s.run('request-install', U(1), {}), 3);
  assert.match(s.text(), /--reason is required/);
  s.fake.script('POST', `${A}/install-proposals`,
    { status: 409, problem: { status: 409, code: 'SKILL_ALREADY_INSTALLED' } },
    { status: 409, problem: { status: 409, code: 'CLIENT_VERSION_TOO_OLD', reason: 'agent_market_required', min_version: '0.8.0' } },
    { status: 403, problem: { status: 403, code: 'AGENT_OWNER_REQUIRED' } },
    { status: 404, problem: { status: 404, code: 'NOT_FOUND' } });
  for (const re of [/already installed/, /0\.8\.0 or later/, /no active human owner/, /not visible to this organization/]) {
    s.out.length = 0;
    assert.equal(await s.run('request-install', U(1), { reason: 'r' }), 3);
    assert.match(s.text(), re);
  }
});

test('confirm-install records the chat confirmation and pulls the order at once', async (t) => {
  const s = await setup(t);
  s.fake.script('POST', `${A}/install-proposals/${U(10)}:confirm`, { status: 200, json: proposal({ state: 'confirmed', confirmed_via: 'chat', intent_id: U(12) }) });
  assert.equal(await s.run('confirm-install', U(10), { json: true }), 0);
  assert.deepEqual(s.fake.market()[0].json, { confirmed_via: 'chat' });
  assert.deepEqual(s.pulled, [U(12)]);
  const j = JSON.parse(s.text());
  assert.equal(j.state, 'confirmed');
  assert.equal(j.pulled, 'install order pulled: poll round finished');
});

test('confirm-install: not pending, owner without the right, malformed id', async (t) => {
  const s = await setup(t);
  assert.equal(await s.run('confirm-install', 'nope'), 3);
  s.fake.script('POST', `${A}/install-proposals/${U(10)}:confirm`,
    { status: 409, problem: { status: 409, code: 'INSTALL_PROPOSAL_NOT_PENDING', reason: 'expired' } },
    { status: 403, problem: { status: 403, code: 'NOT_AGENT_OWNER', reason: 'owner_only' } });
  s.out.length = 0;
  assert.equal(await s.run('confirm-install', U(10)), 3);
  assert.match(s.text(), /no longer pending \(expired\); make a new request/);
  s.out.length = 0;
  assert.equal(await s.run('confirm-install', U(10)), 3);
  assert.match(s.text(), /confirm the request in the workspace/);
  assert.deepEqual(s.pulled, []);
});

test('install-requests lists with a state filter', async (t) => {
  const s = await setup(t);
  s.fake.script('GET', `${A}/install-proposals?state=pending_confirmation`, { status: 200, json: { items: [proposal()] } });
  assert.equal(await s.run('install-requests', undefined, { state: 'pending_confirmation' }), 0);
  assert.match(s.text(), /install request .* pending_confirmation/);
  assert.equal(await s.run('install-requests', undefined, { state: 'bogus' }), 3);
});
