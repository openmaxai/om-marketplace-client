import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { FAKE_KEY, ROOT, VALID_ENV, baseEnv, tmpHome } from './helpers.js';
import { spawn } from 'node:child_process';
import { assertMarketHeaders, startFakeMarket } from './fake/market.js';
import { AGENT, ORG, U } from './fake/pull.js';
import { loadConfig, writeConfig } from '../src/config.js';
import { runMarketCommand } from '../src/agent/commands.js';
import { confirmUrl, marketCleanText, proposalView, rawEvidence } from '../src/agent/proposals-api.js';
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
  assert.equal(await s.run('search', ['x'], { limit: '21' }), 2);
  assert.equal(await s.run('search', ['x'.repeat(101)]), 2);
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
  assert.match(s.text(), /pending_confirmation \(waiting for the owner's reply or a confirmation on the confirm link, expires [^)]+\)\n {2}1\. Skill 1 1\.2\.0 — d\n[\s\S]*\n {2}2\. Skill 5 1\.2\.0 — d\n/);
  assert.match(s.text(), /「组织市场里有 2 个技能能做：① Skill 1 — d ② Skill 5 — d 要装的话回复编号，比如「装 1」「装 1 和 2」或「都装」；不装回复「不装」或「都不装」。安装要我的负责人确认。」/);
  assert.match(s.text(), /Anyone else confirms on the page: 「请到工作台和我的私聊里确认」/);
});

