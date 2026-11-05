import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpHome } from './helpers.js';
import { ImError, createOpenmaxIm, openmaxCommCli } from '../src/starter/im.js';

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
