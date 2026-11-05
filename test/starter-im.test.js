import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpHome } from './helpers.js';
import { ImError, OPENMAX_NORUN_MIN_VERSION, createOpenmaxIm, openmaxCommCli, sendParams, versionAtLeast } from '../src/starter/im.js';

const ORG = '0b6f4f3e-1111-4c2a-9d1e-cccccccccccc';

// Fake execFile: answers per command with {stdout} or {err, stderr}; records argv.
function fakeRun(answers) {
  const calls = [];
  const run = (file, args, opts, cb) => {
    calls.push({ file, args, opts });
    const a = answers[args[1]];
    setImmediate(() => (a.err ? cb(a.err, '', a.stderr ?? '') : cb(null, a.stdout, '')));
  };
  return { calls, run };
}

test('calls the openmax comm CLI with the org on every call and sends plain text without mentions', async () => {
  const zylosDir = tmpHome();
  const f = fakeRun({
    'comm.create_dm': { stdout: JSON.stringify({ id: 'cv-1', type: 'DM' }) },
    'comm.get_conversation': { stdout: JSON.stringify({ id: 'cv-1', type: 'DM' }) },
    'comm.member_list': { stdout: JSON.stringify([{ member_id: 'a' }, { member_id: 'b' }]) },
    'comm.send': { stdout: JSON.stringify({ id: 'm1' }) },
  });
  const im = createOpenmaxIm({ zylosDir, run: f.run });
  assert.equal(im.available(), false);
  assert.equal(await im.createDm({ orgId: ORG, peerMemberId: 'b' }), 'cv-1');
  assert.deepEqual(await im.getConversation({ orgId: ORG, conversationId: 'cv-1' }), { id: 'cv-1', type: 'DM' });
  assert.equal((await im.memberList({ orgId: ORG, conversationId: 'cv-1' })).length, 2);
  await im.sendText({ orgId: ORG, conversationId: 'cv-1', text: 'hi ＠x', clientMsgId: 'cmsg_1' });
  for (const c of f.calls) {
    assert.equal(c.file, process.execPath);
    assert.equal(c.args[0], openmaxCommCli(zylosDir));
    assert.equal(JSON.parse(c.args[2]).org, ORG);
    assert.ok(c.opts.timeout > 0);
  }
  assert.deepEqual(JSON.parse(f.calls[0].args[2]), { org: ORG, peerMemberId: 'b' });
  const send = JSON.parse(f.calls[3].args[2]);
  assert.deepEqual(send, {
    org: ORG, conversationId: 'cv-1', clientMsgId: 'cmsg_1',
    body: { type: 'AGENT_TEXT', content: { content_type: 'text', body: { text: 'hi ＠x' }, attachments: [] } },
  });
  assert.ok(!('mentions' in send) && !('mentions' in send.body));
  fs.mkdirSync(path.dirname(openmaxCommCli(zylosDir)), { recursive: true });
  fs.writeFileSync(openmaxCommCli(zylosDir), '');
  assert.equal(im.available(), true);
});

test('a refused call is definite; a timeout or server error leaves delivery unknown', async () => {
  const exit = Object.assign(new Error('exit'), { code: 1 });
  const cases = [
    [{ err: exit, stderr: JSON.stringify({ error: 'bad', status: 400 }) }, true],
    [{ err: exit, stderr: JSON.stringify({ error: 'busy', status: 503 }) }, false],
    [{ err: exit, stderr: JSON.stringify({ error: 'slow', status: 429 }) }, false],
    [{ err: Object.assign(new Error('killed'), { killed: true }), stderr: '' }, false],
    [{ err: exit, stderr: 'not json' }, false],
  ];
  for (const [answer, definite] of cases) {
    const im = createOpenmaxIm({ zylosDir: tmpHome(), run: fakeRun({ 'comm.send': answer }).run });
    const err = await im.sendText({ orgId: ORG, conversationId: 'c', text: 't', clientMsgId: 'k' }).catch((e) => e);
    assert.ok(err instanceof ImError);
    assert.equal(err.definite, definite, answer.stderr);
  }
});

test('answers without a conversation id or a member list are errors', async () => {
  const im = createOpenmaxIm({
    zylosDir: tmpHome(),
    run: fakeRun({ 'comm.create_dm': { stdout: '{}' }, 'comm.member_list': { stdout: '{"x":1}' } }).run,
  });
  await assert.rejects(im.createDm({ orgId: ORG, peerMemberId: 'b' }), ImError);
  await assert.rejects(im.memberList({ orgId: ORG, conversationId: 'c' }), ImError);
});

