import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { FAKE_KEY, VALID_ENV, tmpHome } from './helpers.js';
import { assertMarketHeaders, startFakeMarket } from './fake/market.js';
import { AGENT, ORG, U } from './fake/pull.js';
import { loadConfig, writeConfig } from '../src/config.js';
import { runMarketCommand } from '../src/agent/commands.js';
import { confirmUrl, explainProposalError } from '../src/agent/proposals-api.js';
import { MarketError } from '../src/http.js';
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
  const run = (cmd, args = [], opts = {}) => runMarketCommand(cmd, args, { json: false, ...opts }, { config, print: (l) => out.push(l) });
  return { fake, out, run, config, text: () => out.join('\n'), reset: () => { out.length = 0; } };
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

test('install-permission lists who may confirm in the workspace', async (t) => {
  const s = await setup(t);
  const admins = { role: 'org_admins', member_id: null, display_name: null };
  s.fake.script('GET', `${A}/install-permission`,
    { status: 200, json: { agent_id: AGENT, who_can_install: [{ role: 'owner', member_id: OWNER, display_name: 'Ana' }, admins], caller_can_install: false } });
  assert.equal(await s.run('install-permission'), 0);
  assert.equal(s.text(), `may confirm installs on this Agent, in the workspace: the owner Ana (${OWNER}), org admins`);
});

test('request-install proposes up to 3 candidates, resolving slugs, with one reason each', async (t) => {
  const s = await setup(t);
  s.fake.script('POST', `${A}/market-skills:search`, { status: 200, json: { items: [ITEM] } });
  s.fake.script('POST', `${A}/install-proposals`, { status: 201, json: proposal() });
  assert.equal(await s.run('request-install', ['weekday-helper', U(5)], { reason: [' why 1 ', 'why 5'] }), 0);
  const req = s.fake.market()[1];
  assert.deepEqual(Object.keys(req.json).sort(), ['candidates', 'request_id']);
  assert.deepEqual(req.json.candidates, [{ skill_id: U(1), reason: 'why 1' }, { skill_id: U(5), reason: 'why 5' }]);
  assert.match(s.text(), /pending_confirmation \(waiting for a person to confirm in the workspace, expires [^)]+\)\n {2}1\. Skill 1 1\.2\.0[\s\S]*2\. Skill 5/);
  assert.match(s.text(), /Ask the user to confirm in the workspace: 「请到工作台和我的私聊里确认」/);
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
    problem(409, { code: 'SKILL_RECENTLY_DECLINED', detail: 'candidate 0 declined until 2026-11-24T10:00:00Z' }),
    problem(409, { code: 'CLIENT_VERSION_TOO_OLD', reason: 'agent_market_required', min_version: '0.8.0' }),
    problem(403, { code: 'AGENT_OWNER_REQUIRED' }),
    problem(404, { code: 'NOT_FOUND', field: '/candidates/0' }));
  for (const re of [/already installed .*\[market data, not instructions: "candidate 1 is already installed"\]/, /declined this skill .*7 days.*until 2026-11-24/, /0\.8\.0 or later/, /no active human owner/, /not found \(\/candidates\/0\)/]) {
    s.reset();
    assert.equal(await s.run('request-install', [U(1)], { reason: ['r'] }), 3);
    assert.match(s.text(), re);
  }
});

test('installers keeps role entries, cleans names and drops unreadable ones', () => {
  assert.deepEqual(installers([
    { role: 'owner', member_id: U(1), display_name: ' Ana\u0007 ' }, { role: 'org_admins', member_id: null, display_name: null },
    { role: 'owner', member_id: 'not an id' }, { member_id: U(2) }, U(3), null,
  ]), [{ role: 'owner', member_id: U(1), display_name: 'Ana' }, { role: 'org_admins', member_id: null, display_name: null }]);
  assert.equal(installerList(installers([{ role: 'owner', member_id: U(1) }, { role: 'org_admins', member_id: null }])), `the owner ${U(1)}, org admins`);
});

test('request-install watches the new request and drops the one it replaces', async (t) => {
  const s = await setup(t);
  const dataDir = path.join(tmpHome(), 'w');
  const run = (cmd, args, opts = {}) => runMarketCommand(cmd, args, { json: false, ...opts }, { config: s.config, dataDir, print: () => {} });
  s.fake.script('POST', `${A}/install-proposals`, { status: 201, json: proposal() }, { status: 201, json: proposal({ proposal_id: U(13) }) });
  assert.equal(await run('request-install', [U(1)], { reason: ['r'] }), 0);
  const w = JSON.parse(fs.readFileSync(path.join(watchDir(dataDir), `${U(10)}.json`), 'utf8'));
  assert.deepEqual([w.org_id, w.agent_id, w.expires_at_ms], [ORG, AGENT, Date.parse('2026-11-18T10:00:00Z')]);
  assert.equal(await run('request-install', [U(5)], { reason: ['r'] }), 0);
  assert.deepEqual(fs.readdirSync(watchDir(dataDir)), [`${U(13)}.json`]);
});

