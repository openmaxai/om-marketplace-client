import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ORG, ORG2 } from './fake/pull.js';
import { fakeCursor } from './fake/market.js';
import { skillMd, skillPackage } from './fake/package.js';
import { buildZip } from './fake/zip.js';
import { B, C02, MARKET, SKILL, VID, problem, skillHarness } from './fake/skills.js';
import { createRevocationPuller } from '../src/revocations.js';

const v2 = () => skillPackage('demo-skill', { 'docs/guide.md': 'guide v2\n' });
const v3 = () => skillPackage('demo-skill', { 'docs/guide.md': 'guide v3\n' });
const f503 = problem(503, 'DEPENDENCY_UNAVAILABLE');
const c02s = (h) => h.sent('/install-requests');
const queueOf = (h) => h.state.read('intents', null).queue;
const alerts = (h) => Object.values(h.state.read('status', { alerts: {} }).alerts).map((a) => a.message).join('\n');

async function installed(t, opts) {
  const h = await skillHarness(t, opts);
  const s = h.make();
  await h.queue(['install', 1]);
  assert.deepEqual(await s.runRound(), ['succeeded']);
  return { h, s };
}

test('install runs C-02, C-03, download, land and C-06 and records the inventory', async (t) => {
  const { h } = await installed(t);
  const [c02] = c02s(h);
  const rid = c02.json.request_id;
  assert.deepEqual(c02.json, { request_id: rid, skill_id: SKILL, skill_version_id: VID(1), op: 'install', intent_id: c02.json.intent_id, market: MARKET });
  assert.deepEqual(h.results().map((r) => r.json), [{ status: 'succeeded', installed_sha256: h.versions[1].sha }]);
  assert.equal(h.storage.requests[0].headers.authorization, undefined);
  assert.equal(fs.readFileSync(path.join(h.target, 'docs/guide.md'), 'utf8'), 'guide\n');
  const rec = h.state.read('installs', {})[SKILL];
  assert.deepEqual([rec.org_id, rec.version_no, rec.state, rec.skill_version_id, rec.rollback], [ORG, 1, 'enabled', VID(1), null]);
  assert.deepEqual(queueOf(h), []);
  assert.equal(h.state.journal.get(rid).phase, 'reported');
});

test('upgrade lands the higher version, keeps the old one in the rollback area, and stays disabled when disabled', async (t) => {
  const { h, s } = await installed(t, { versions: { 1: skillPackage(), 2: v2(), 3: v3() } });
  await h.queue(['upgrade', 2], ['disable'], ['upgrade', 3]);
  assert.deepEqual(await s.runRound(), ['succeeded', 'done', 'succeeded']);
  assert.equal(c02s(h)[1].json.op, 'upgrade');
  const rec = h.state.read('installs', {})[SKILL];
  assert.deepEqual([rec.version_no, rec.state, rec.rollback], [3, 'disabled', { version_no: 2, skill_version_id: VID(2) }]);
  assert.equal(fs.existsSync(h.target), false);
  assert.equal(h.marker(path.join(h.dataDir, 'disabled', 'market--demo-skill')).version_no, 3);
  assert.deepEqual(fs.readdirSync(path.join(h.dataDir, 'rollback', 'demo-skill')), ['2']);
});

test('upgrade monotonicity: not higher is refused; a lower version is allowed only when the installed one is revoked', async (t) => {
  const { h, s } = await installed(t, { versions: { 1: skillPackage(), 2: v2() } });
  await h.queue(['upgrade', 2]);
  await s.runRound();
  await h.queue(['upgrade', 1]);
  assert.deepEqual(await s.runRound(), ['failed']);
  assert.deepEqual(h.results().at(-1).json, { status: 'failed', error_code: 'INSTALL_TARGET_CONFLICT', error_message: 'not_higher' });
  assert.equal(h.marker().version_no, 2);
  h.state.write('revoked', { skill_version_id: [VID(2)] });
  await h.queue(['upgrade', 1]);
  assert.deepEqual(await s.runRound(), ['succeeded']);
  assert.equal(h.marker().version_no, 1);
  assert.equal(h.marker(path.join(h.dataDir, 'quarantine', 'market--demo-skill')).version_no, 2);
});

