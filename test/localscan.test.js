import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpHome } from './helpers.js';
import { AGENT, ORG, ORG2, U, pullHarness } from './fake/pull.js';
import { looksLikeSecret } from '../src/secretscan.js';
import {
  HEARTBEAT_MS, MAX_REPORT_BYTES, MAX_SCAN_ENTRIES, MAX_REPORT_ITEMS, MAX_SKILL_MD_READ, MIN_CHANGE_INTERVAL_MS, REPORT_EVERY_MS, buildReport, cleanText,
  componentSkillNames, createLocalSkillReporter, parseFrontmatter, reportHash, scanLocalSkills,
} from '../src/localscan.js';

const AGENT2 = U(77);
const C16 = (org, agent = AGENT) => `/api/v1/orgs/${org}/agents/${agent}/local-skills:report`;
const ok = (accepted = 0, dropped = 0, unchanged = false) => ({ status: 200, json: { accepted, dropped, unchanged } });
const problem = (status, code, extra = {}, headers = {}) => ({ status, headers, problem: { status, code, ...extra } });
const SECRET_BODY = 'BODY-TEXT-NEVER-SENT';

function fakeZylosDir() {
  const zylosDir = path.join(tmpHome(), 'zylos');
  const skillsDir = path.join(zylosDir, '.claude', 'skills');
  fs.mkdirSync(skillsDir, { recursive: true });
  fs.mkdirSync(path.join(zylosDir, '.zylos'));
  return { zylosDir, skillsDir };
}

function skill(skillsDir, name, md = `---\nname: ${name}\nversion: 1.0.0\ndescription: secret description\n---\n${SECRET_BODY}\n`) {
  const dir = path.join(skillsDir, name);
  fs.mkdirSync(dir, { recursive: true });
  if (md !== null) fs.writeFileSync(path.join(dir, 'SKILL.md'), md);
  return dir;
}

function components(zylosDir, doc) {
  fs.writeFileSync(path.join(zylosDir, '.zylos', 'components.json'), typeof doc === 'string' ? doc : JSON.stringify(doc));
}

test('the scan lists first-level skill directories only, never through links, and skips market, dot and SKILL.md-less ones', () => {
  const { zylosDir, skillsDir } = fakeZylosDir();
  const outside = skill(path.join(tmpHome(), 'elsewhere'), 'linked');
  skill(skillsDir, 'plain');
  skill(skillsDir, 'market--demo');
  skill(skillsDir, '.hidden');
  skill(skillsDir, 'no-skill-md', null);
  skill(skillsDir, 'bad name');
  skill(path.join(skillsDir, 'plain'), 'nested');
  fs.symlinkSync(outside, path.join(skillsDir, 'linked'));
  fs.writeFileSync(path.join(skillsDir, 'file.md'), '---\nname: file\n---\n');
  const linkedMd = skill(skillsDir, 'linked-md', null);
  fs.symlinkSync(path.join(outside, 'SKILL.md'), path.join(linkedMd, 'SKILL.md'));
  const scan = scanLocalSkills({ skillsDir, zylosDir });
  assert.deepEqual(scan.items, [
    { location_id: 'linked-md', source: 'local' },
    { location_id: 'plain', name: 'plain', version: '1.0.0', source: 'local' },
  ]);
  assert.equal(scan.skipped, 1, 'a name the market would drop is left out');
  assert.deepEqual(scanLocalSkills({ skillsDir: path.join(skillsDir, 'missing'), zylosDir }), { items: [], skipped: 0, capped: false });
});

test('source: a zylos component skill, else a directory with .git, else local; .git remotes are never read', () => {
  const { zylosDir, skillsDir } = fakeZylosDir();
  for (const n of ['comp', 'comp-git', 'cloned', 'worktree', 'mine', 'renamed']) skill(skillsDir, n);
  fs.mkdirSync(path.join(skillsDir, 'comp-git', '.git'));
  fs.mkdirSync(path.join(skillsDir, 'cloned', '.git'));
  fs.writeFileSync(path.join(skillsDir, 'cloned', '.git', 'config'), '[remote "origin"]\n\turl = https://user:pw@example.test/x.git\n');
  fs.writeFileSync(path.join(skillsDir, 'worktree', '.git'), 'gitdir: /somewhere/else\n');
  components(zylosDir, {
    comp: { version: '1.0.0', skillDir: path.join(skillsDir, 'comp') },
    'comp-git': { skillDir: path.join(skillsDir, 'comp-git') },
    other: { skillDir: path.join(skillsDir, 'renamed') },
    foreign: { skillDir: path.join(tmpHome(), 'mine') },
    'no-dir': { version: '1' },
  });
  assert.deepEqual([...componentSkillNames(zylosDir, skillsDir)].sort(), ['comp', 'comp-git', 'renamed'], 'an entry without skillDir marks nothing');
  const sources = Object.fromEntries(scanLocalSkills({ skillsDir, zylosDir }).items.map((i) => [i.location_id, i.source]));
  assert.deepEqual(sources, {
    cloned: 'git', comp: 'zylos_component', 'comp-git': 'zylos_component', mine: 'local', renamed: 'zylos_component', worktree: 'git',
  });
  for (const bad of ['not json', '[]', 'null']) {
    components(zylosDir, bad);
    assert.equal(scanLocalSkills({ skillsDir, zylosDir }).items.find((i) => i.location_id === 'comp').source, 'local');
  }
});

