import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isCanonicalUuid } from './ids.js';

const NAME_RE = /^[a-z][a-z0-9_-]{0,63}$/;

export class StateError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StateError';
  }
}

export class StateLockedError extends StateError {
  constructor(pid) {
    super(`another instance (pid ${pid}) holds the state lock`);
    this.name = 'StateLockedError';
    this.pid = pid;
  }
}

export function sha256Hex(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = fs.lstatSync(dir);
  if (!st.isDirectory()) throw new StateError(`${dir} is not a directory`);
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) throw new StateError(`${dir} is not owned by the current user`);
  if ((st.mode & 0o077) !== 0) fs.chmodSync(dir, 0o700);
}

function fsyncDir(dir) {
  let fd;
  try {
    fd = fs.openSync(dir, 'r');
    fs.fsyncSync(fd);
  } catch { /* not supported on this platform */ } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// tmp + fsync + rename + directory fsync, mode 0600.
export function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    const fd = fs.openSync(tmp, 'wx', 0o600);
    try {
      fs.writeSync(fd, JSON.stringify(value));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* not created */ }
    throw err;
  }
  fsyncDir(path.dirname(file));
}

// Missing file -> fallback; a symlink, non-file or unparsable file fails closed.
export function readJson(file, fallback) {
  let st;
  try {
    st = fs.lstatSync(file);
  } catch (err) {
    if (err.code === 'ENOENT') return structuredClone(fallback);
    throw err;
  }
  if (!st.isFile()) throw new StateError(`${file} is not a regular file`);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new StateError(`${file} is not valid JSON`);
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function readTrim(file) {
  try { return fs.readFileSync(file, 'utf8').trim(); } catch { return null; }
}

// Boot id plus the kernel start time (clock ticks since boot) of pid; null when either is unknown.
export function processStartId(pid) {
  const stat = readTrim(`/proc/${pid}/stat`);
  if (!stat) return null;
  const starttime = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  if (!/^\d+$/.test(starttime ?? '')) return null;
  const bootId = readTrim('/proc/sys/kernel/random/boot_id');
  if (!bootId) return null;
  return `${bootId}:${starttime}`;
}

function parseLock(text) {
  try {
    const o = JSON.parse(text);
    if (o && typeof o === 'object') return { pid: o.pid, start: typeof o.start === 'string' ? o.start : null };
  } catch { /* older plain-pid format */ }
  return { pid: Number.parseInt(text, 10), start: null };
}

const heldLocks = new Map();
const LOCK_WAIT_MS = 10000;

// A lock or guard is stale when its pid is not a live process, is this process (a previous incarnation with the
// same pid, e.g. pid 1 in a container), or now belongs to a process with a different start time. A live pid whose
// start time is unknown on either side counts as live. Pids are only meaningful within one PID namespace, so a data
// dir must not be shared between containers.
function lockIsStale({ pid, start }) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid || !pidAlive(pid)) return true;
  const current = start ? hooks.startId(pid) : null;
  return current !== null && current !== start;
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Test seam: test/fake/lock-hooks.js replaces these; production never does.
const hooks = { step: () => {}, startId: (pid) => processStartId(pid) };
export function setLockHooks(h) {
  Object.assign(hooks, h);
}

function readLockFile(file) {
  hooks.step('read', file);
  try { return fs.readFileSync(file, 'utf8'); } catch (err) { if (err.code === 'ENOENT') return null; throw err; }
}

function unlinkFile(file) {
  hooks.step('unlink', file);
  try { fs.unlinkSync(file); } catch (err) { if (err.code !== 'ENOENT') throw err; }
}

function ownerRecord() {
  return JSON.stringify({ pid: process.pid, start: hooks.startId(process.pid), nonce: crypto.randomBytes(8).toString('hex') });
}

const TMP_RE = /\.tmp-(\d+)-[0-9a-f]{8}$/;

