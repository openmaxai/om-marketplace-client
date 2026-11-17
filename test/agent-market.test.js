import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { FAKE_KEY, VALID_ENV, tmpHome } from './helpers.js';
import { assertMarketHeaders, startFakeMarket } from './fake/market.js';
import { AGENT, ORG, U } from './fake/pull.js';
import { loadConfig, writeConfig } from '../src/config.js';
import { runMarketCommand } from '../src/agent/commands.js';
import { installerList, installers } from '../src/http.js';
import { watchDir } from '../src/agent/proposal-watch.js';
import fs from 'node:fs';

const A = `/api/v1/orgs/${ORG}/agents/${AGENT}`;
const OWNER = U(11);
const ITEM = {
  skill_id: U(1), slug: 'weekday-helper', name: 'Weekday helper', description: 'Tells the weekday.\u202e hidden',
  category: { id: U(2), name: 'Efficiency', name_en: 'Productivity' }, skill_version_id: U(3), version: '1.2.0', source_market_id: U(4),
  examples: [{ title: 'Which day', prompt: 'What day is 2026-11-20?' }], installed: false,
};
const cand = (n, over = {}) => ({
  skill_id: U(n), skill_version_id: U(n + 50), version: '1.2.0', name: `Skill ${n}`, description: 'd', reason: `why ${n}`, selected: null, intent_id: null, ...over,
});
const proposal = (over = {}) => ({
  proposal_id: U(10), agent_id: AGENT, owner_member_id: OWNER, state: 'pending_confirmation', candidates: [cand(1), cand(5)],
  created_at: '2026-11-17T10:00:00Z', expires_at: '2026-11-18T10:00:00Z', decided_at: null, confirmed_via: null, confirmed_by_member_id: null, ...over,
});
const problem = (status, body, headers) => ({ status, headers, problem: { status, ...body } });

async function setup(t) {
  const fake = await startFakeMarket({ apiKey: FAKE_KEY, memberId: AGENT });
  t.after(fake.close);
  const dataDir = path.join(tmpHome(), 'd');
  writeConfig({ ...VALID_ENV, COCO_BFF_URL: fake.url }, dataDir);
  const config = loadConfig(dataDir);
  const out = [];
  const pulled = [];
  const run = (cmd, args = [], opts = {}) => runMarketCommand(cmd, args, { json: false, ...opts }, {
    config, print: (l) => out.push(l), afterConfirm: async (ids) => { pulled.push(...ids); return 'install orders pulled now'; },
  });
  return { fake, out, run, pulled, config, text: () => out.join('\n'), reset: () => { out.length = 0; } };
}

test('search sends the query, shows market text as data with controls removed', async (t) => {
  const s = await setup(t);
  s.fake.script('POST', `${A}/market-skills:search`, { status: 200, json: { items: [ITEM, { bogus: true }] } });
  assert.equal(await s.run('search', ['weekday'], { limit: '5' }), 0);
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
  assert.equal(await s.run('search', ['x'], { limit: '21' }), 3);
  assert.equal(await s.run('search', ['x'.repeat(101)]), 3);
  assert.equal(s.fake.requests.length, 0);
  s.fake.script('POST', `${A}/market-skills:search`, problem(429, { code: 'RATE_LIMITED', reason: 'agent_search' }, { 'retry-after': '30' }));
  assert.equal(await s.run('search'), 3);
  assert.match(s.text(), /search limit; try again in about 1 minute/);
});

