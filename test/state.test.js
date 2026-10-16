import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { ROOT, mode, tmpHome } from './helpers.js';
import { StateError, StateLockedError, openState as open, processStartId, sha256Hex, stateScope, writeJsonAtomic } from '../src/state.js';

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

// N processes start together over a dead-pid lock. Each holder marks itself with an O_EXCL file for the whole hold
// and records its hold interval, so two simultaneous holders are detected directly and by overlapping intervals.
async function lockRace({ procs = 6, holdMs = 300, delayMs = 0 } = {}) {
  const dataDir = path.join(tmpHome(), 'd');
  writeLock(dataDir, '999999999\n');
  const marker = path.join(dataDir, 'holder');
  const startAt = Date.now() + 300;
  const script = `
    import fs from 'node:fs';
    import { openState } from ${JSON.stringify(path.join(ROOT, 'src/state.js'))};
    while (Date.now() < ${startAt});
    let s;
    try {
      s = openState(${JSON.stringify(dataDir)}, { bffUrl: 'https://bff.example.test', orgId: 'org-1', memberId: 'm-1' });
    } catch (err) {
      process.stdout.write(JSON.stringify({ out: err.name }));
      process.exit(0);
    }
    const enter = process.hrtime.bigint();
    let out = 'acquired';
    try { fs.closeSync(fs.openSync(${JSON.stringify(marker)}, 'wx')); } catch { out = 'overlap'; }
    setTimeout(() => {
      if (out === 'acquired') fs.unlinkSync(${JSON.stringify(marker)});
      const exit = process.hrtime.bigint();
      s.close();
      process.stdout.write(JSON.stringify({ out, enter: String(enter), exit: String(exit) }));
    }, ${holdMs});`;
  const env = { ...process.env, OM_MARKETPLACE_CLIENT_TEST_LOCK_DELAY_MS: String(delayMs) };
  const runs = Array.from({ length: procs }, () => new Promise((resolve) => {
    const c = spawn(process.execPath, ['--input-type=module', '-e', script], { env });
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    c.on('exit', () => { try { resolve(JSON.parse(out)); } catch { resolve({ out: `bad output: ${out}` }); } });
  }));
  const results = await Promise.all(runs);
  const holds = results.filter((r) => r.enter).map((r) => [BigInt(r.enter), BigInt(r.exit)]).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const overlaps = holds.slice(1).filter(([enter], i) => enter < holds[i][1]).length;
  const failures = [];
  if (holds.length === 0) failures.push('no holder');
  if (overlaps > 0 || results.some((r) => r.out === 'overlap')) failures.push('two holders');
  for (const r of results) if (r.out !== 'acquired' && r.out !== 'overlap' && r.out !== 'StateLockedError') failures.push(r.out);
  return { results, failures };
}

test('processes contending for a stale lock: at most one holder at any moment, at least one acquisition', async () => {
  const trials = Number(process.env.LOCK_RACE_TRIALS) || 3;
  for (let i = 0; i < trials; i++) {
    for (const delayMs of [0, 5]) {
      const { results, failures } = await lockRace({ delayMs });
      assert.deepEqual(failures, [], JSON.stringify(results));
    }
  }
});

const reapName = (content) => `lock.reap-${sha256Hex(content).slice(0, 16)}`;
const lockFiles = (dataDir) => fs.readdirSync(path.dirname(lockPath(dataDir))).filter((n) => n.startsWith('lock'));
const deadPid = () => Number(spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout);
const record = (pid, start = null) => JSON.stringify({ pid, start, nonce: crypto.randomBytes(8).toString('hex') });

async function sleeper(t) {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  t.after(() => child.kill('SIGKILL'));
  await new Promise((r) => child.once('spawn', r));
  return child;
}

test('reap guards and temp files left by dead processes are removed', () => {
  const dataDir = path.join(tmpHome(), 'd');
  const dead = deadPid();
  const stale = record(dead);
  writeLock(dataDir, stale);
  const dir = path.dirname(lockPath(dataDir));
  const reaper = record(dead);
  fs.writeFileSync(path.join(dir, reapName(stale)), reaper);
  fs.writeFileSync(path.join(dir, `${reapName(stale)}.reap-${sha256Hex(reaper).slice(0, 16)}`), record(dead));
  fs.writeFileSync(path.join(dir, 'lock.reap-0123456789abcdef'), record(dead));
  fs.writeFileSync(path.join(dir, 'lock.takeover'), record(dead));
  fs.writeFileSync(path.join(dir, `lock.tmp-${dead}-0badc0de`), '');
  openState(dataDir, { bffUrl: BFF }).close();
  assert.deepEqual(lockFiles(dataDir), []);
});