test('C-02 201 with a bad shape is reported as CLIENT_INTERNAL', async (t) => {
  const h = await skillHarness(t);
  h.over.c02.push((req) => ({ status: 201, json: { request_id: req.json.request_id, status: 'running' } }));
  await h.queue(['install', 1]);
  assert.deepEqual(await h.make().runRound(), ['failed']);
  assert.deepEqual(h.results().map((r) => r.json), [{ status: 'failed', error_code: 'CLIENT_INTERNAL', error_message: 'install_response_invalid' }]);
});

test('C-02 200 ALREADY_INSTALLED closes the intent without download or result', async (t) => {
  const h = await skillHarness(t);
  h.over.c02.push((req) => ({ status: 200, json: { request_id: req.json.request_id, status: 'succeeded', code: 'ALREADY_INSTALLED' } }));
  await h.queue(['install', 1]);
  assert.deepEqual(await h.make().runRound(), ['closed']);
  assert.deepEqual([h.results().length, h.storage.requests.length, queueOf(h).length], [0, 0, 0]);
  assert.match(h.lines.join('\n'), /missing locally/);
});

for (const [p, alert] of [
  [problem(404, 'VERSION_NOT_FOUND'), /VERSION_NOT_FOUND/],
  [problem(409, 'VERSION_REVOKED'), /VERSION_REVOKED/],
  [problem(409, 'NOT_APPROVED'), /NOT_APPROVED/],
  [problem(409, 'SKILL_ALREADY_INSTALLED', { installed_by_org_id: ORG2 }), new RegExp(`already installed by org ${ORG2}`)],
  [problem(403, 'INSTALLED_BY_OTHER_ORG', { installed_by_org_id: ORG2 }), new RegExp(`already installed by org ${ORG2}`)],
  [problem(403, 'AGENT_NOT_SELF'), /AGENT_NOT_SELF/],
  [problem(409, 'REQUEST_ID_CONFLICT'), /REQUEST_ID_CONFLICT/],
  [problem(400, 'VALIDATION_FAILED', { reason: 'not_higher' }), null],
  [problem(400, 'VALIDATION_FAILED', { reason: 'not_installed' }), null],
  [problem(409, 'INTENT_NOT_PENDING'), null],
  [problem(409, 'INTENT_EXPIRED'), null],
]) {
  test(`C-02 ${p.status} ${p.problem.code}${p.problem.reason ? ` ${p.problem.reason}` : ''} closes the intent, no result, no retry`, async (t) => {
    const h = await skillHarness(t);
    h.over.c02.push(p);
    await h.queue(['install', 1]);
    const s = h.make();
    assert.deepEqual(await s.runRound(), ['closed']);
    assert.deepEqual(await s.runRound(), []);
    assert.deepEqual([c02s(h).length, h.results().length, queueOf(h).length, h.storage.requests.length], [1, 0, 0, 0]);
    if (alert) assert.match(alerts(h), alert);
    else assert.equal(alerts(h), '');
  });
}

test('C-02 INTENT_OUT_OF_ORDER holds the org back for the round and replays the same body next round', async (t) => {
  const h = await skillHarness(t);
  h.over.c02.push(problem(409, 'INTENT_OUT_OF_ORDER'));
  await h.queue(['install', 1], ['disable']);
  const s = h.make();
  assert.deepEqual(await s.runRound(), ['deferred']);
  assert.equal(h.sent(':set-enabled').length, 0);
  assert.deepEqual(await s.runRound(), ['succeeded', 'done']);
  const [a, b] = c02s(h);
  assert.equal(a.body, b.body);
});

for (const p of [problem(429, 'RATE_LIMITED', {}), f503]) {
  test(`C-02 ${p.status} is retried with the same request id and body after C-07 finds no request`, async (t) => {
    const h = await skillHarness(t);
    h.over.c02.push(p);
    await h.queue(['install', 1]);
    const s = h.make();
    assert.deepEqual(await s.runRound(), ['deferred']);
    assert.deepEqual(await s.runRound(), ['succeeded']);
    const [a, b] = c02s(h);
    assert.equal(a.body, b.body);
    assert.equal(h.sent(`/install-requests/${a.json.request_id}`).length, 1);
  });
}