test('install-permission reads who may install and who may confirm in chat', async (t) => {
  const s = await setup(t);
  const admins = { role: 'org_admins', member_id: null, display_name: null };
  const owned = { status: 200, json: { agent_id: AGENT, who_can_install: [{ role: 'owner', member_id: OWNER, display_name: 'Ana' }, admins], chat_confirm_by: { member_id: OWNER, display_name: 'Ana' }, caller_can_install: false } };
  s.fake.script('GET', `${A}/install-permission`, owned, owned,
    { status: 200, json: { agent_id: AGENT, who_can_install: [admins], chat_confirm_by: null, caller_can_install: false } });
  assert.equal(await s.run('install-permission', [], { json: true }), 0);
  const j = JSON.parse(s.text());
  assert.deepEqual(j.chat_confirm_by, { member_id: OWNER, display_name: 'Ana' });
  assert.equal(j.who_can_install.length, 2);
  s.reset();
  assert.equal(await s.run('install-permission'), 0);
  assert.equal(s.text(), `may install skills on this Agent: the owner Ana (${OWNER}), org admins. Confirmation in chat: only Ana (${OWNER}) (the owner)`);
  s.reset();
  assert.equal(await s.run('install-permission'), 0);
  assert.match(s.text(), /may install skills on this Agent: org admins\. This Agent has no active owner, so nobody can confirm in chat/);
});

test('request-install proposes up to 3 candidates, resolving slugs, with one reason each', async (t) => {
  const s = await setup(t);
  s.fake.script('POST', `${A}/market-skills:search`, { status: 200, json: { items: [ITEM] } });
  s.fake.script('POST', `${A}/install-proposals`, { status: 201, json: proposal() });
  assert.equal(await s.run('request-install', ['weekday-helper', U(5)], { reason: [' why 1 ', 'why 5'] }), 0);
  const req = s.fake.market()[1];
  assert.deepEqual(Object.keys(req.json).sort(), ['candidates', 'request_id']);
  assert.deepEqual(req.json.candidates, [{ skill_id: U(1), reason: 'why 1' }, { skill_id: U(5), reason: 'why 5' }]);
  assert.match(s.text(), /pending_confirmation\n {2}waiting for a person to choose and confirm[\s\S]*1\. Skill 1 1\.2\.0[\s\S]*2\. Skill 5/);
});

test('request-install refusals', async (t) => {
  const s = await setup(t);
  assert.equal(await s.run('request-install', [U(1)], {}), 3);
  assert.match(s.text(), /--reason/);
  assert.equal(await s.run('request-install', [U(1), U(2)], { reason: ['a', 'b', 'c'] }), 3);
  assert.equal(await s.run('request-install', [U(1), U(1)], { reason: ['a'] }), 3);
  assert.equal(await s.run('request-install', [U(1), U(2), U(3), U(4)], { reason: ['a'] }), 3);
  assert.equal(s.fake.requests.length, 0);
  s.fake.script('POST', `${A}/install-proposals`,
    problem(409, { code: 'SKILL_ALREADY_INSTALLED', detail: 'candidate 1 is already installed' }),
    problem(409, { code: 'CLIENT_VERSION_TOO_OLD', reason: 'agent_market_required', min_version: '0.8.0' }),
    problem(403, { code: 'AGENT_OWNER_REQUIRED' }),
    problem(404, { code: 'NOT_FOUND', field: '/candidates/0' }));
  for (const re of [/already installed .*\(candidate 1 is already installed\)/, /0\.8\.0 or later/, /no active human owner/, /not found \(\/candidates\/0\)/]) {
    s.reset();
    assert.equal(await s.run('request-install', [U(1)], { reason: ['r'] }), 3);
    assert.match(s.text(), re);
  }
});

test('confirm-install sends the chosen skills with confirmed_via chat and pulls the orders', async (t) => {
  const s = await setup(t);
  s.fake.script('GET', `${A}/install-proposals/${U(10)}`, { status: 200, json: proposal() });
  s.fake.script('POST', `${A}/install-proposals/${U(10)}:confirm`, {
    status: 200,
    json: proposal({ state: 'confirmed', confirmed_via: 'chat', confirmed_by_member_id: OWNER, candidates: [cand(1, { selected: false }), cand(5, { selected: true, intent_id: U(12) })] }),
  });
  assert.equal(await s.run('confirm-install', [U(10), '2'], { json: true }), 0);
  const confirm = s.fake.market().find((r) => r.path.endsWith(':confirm'));
  assert.deepEqual(confirm.json, { skill_ids: [U(5)], confirmed_via: 'chat' });
  assert.deepEqual(s.pulled, [U(12)]);
  const j = JSON.parse(s.text());
  assert.equal(j.state, 'confirmed');
  assert.equal(j.pulled, 'install orders pulled now');
});