test('a reap guard held by a live process blocks removal of the stale lock until it is released', { skip: processStartId(process.pid) === null && 'no /proc' }, async (t) => {
  const child = await sleeper(t);
  const dataDir = path.join(tmpHome(), 'd');
  const stale = record(deadPid());
  writeLock(dataDir, stale);
  const guard = path.join(path.dirname(lockPath(dataDir)), reapName(stale));
  fs.writeFileSync(guard, record(child.pid, processStartId(child.pid)));
  const script = `
    import { openState } from ${JSON.stringify(path.join(ROOT, 'src/state.js'))};
    process.stdout.write('started\\n');
    const t0 = Date.now();
    openState(${JSON.stringify(dataDir)}, { bffUrl: 'https://bff.example.test', orgId: 'org-1', memberId: 'm-1' }).close();
    process.stdout.write(String(Date.now() - t0));`;
  const c = spawn(process.execPath, ['--input-type=module', '-e', script]);
  let out = '';
  const started = new Promise((r) => c.stdout.on('data', (d) => { out += d; if (out.includes('\n')) r(); }));
  let done = false;
  const exited = new Promise((r) => c.on('exit', (code) => { done = true; r(code); }));
  await started;
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(done, false, 'waits while the guard is held');
  assert.equal(fs.readFileSync(lockPath(dataDir), 'utf8'), stale, 'stale lock not removed while the guard is held');
  fs.unlinkSync(guard);
  assert.equal(await exited, 0);
  assert.ok(Number(out.split('\n')[1]) >= 400, out);
  assert.deepEqual(lockFiles(dataDir), []);
});

test('a reap guard held by a live pid with a different start time is taken over', { skip: processStartId(process.pid) === null && 'no /proc' }, async (t) => {
  const child = await sleeper(t);
  const dataDir = path.join(tmpHome(), 'd');
  const stale = record(deadPid());
  writeLock(dataDir, stale);
  fs.writeFileSync(path.join(path.dirname(lockPath(dataDir)), reapName(stale)), record(child.pid, `${processStartId(child.pid)}0`));
  openState(dataDir, { bffUrl: BFF }).close();
  assert.deepEqual(lockFiles(dataDir), []);
});

test('an unreadable boot id makes the start time unknown, so a live holder keeps the lock', { skip: processStartId(process.pid) === null && 'no /proc' }, async (t) => {
  const child = await sleeper(t);
  const start = processStartId(child.pid);
  const dataDir = path.join(tmpHome(), 'd');
  const content = record(child.pid, start);
  writeLock(dataDir, content);
  const readFileSync = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', (p, ...rest) => {
    if (p === '/proc/sys/kernel/random/boot_id') throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
    return readFileSync(p, ...rest);
  });
  assert.equal(processStartId(child.pid), null);
  assert.throws(() => openState(dataDir, { bffUrl: BFF }), (err) => err instanceof StateLockedError && err.pid === child.pid);
  assert.equal(readFileSync(lockPath(dataDir), 'utf8'), content);
});

// A child that pauses before every lock file operation (see step() in src/state.js) and reports it, so the test
// decides the interleaving. After acquiring it keeps the lock until stdin closes.
function stepper(t, dataDir) {
  const script = `
    import fs from 'node:fs';
    import { openState } from ${JSON.stringify(path.join(ROOT, 'src/state.js'))};
    let done;
    try {
      openState(${JSON.stringify(dataDir)}, { bffUrl: 'https://bff.example.test', orgId: 'org-1', memberId: 'm-1' });
      done = 'acquired';
    } catch (err) {
      done = err.name;
    }
    fs.writeSync(1, JSON.stringify({ done }) + '\\n');
    try { while (fs.readSync(0, Buffer.alloc(1)) > 0); } catch {}`;
  const c = spawn(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, OM_MARKETPLACE_CLIENT_TEST_LOCK_STEP: '1', OM_MARKETPLACE_CLIENT_TEST_LOCK_DELAY_MS: '0' },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  t.after(() => c.kill('SIGKILL'));
  const queue = [];
  const waiters = [];
  let buf = '';
  c.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const msg = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      if (waiters.length) waiters.shift()(msg); else queue.push(msg);
    }
  });
  const next = () => (queue.length ? Promise.resolve(queue.shift()) : new Promise((r) => waiters.push(r)));
  let pending = null;
  // Lets the child run until it is paused before an operation matching pred, or has finished.
  return async (pred = () => false, maxSteps = 400) => {
    for (let i = 0; i < maxSteps; i++) {
      pending ??= await next();
      if (pending.done || pred(pending)) return pending;
      c.stdin.write('\n');
      pending = null;
    }
    return pending;
  };
}

const before = (op, name) => (m) => m.op === op && m.name === name;
const isDone = (m) => m.done;

