import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { mode, tmpHome } from './helpers.js';
import { StateError, StateLockedError, openState as open, stateScope } from '../src/state.js';

const BFF = 'https://bff.example.test';
const SCOPE = { orgId: 'org-1', memberId: 'm-1' };
const openState = (dir, opts) => open(dir, { ...SCOPE, ...opts });
const ID = '0190f000-0000-7000-8000-000000000001';

test('state lives in a 0700 per-origin directory; documents are written atomically with mode 0600', () => {
  const dataDir = path.join(tmpHome(), 'd');
  const s = openState(dataDir, { bffUrl: BFF });
  assert.equal(s.dir, path.join(dataDir, 'state', stateScope(BFF, 'org-1', 'm-1')));
  assert.equal(mode(s.dir), 0o700);
  assert.deepEqual(s.read('intents', { a: 1 }), { a: 1 });
  s.write('intents', { b: 2 });
  assert.deepEqual(s.read('intents', null), { b: 2 });
  assert.equal(mode(path.join(s.dir, 'intents.json')), 0o600);
  assert.deepEqual(s.update('intents', {}, (d) => { d.c = 3; }), { b: 2, c: 3 });
  assert.deepEqual(fs.readdirSync(s.dir).filter((n) => n.endsWith('.tmp')), []);
  assert.throws(() => s.read('../x', null), TypeError);
  s.close();
});

test('a different market origin or agent gets separate state', () => {
  const dataDir = path.join(tmpHome(), 'd');
  const a = openState(dataDir, { bffUrl: BFF });
  a.write('intents', { after_seq: 9 });
  a.close();
  for (const other of [{ bffUrl: 'https://other.example.test' }, { bffUrl: BFF, orgId: 'org-2' }, { bffUrl: BFF, memberId: 'm-2' }]) {
    const b = openState(dataDir, other);
    assert.deepEqual(b.read('intents', { after_seq: 0 }), { after_seq: 0 });
    b.close();
  }
  const again = openState(dataDir, { bffUrl: `${BFF}/` });
  assert.deepEqual(again.read('intents', null), { after_seq: 9 });
  again.close();
});

test('corrupt or symlinked documents fail closed', () => {
  const s = openState(path.join(tmpHome(), 'd'), { bffUrl: BFF });
  fs.writeFileSync(path.join(s.dir, 'gate.json'), '{nope');
  assert.throws(() => s.read('gate', {}), StateError);
  const other = path.join(tmpHome(), 'x.json');
  fs.writeFileSync(other, '{}');
  fs.symlinkSync(other, path.join(s.dir, 'orgs.json'));
  assert.throws(() => s.read('orgs', {}), /not a regular file/);
  s.close();
});

test('the lock admits one instance and is taken over from a dead owner', () => {
  const dataDir = path.join(tmpHome(), 'd');
  const s = openState(dataDir, { bffUrl: BFF });
  assert.throws(() => openState(dataDir, { bffUrl: BFF }), StateLockedError);
  s.close();
  assert.equal(fs.existsSync(path.join(dataDir, 'state', 'lock')), false);
  const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout;
  fs.writeFileSync(path.join(dataDir, 'state', 'lock'), `${dead}\n`);
  openState(dataDir, { bffUrl: BFF }).close();
});

test('journal and outbox store one record per canonical id', () => {
  const s = openState(path.join(tmpHome(), 'd'), { bffUrl: BFF });
  for (const c of [s.journal, s.outbox]) {
    assert.deepEqual(c.list(), []);
    assert.equal(c.get(ID), null);
    c.put(ID, { phase: 'requested', body: { request_id: ID } });
    assert.deepEqual(c.get(ID), { phase: 'requested', body: { request_id: ID } });
    assert.deepEqual(c.list(), [ID]);
    c.remove(ID);
    c.remove(ID);
    assert.deepEqual(c.list(), []);
    assert.throws(() => c.put('../../x', {}), TypeError);
  }
  s.close();
});

test('alerts persist until cleared and report whether they are new', () => {
  const s = openState(path.join(tmpHome(), 'd'), { bffUrl: BFF, now: () => 0 });
  assert.equal(s.setAlert('a', 'first'), true);
  assert.equal(s.setAlert('a', 'second'), false);
  s.recordRun('intents', 'ok');
  const st = s.read('status', null);
  assert.equal(st.alerts.a.message, 'second');
  assert.equal(st.alerts.a.since, '1970-01-01T00:00:00.000Z');
  assert.deepEqual(st.runs.intents, { outcome: 'ok', at: '1970-01-01T00:00:00.000Z' });
  s.clearAlert('a');
  assert.deepEqual(s.read('status', null).alerts, {});
  s.close();
});