test('confirm-install: refused for the Agent, not pending, bad input', async (t) => {
  const s = await setup(t);
  assert.equal(await s.run('confirm-install', ['nope', '1']), 3);
  assert.equal(await s.run('confirm-install', [U(10), 'x']), 3);
  assert.equal(s.fake.requests.length, 0);
  s.fake.script('POST', `${A}/install-proposals/${U(10)}:confirm`,
    problem(403, { code: 'NOT_AGENT_OWNER', reason: 'owner_only' }),
    problem(409, { code: 'INSTALL_PROPOSAL_NOT_PENDING', reason: 'expired' }));
  s.reset();
  assert.equal(await s.run('confirm-install', [U(10), U(1)], { json: true }), 3);
  const j = JSON.parse(s.text());
  assert.equal(j.error, 'NOT_AGENT_OWNER');
  assert.match(j.message, /install-permission.*install it in the workspace/);
  s.reset();
  assert.equal(await s.run('confirm-install', [U(10), U(1)]), 3);
  assert.match(s.text(), /no longer pending \(expired\); make a new request/);
  assert.deepEqual(s.pulled, []);
});

test('decline-install and install-requests', async (t) => {
  const s = await setup(t);
  s.fake.script('POST', `${A}/install-proposals/${U(10)}:decline`, { status: 200, json: proposal({ state: 'declined', confirmed_via: 'chat' }) });
  assert.equal(await s.run('decline-install', [U(10)]), 0);
  assert.deepEqual(s.fake.market()[0].json, { confirmed_via: 'chat' });
  assert.match(s.text(), /declined/);
  s.fake.script('GET', `${A}/install-proposals?state=pending_confirmation`, { status: 200, json: { items: [proposal()] } });
  s.reset();
  assert.equal(await s.run('install-requests', [], { state: 'pending_confirmation' }), 0);
  assert.match(s.text(), /install request .*: pending_confirmation/);
  assert.equal(await s.run('install-requests', [], { state: 'bogus' }), 3);
});

test('installers keeps role entries, cleans names and drops unreadable ones', () => {
  assert.deepEqual(installers([
    { role: 'owner', member_id: U(1), display_name: ' Ana\u0007 ' }, { role: 'org_admins', member_id: null, display_name: null },
    { role: 'owner', member_id: 'not an id' }, { member_id: U(2) }, U(3), null,
  ]), [{ role: 'owner', member_id: U(1), display_name: 'Ana' }, { role: 'org_admins', member_id: null, display_name: null }]);
  assert.equal(installerList(installers([{ role: 'owner', member_id: U(1) }, { role: 'org_admins', member_id: null }])), `the owner ${U(1)}, org admins`);
});

test('request-install watches a pending request; confirm and decline stop watching it', async (t) => {
  const s = await setup(t);
  const dataDir = path.join(tmpHome(), 'w');
  const run = (cmd, args, opts = {}) => runMarketCommand(cmd, args, { json: false, ...opts }, {
    config: s.config, dataDir, print: () => {}, afterConfirm: async () => 'pulled',
  });
  s.fake.script('POST', `${A}/install-proposals`, { status: 201, json: proposal() });
  assert.equal(await run('request-install', [U(1)], { reason: ['r'] }), 0);
  const file = path.join(watchDir(dataDir), `${U(10)}.json`);
  const w = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual([w.org_id, w.agent_id, w.expires_at_ms], [ORG, AGENT, Date.parse('2026-11-18T10:00:00Z')]);
  s.fake.script('POST', `${A}/install-proposals/${U(10)}:decline`, { status: 200, json: proposal({ state: 'declined', confirmed_via: 'chat' }) });
  assert.equal(await run('decline-install', [U(10)]), 0);
  assert.equal(fs.existsSync(file), false);
});