test('frontmatter: only top-level name and version, quoted or plain, never the body', () => {
  assert.deepEqual(parseFrontmatter('---\nname: "pdf tools" # c\nversion: 1.2 # c\n---\nname: body\n'), { name: 'pdf tools', version: '1.2' });
  assert.deepEqual(parseFrontmatter("﻿---\r\nversion: '2024.1'\r\nname: x\r\nname: y\r\n---\r\n"), { name: 'x', version: '2024.1' });
  assert.deepEqual(parseFrontmatter('---\nmeta:\n  name: nested\ndescription: d\n---\n'), { name: null, version: null });
  assert.deepEqual(parseFrontmatter('---\nname: open\n'), { name: null, version: null }, 'an unclosed frontmatter yields nothing');
  assert.deepEqual(parseFrontmatter('name: x\n---\n'), { name: null, version: null });
  assert.deepEqual(parseFrontmatter('---\nname: |\n  block\nversion: [1]\n---\n'), { name: null, version: null });
});

test('SKILL.md is read up to 64 KiB: a frontmatter closed beyond it yields no metadata, a large body is fine', () => {
  const { zylosDir, skillsDir } = fakeZylosDir();
  skill(skillsDir, 'big-body', `---\nname: big\n---\n${'x'.repeat(4 * MAX_SKILL_MD_READ)}`);
  skill(skillsDir, 'big-head', `---\nname: head\ndescription: ${'y'.repeat(MAX_SKILL_MD_READ)}\n---\n`);
  assert.deepEqual(scanLocalSkills({ skillsDir, zylosDir }).items, [
    { location_id: 'big-body', name: 'big', source: 'local' },
    { location_id: 'big-head', source: 'local' },
  ]);
});

test('name and version are cleaned to the market rules: NFC, 64 characters, no control or format characters', () => {
  assert.equal(cleanText('Café'), 'Café');
  assert.equal(cleanText('a​b'), null);
  assert.equal(cleanText('a\u0007b'), null);
  assert.equal(cleanText('‮evil'), null);
  assert.equal(cleanText('   '), null);
  assert.equal(cleanText('名'.repeat(64)), '名'.repeat(64));
  assert.equal(cleanText('名'.repeat(65)), null, 'a long version is left out');
  assert.equal(cleanText('名'.repeat(65), { cut: true }), '名'.repeat(64), 'a long name is cut');
  const { zylosDir, skillsDir } = fakeZylosDir();
  skill(skillsDir, 'odd', `---\nname: ${'n'.repeat(80)}\nversion: ${'1'.repeat(65)}\n---\n`);
  assert.deepEqual(scanLocalSkills({ skillsDir, zylosDir }).items, [{ location_id: 'odd', name: 'n'.repeat(64), source: 'local' }]);
});

test('a report holds at most 200 items and 64 KiB; the rest is marked truncated', () => {
  const items = Array.from({ length: 250 }, (_, i) => ({ location_id: `s${String(i).padStart(3, '0')}`, source: 'local' }));
  const r = buildReport(items, '2026-11-05T08:00:00.000Z');
  assert.equal(r.items.length, MAX_REPORT_ITEMS);
  assert.equal(r.truncated, true);
  assert.equal(buildReport(items.slice(0, 200), 'x').truncated, false);
  const wide = Array.from({ length: 200 }, (_, i) => ({
    location_id: `${String(i).padStart(3, '0')}${'d'.repeat(125)}`, name: '名'.repeat(64), version: '版'.repeat(64), source: 'zylos_component',
  }));
  const w = buildReport(wide, '2026-11-05T08:00:00.000Z');
  assert.ok(w.truncated && w.items.length < 200);
  assert.ok(Buffer.byteLength(JSON.stringify(w)) <= MAX_REPORT_BYTES);
  assert.equal(reportHash({ ...w, scanned_at: 'other' }), reportHash(w), 'the scan time is not part of the content');
});