test('request-install refusals', async (t) => {
  const s = await setup(t);
  assert.equal(await s.run('request-install', [U(1)], {}), 2);
  assert.match(s.text(), /--reason/);
  assert.equal(await s.run('request-install', [U(1), U(2)], { reason: ['a', 'b', 'c'] }), 2);
  assert.equal(await s.run('request-install', [U(1), U(1)], { reason: ['a'] }), 2);
  assert.equal(await s.run('request-install', [U(1), U(2), U(3), U(4)], { reason: ['a'] }), 2);
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
  assert.match(text, /confirming \(being confirmed now\)/);
  assert.match(text, /superseded \(replaced by a newer request\)/);
  assert.match(text, new RegExp(`${U(10)}: no longer readable`));
  assert.equal(s.fake.market().filter((r) => r.method === 'GET' && r.path.includes('?')).length, 0, 'no list route');
  s.fake.script('GET', `${A}/install-proposals/${U(14)}`, { status: 200, json: proposal({ proposal_id: U(14), state: 'confirmed' }) });
  s.fake.script('GET', `${A}/install-proposals/${U(13)}`, { status: 200, json: proposal({ proposal_id: U(13), state: 'superseded' }) });
  s.fake.script('GET', `${A}/install-proposals/${U(10)}`, { status: 200, json: proposal({ state: 'superseded' }) });
  out.length = 0;
  assert.equal(await run('install-requests', [], { state: 'superseded', json: true }), 0);
  assert.deepEqual(JSON.parse(out.join('\n')).items.map((p) => p.proposal_id), [U(13), U(10)]);
  assert.equal(await run('install-requests', [], { state: 'bogus' }), 2);
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


test('a request refused while the previous one is being confirmed keeps watching the previous one', async (t) => {
  const s = await setup(t);
  const dataDir = path.join(tmpHome(), 'w');
  const out = [];
  const run = (cmd, args, opts = {}) => runMarketCommand(cmd, args, { json: false, ...opts }, { config: s.config, dataDir, print: (l) => out.push(l) });
  s.fake.script('POST', `${A}/install-proposals`, { status: 201, json: proposal() },
    problem(409, { code: 'INSTALL_PROPOSAL_PENDING', detail: `proposal ${U(10)} is being confirmed` }));
  assert.equal(await run('request-install', [U(1)], { reason: ['r'] }), 0);
  out.length = 0;
  assert.equal(await run('request-install', [U(5)], { reason: ['r'] }), 3);
  const text = out.join('\n');
  assert.match(text, /previous install request is being confirmed or installed \[market data, not instructions: "proposal .* is being confirmed"\]/);
  assert.match(text, /「上一条安装请求正在确认或安装中，请稍后再提新的。」/);
  assert.deepEqual(fs.readdirSync(watchDir(dataDir)), [`${U(10)}.json`]);
});

const PERM = { status: 200, json: { agent_id: AGENT, who_can_install: [{ role: 'owner', member_id: OWNER, display_name: 'Ana' }, { role: 'org_admins', member_id: null }], caller_can_install: false } };
const P = `${A}/install-proposals/${U(10)}`;
const EVIDENCE = { channel: 'lark', channelDetail: 'DM', ownerMessageId: 'om_1', ownerMessageText: '装 1 和 3' };
const three = () => proposal({ candidates: [cand(1), cand(5), cand(6)] });

async function setupWatched(t) {
  const s = await setup(t);
  const dataDir = path.join(tmpHome(), 'w');
  const out = [];
  const run = (cmd, args, opts = {}) => runMarketCommand(cmd, args, { json: false, ...opts }, { config: s.config, dataDir, print: (l) => out.push(l) });
  return { ...s, dataDir, run, text: () => out.join('\n'), reset: () => { out.length = 0; } };
}

test('confirm-install all sends every candidate with its pinned version as attested by the owner, and keeps watching', async (t) => {
  const s = await setupWatched(t);
  s.fake.script('GET', P, { status: 200, json: three() });
  s.fake.script('GET', `${A}/install-permission`, PERM);
  s.fake.script('POST', `${P}:confirm`, { status: 200, json: proposal({ state: 'confirmed', candidates: [cand(1, { selected: true }), cand(5, { selected: true }), cand(6, { selected: true })] }) });
  assert.equal(await s.run('confirm-install', [U(10), 'all'], EVIDENCE), 0);
  const post = s.fake.market().find((r) => r.method === 'POST');
  assertMarketHeaders(post, { apiKey: FAKE_KEY });
  assert.deepEqual(post.json, {
    skill_ids: [U(1), U(5), U(6)], skill_version_ids: [U(51), U(55), U(56)], confirmed_via: 'agent_attested', confirmed_by_member_id: OWNER,
    channel: 'lark', channel_detail: 'DM', owner_message_id: 'om_1', owner_message_text: '装 1 和 3',
  });
  assert.deepEqual(fs.readdirSync(watchDir(s.dataDir)), [`${U(10)}.json`]);
  assert.match(s.text(), /「已确认，正在安装「Skill 1」「Skill 5」「Skill 6」，我空闲时会自动生效。」/);
});

test('confirm-install a subset by number and skill id keeps the selection order and names the rest', async (t) => {
  const s = await setupWatched(t);
  s.fake.script('GET', P, { status: 200, json: three() }, { status: 200, json: three() });
  s.fake.script('GET', `${A}/install-permission`, PERM, PERM);
  const done = proposal({ state: 'confirmed', candidates: [cand(1, { selected: true }), cand(5, { selected: false }), cand(6, { selected: true })] });
  s.fake.script('POST', `${P}:confirm`, { status: 200, json: done }, { status: 200, json: done });
  assert.equal(await s.run('confirm-install', [U(10), '3', U(1)], { channel: 'workspace', ownerMessageId: 'm9' }), 0);
  let post = s.fake.market().filter((r) => r.method === 'POST')[0];
  assert.deepEqual([post.json.skill_ids, post.json.skill_version_ids], [[U(6), U(1)], [U(56), U(51)]]);
  assert.equal(post.json.channel, 'workspace');
  assert.equal('owner_message_text' in post.json || 'channel_detail' in post.json, false);
  assert.match(s.text(), /「已确认，正在安装「Skill 6」「Skill 1」，我空闲时会自动生效。「Skill 5」没选，这次不装。」/);
  assert.match(s.text(), /3\. Skill 6 1\.2\.0 — d \[selected\]/);
  assert.match(s.text(), /2\. Skill 5 1\.2\.0 — d \[not selected\]/);
  s.reset();
  assert.equal(await s.run('confirm-install', [U(10), '1,3'], { ...EVIDENCE, json: true }), 0);
  post = s.fake.market().filter((r) => r.method === 'POST')[1];
  assert.deepEqual(post.json.skill_ids, [U(1), U(6)]);
  const j = JSON.parse(s.text());
  assert.equal(j.ok, true);
  assert.equal(j.state, 'confirmed');
  assert.match(j.owner_reply, /「Skill 5」没选/);
});

test('confirm-install and decline-install refuse locally without sending anything', async (t) => {
  const s = await setupWatched(t);
  for (const [cmd, args, opts, re] of [
    ['confirm-install', [U(10), '1'], {}, /--channel must be one of workspace, lark, telegram, other/],
    ['confirm-install', [U(10), '1'], { channel: 'slack', ownerMessageText: 'yes' }, /--channel/],
    ['confirm-install', [U(10), '1'], { channel: 'lark' }, /--owner-message-id and\/or --owner-message-text/],
    ['confirm-install', [U(10), '1'], { channel: 'lark', ownerMessageText: ' \u200b\u202e\n\u0000 ', ownerMessageId: '\u2066\u2069' }, /--owner-message-text/],
    ['confirm-install', [U(10), '1'], { channel: 'lark', ownerMessageText: '\u3164\u2028\u2029\u115f\uffa0' }, /--owner-message-text/],
    ['confirm-install', [U(10)], EVIDENCE, /use decline-install/],
    ['confirm-install', ['nope', '1'], EVIDENCE, /proposal_id/],
    ['decline-install', [U(10), '1'], EVIDENCE, /only the install request id/],
    ['decline-install', [U(10)], { channel: 'telegram' }, /--owner-message-id/],
  ]) {
    s.reset();
    assert.equal(await s.run(cmd, args, opts), 2, `${cmd} ${args} ${JSON.stringify(opts)}`);
    assert.match(s.text(), re);
  }
  assert.equal(s.fake.requests.length, 0);
  for (const [sel, re] of [[['4'], /4 is not a candidate/], [['1', U(1)], /selected twice/], [['all', '2'], /"all" cannot be combined/],
    [['weekday-helper'], /not a candidate/], [[U(9)], /not a candidate/], [[','], /use decline-install/]]) {
    s.fake.script('GET', P, { status: 200, json: three() });
    s.reset();
    assert.equal(await s.run('confirm-install', [U(10), ...sel], EVIDENCE), 2, String(sel));
    assert.match(s.text(), re);
  }
  s.fake.script('GET', P, { status: 200, json: proposal({ candidates: [cand(1, { skill_version_id: null })] }) });
  assert.equal(await s.run('confirm-install', [U(10), '1'], EVIDENCE), 2);
  assert.match(s.text(), /no pinned version for candidate 1/);
  assert.equal(s.fake.market().filter((r) => r.method === 'POST').length, 0);
});

test('confirm-install refuses locally when the Agent has no owner', async (t) => {
  const s = await setupWatched(t);
  s.fake.script('GET', P, { status: 200, json: three() });
  s.fake.script('GET', `${A}/install-permission`, { status: 200, json: { agent_id: AGENT, who_can_install: [{ role: 'org_admins', member_id: null }], caller_can_install: false } });
  assert.equal(await s.run('confirm-install', [U(10), 'all'], { ...EVIDENCE, json: true }), 3);
  const j = JSON.parse(s.text());
  assert.equal(j.error, 'AGENT_OWNER_REQUIRED');
  assert.match(j.message, /no active human owner.*only an org admin.*confirm_url/);
  assert.equal(s.fake.market().filter((r) => r.method === 'POST').length, 0);
});

const VECTORS = JSON.parse(fs.readFileSync(new URL('./vectors/evidence-sanitize.json', import.meta.url), 'utf8')).vectors;

test('the emptiness check cleans evidence as the market stores it (shared vectors)', () => {
  assert.ok(VECTORS.length >= 20);
  for (const v of VECTORS) {
    assert.equal(marketCleanText(v.input, v.max), v.market, v.name);
    assert.equal(rawEvidence(v.input, v.max) === null, v.empty, v.name);
  }
});

test('evidence is sent as received; only an oversized value is cut', async (t) => {
  const s = await setupWatched(t);
  s.fake.script('GET', P, { status: 200, json: three() });
  s.fake.script('GET', `${A}/install-permission`, PERM);
  s.fake.script('POST', `${P}:decline`, { status: 200, json: proposal({ state: 'declined', confirmed_via: 'agent_attested' }) });
  const text = ` 不装\r\n\u202e"$(x)\` ${'x'.repeat(2500)}`;
  assert.equal(await s.run('decline-install', [U(10)], { channel: 'other', channelDetail: '\u3164', ownerMessageId: `${'i'.repeat(250)}`, ownerMessageText: text }), 0);
  const post = s.fake.market().find((r) => r.method === 'POST');
  assert.equal('channel_detail' in post.json, false);
  assert.equal(post.json.owner_message_id, 'i'.repeat(250));
  assert.equal(post.json.owner_message_text, [...text].slice(0, 4 * 500).join(''));
});

test('decline-install sends no skills, drops the watch and tells the owner', async (t) => {
  const s = await setupWatched(t);
  s.fake.script('POST', `${A}/install-proposals`, { status: 201, json: proposal() });
  assert.equal(await s.run('request-install', [U(1)], { reason: ['r'] }), 0);
  assert.deepEqual(fs.readdirSync(watchDir(s.dataDir)), [`${U(10)}.json`]);
  s.fake.script('GET', P, { status: 200, json: proposal() });
  s.fake.script('GET', `${A}/install-permission`, PERM);
  s.fake.script('POST', `${P}:decline`, { status: 200, json: proposal({ state: 'declined', confirmed_via: 'agent_attested', confirmed_by_member_id: OWNER }) });
  s.reset();
  assert.equal(await s.run('decline-install', [U(10)], { channel: 'telegram', ownerMessageText: '不装' }), 0);
  const post = s.fake.market().filter((r) => r.method === 'POST')[1];
  assert.deepEqual(post.json, { confirmed_via: 'agent_attested', confirmed_by_member_id: OWNER, channel: 'telegram', owner_message_text: '不装' });
  assert.deepEqual(fs.readdirSync(watchDir(s.dataDir)), []);
  assert.match(s.text(), /「好，不装。这个任务我先用现有办法做。」/);
});

test('confirm-install explains each market refusal', async (t) => {
  const s = await setupWatched(t);
  const cases = [
    [problem(403, { code: 'AGENT_ATTESTATION_REFUSED', reason: 'not_owner' }), /only your current owner's own reply counts.*confirm_url/],
    [problem(403, { code: 'AGENT_ATTESTATION_REFUSED', reason: 'owner_changed' }), /made for a previous owner.*request-install/],
    [problem(403, { code: 'AGENT_CONFIRM_DISABLED' }), /client bug.*predates.*do not retry/],
    [problem(403, { code: 'AGENT_CONFIRM_DISABLED', reason: 'attested_off' }), /^confirm-install refused: chat confirmation is turned off in this market; nothing was changed\. Send the owner the confirm link \(confirm_url\) instead, don't retry$/],
    [{ status: 404, raw: 'not found' }, /does not support confirming install requests in conversation yet \(404 on the confirm route/],
    [problem(409, { code: 'INSTALL_PROPOSAL_STALE', reason: 'version_changed' }), /a skill version changed since the request \(version_changed\).*request-install.*ask the owner again/],
    [problem(409, { code: 'INSTALL_PROPOSAL_STALE', reason: 'agent_changed' }), /this Agent changed since the request/],
    [problem(409, { code: 'INSTALL_PROPOSAL_NOT_PENDING', reason: 'expired' }), /no longer waiting for a decision \(expired\).*already decided or has expired/],
    [problem(400, { code: 'VALIDATION_FAILED', errors: [{ field: 'owner_message_id', message: 'required' }, { field: 'owner_message_text' }] }), /invalid request \(owner_message_id: required; owner_message_text\)/],
    [problem(403, { code: 'AGENT_OWNER_REQUIRED' }), /only an org admin/],
    [problem(409, { code: 'AGENT_NO_CLIENT' }), /not see this Agent's client as active.*waiting for a decision again/],
  ];
  for (const [resp, re] of cases) {
    s.fake.script('GET', P, { status: 200, json: three() });
    s.fake.script('GET', `${A}/install-permission`, PERM);
    s.fake.script('POST', `${P}:confirm`, resp);
    s.reset();
    assert.equal(await s.run('confirm-install', [U(10), '1'], EVIDENCE), 3);
    assert.match(s.text(), re);
  }
  s.fake.script('GET', P, { status: 200, json: three() });
  s.fake.script('GET', `${A}/install-permission`, PERM);
  s.fake.script('POST', `${P}:decline`, problem(403, { code: 'AGENT_ATTESTATION_REFUSED', reason: 'not_owner' }));
  s.reset();
  assert.equal(await s.run('decline-install', [U(10)], { ...EVIDENCE, json: true }), 3);
  assert.deepEqual((({ error, status, reason }) => ({ error, status, reason }))(JSON.parse(s.text())), { error: 'AGENT_ATTESTATION_REFUSED', status: 403, reason: 'not_owner' });
});

test('proposal view keeps the attestation as data and install-requests shows how it was confirmed', async (t) => {
  const v = proposalView(proposal({
    state: 'confirmed', confirmed_via: 'agent_attested', confirmed_by_member_id: OWNER,
    attestation: { agent_id: AGENT, channel: 'lark', channel_detail: 'DM', owner_message_id: 'om_1', owner_message_text: '装 1\u202e' },
  }));
  assert.deepEqual(v.attestation, { agent_id: AGENT, channel: 'lark', channel_detail: 'DM', owner_message_id: 'om_1', owner_message_text: '装 1' });
  assert.deepEqual([v.confirmed_via, v.confirmed_by_member_id], ['agent_attested', OWNER]);
  assert.deepEqual(v.candidates.map((c) => [c.position, c.skill_version_id]), [[1, U(51)], [2, U(55)]]);
  assert.equal(proposalView(proposal({ confirmed_via: 'chat' })).confirmed_via, null);
  assert.equal(proposalView(proposal({ attestation: 'x' })).attestation, null);
  const s = await setupWatched(t);
  s.fake.script('POST', `${A}/install-proposals`, { status: 201, json: proposal() });
  assert.equal(await s.run('request-install', [U(1)], { reason: ['r'] }), 0);
  s.fake.script('GET', P, { status: 200, json: proposal({ state: 'confirmed', confirmed_via: 'agent_attested', attestation: { channel: 'lark', channel_detail: 'DM', owner_message_text: '装 1' } }) },
    { status: 200, json: proposal({ state: 'confirmed', confirmed_via: 'card' }) });
  s.reset();
  assert.equal(await s.run('install-requests', []), 0);
  assert.match(s.text(), /confirmed via: agent_attested \(lark, DM\)\n {2}owner's message: "装 1"/);
  s.reset();
  assert.equal(await s.run('install-requests', []), 0);
  assert.match(s.text(), /confirmed via: card/);
});

const cliRun = (args, { dataDir, input }) => new Promise((resolve) => {
  const child = spawn(process.execPath, [path.join(ROOT, 'src/cli.js'), ...args], { env: baseEnv(dataDir) });
  let stdout = '';
  child.stdout.on('data', (c) => { stdout += c; });
  child.on('exit', (code) => resolve({ code, stdout }));
  child.stdin.end(input ?? '');
});

test('CLI: the owner reply is read verbatim from stdin; repeated options are usage errors', async (t) => {
  const fake = await startFakeMarket({ apiKey: FAKE_KEY, memberId: AGENT });
  t.after(fake.close);
  const dataDir = path.join(tmpHome(), 'd');
  writeConfig({ ...VALID_ENV, COCO_BFF_URL: fake.url }, dataDir);
  fake.script('GET', P, { status: 200, json: three() });
  fake.script('GET', `${A}/install-permission`, PERM);
  fake.script('POST', `${P}:confirm`, { status: 200, json: proposal({ state: 'confirmed' }) });
  const reply = '装 1 "and" `rm -rf` $(id) \'x\'\nsecond line';
  const r = await cliRun(['confirm-install', U(10), '1', '--channel', 'telegram', '--owner-message-text-stdin', '--json'], { dataDir, input: `${reply}\n` });
  assert.equal(r.code, 0, r.stdout);
  assert.equal(fake.market().find((q) => q.method === 'POST').json.owner_message_text, reply);
  const n = fake.requests.length;
  for (const args of [
    ['confirm-install', U(10), '1', '--channel', 'lark', '--channel', 'telegram', '--owner-message-text', 'y'],
    ['confirm-install', U(10), '1', '--channel', 'lark', '--owner-message-text', 'a', '--owner-message-text', 'b'],
    ['confirm-install', U(10), '1', '--channel', 'lark', '--owner-message-text', 'a', '--owner-message-text-stdin'],
  ]) assert.equal((await cliRun(args, { dataDir, input: 'z' })).code, 2, args.join(' '));
  assert.equal((await cliRun(['decline-install', U(10), '--channel', 'lark', '--owner-message-text-stdin'], { dataDir, input: 'ㅤ\n' })).code, 2);
  assert.equal(fake.requests.length, n);
});
