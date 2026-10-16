import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { skillPackage } from './fake/package.js';
import { SKILL, VID, skillHarness } from './fake/skills.js';
import { emptyTrash } from '../src/trash.js';

const v2 = () => skillPackage('demo-skill', { 'docs/guide.md': 'guide v2\n' });
const rid = (req) => req.path.split('/')[6];
const closed = (code) => (req) => ({ status: 200, json: { request_id: rid(req), status: 'failed', error_code: code } });
const rec = (h) => h.state.read('installs', {})[SKILL];
const alerts = (h) => h.state.read('status', { alerts: {} }).alerts;

// v1 installed, then v2 landed by an upgrade the market timed out, then a second upgrade to v2 that needs no landing.
async function landedTwice(t, refusal) {
  const h = await skillHarness(t, { versions: { 1: skillPackage(), 2: v2() } });
  const s = h.make();
  await h.queue(['install', 1]);
  await s.runRound();
  h.over.c06.push(closed('INSTALL_TIMEOUT'));
  await h.queue(['upgrade', 2]);
  await s.runRound();
  assert.equal(h.marker().version_no, 2);
  h.over.c06.push(refusal(h));
  await h.queue(['upgrade', 2]);
  assert.deepEqual(await s.runRound(), ['succeeded']);
  return { h, s };
}

test('a refused success for a version that was already in place leaves it installed', async (t) => {
  const { h, s } = await landedTwice(t, () => closed('PACKAGE_MISMATCH'));
  assert.equal(h.marker().version_no, 2);
  assert.equal(fs.readFileSync(path.join(h.target, 'docs/guide.md'), 'utf8'), 'guide v2\n');
  assert.deepEqual([rec(h).version_no, rec(h).state], [2, 'enabled']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(h.dataDir, 'rollback', 'demo-skill', '1', '.market-managed'), 'utf8')).version_no, 1);
  assert.deepEqual(await s.runRound(), []);
});

test('a refused success for an already-placed version revoked meanwhile quarantines it', async (t) => {
  const { h } = await landedTwice(t, (x) => (req) => {
    x.state.write('revoked', { skill_version_id: [VID(2)] });
    return closed('VERSION_REVOKED')(req);
  });
  assert.equal(fs.existsSync(h.target), false);
  assert.equal(rec(h).state, 'revoked_disabled');
  const q = path.join(h.dataDir, 'quarantine', 'market--demo-skill');
  assert.deepEqual(fs.readdirSync(q), [`2-${VID(2)}`]);
});

test('a local error that keeps an intent from running raises an alert, cleared once it runs', async (t) => {
  const h = await skillHarness(t);
  const s = h.make();
  await h.queue(['install', 1]);
  await s.runRound();
  // The trash must share the skills filesystem; a non-directory there fails every uninstall the same way.
  const trash = path.join(h.dataDir, 'trash');
  fs.rmSync(trash, { recursive: true, force: true });
  fs.writeFileSync(trash, '');
  const [it] = await h.queue(['uninstall']);
  assert.deepEqual(await s.runRound(), ['deferred']);
  assert.deepEqual(await s.runRound(), ['deferred']);
  assert.match(alerts(h)[`intent_failed:${it.id}`].message, /uninstall of skill .* failed locally/);
  assert.ok(fs.existsSync(h.target));
  fs.rmSync(trash);
  assert.deepEqual(await s.runRound(), ['done']);
  assert.equal(alerts(h)[`intent_failed:${it.id}`], undefined);
  assert.equal(fs.existsSync(h.target), false);
});

test('an intent_failed alert is cleared once its intent leaves the queue without running', async (t) => {
  const h = await skillHarness(t);
  const s = h.make();
  await h.queue(['install', 1]);
  await s.runRound();
  const trash = path.join(h.dataDir, 'trash');
  fs.rmSync(trash, { recursive: true, force: true });
  fs.writeFileSync(trash, '');
  const [it] = await h.queue(['uninstall']);
  assert.deepEqual(await s.runRound(), ['deferred']);
  assert.ok(alerts(h)[`intent_failed:${it.id}`]);
  h.state.update('intents', null, (d) => { d.queue = d.queue.filter((q) => q.id !== it.id); });
  assert.deepEqual(await s.runRound(), []);
  assert.equal(alerts(h)[`intent_failed:${it.id}`], undefined);
  assert.ok(fs.existsSync(h.target));
});

test('startup cleanup never follows a linked trash or staging dir and survives entries it cannot remove', async (t) => {
  const h = await skillHarness(t);
  const outside = path.join(path.dirname(h.dataDir), 'outside');
  fs.mkdirSync(path.join(outside, 'keep'), { recursive: true });
  fs.symlinkSync(outside, path.join(h.dataDir, 'trash'));
  fs.symlinkSync(outside, path.join(h.dataDir, 'staging'));
  h.make();
  assert.ok(fs.existsSync(path.join(outside, 'keep')));

  const dir = path.join(path.dirname(h.dataDir), 'bin');
  fs.mkdirSync(path.join(dir, 'locked', 'inner'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'free'));
  fs.chmodSync(path.join(dir, 'locked'), 0o500);
  t.after(() => fs.chmodSync(path.join(dir, 'locked'), 0o700));
  const left = emptyTrash(dir);
  if (process.getuid?.() === 0) return;
  assert.equal(left, 1);
  assert.deepEqual(fs.readdirSync(dir), ['locked']);
});
