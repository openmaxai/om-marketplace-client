import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpHome } from './helpers.js';
import {
  ImError, OPENMAX_NORUN_MIN_VERSION, createOpenmaxIm, openmaxCommCli, parseCliOutput, redact, sendParams, versionAtLeast,
} from '../src/starter/im.js';

const ORG = '0b6f4f3e-1111-4c2a-9d1e-cccccccccccc';

// Fake execFile: answers per command with {stdout} or {err, stderr}, or a list of them used in turn; records argv.
function fakeRun(answers) {
  const calls = [];
  const turns = {};
  const run = (file, args, opts, cb) => {
    calls.push({ file, args, opts });
    const list = [answers[args[1]]].flat();
    const n = turns[args[1]] = (turns[args[1]] ?? 0) + 1;
    const a = list[Math.min(n, list.length) - 1];
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
  assert.equal(OPENMAX_NORUN_MIN_VERSION, '2.32.0');
  assert.equal(createOpenmaxIm({ zylosDir: fakeOpenmax({ version: '2.32.0' }) }).supportsNoRun(), true);
  assert.equal(createOpenmaxIm({ zylosDir: fakeOpenmax({ version: '2.31.0' }) }).supportsNoRun(), false);
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

test('turns off the CLI request trace and reads the answer past any trace lines on stdout', async () => {
  const trace = '[rpc] \u2192 POST https://example.test/api/v1/conversations/dm  req: {"peer_member_id":"b"}\n'
    + '[rpc] \u2190 POST https://example.test/api/v1/conversations/dm resp 200: {"data":{"id":"cv-1"}}\n';
  const f = fakeRun({ 'comm.create_dm': { stdout: `${trace}${JSON.stringify({ id: 'cv-1', type: 'DM' }, null, 2)}\n` } });
  const im = createOpenmaxIm({ zylosDir: tmpHome(), run: f.run });
  assert.equal(await im.createDm({ orgId: ORG, peerMemberId: 'b' }), 'cv-1');
  assert.equal(f.calls[0].opts.env.COCO_RPC_LOG, '0');
  assert.deepEqual(parseCliOutput(`${trace}[1,2]`), [1, 2]);
  assert.throws(() => parseCliOutput(trace), SyntaxError);
});

test('reads the service answer shapes of create_dm, get_conversation and member_list', async () => {
  const conv = { id: 'cv-9', type: 'DM', member_count: 2, dm: { peer_member_id: 'b', peer_kind: 'human', can_send: true } };
  const f = fakeRun({
    'comm.create_dm': { stdout: JSON.stringify({ data: { conversation: conv, created: false } }) },
    'comm.get_conversation': { stdout: JSON.stringify({ data: conv }) },
    'comm.member_list': { stdout: JSON.stringify({ data: [{ member_id: 'a', role: 'MEMBER', kind: 'agent' }, { member_id: 'b', role: 'MEMBER', kind: 'human' }] }) },
  });
  const im = createOpenmaxIm({ zylosDir: tmpHome(), run: f.run });
  assert.equal(await im.createDm({ orgId: ORG, peerMemberId: 'b' }), 'cv-9');
  assert.equal((await im.getConversation({ orgId: ORG, conversationId: 'cv-9' })).type, 'DM');
  assert.deepEqual((await im.memberList({ orgId: ORG, conversationId: 'cv-9' })).map((m) => m.member_id), ['a', 'b']);
  const empty = createOpenmaxIm({ zylosDir: tmpHome(), run: fakeRun({ 'comm.create_dm': { stdout: '{"data":{"conversation":{},"created":true}}' } }).run });
  await assert.rejects(empty.createDm({ orgId: ORG, peerMemberId: 'b' }), ImError);
});

// The lines openmax 2.32.0 prints to stdout around a lazy token refresh (src/lib/token.js), before the answer.
const TOKEN_LINES = '[token] auto-filled orgs.acme.self.member_id from JWT claims: 019f0000-0000-7000-8000-000000000001\n'
  + `[token] refresh org=${ORG}\n[token] refresh ok org=${ORG} exp=2026-11-10T10:24:21.000Z\n`;

test('reads the answer past [token] and [rpc] lines, pretty-printed or compact', () => {
  const answer = { data: { conversation: { id: 'cv-1', type: 'DM', tags: ['a', 'b'] }, created: false } };
  const rpc = '[rpc] \u2192 POST https://example.test/api/v1/conversations/dm  req: {"peer_member_id":"b"}\n';
  for (const stdout of [
    `${TOKEN_LINES}${JSON.stringify(answer, null, 2)}\n`,
    `${TOKEN_LINES}${rpc}${JSON.stringify(answer, null, 2)}\n`,
    `${rpc}${TOKEN_LINES}${JSON.stringify(answer)}`,
    `[token] exchange org=${ORG}\n[ws.ticket-2] x\n${JSON.stringify(answer, null, 2)}`,
    `some unprefixed note\n{ not json\n${JSON.stringify(answer, null, 2)}\n\n`,
  ]) assert.deepEqual(parseCliOutput(stdout), answer, stdout);
  assert.deepEqual(parseCliOutput(`${TOKEN_LINES}${JSON.stringify([1, [2]], null, 2)}`), [1, [2]]);
  assert.throws(() => parseCliOutput(TOKEN_LINES), SyntaxError);
  assert.throws(() => parseCliOutput(`${TOKEN_LINES}{"a":`), SyntaxError);
  assert.throws(() => parseCliOutput(''), SyntaxError);
});

test('a DM-check call answered after [token] lines succeeds without a retry', async () => {
  const conv = { id: 'cv-1', type: 'DM' };
  const f = fakeRun({ 'comm.create_dm': { stdout: `${TOKEN_LINES}${JSON.stringify({ data: { conversation: conv, created: false } }, null, 2)}\n` } });
  const im = createOpenmaxIm({ zylosDir: tmpHome(), run: f.run, retryDelayMs: 0 });
  assert.equal(await im.createDm({ orgId: ORG, peerMemberId: 'b' }), 'cv-1');
  assert.equal(f.calls.length, 1);
});

test('the read-only DM-check calls are tried once more after unreadable output or a timeout, not after a refusal', async () => {
  const good = {
    'comm.create_dm': { stdout: JSON.stringify({ id: 'cv-1' }) },
    'comm.get_conversation': { stdout: JSON.stringify({ id: 'cv-1', type: 'DM' }) },
    'comm.member_list': { stdout: JSON.stringify([{ member_id: 'a' }, { member_id: 'b' }]) },
  };
  const calls = {
    'comm.create_dm': (im) => im.createDm({ orgId: ORG, peerMemberId: 'b' }),
    'comm.get_conversation': (im) => im.getConversation({ orgId: ORG, conversationId: 'cv-1' }),
    'comm.member_list': (im) => im.memberList({ orgId: ORG, conversationId: 'cv-1' }),
  };
  const exit = Object.assign(new Error('exit'), { code: 1 });
  const transient = [
    { stdout: 'garbage' },
    { err: Object.assign(new Error('killed'), { killed: true }), stderr: '' },
    { err: exit, stderr: JSON.stringify({ error: 'busy', status: 503 }) },
  ];
  for (const [command, invoke] of Object.entries(calls)) {
    for (const first of transient) {
      const f = fakeRun({ [command]: [first, good[command]] });
      await invoke(createOpenmaxIm({ zylosDir: tmpHome(), run: f.run, retryDelayMs: 0 }));
      assert.equal(f.calls.length, 2, `${command} ${JSON.stringify(first)}`);
    }
    const twice = fakeRun({ [command]: [{ stdout: 'garbage' }, { stdout: 'still garbage' }, good[command]] });
    const err = await invoke(createOpenmaxIm({ zylosDir: tmpHome(), run: twice.run, retryDelayMs: 0 })).catch((e) => e);
    assert.ok(err instanceof ImError);
    assert.equal(err.kind, 'unreadable');
    assert.equal(twice.calls.length, 2);
    const refused = fakeRun({ [command]: [{ err: exit, stderr: JSON.stringify({ error: 'no', status: 403 }) }, good[command]] });
    const no = await invoke(createOpenmaxIm({ zylosDir: tmpHome(), run: refused.run, retryDelayMs: 0 })).catch((e) => e);
    assert.equal(no.status, 403);
    assert.equal(no.definite, true);
    assert.equal(refused.calls.length, 1);
  }
});

test('comm.send is never tried again, whatever the failure', async () => {
  const exit = Object.assign(new Error('exit'), { code: 1 });
  for (const first of [
    { stdout: 'garbage' },
    { err: Object.assign(new Error('killed'), { killed: true }), stderr: '' },
    { err: exit, stderr: JSON.stringify({ error: 'busy', status: 503 }) },
    { err: exit, stderr: JSON.stringify({ error: 'bad', status: 400 }) },
  ]) {
    const f = fakeRun({ 'comm.send': [first, { stdout: '{"id":"m1"}' }] });
    const im = createOpenmaxIm({ zylosDir: tmpHome(), run: f.run, retryDelayMs: 0 });
    await assert.rejects(im.sendText({ orgId: ORG, conversationId: 'c', text: 't', clientMsgId: 'k' }), ImError);
    assert.equal(f.calls.length, 1);
  }
});

test('an ImError keeps what failed and the CLI error text, redacted', async () => {
  const exit = Object.assign(new Error('exit'), { code: 1 });
  const fail = async (answer) => {
    const im = createOpenmaxIm({ zylosDir: tmpHome(), run: fakeRun({ 'comm.send': answer }).run });
    return im.sendText({ orgId: ORG, conversationId: 'c', text: 't', clientMsgId: 'k' }).catch((e) => e);
  };
  let err = await fail({ err: exit, stderr: `warn line\n${JSON.stringify({ error: 'peer is not a member', status: 403 })}\n` });
  assert.deepEqual([err.message, err.kind, err.status, err.definite], ['HTTP 403: peer is not a member', 'http', 403, true]);
  err = await fail({ err: exit, stderr: JSON.stringify({ error: 'request failed: Authorization: Bearer abc123 token=xyz789' }) });
  assert.equal(err.kind, 'exit');
  assert.ok(err.message.startsWith('exit 1: request failed'), err.message);
  assert.ok(!err.message.includes('abc123') && !err.message.includes('xyz789'), err.message);
  err = await fail({ err: Object.assign(new Error('killed'), { killed: true }), stderr: '' });
  assert.deepEqual([err.message, err.kind], ['timed out', 'timeout']);
  err = await fail({ stdout: `${TOKEN_LINES}oops` });
  assert.equal(err.kind, 'unreadable');
  assert.ok(err.message.startsWith('unreadable output: [token] auto-filled'), err.message);
  assert.ok(err.message.length < 260, err.message);
  assert.ok(!redact('x '.repeat(500)).includes('\n'));
  assert.equal(redact('password: hunter2, api_key=k1'), 'password: [redacted], api_key=[redacted]');
});