test('C-02 CLIENT_VERSION_TOO_OLD enters too-old mode and stops executing intents', async (t) => {
  const h = await skillHarness(t);
  h.over.c02.push(problem(409, 'CLIENT_VERSION_TOO_OLD', { reason: 'below_minimum', min_version: '9.0.0' }));
  await h.queue(['install', 1], ['disable']);
  const s = h.make();
  assert.deepEqual(await s.runRound(), ['deferred']);
  assert.equal(h.state.read('gate', {}).too_old.min_version, '9.0.0');
  assert.deepEqual(await s.runRound(), []);
});

test('a revoked version in the 201 is reported VERSION_REVOKED without download', async (t) => {
  const h = await skillHarness(t);
  await h.queue(['install', 1]);
  h.state.write('revoked', { package_sha256: [h.versions[1].sha] });
  assert.deepEqual(await h.make().runRound(), ['failed']);
  assert.deepEqual(h.results().map((r) => r.json.error_code), ['VERSION_REVOKED']);
  assert.equal(h.storage.requests.length, 0);
});

test('C-03 200 with a different sha256 or size is CLIENT_INTERNAL', async (t) => {
  const h = await skillHarness(t);
  h.over.c03.push({ status: 200, json: { download_url: 'https://storage.googleapis.com/x', expires_at: '2026-10-16T00:05:00Z', sha256: 'ab'.repeat(32), size: 1 } });
  await h.queue(['install', 1]);
  assert.deepEqual(await h.make().runRound(), ['failed']);
  assert.deepEqual(h.results()[0].json, { status: 'failed', error_code: 'CLIENT_INTERNAL', error_message: 'download_metadata_mismatch' });
});

for (const [p, code, msg] of [
  [problem(404, 'VERSION_NOT_FOUND'), 'CLIENT_INTERNAL', 'download_unavailable'],
  [problem(409, 'NOT_APPROVED'), 'CLIENT_INTERNAL', 'download_unavailable'],
  [problem(409, 'VERSION_REVOKED'), 'VERSION_REVOKED', 'version_revoked'],
]) {
  test(`C-03 ${p.status} ${p.problem.code} reports ${code}`, async (t) => {
    const h = await skillHarness(t);
    h.over.c03.push(p);
    await h.queue(['install', 1]);
    assert.deepEqual(await h.make().runRound(), ['failed']);
    assert.deepEqual(h.results()[0].json, { status: 'failed', error_code: code, error_message: msg });
  });
}

for (const [p, c07, outcome, results] of [
  [problem(404, 'NOT_FOUND'), { status: 'failed', error_code: 'INSTALL_TIMEOUT' }, 'closed', []],
  [problem(403, 'AGENT_NOT_SELF'), problem(404, 'NOT_FOUND'), 'closed', []],
  [problem(404, 'NOT_FOUND'), null, 'failed', ['CLIENT_INTERNAL']],
]) {
  test(`C-03 ${p.problem.code} asks C-07 instead of retrying (${c07?.status ?? 'running'})`, async (t) => {
    const h = await skillHarness(t);
    h.over.c03.push(p);
    if (c07?.problem) h.over.c07.push(c07);
    else if (c07) h.over.c07.push((req) => ({ status: 200, json: { request_id: req.path.split('/').at(-1), op: 'install', skill_id: SKILL, ...c07, created_at: '2026-10-16T00:00:00Z' } }));
    await h.queue(['install', 1]);
    assert.deepEqual(await h.make().runRound(), [outcome]);
    assert.deepEqual(h.results().map((r) => r.json.error_code), results);
    assert.equal(h.sent('/packages/' + c02s(h)[0].json.request_id).length, 1);
    assert.deepEqual(queueOf(h), []);
  });
}

test('C-03 MEMBER_LEFT_ORG marks the org and defers', async (t) => {
  const h = await skillHarness(t);
  h.over.c03.push(problem(403, 'MEMBER_LEFT_ORG', { reason: 'member_departed' }));
  await h.queue(['install', 1]);
  assert.deepEqual(await h.make().runRound(), ['deferred']);
  assert.equal(h.orgs.membership(ORG), 'invalid');
  assert.equal(h.results().length, 0);
});