// A zylos dir whose openmax has the given version and activity modules.
function fakeOpenmax({ version = '2.30.0', active = null, selected = null } = {}) {
  const zylosDir = tmpHome();
  const dir = path.join(zylosDir, '.claude', 'skills', 'openmax');
  const act = path.join(dir, 'src', 'lib', 'activity');
  fs.mkdirSync(act, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version }));
  fs.writeFileSync(path.join(act, 'run-store.js'),
    `export function createRunStore() { return { readActive: () => (${JSON.stringify(active)}), readRun: () => null, claimExists: () => false }; }\n`);
  fs.writeFileSync(path.join(act, 'reply.js'),
    `export function selectRun({ store, active, convId, now }) { globalThis.selectRunCalls = (globalThis.selectRunCalls ?? []).concat([{ active, convId, now }]); return { run: (${JSON.stringify(selected)}) }; }\n`);
  return zylosDir;
}

test('the run check asks openmax\'s own activity store and run selection', async () => {
  const active = { by_conversation: { 'cv-1': ['r_00000001'] } };
  globalThis.selectRunCalls = [];
  const busy = createOpenmaxIm({ zylosDir: fakeOpenmax({ active, selected: { run_id: 'r_00000001' } }), now: () => 42 });
  assert.equal(await busy.runInProgress({ conversationId: 'cv-1' }), true);
  assert.deepEqual(globalThis.selectRunCalls.at(-1), { active, convId: 'cv-1', now: 42 });
  const free = createOpenmaxIm({ zylosDir: fakeOpenmax({ active, selected: null }) });
  assert.equal(await free.runInProgress({ conversationId: 'cv-1' }), false);
  const none = createOpenmaxIm({ zylosDir: fakeOpenmax({ active: null, selected: { run_id: 'x' } }) });
  assert.equal(await none.runInProgress({ conversationId: 'cv-1' }), false);
  await assert.rejects(createOpenmaxIm({ zylosDir: tmpHome() }).runInProgress({ conversationId: 'cv-1' }));
});

test('noRun is used only from the configured openmax version on', () => {
  assert.equal(versionAtLeast('2.31.0', '2.31.0'), true);
  assert.equal(versionAtLeast('2.31.1', '2.31.0'), true);
  assert.equal(versionAtLeast('3.0.0', '2.31.0'), true);
  assert.equal(versionAtLeast('2.30.9', '2.31.0'), false);
  assert.equal(versionAtLeast('x', '2.31.0'), false);
  assert.equal(OPENMAX_NORUN_MIN_VERSION, null);
  assert.equal(createOpenmaxIm({ zylosDir: fakeOpenmax({ version: '9.9.9' }) }).supportsNoRun(), false);
  assert.equal(createOpenmaxIm({ zylosDir: fakeOpenmax({ version: '2.31.0' }), noRunMinVersion: '2.31.0' }).supportsNoRun(), true);
  assert.equal(createOpenmaxIm({ zylosDir: fakeOpenmax({ version: '2.30.0' }), noRunMinVersion: '2.31.0' }).supportsNoRun(), false);
  assert.equal(createOpenmaxIm({ zylosDir: tmpHome(), noRunMinVersion: '2.31.0' }).supportsNoRun(), false);
  assert.equal(sendParams({ orgId: 'o', conversationId: 'c', text: 't', clientMsgId: 'k', noRun: true }).noRun, true);
  assert.equal('noRun' in sendParams({ orgId: 'o', conversationId: 'c', text: 't', clientMsgId: 'k' }), false);
});

// Against a real openmax checkout (OPENMAX_DIR): an open run and a run closed by a reply within 10 minutes are busy.
test('real openmax run selection: open run, reply-closed run within and after 10 minutes', { skip: !process.env.OPENMAX_DIR && 'OPENMAX_DIR not set' }, async () => {
  const runs = tmpHome();
  process.env.OPENMAX_RUNS_DIR = runs;
  const zylosDir = tmpHome();
  fs.mkdirSync(path.join(zylosDir, '.claude', 'skills'), { recursive: true });
  fs.symlinkSync(process.env.OPENMAX_DIR, path.join(zylosDir, '.claude', 'skills', 'openmax'));
  const now = Date.parse('2026-11-05T00:00:00Z');
  const write = (run) => fs.writeFileSync(path.join(runs, `${run.run_id}.json`), JSON.stringify({ org_id: ORG, created_at: now - 60_000, ...run }));
  fs.writeFileSync(path.join(runs, 'active.json'), JSON.stringify({
    by_conversation: { open: ['r_0000000a'], recent: ['r_0000000b'], old: ['r_0000000c'] }, gate: { [ORG]: 'open' },
  }));
  write({ run_id: 'r_0000000a', state: 'running' });
  write({ run_id: 'r_0000000b', state: 'closed', closed_on_reply: true, ended_at: now - 9 * 60_000 });
  write({ run_id: 'r_0000000c', state: 'closed', closed_on_reply: true, ended_at: now - 11 * 60_000 });
  const im = createOpenmaxIm({ zylosDir, now: () => now });
  assert.equal(await im.runInProgress({ conversationId: 'open' }), true);
  assert.equal(await im.runInProgress({ conversationId: 'recent' }), true);
  assert.equal(await im.runInProgress({ conversationId: 'old' }), false);
  assert.equal(await im.runInProgress({ conversationId: 'other' }), false);
});
