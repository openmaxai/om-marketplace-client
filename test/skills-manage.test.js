import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AGENT, ORG, ORG2, U } from './fake/pull.js';
import { fakeCursor } from './fake/market.js';
import { skillMd, skillPackage } from './fake/package.js';
import { buildZip } from './fake/zip.js';
import { B, C02, MARKET, SKILL, VID, problem, skillHarness } from './fake/skills.js';
import { createRevocationPuller } from '../src/revocations.js';
import { inspectInWorker } from '../src/inspect.js';
import { MAX_PACKAGE_BYTES, MAX_PACKAGE_FILES } from '../src/pkg/zip.js';
import { alerts, c02s, downloads, f503, failure, installed, qdir, queueOf, quarantined, v2, v3 } from './fake/skill-cases.js';

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
  const q = qdir(h);
  assert.equal(fs.existsSync(h.target), false);
  assert.deepEqual(quarantined(h), { [`1-${VID(1)}`]: 1 });
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

const userDir = (dir) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'mine.txt'), 'user\n');
};
const userFile = (dir) => fs.readFileSync(path.join(dir, 'mine.txt'), 'utf8');
const disabledDir = (h) => path.join(h.dataDir, 'disabled', 'market--demo-skill');
const timeout = (req) => ({ status: 200, json: { request_id: req.path.split('/')[6], status: 'failed', error_code: 'INSTALL_TIMEOUT' } });

test('the same version with another package is refused as not_higher', async (t) => {
  const { h, s } = await installed(t, { versions: { 1: skillPackage(), 2: v2() } });
  h.patch.c02 = () => ({ version_no: 1 });
  await h.queue(['upgrade', 2]);
  assert.deepEqual(await s.runRound(), ['failed']);
  assert.deepEqual(h.results().at(-1).json, failure('INSTALL_TARGET_CONFLICT', 'not_higher'));
  assert.equal(h.marker().package_sha256, h.versions[1].sha);
});

test('the same version and package kept after INSTALL_TIMEOUT is reported succeeded without a download', async (t) => {
  const { h, s } = await installed(t, { versions: { 1: skillPackage(), 2: v2() } });
  h.over.c06.push(timeout);
  await h.queue(['upgrade', 2]);
  assert.deepEqual(await s.runRound(), ['succeeded']);
  assert.equal(h.marker().version_no, 2);
  const before = downloads(h);
  await h.queue(['upgrade', 2]);
  assert.deepEqual(await s.runRound(), ['succeeded']);
  assert.equal(downloads(h), before);
  assert.deepEqual(h.results().at(-1).json, { status: 'succeeded', installed_sha256: h.versions[2].sha });
  const rec = h.state.read('installs', {})[SKILL];
  assert.deepEqual([rec.version_no, rec.rollback?.version_no], [2, 1]);
  assert.equal(h.reqs.get(c02s(h).at(-1).json.request_id).status, 'succeeded');
});

test('a lower version is refused when it comes from another source shelf, even with the installed one revoked', async (t) => {
  const { h, s } = await installed(t, { versions: { 1: skillPackage(), 2: v2() } });
  await h.queue(['upgrade', 2]);
  await s.runRound();
  h.state.write('revoked', { skill_version_id: [VID(2)] });
  h.patch.c02 = () => ({ source_market_id: U(4) });
  await h.queue(['upgrade', 1]);
  assert.deepEqual(await s.runRound(), ['failed']);
  assert.deepEqual(h.results().at(-1).json, failure('INSTALL_TARGET_CONFLICT', 'not_higher'));
});

test('an install over a local version follows the same version rules', async (t) => {
  const { h, s } = await installed(t, { versions: { 1: skillPackage(), 2: v2() } });
  await h.queue(['upgrade', 2]);
  await s.runRound();
  await h.queue(['install', 1]);
  assert.deepEqual(await s.runRound(), ['failed']);
  assert.deepEqual(h.results().at(-1).json, failure('INSTALL_TARGET_CONFLICT', 'not_higher'));
  assert.equal(h.marker().version_no, 2);
});

test('uninstall leaves a directory without our marker alone and clears the rollback area', async (t) => {
  const { h, s } = await installed(t, { versions: { 1: skillPackage(), 2: v2() } });
  await h.queue(['upgrade', 2], ['disable']);
  assert.deepEqual(await s.runRound(), ['succeeded', 'done']);
  userDir(h.target);
  await h.queue(['uninstall']);
  assert.deepEqual(await s.runRound(), ['done']);
  assert.equal(userFile(h.target), 'user\n');
  assert.equal(fs.existsSync(disabledDir(h)), false);
  assert.equal(fs.existsSync(path.join(h.dataDir, 'rollback', 'demo-skill')), false);
  assert.equal(h.state.read('installs', {})[SKILL], undefined);
});