async function harness(t) {
  const h = await pullHarness(t, { orgs: { [ORG2]: { member_id: AGENT2 } } });
  const { zylosDir, skillsDir } = fakeZylosDir();
  skill(skillsDir, 'notes');
  const reporter = (opts = {}) => createLocalSkillReporter({
    api: h.api, state: h.state, orgs: h.orgs, logger: h.logger, skillsDir, zylosDir, now: h.now, ...opts,
  });
  const sent = (org, agent) => h.fake.market().filter((r) => r.path === C16(org, agent));
  return { ...h, zylosDir, skillsDir, reporter, sent };
}

test('each org gets the report with its own token and member id; the body is metadata only', async (t) => {
  const h = await harness(t);
  components(h.zylosDir, { notes: { skillDir: path.join(h.skillsDir, 'notes') } });
  h.fake.script('POST', C16(ORG), ok(1));
  h.fake.script('POST', C16(ORG2, AGENT2), ok(1));
  const res = await h.reporter().run();
  assert.deepEqual(res, { outcome: 'ok', orgs: { [ORG]: 'ok', [ORG2]: 'ok' } });
  for (const [org, agent] of [[ORG, AGENT], [ORG2, AGENT2]]) {
    const [req] = h.sent(org, agent);
    const claims = JSON.parse(Buffer.from(req.headers.authorization.split('.')[1], 'base64url').toString());
    assert.equal(claims.org_id, org, 'token of that org');
    assert.deepEqual(Object.keys(req.json).sort(), ['items', 'scanned_at', 'truncated']);
    assert.deepEqual(req.json.items, [{ location_id: 'notes', name: 'notes', version: '1.0.0', source: 'zylos_component' }]);
    assert.equal(req.json.scanned_at, '2026-10-16T00:00:00.000Z');
    for (const leak of [SECRET_BODY, 'secret description', h.skillsDir, h.zylosDir, '/']) assert.ok(!req.body.includes(leak), `body carries ${leak}`);
    assert.ok(!/[0-9a-f]{64}/.test(req.body), 'no hashes');
  }
  assert.equal(h.state.read('status', null).runs.local_skills.outcome, 'ok');
});

test('an unchanged report is skipped until 12 hours after the last success, also after a restart', async (t) => {
  const h = await harness(t);
  h.fake.script('POST', C16(ORG), ok(1), ok(0, 0, true));
  h.fake.script('POST', C16(ORG2, AGENT2), ok(1), ok(0, 0, true));
  const r = h.reporter();
  await r.run();
  assert.equal(await r.maybeRun(), null, 'not due again yet');
  h.clock.t += REPORT_EVERY_MS;
  assert.deepEqual((await r.maybeRun()).orgs, { [ORG]: 'unchanged', [ORG2]: 'unchanged' });
  assert.deepEqual((await h.reporter().maybeRun()).orgs, { [ORG]: 'unchanged', [ORG2]: 'unchanged' }, 'a restart remembers the last success');
  assert.equal(h.sent(ORG).length, 1);
  h.clock.t += HEARTBEAT_MS;
  assert.deepEqual((await h.reporter().run()).orgs, { [ORG]: 'ok', [ORG2]: 'ok' });
  assert.equal(h.sent(ORG).length, 2, 'sent every 12 hours although unchanged');
  assert.deepEqual(h.sent(ORG)[1].json.items, h.sent(ORG)[0].json.items);
});

test('a changed report waits 5 minutes after the last changed one, then goes out', async (t) => {
  const h = await harness(t);
  h.fake.script('POST', C16(ORG), ok(1), ok(2));
  h.fake.script('POST', C16(ORG2, AGENT2), ok(1), ok(2));
  await h.reporter().run();
  skill(h.skillsDir, 'more');
  h.clock.t += 60_000;
  const r = h.reporter();
  assert.deepEqual((await r.run()).orgs, { [ORG]: 'deferred', [ORG2]: 'deferred' });
  assert.equal(h.sent(ORG).length, 1);
  h.clock.t += MIN_CHANGE_INTERVAL_MS - 60_000 - 1;
  assert.equal(await r.maybeRun(), null, 'retried at the end of the interval, not on the hourly cadence');
  h.clock.t += 1;
  assert.deepEqual((await r.maybeRun()).orgs, { [ORG]: 'ok', [ORG2]: 'ok' });
  assert.deepEqual(h.sent(ORG)[1].json.items.map((i) => i.location_id), ['more', 'notes']);
});

