import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpHome } from './helpers.js';
import { EXIT, MAX_ARG_LENGTH, spool, validRequest } from '../src/commands.js';

const dirOf = (d) => path.join(d, 'cli');

test('requests are validated on submit and on claim', () => {
  assert.ok(validRequest('sync', null));
  assert.ok(validRequest('disable', 'demo'));
  assert.ok(validRequest('rollback', 'x'.repeat(MAX_ARG_LENGTH)));
  for (const [c, a] of [['sync', 'x'], ['disable', null], ['disable', ''], ['disable', 5], ['disable', 'x'.repeat(MAX_ARG_LENGTH + 1)], ['status', null], ['keygen', 'x'], [1, 'x']]) {
    assert.equal(validRequest(c, a), false, `${c} ${a}`);
  }
  const d = tmpHome();
  const sp = spool(d);
  assert.throws(() => sp.submit('disable', { slug: 'x' }), TypeError);
  const now = Date.now();
  const put = (id, body) => { fs.mkdirSync(dirOf(d), { recursive: true }); fs.writeFileSync(path.join(dirOf(d), `${id}.json`), typeof body === 'string' ? body : JSON.stringify(body)); };
  put('a', { cmd: 'disable', arg: ['demo'], at: new Date(now).toISOString() });
  put('b', { cmd: 'disable', arg: 'demo', at: new Date(now).toISOString(), pad: 'x'.repeat(5000) });
  put('c', { cmd: 'disable', arg: 'demo', at: new Date(now - 60 * 60 * 1000).toISOString() });
  put('d', { cmd: 'disable', arg: 'demo', at: new Date(now + 60 * 1000).toISOString() });
  put('e', 'null');
  put('f', { cmd: 'disable', arg: 'demo', at: new Date(now - 1000).toISOString(), extra: 1 });
  const claimed = sp.claim(now);
  assert.deepEqual(claimed.map((r) => [r.id, r.cmd, r.arg]), [['f', 'disable', 'demo']]);
  assert.equal(claimed[0].extra, undefined);
  for (const id of ['a', 'b', 'c', 'd', 'e']) assert.equal(sp.take(id).code, EXIT.USAGE, id);
});

test('a result answers only its own request; an orphaned claim is answered as interrupted; old results expire', () => {
  const d = tmpHome();
  const sp = spool(d);
  const one = sp.submit('sync');
  const two = sp.submit('disable', 'demo');
  const reqs = sp.claim();
  assert.deepEqual(reqs.map((r) => r.id).sort(), [one, two].sort());
  sp.answer(one, { code: EXIT.OK, message: 'one' });
  assert.equal(sp.take(two), null);
  assert.equal(sp.take(one).message, 'one');
  assert.equal(sp.take(one), null, 'taken once');

  assert.ok(fs.existsSync(path.join(dirOf(d), `${two}.run`)));
  sp.claim();
  assert.match(sp.take(two).message, /interrupted/);

  const three = sp.submit('sync');
  sp.claim();
  sp.answer(three, { code: EXIT.OK, message: 'late' });
  const res = path.join(dirOf(d), `${three}.result.json`);
  sp.claim(Date.now() + 60 * 60 * 1000 - 5000);
  assert.ok(fs.existsSync(res));
  sp.claim(Date.now() + 60 * 60 * 1000 + 5000);
  assert.ok(!fs.existsSync(res), 'an untaken result older than an hour is removed');
});