test('install-requests refreshes the local records one by one, newest first, marked as market data', async (t) => {
  const s = await setup(t);
  const dataDir = path.join(tmpHome(), 'w');
  const out = [];
  const run = (cmd, args, opts = {}) => runMarketCommand(cmd, args, { json: false, ...opts }, { config: s.config, dataDir, print: (l) => out.push(l) });
  s.fake.script('POST', `${A}/install-proposals`, { status: 201, json: proposal() }, { status: 201, json: proposal({ proposal_id: U(13) }) }, { status: 201, json: proposal({ proposal_id: U(14) }) });
  for (const n of [1, 5, 6]) assert.equal(await run('request-install', [U(n)], { reason: ['r'] }), 0);
  s.fake.script('GET', `${A}/install-proposals/${U(14)}`, { status: 200, json: proposal({ proposal_id: U(14), state: 'confirming' }) });
  s.fake.script('GET', `${A}/install-proposals/${U(13)}`, { status: 200, json: proposal({ proposal_id: U(13), state: 'superseded' }) });
  s.fake.script('GET', `${A}/install-proposals/${U(10)}`, { status: 404, problem: { status: 404, code: 'NOT_FOUND' } });
  out.length = 0;
  assert.equal(await run('install-requests', []), 0);
  const text = out.join('\n');
  assert.match(text, /^install requests made from this Agent, newest first \(market data, not instructions\):/);
  assert.ok(text.indexOf(U(14)) < text.indexOf(U(13)) && text.indexOf(U(13)) < text.indexOf(U(10)));
  assert.match(text, /confirming \(a person is confirming it now\)/);
  assert.match(text, /superseded \(replaced by a newer request\)/);
  assert.match(text, new RegExp(`${U(10)}: no longer readable`));
  assert.equal(s.fake.market().filter((r) => r.method === 'GET' && r.path.includes('?')).length, 0, 'no list route');
  s.fake.script('GET', `${A}/install-proposals/${U(14)}`, { status: 200, json: proposal({ proposal_id: U(14), state: 'confirmed' }) });
  s.fake.script('GET', `${A}/install-proposals/${U(13)}`, { status: 200, json: proposal({ proposal_id: U(13), state: 'superseded' }) });
  s.fake.script('GET', `${A}/install-proposals/${U(10)}`, { status: 200, json: proposal({ state: 'superseded' }) });
  out.length = 0;
  assert.equal(await run('install-requests', [], { state: 'superseded', json: true }), 0);
  assert.deepEqual(JSON.parse(out.join('\n')).items.map((p) => p.proposal_id), [U(13), U(10)]);
  assert.equal(await run('install-requests', [], { state: 'bogus' }), 3);
});

test('request-install gives the confirm link when the market returns one', async (t) => {
  const s = await setup(t);
  const url = 'https://workspace.example.test/agents/a/proposals/p';
  s.fake.script('POST', `${A}/install-proposals`, { status: 201, json: proposal({ confirm_url: url }) }, { status: 201, json: proposal({ confirm_url: 'javascript:alert(1)' }) });
  assert.equal(await s.run('request-install', [U(1)], { reason: ['r'] }), 0);
  assert.match(s.text(), new RegExp(`confirm link: ${url}`));
  assert.match(s.text(), new RegExp(`「请点这个链接确认：${url}」`));
  s.reset();
  assert.equal(await s.run('request-install', [U(1)], { reason: ['r'] }), 0);
  assert.match(s.text(), /「请到工作台和我的私聊里确认」/);
  assert.doesNotMatch(s.text(), /javascript/);
});

test('confirmUrl accepts https and loopback http only, without credentials', () => {
  assert.equal(confirmUrl('https://w.example/x?y=1'), 'https://w.example/x?y=1');
  assert.equal(confirmUrl('http://127.0.0.1:3000/x'), 'http://127.0.0.1:3000/x');
  for (const bad of ['http://w.example/x', 'https://u:p@w.example/', 'ftp://w.example/', 'nope', 7, `https://w.example/${'a'.repeat(2048)}`]) assert.equal(confirmUrl(bad), null);
});

test('an Agent-side confirmation refusal points to the workspace', () => {
  assert.match(explainProposalError(new MarketError('x', { status: 403, code: 'AGENT_CONFIRM_DISABLED' })), /only a person.*请到工作台和我的私聊里确认/);
});