test('interleaving: a dead reaper\'s guard is removed under its own guard, so a live guard is never deleted', async (t) => {
  const dataDir = path.join(tmpHome(), 'd');
  const dead = deadPid();
  const stale = record(dead);
  writeLock(dataDir, stale);
  fs.writeFileSync(path.join(path.dirname(lockPath(dataDir)), reapName(stale)), record(dead));
  const x = stepper(t, dataDir);
  const y = stepper(t, dataDir);
  // Y has re-read the dead reaper's guard and pauses before deleting it.
  assert.ok(!(await y(before('unlink', reapName(stale)))).done);
  // X tries to get as far as deleting the stale lock.
  await x(before('unlink', 'lock'), 300);
  const results = [(await y(isDone)).done, (await x(isDone)).done].sort();
  assert.deepEqual(results, ['StateLockedError', 'acquired']);
});

test('interleaving: a reaper that judged the lock stale re-checks it before deleting', async (t) => {
  const dataDir = path.join(tmpHome(), 'd');
  const stale = record(deadPid());
  writeLock(dataDir, stale);
  const x = stepper(t, dataDir);
  const y = stepper(t, dataDir);
  // Y has judged the lock stale and pauses before taking the reap guard; X then acquires.
  assert.ok(!(await y(before('create', reapName(stale)))).done);
  assert.equal((await x(isDone)).done, 'acquired');
  assert.equal((await y(isDone)).done, 'StateLockedError');
});

// Workers acquire and release repeatedly while random workers are SIGKILLed and respawned. A holder records its
// pid in a marker file; finding a marker of a live pid means two holders. After each round one fresh process must
// still acquire the lock promptly.
async function killRound(dataDir, { workers = 8, durationMs = 300 } = {}) {
  const marker = path.join(dataDir, 'holder');
  const script = (once) => `
    import fs from 'node:fs';
    import { openState } from ${JSON.stringify(path.join(ROOT, 'src/state.js'))};
    const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
    const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    for (;;) {
      let s;
      try {
        s = openState(${JSON.stringify(dataDir)}, { bffUrl: 'https://bff.example.test', orgId: 'org-1', memberId: 'm-1' });
      } catch (err) {
        if (err.name !== 'StateLockedError') { fs.writeSync(1, 'E' + err.message + '\\n'); process.exit(1); }
        pause(Math.random() * 3);
        continue;
      }
      let prev = null;
      try { prev = Number(fs.readFileSync(${JSON.stringify(marker)}, 'utf8')); } catch {}
      if (prev && prev !== process.pid && alive(prev)) fs.writeSync(1, 'O\\n');
      fs.writeFileSync(${JSON.stringify(marker)}, String(process.pid));
      fs.writeSync(1, 'A\\n');
      pause(Math.random() * 3);
      fs.unlinkSync(${JSON.stringify(marker)});
      s.close();
      if (${once}) process.exit(0);
    }`;
  const env = { ...process.env, OM_MARKETPLACE_CLIENT_TEST_LOCK_DELAY_MS: '1' };
  const stats = { acquired: 0, overlaps: 0, errors: [], kills: 0 };
  const startWorker = (once) => {
    const c = spawn(process.execPath, ['--input-type=module', '-e', script(once)], { env, stdio: ['ignore', 'pipe', 'ignore'] });
    c.exited = new Promise((r) => c.on('exit', r));
    c.stdout.on('data', (d) => {
      for (const line of String(d).split('\n')) {
        if (line === 'A') stats.acquired++;
        else if (line === 'O') stats.overlaps++;
        else if (line) stats.errors.push(line);
      }
    });
    return c;
  };
  const pool = Array.from({ length: workers }, () => startWorker(false));
  const end = Date.now() + durationMs;
  while (Date.now() < end) {
    await new Promise((r) => setTimeout(r, 5 + Math.random() * 20));
    const i = Math.floor(Math.random() * pool.length);
    pool[i].kill('SIGKILL');
    stats.kills++;
    pool[i] = startWorker(false);
  }
  for (const c of pool) c.kill('SIGKILL');
  await Promise.all(pool.map((c) => c.exited));
  const t0 = Date.now();
  const last = startWorker(true);
  stats.lastExit = await last.exited;
  stats.lastMs = Date.now() - t0;
  return stats;
}

test('random SIGKILLs during contention: never two holders, and the lock stays acquirable', async () => {
  const rounds = Number(process.env.LOCK_KILL_ROUNDS) || 2;
  const dataDir = path.join(tmpHome(), 'd');
  fs.mkdirSync(dataDir);
  const total = { acquired: 0, kills: 0, maxLastMs: 0 };
  for (let i = 0; i < rounds; i++) {
    const s = await killRound(dataDir);
    assert.equal(s.overlaps, 0, `round ${i}: two holders`);
    assert.deepEqual(s.errors, [], `round ${i}`);
    assert.equal(s.lastExit, 0, `round ${i}: final acquire failed`);
    total.acquired += s.acquired;
    total.kills += s.kills;
    total.maxLastMs = Math.max(total.maxLastMs, s.lastMs);
  }
  if (process.env.LOCK_KILL_ROUNDS) console.log(JSON.stringify({ rounds, ...total }));
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
