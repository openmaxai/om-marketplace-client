import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { ROOT, mode, tmpHome } from './helpers.js';
import { StateError, StateLockedError, openState as open, processStartId, stateScope, writeJsonAtomic } from '../src/state.js';

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

const lockPath = (dataDir) => path.join(dataDir, 'state', 'lock');
const writeLock = (dataDir, content) => {
  fs.mkdirSync(path.dirname(lockPath(dataDir)), { recursive: true, mode: 0o700 });
  fs.writeFileSync(lockPath(dataDir), content);
};

test('the lock admits one instance and is taken over from a dead owner', () => {
  const dataDir = path.join(tmpHome(), 'd');
  const s = openState(dataDir, { bffUrl: BFF });
  assert.throws(() => openState(dataDir, { bffUrl: BFF }), StateLockedError);
  s.close();
  assert.equal(fs.existsSync(lockPath(dataDir)), false);
  const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout;
  writeLock(dataDir, `${dead}\n`);
  openState(dataDir, { bffUrl: BFF }).close();
  assert.deepEqual(fs.readdirSync(path.dirname(lockPath(dataDir))).filter((n) => n.startsWith('lock')), []);
});

test('a lock carrying this process id is left by a previous incarnation and is taken over', () => {
  for (const content of [`${process.pid}\n`, JSON.stringify({ pid: process.pid, start: processStartId(process.pid) })]) {
    const dataDir = path.join(tmpHome(), 'd');
    writeLock(dataDir, content);
    const s = openState(dataDir, { bffUrl: BFF });
    assert.equal(JSON.parse(fs.readFileSync(lockPath(dataDir), 'utf8')).pid, process.pid);
    s.close();
    assert.equal(fs.existsSync(lockPath(dataDir)), false);
  }
});

test('a live pid holds the lock only while its start time matches', { skip: processStartId(process.pid) === null && 'no /proc' }, async (t) => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  t.after(() => child.kill('SIGKILL'));
  await new Promise((r) => child.once('spawn', r));
  const start = processStartId(child.pid);
  assert.ok(start);
  assert.equal(processStartId(child.pid), start, 'stable');
  for (const [content, held] of [
    [`${child.pid}\n`, true],
    [JSON.stringify({ pid: child.pid, start }), true],
    [JSON.stringify({ pid: child.pid, start: `${start}0` }), false],
  ]) {
    const dataDir = path.join(tmpHome(), 'd');
    writeLock(dataDir, content);
    if (held) {
      assert.throws(() => openState(dataDir, { bffUrl: BFF }), (err) => err instanceof StateLockedError && err.pid === child.pid);
      assert.equal(fs.readFileSync(lockPath(dataDir), 'utf8'), content, 'a live lock is left alone');
    } else {
      openState(dataDir, { bffUrl: BFF }).close();
    }
  }
});

test('processes starting together over a stale lock: exactly one acquires it', async () => {
  const dataDir = path.join(tmpHome(), 'd');
  writeLock(dataDir, '999999999\n');
  const script = `
    import { openState } from ${JSON.stringify(path.join(ROOT, 'src/state.js'))};
    try {
      const s = openState(${JSON.stringify(dataDir)}, { bffUrl: 'https://bff.example.test', orgId: 'org-1', memberId: 'm-1' });
      process.stdout.write('acquired');
      setTimeout(() => s.close(), 1500);
    } catch (err) {
      process.stdout.write(err.name);
    }`;
  const runs = Array.from({ length: 6 }, () => new Promise((resolve) => {
    const c = spawn(process.execPath, ['--input-type=module', '-e', script]);
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    c.on('exit', () => resolve(out));
  }));
  const outs = await Promise.all(runs);
  assert.equal(outs.filter((o) => o === 'acquired').length, 1, outs.join(','));
  assert.ok(outs.every((o) => o === 'acquired' || o === 'StateLockedError'), outs.join(','));
});

test('writes replace the document by rename and fsync the directory', (t) => {
  const s = openState(path.join(tmpHome(), 'd'), { bffUrl: BFF });
  t.after(() => s.close());
  s.write('intents', { a: 1 });
  const file = path.join(s.dir, 'intents.json');
  const ino = fs.statSync(file).ino;
  const dirFds = new Set();
  const synced = [];
  const openSync = fs.openSync;
  t.mock.method(fs, 'openSync', (p, ...rest) => {
    const fd = openSync(p, ...rest);
    if (p === s.dir) dirFds.add(fd);
    return fd;
  });
  t.mock.method(fs, 'fsyncSync', (fd) => { synced.push(fd); });
  writeJsonAtomic(file, { a: 2 });
  assert.notEqual(fs.statSync(file).ino, ino, 'a new inode: written aside and renamed');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { a: 2 });
  assert.equal(synced.length, 2);
  assert.ok(dirFds.has(synced[1]), 'directory fsynced after the rename');
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