// Creates file with content only if it does not exist. Published via link(2), so it is never seen half-written.
// A temp file left by a crash here is removed by sweepLockDir.
function createExclusive(file, content) {
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try {
    try {
      fs.writeSync(fd, content);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    hooks.step('create', file);
    fs.linkSync(tmp, file);
    return true;
  } catch (err) {
    if (err.code === 'EEXIST') return false;
    throw err;
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* left to sweepLockDir */ }
  }
}

const REMOVED = Symbol('removed');
const BUSY = Symbol('busy');
const RETRY = Symbol('retry');
const MAX_NAME = 200;

// Removes file only if it still has content `seen`, which the caller judged stale. The check and the unlink run
// while holding `<file>.reap-<sha256(seen)[:16]>`, created exclusively. Every record carries a fresh nonce, so a
// given content never recurs: all processes removing the same stale content contend on one name, and no one can
// delete a file that was replaced after it was judged. A guard left by a dead reaper is removed the same way, one
// level down.
function removeStale(file, seen) {
  const reap = `${file}.reap-${sha256Hex(seen).slice(0, 16)}`;
  if (path.basename(reap).length > MAX_NAME) return BUSY;
  const mine = ownerRecord();
  if (createExclusive(reap, mine)) {
    try {
      if (readLockFile(file) === seen) unlinkFile(file);
    } finally {
      if (readLockFile(reap) === mine) unlinkFile(reap);
    }
    return REMOVED;
  }
  const other = readLockFile(reap);
  if (other === null) return RETRY;
  if (!lockIsStale(parseLock(other))) return BUSY;
  removeStale(reap, other);
  return RETRY;
}

// Run by the lock holder: removes reap guards and temp files left by crashed processes so they cannot accumulate.
function sweepLockDir(file) {
  const dir = path.dirname(file);
  const prefix = `${path.basename(file)}.`;
  let names;
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const p = path.join(dir, name);
    try {
      const tmp = TMP_RE.exec(name);
      if (tmp) {
        const pid = Number(tmp[1]);
        if (pid === process.pid || !pidAlive(pid)) unlinkFile(p);
        continue;
      }
      const content = readLockFile(p);
      if (content !== null && lockIsStale(parseLock(content))) removeStale(p, content);
    } catch { /* best effort; retried on the next acquisition */ }
  }
}

// The lock is created atomically; a stale lock is removed only by removeStale and then contended for again.
function acquireLock(file) {
  if (heldLocks.has(file)) throw new StateLockedError(process.pid);
  const content = ownerRecord();
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    if (createExclusive(file, content)) {
      heldLocks.set(file, content);
      sweepLockDir(file);
      return;
    }
    const seen = readLockFile(file);
    let r = RETRY;
    if (seen !== null) {
      const owner = parseLock(seen);
      if (!lockIsStale(owner)) throw new StateLockedError(owner.pid);
      r = removeStale(file, seen);
    }
    if (Date.now() > deadline) throw new StateError('cannot acquire the state lock');
    if (r !== REMOVED) sleepMs(r === BUSY ? 5 : 1);
  }
}

function releaseLock(file) {
  const content = heldLocks.get(file);
  if (content === undefined) return;
  heldLocks.delete(file);
  try {
    if (readLockFile(file) === content) unlinkFile(file);
  } catch { /* already gone */ }
}

// One JSON document per id under <dir>/<id>.json; ids are client-generated canonical UUIDs.
function collection(dir) {
  const file = (id) => {
    if (!isCanonicalUuid(id)) throw new TypeError('record id must be a lowercase canonical UUID');
    return path.join(dir, `${id}.json`);
  };
  return {
    put(id, record) {
      ensureDir(dir);
      writeJsonAtomic(file(id), record);
    },
    get: (id) => readJson(file(id), null),
    remove(id) {
      try { fs.unlinkSync(file(id)); } catch (err) { if (err.code !== 'ENOENT') throw err; }
      fsyncDir(dir);
    },
    // Moves an unreadable entry to <state dir>/corrupt/ so it stops being read; it is kept for inspection.
    quarantine(id) {
      const aside = path.join(path.dirname(dir), 'corrupt');
      ensureDir(aside);
      const to = path.join(aside, `${path.basename(dir)}-${id}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.json`);
      try { fs.renameSync(file(id), to); } catch (err) { if (err.code !== 'ENOENT') throw err; }
      fsyncDir(dir);
      fsyncDir(aside);
    },
    list() {
      let names;
      try { names = fs.readdirSync(dir); } catch (err) { if (err.code === 'ENOENT') return []; throw err; }
      return names.filter((n) => n.endsWith('.json') && isCanonicalUuid(n.slice(0, -5))).map((n) => n.slice(0, -5)).sort();
    },
  };
}