test('enable onto a directory without our marker is refused with an alert; nothing moves and nothing is reported', async (t) => {
  const { h, s } = await installed(t);
  await h.queue(['disable']);
  await s.runRound();
  userDir(h.target);
  const [en] = await h.queue(['enable']);
  assert.deepEqual(await s.runRound(), ['refused']);
  assert.equal(userFile(h.target), 'user\n');
  assert.equal(h.marker(disabledDir(h)).version_no, 1);
  assert.equal(h.state.read('installs', {})[SKILL].state, 'disabled');
  assert.equal(h.sent(':set-enabled').filter((r) => r.json.enabled).length, 0);
  assert.match(alerts(h), new RegExp(`not market-managed; intent ${en.id} stays pending`));
  assert.deepEqual(queueOf(h), []);
});

test('disable never moves a directory that does not carry our marker', async (t) => {
  const { h, s } = await installed(t);
  fs.renameSync(h.target, path.join(h.dataDir, 'aside'));
  userDir(h.target);
  await h.queue(['disable']);
  assert.deepEqual(await s.runRound(), ['done']);
  assert.equal(userFile(h.target), 'user\n');
  assert.equal(fs.existsSync(disabledDir(h)), false);
});

// A directory a user or another market skill owns: its marker names another skill id.
const foreignDir = (dir) => {
  userDir(dir);
  fs.writeFileSync(path.join(dir, '.market-managed'), JSON.stringify({ skill_id: U(2), version_no: 1, package_sha256: 'a'.repeat(64) }));
};

test('a directory whose marker names another skill is never moved onto, moved or removed', async (t) => {
  const en = await installed(t);
  await en.h.queue(['disable']);
  await en.s.runRound();
  foreignDir(en.h.target);
  await en.h.queue(['enable']);
  assert.deepEqual(await en.s.runRound(), ['refused']);
  assert.equal(userFile(en.h.target), 'user\n');
  assert.equal(en.h.marker(disabledDir(en.h)).version_no, 1);
  assert.equal(en.h.state.read('installs', {})[SKILL].state, 'disabled');

  const dis = await installed(t);
  fs.rmSync(dis.h.target, { recursive: true });
  foreignDir(dis.h.target);
  await dis.h.queue(['disable']);
  assert.deepEqual(await dis.s.runRound(), ['done']);
  assert.equal(dis.h.marker().skill_id, U(2));
  assert.equal(fs.existsSync(disabledDir(dis.h)), false);

  const un = await installed(t);
  fs.rmSync(un.h.target, { recursive: true });
  foreignDir(un.h.target);
  await un.h.queue(['uninstall']);
  assert.deepEqual(await un.s.runRound(), ['done']);
  assert.equal(userFile(un.h.target), 'user\n');
  assert.equal(un.h.marker().skill_id, U(2));
});

test('a revocation that arrives during the download is VERSION_REVOKED and nothing lands', async (t) => {
  const h = await skillHarness(t);
  h.over.c03.push(() => { h.state.write('revoked', { skill_version_id: [VID(1)] }); });
  await h.queue(['install', 1]);
  assert.deepEqual(await h.make().runRound(), ['failed']);
  assert.deepEqual(h.results()[0].json, failure('VERSION_REVOKED', 'version_revoked'));
  assert.equal(fs.existsSync(h.target), false);
  assert.equal(h.state.read('installs', {})[SKILL], undefined);
});

test('a revoked record whose directory is still in place is quarantined on the next round', async (t) => {
  const { h, s } = await installed(t);
  h.state.update('installs', {}, (d) => { d[SKILL].state = 'revoked_disabled'; });
  assert.deepEqual(await s.runRound(), []);
  assert.equal(fs.existsSync(h.target), false);
  assert.deepEqual(quarantined(h), { [`1-${VID(1)}`]: 1 });
});

test('quarantine keeps every revoked copy: a second revoked version never replaces the first', async (t) => {
  const { h, s } = await installed(t, { versions: { 1: skillPackage(), 2: v2() } });
  await h.queue(['upgrade', 2]);
  await s.runRound();
  h.state.write('revoked', { skill_version_id: [VID(2)] });
  await h.queue(['upgrade', 1]);
  assert.deepEqual(await s.runRound(), ['succeeded']);
  h.state.write('revoked', { skill_version_id: [VID(2), VID(1)] });
  assert.equal(s.enforceRevocations(), 1);
  assert.deepEqual(quarantined(h), { [`1-${VID(1)}`]: 1, [`2-${VID(2)}`]: 2 });
  assert.equal(fs.existsSync(h.target), false);
});

test('a rollback after a refused success does not put back a version revoked meanwhile', async (t) => {
  const { h, s } = await installed(t, { versions: { 1: skillPackage(), 2: v2() } });
  h.over.c06.push((req) => {
    h.state.write('revoked', { skill_version_id: [VID(1)] });
    return { status: 200, json: { request_id: req.path.split('/')[6], status: 'failed', error_code: 'PACKAGE_MISMATCH' } };
  });
  await h.queue(['upgrade', 2]);
  await s.runRound();
  assert.equal(fs.existsSync(h.target), false);
  assert.deepEqual(quarantined(h), { [`1-${VID(1)}`]: 1 });
  const rec = h.state.read('installs', {})[SKILL];
  assert.deepEqual([rec.version_no, rec.state], [1, 'revoked_disabled']);
  assert.deepEqual(fs.readdirSync(path.join(h.dataDir, 'rollback', 'demo-skill')), []);
});