test('one org failing neither stops nor delays the others', async (t) => {
  const h = await harness(t);
  h.fake.script('POST', C16(ORG), problem(503, 'DEPENDENCY_UNAVAILABLE'), problem(404, 'NOT_FOUND'), ok(1));
  h.fake.script('POST', C16(ORG2, AGENT2), ok(1));
  const r = h.reporter();
  assert.deepEqual(await r.run(), { outcome: 'partial', orgs: { [ORG]: 'deferred', [ORG2]: 'ok' } });
  h.clock.t += REPORT_EVERY_MS;
  assert.deepEqual((await r.maybeRun()).orgs, { [ORG]: 'refused', [ORG2]: 'unchanged' });
  h.clock.t += REPORT_EVERY_MS;
  assert.deepEqual((await r.maybeRun()).orgs, { [ORG]: 'ok', [ORG2]: 'unchanged' });
  assert.equal(h.sent(ORG2, AGENT2).length, 1);
  h.fake.script('POST', C16(ORG), problem(403, 'MEMBER_LEFT_ORG', { reason: 'member_departed' }));
  skill(h.skillsDir, 'more');
  h.clock.t += REPORT_EVERY_MS;
  h.fake.script('POST', C16(ORG2, AGENT2), ok(2));
  assert.deepEqual((await r.maybeRun()).orgs, { [ORG]: 'org_left', [ORG2]: 'ok' });
  assert.equal(h.orgs.membership(ORG), 'invalid');
  h.clock.t += REPORT_EVERY_MS;
  assert.deepEqual((await r.maybeRun()).orgs, { [ORG]: 'org_invalid', [ORG2]: 'unchanged' });
});

test('a 429 is honoured per its Retry-After, also across a restart', async (t) => {
  const h = await harness(t);
  h.fake.script('POST', C16(ORG), problem(429, 'RATE_LIMITED', { reason: 'local_skill_report' }, { 'retry-after': '120' }), ok(1));
  h.fake.script('POST', C16(ORG2, AGENT2), ok(1));
  const r = h.reporter();
  assert.deepEqual((await r.run()).orgs, { [ORG]: 'rate_limited', [ORG2]: 'ok' });
  h.clock.t += 119_000;
  assert.equal(await r.maybeRun(), null);
  assert.deepEqual((await h.reporter().run()).orgs, { [ORG]: 'backoff', [ORG2]: 'unchanged' });
  assert.equal(h.sent(ORG).length, 1);
  h.clock.t += 1000;
  assert.deepEqual((await r.maybeRun()).orgs, { [ORG]: 'ok', [ORG2]: 'unchanged' });
});

test('a 400 is logged and the same content is resent only after the heartbeat; changed content is', async (t) => {
  const h = await harness(t);
  h.fake.script('POST', C16(ORG), problem(400, 'VALIDATION_FAILED'), problem(400, 'VALIDATION_FAILED'), ok(2));
  h.fake.script('POST', C16(ORG2, AGENT2), ok(1), ok(1), ok(2));
  const r = h.reporter();
  assert.deepEqual((await r.run()).orgs, { [ORG]: 'rejected', [ORG2]: 'ok' });
  assert.ok(h.lines.some((l) => l.includes(`local skill report to org ${ORG} rejected (VALIDATION_FAILED)`)));
  h.clock.t += HEARTBEAT_MS - 1000;
  assert.deepEqual((await r.run()).orgs, { [ORG]: 'rejected', [ORG2]: 'unchanged' });
  assert.equal(h.sent(ORG).length, 1, 'not resent within the heartbeat');
  h.clock.t += 2000;
  assert.deepEqual((await r.run()).orgs, { [ORG]: 'rejected', [ORG2]: 'ok' });
  assert.equal(h.sent(ORG).length, 2, 'resent once the heartbeat has passed');
  skill(h.skillsDir, 'more');
  h.clock.t += REPORT_EVERY_MS;
  assert.deepEqual((await r.run()).orgs, { [ORG]: 'ok', [ORG2]: 'ok' });
  assert.equal(h.sent(ORG).length, 3);
});