test('C-03 429 and 503 are retried; a persistent 503 defers and the next round replays C-02 for a fresh URL', async (t) => {
  const h = await skillHarness(t);
  h.over.c03.push(problem(429, 'RATE_LIMITED'), f503, f503, f503);
  await h.queue(['install', 1]);
  const s = h.make();
  assert.deepEqual(await s.runRound(), ['deferred']);
  assert.deepEqual(await s.runRound(), ['succeeded']);
  assert.equal(c02s(h).length, 2);
  assert.equal(c02s(h)[0].body, c02s(h)[1].body);
});

test('C-06 200 failed INSTALL_TIMEOUT keeps what landed', async (t) => {
  const h = await skillHarness(t);
  h.over.c06.push((req) => ({ status: 200, json: { request_id: req.path.split('/')[6], status: 'failed', error_code: 'INSTALL_TIMEOUT' } }));
  await h.queue(['install', 1]);
  assert.deepEqual(await h.make().runRound(), ['succeeded']);
  assert.equal(h.marker().version_no, 1);
  assert.equal(h.state.read('installs', {})[SKILL].version_no, 1);
});

for (const code of ['PACKAGE_MISMATCH', 'VERSION_REVOKED']) {
  test(`C-06 200 failed ${code} after a reported success rolls the landing back`, async (t) => {
    const { h, s } = await installed(t, { versions: { 1: skillPackage(), 2: v2() } });
    h.over.c06.push((req) => ({ status: 200, json: { request_id: req.path.split('/')[6], status: 'failed', error_code: code } }));
    await h.queue(['upgrade', 2]);
    await s.runRound();
    assert.equal(h.marker().version_no, 1);
    assert.equal(h.state.read('installs', {})[SKILL].version_no, 1);
    h.over.c06.push((req) => ({ status: 200, json: { request_id: req.path.split('/')[6], status: 'failed', error_code: code } }));
    await s.uninstall(SKILL);
    await h.queue(['install', 2]);
    await s.runRound();
    assert.equal(fs.existsSync(h.target), false);
    assert.equal(h.state.read('installs', {})[SKILL], undefined);
  });
}

for (const p of [problem(400, 'VALIDATION_FAILED'), problem(404, 'NOT_FOUND'), problem(409, 'REQUEST_ID_CONFLICT')]) {
  test(`C-06 ${p.status} ${p.problem.code} drops the report with an alert and keeps the landing`, async (t) => {
    const h = await skillHarness(t);
    h.over.c06.push(p);
    await h.queue(['install', 1]);
    assert.deepEqual(await h.make().runRound(), ['succeeded']);
    assert.deepEqual([h.state.outbox.list().length, queueOf(h).length], [0, 0]);
    assert.match(alerts(h), new RegExp(p.problem.code));
    assert.equal(h.marker().version_no, 1);
  });
}

test('C-06 503 keeps the report in the outbox and resends it unchanged before anything else', async (t) => {
  const h = await skillHarness(t);
  h.over.c06.push(f503);
  await h.queue(['install', 1]);
  const s = h.make();
  assert.deepEqual(await s.runRound(), ['deferred']);
  assert.equal(h.state.outbox.list().length, 1);
  assert.deepEqual(await s.runRound(), []);
  const [a, b] = h.results();
  assert.equal(a.body, b.body);
  assert.deepEqual([h.state.outbox.list().length, queueOf(h).length, c02s(h).length], [0, 0, 1]);
});

test('an unsafe package is PACKAGE_UNSAFE and a wrong storage sha256 is PACKAGE_MISMATCH; nothing lands', async (t) => {
  const zip = buildZip([{ name: 'SKILL.md', data: skillMd('demo-skill', 'hooks: x\n') }]);
  const bad = { zip, sha: crypto.createHash('sha256').update(zip).digest('hex'), size: zip.length, manifest: [] };
  const h = await skillHarness(t, { versions: { 1: bad } });
  await h.queue(['install', 1]);
  assert.deepEqual(await h.make().runRound(), ['failed']);
  assert.match(h.results()[0].json.error_message, /^SKILL_FRONTMATTER_KEY_NOT_ALLOWED at line \d+$/);
  assert.deepEqual(fs.readdirSync(h.skillsDir), []);
});