export function stateScope(bffUrl, orgId, memberId) {
  return sha256Hex([new URL(bffUrl).origin, orgId, memberId].join('\n'));
}

const lockPath = (dataDir) => path.join(fs.realpathSync(path.join(dataDir, 'state')), 'lock');

// The pid holding the data dir's state lock, read once, only when that process is provably the one that took it: its
// recorded start id is known and equals the pid's current one. Null otherwise (no lock, unknown start, pid reused,
// this process, or pid 1).
export function verifiedLockHolder(dataDir) {
  let text;
  try { text = fs.readFileSync(lockPath(dataDir), 'utf8'); } catch { return null; }
  const { pid, start } = parseLock(text);
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid || !start) return null;
  return hooks.startId(pid) === start ? pid : null;
}

// Takes the data dir's state lock without opening a state scope; returns its release function. Throws
// StateLockedError while a live process holds it.
export function lockDataDir(dataDir) {
  ensureDir(dataDir);
  ensureDir(path.join(dataDir, 'state'));
  const file = lockPath(dataDir);
  acquireLock(file);
  return () => releaseLock(file);
}

// State lives under <dataDir>/state/<sha256(bff origin, primary org, member id)>/ so cursors, queues and journals of
// one market environment or agent are never applied to another; an API key rotation keeps them. The lock is per data dir.
export function openState(dataDir, { bffUrl, orgId, memberId, now = Date.now }) {
  const root = path.join(dataDir, 'state');
  ensureDir(dataDir);
  ensureDir(root);
  // Keyed by real path, so one process opening the data dir through another path does not take its own lock.
  const lockFile = path.join(fs.realpathSync(root), 'lock');
  acquireLock(lockFile);
  const dir = path.join(root, stateScope(bffUrl, orgId, memberId));
  try {
    ensureDir(dir);
  } catch (err) {
    releaseLock(lockFile);
    throw err;
  }
  const docPath = (name) => {
    if (!NAME_RE.test(name)) throw new TypeError('invalid state document name');
    return path.join(dir, `${name}.json`);
  };
  const read = (name, fallback) => readJson(docPath(name), fallback);
  const write = (name, value) => writeJsonAtomic(docPath(name), value);
  const update = (name, fallback, fn) => {
    const doc = read(name, fallback);
    const next = fn(doc) ?? doc;
    write(name, next);
    return next;
  };
  const EMPTY_STATUS = { alerts: {}, runs: {} };
  const iso = () => new Date(now()).toISOString();

  return {
    dir,
    read,
    write,
    update,
    journal: collection(path.join(dir, 'requests')),
    outbox: collection(path.join(dir, 'outbox')),
    // Alerts persist in status.json until cleared; returns true when the alert is new.
    setAlert(key, message) {
      let added = false;
      update('status', EMPTY_STATUS, (s) => {
        added = !s.alerts[key];
        s.alerts[key] = { message, since: s.alerts[key]?.since ?? iso(), updated_at: iso() };
      });
      return added;
    },
    clearAlert(key) {
      if (!read('status', EMPTY_STATUS).alerts[key]) return;
      update('status', EMPTY_STATUS, (s) => { delete s.alerts[key]; });
    },
    recordRun(name, outcome) {
      update('status', EMPTY_STATUS, (s) => { s.runs[name] = { outcome, at: iso() }; });
    },
    close: () => releaseLock(lockFile),
  };
}