test('CLIENT_VERSION_TOO_OLD enters too-old mode; no report is sent while it lasts', async (t) => {
  const h = await harness(t);
  h.fake.script('POST', C16(ORG), problem(409, 'CLIENT_VERSION_TOO_OLD', { reason: 'below_min', min_version: '9.0.0' }));
  h.fake.script('POST', C16(ORG2, AGENT2), problem(409, 'CLIENT_VERSION_TOO_OLD', { reason: 'below_min', min_version: '9.0.0' }));
  const r = h.reporter();
  assert.deepEqual((await r.run()).orgs, { [ORG]: 'too_old', [ORG2]: 'too_old' });
  assert.equal(h.state.read('gate', null).too_old.min_version, '9.0.0');
  assert.ok(h.state.read('status', null).alerts.client_too_old);
  h.clock.t += REPORT_EVERY_MS;
  assert.deepEqual(await r.maybeRun(), { outcome: 'too_old', orgs: {} });
  assert.equal(h.fake.market().length, 2);
});

test('a scan failure or broken state never throws out of the reporter', async (t) => {
  const h = await harness(t);
  fs.writeFileSync(path.join(h.state.dir, 'local_skills.json'), 'not json');
  h.fake.script('POST', C16(ORG), ok(1));
  h.fake.script('POST', C16(ORG2, AGENT2), ok(1));
  assert.equal((await h.reporter().run()).outcome, 'ok');
  assert.deepEqual(Object.keys(h.state.read('local_skills', null)).sort(), [ORG, ORG2].sort(), 'an unreadable state document is replaced');
  const file = path.join(tmpHome(), 'not-a-dir');
  fs.writeFileSync(file, '');
  const res = await createLocalSkillReporter({
    api: h.api, state: h.state, orgs: h.orgs, logger: h.logger, skillsDir: file, zylosDir: h.zylosDir, now: h.now,
  }).maybeRun();
  assert.deepEqual(res, { outcome: 'scan_failed', orgs: {} });
});

test('the heartbeat stays below the market stale window of 24 hours by more than two report cycles', () => {
  assert.ok(HEARTBEAT_MS + 2 * (REPORT_EVERY_MS + 6 * 60 * 1000) < 24 * 60 * 60 * 1000);
});

test('only the first MAX_SCAN_ENTRIES directory entries are read; the report is then truncated', () => {
  const { zylosDir, skillsDir } = fakeZylosDir();
  for (let i = 0; i < MAX_SCAN_ENTRIES - 1; i += 1) fs.mkdirSync(path.join(skillsDir, `a${String(i).padStart(4, '0')}`));
  skill(skillsDir, 'one');
  const full = scanLocalSkills({ skillsDir, zylosDir });
  assert.equal(full.capped, false);
  assert.deepEqual(full.items.map((i) => i.location_id), ['one']);
  fs.mkdirSync(path.join(skillsDir, 'b-extra'));
  const scan = scanLocalSkills({ skillsDir, zylosDir });
  assert.equal(scan.capped, true);
  assert.ok(scan.items.length <= 1);
  assert.equal(buildReport(scan.items, 'now', { capped: scan.capped }).truncated, true);
  assert.equal(buildReport([], 'now').truncated, false);
});

test('a name, version or directory name that looks like a credential is never sent', () => {
  const { zylosDir, skillsDir } = fakeZylosDir();
  skill(skillsDir, 'ok-skill');
  skill(skillsDir, 'named', '---\nname: ghp_0123456789abcdefABCDEF\nversion: 1\n---\n');
  skill(skillsDir, 'versioned', '---\nname: v\nversion: "token=abcdefgh12"\n---\n');
  skill(skillsDir, 'AKIAABCDEFGHIJKLMNOP');
  skill(skillsDir, 'wide', '---\nname: ｇｈｐ＿0123456789abcdefABCDEF\n---\n');
  const scan = scanLocalSkills({ skillsDir, zylosDir });
  assert.deepEqual(scan.items.map((i) => i.location_id), ['ok-skill']);
  assert.equal(scan.skipped, 4);
});

test('credential scan follows the market rules', () => {
  for (const hit of ['sk-abcdefghijklmnop1234', 'xoxb-1234567890abcdef', 'eyJa.eyJb.sig', 'Bearer abcdefghijklmnopqrstu',
    'https://u:p@h', 'password: hunter22hunter', 'AIza' + 'a'.repeat(35), '0x' + '0123456789abcdef'.repeat(2),
    'aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1dE', 'secret: "correct horse battery"', 'g\u200bhp_0123456789abcdefABCD']) {
    assert.equal(looksLikeSecret(hit), true, hit);
  }
  for (const miss of ['task-runner', 'desk-abcdefghijklmnop1234', 'pdf tools', '1.2.3', 'sk-short', 'a'.repeat(40), 'my secret notes']) {
    assert.equal(looksLikeSecret(miss), false, miss);
  }
});