test('enabling outside a round a disabled skill whose version was revoked since is refused and quarantines it', async (t) => {
  const { h, s } = await installed(t);
  assert.equal(await s.setEnabled(SKILL, false), 'done');
  h.state.write('revoked', { skill_version_id: [VID(1)] });
  assert.equal(await s.setEnabled(SKILL, true), 'refused');
  assert.equal(fs.existsSync(h.target), false);
  assert.equal(h.state.read('installs', {})[SKILL].state, 'revoked_disabled');
  assert.deepEqual(quarantined(h), { [`1-${VID(1)}`]: 1 });
  assert.equal(h.sent(':set-enabled').filter((r) => r.json.enabled).length, 0);
});

test('an unreadable journal entry raises an alert, is moved aside and no longer holds the org back', async (t) => {
  const h = await skillHarness(t);
  h.over.c02.push(f503);
  await h.queue(['install', 1]);
  const s = h.make();
  assert.deepEqual(await s.runRound(), ['deferred']);
  const rid = queueOf(h)[0].request_id;
  fs.writeFileSync(path.join(h.state.dir, 'requests', `${rid}.json`), '{not json');
  await h.queue(['disable']);
  assert.deepEqual(await s.runRound(), ['closed', 'done']);
  assert.match(alerts(h), new RegExp(`journal entry ${rid} is unreadable`));
  assert.equal(fs.readdirSync(path.join(h.state.dir, 'corrupt')).length, 1);
  assert.deepEqual(await s.runRound(), []);
});

test('an unreadable outbox entry raises an alert and the request reports again from its journal', async (t) => {
  const h = await skillHarness(t);
  h.over.c06.push(f503);
  await h.queue(['install', 1]);
  const s = h.make();
  assert.deepEqual(await s.runRound(), ['deferred']);
  const [rid] = h.state.outbox.list();
  fs.writeFileSync(path.join(h.state.dir, 'outbox', `${rid}.json`), '[');
  assert.deepEqual(await s.runRound(), ['succeeded']);
  assert.match(alerts(h), new RegExp(`outbox entry ${rid} is unreadable`));
  assert.equal(h.reqs.get(rid).status, 'succeeded');
  assert.deepEqual([h.state.outbox.list(), queueOf(h)], [[], []]);
});

test('an outbox entry that cannot be read now is skipped, not moved aside, and the round goes on', { skip: process.getuid?.() === 0 && 'root ignores modes' }, async (t) => {
  const h = await skillHarness(t);
  h.over.c06.push(f503);
  await h.queue(['install', 1]);
  const s = h.make();
  assert.deepEqual(await s.runRound(), ['deferred']);
  const [rid] = h.state.outbox.list();
  const file = path.join(h.state.dir, 'outbox', `${rid}.json`);
  fs.chmodSync(file, 0o000);
  t.after(() => { try { fs.chmodSync(file, 0o600); } catch { /* replaced */ } });
  assert.deepEqual(await s.runRound(), ['succeeded']);
  assert.ok(h.lines.some((l) => new RegExp(`report ${rid} cannot be read \\(EACCES\\); retried next round`).test(l)));
  assert.doesNotMatch(alerts(h), /unreadable/);
  assert.equal(fs.existsSync(path.join(h.state.dir, 'corrupt')), false);
  assert.equal(h.reqs.get(rid).status, 'succeeded');
  assert.deepEqual([h.state.outbox.list(), queueOf(h)], [[], []]);
});

test('what a crash left in the trash or in staging is removed at startup', async (t) => {
  const h = await skillHarness(t);
  for (const d of ['trash/x/docs', 'staging/y']) fs.mkdirSync(path.join(h.dataDir, d), { recursive: true });
  fs.writeFileSync(path.join(h.dataDir, 'trash/x/docs/a.md'), 'a');
  h.make();
  assert.deepEqual([fs.readdirSync(path.join(h.dataDir, 'trash')), fs.readdirSync(path.join(h.dataDir, 'staging'))], [[], []]);
});

test('a second quarantined copy of the same version gets its own subdirectory', async (t) => {
  const { h, s } = await installed(t);
  fs.cpSync(h.target, disabledDir(h), { recursive: true });
  h.state.write('revoked', { skill_version_id: [VID(1)] });
  assert.equal(s.enforceRevocations(), 1);
  assert.deepEqual(quarantined(h), { [`1-${VID(1)}`]: 1, [`1-${VID(1)}.2`]: 1 });
  assert.deepEqual([fs.existsSync(h.target), fs.existsSync(disabledDir(h))], [false, false]);
});