test('disable, enable and uninstall change the skill locally first, then report C-08 / C-09 with the intent', async (t) => {
  const { h, s } = await installed(t);
  const disabled = path.join(h.dataDir, 'disabled', 'market--demo-skill');
  const [dis] = await h.queue(['disable']);
  h.over.manage.push(() => {
    assert.ok(fs.existsSync(disabled) && !fs.existsSync(h.target));
    return null;
  });
  assert.deepEqual(await s.runRound(), ['done']);
  const [en] = await h.queue(['enable']);
  assert.deepEqual(await s.runRound(), ['done']);
  assert.ok(fs.existsSync(h.target) && !fs.existsSync(disabled));
  const [un] = await h.queue(['uninstall']);
  assert.deepEqual(await s.runRound(), ['done']);
  const bodies = [...h.sent(':set-enabled'), ...h.sent(':uninstall')].map((r) => r.json);
  assert.deepEqual(bodies.map(({ request_id: _, ...b }) => b), [
    { enabled: false, intent_id: dis.id }, { enabled: true, intent_id: en.id }, { intent_id: un.id },
  ]);
  assert.equal(fs.existsSync(h.target), false);
  assert.deepEqual(h.state.read('installs', {}), {});
  assert.deepEqual(queueOf(h), []);
});

test('local enable/disable/uninstall need no intent; C-08 404 is logged and nothing is reverted', async (t) => {
  const { h, s } = await installed(t);
  h.over.manage.push(problem(404, 'NOT_FOUND'));
  assert.equal(await s.setEnabled(SKILL, false), 'done');
  assert.deepEqual(Object.keys(h.sent(':set-enabled')[0].json), ['request_id', 'enabled']);
  assert.equal(h.state.read('installs', {})[SKILL].state, 'disabled');
  assert.equal(await s.uninstall(SKILL), 'done');
  assert.deepEqual(Object.keys(h.sent(':uninstall')[0].json), ['request_id']);
  await assert.rejects(s.setEnabled(SKILL, true), /not installed/);
});

test('C-08 503 keeps the report for an identical resend; INTENT_NOT_PENDING drops it', async (t) => {
  const { h, s } = await installed(t);
  h.over.manage.push(f503, problem(409, 'INTENT_NOT_PENDING'));
  await h.queue(['disable']);
  assert.deepEqual(await s.runRound(), ['deferred']);
  assert.deepEqual(await s.runRound(), []);
  const [a, b] = h.sent(':set-enabled');
  assert.equal(a.body, b.body);
  assert.deepEqual([h.state.outbox.list().length, queueOf(h).length], [0, 0]);
  assert.equal(h.state.read('installs', {})[SKILL].state, 'disabled');
});

test('a revocation pulled through C-11 quarantines the installed version; enabling it is refused and not reported', async (t) => {
  const { h, s } = await installed(t);
  const puller = createRevocationPuller({ api: h.api, state: h.state, orgs: h.orgs, logger: h.logger, now: h.now, enforce: async () => s.enforceRevocations() });
  h.fake.script('POST', `${B}/revocations:query`, { status: 200, json: { items: [{
    kind: 'version_revoke', source_market_id: MARKET, skill_id: SKILL, skill_version_id: VID(1), template_version_id: null,
    package_sha256: null, manifest_sha256: null, revoked_at: '2026-10-16T00:00:00Z',
  }], next_cursor: fakeCursor(1), has_more: false } });
  await puller.pull();
  const q = path.join(h.dataDir, 'quarantine', 'market--demo-skill');
  assert.equal(fs.existsSync(h.target), false);
  assert.equal(h.marker(q).version_no, 1);
  assert.equal(h.state.read('installs', {})[SKILL].state, 'revoked_disabled');
  assert.equal(s.enforceRevocations(), 0);
  await h.queue(['enable']);
  assert.deepEqual(await s.runRound(), ['refused']);
  assert.equal(h.sent(':set-enabled').length, 0);
  assert.ok(fs.existsSync(q));
  assert.match(alerts(h), /revoked/);
  await h.queue(['uninstall']);
  assert.deepEqual(await s.runRound(), ['done']);
  assert.equal(fs.existsSync(q), false);
});

test('installs wait while the vendored policy does not match its pin', async (t) => {
  const h = await skillHarness(t);
  await h.queue(['install', 1]);
  assert.deepEqual(await h.make(h.state, { installsAllowed: false }).runRound(), []);
  assert.equal(queueOf(h)[0].status, 'queued');
  assert.equal(h.sent(C02).length, 0);
});
