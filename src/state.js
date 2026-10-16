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

// Boot id plus the kernel start time (clock ticks since boot) of pid; null where /proc is not available.
export function processStartId(pid) {
  const stat = readTrim(`/proc/${pid}/stat`);
  if (!stat) return null;
  const starttime = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  if (!/^\d+$/.test(starttime ?? '')) return null;
  return `${readTrim('/proc/sys/kernel/random/boot_id') ?? ''}:${starttime}`;
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

// A lock is stale when its pid is not a live process, is this process (a previous incarnation with the same pid,
// e.g. pid 1 in a container), or now belongs to a process with a different start time. Pids are only meaningful
// within one PID namespace, so a data dir must not be shared between containers.
function lockIsStale({ pid, start }) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid || !pidAlive(pid)) return true;
  const current = start ? processStartId(pid) : null;
  return current !== null && current !== start;
}

function readLockFile(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch (err) { if (err.code === 'ENOENT') return null; throw err; }
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Test-only: a random pause of up to this many ms at each critical step widens the race windows.
function raceDelay() {
  const max = Number(process.env.OM_MARKETPLACE_CLIENT_TEST_LOCK_DELAY_MS);
  if (max > 0) sleepMs(Math.random() * max);
}

function ownerRecord() {
  return JSON.stringify({ pid: process.pid, start: processStartId(process.pid), nonce: crypto.randomBytes(8).toString('hex') });
}

// Creates file with content only if it does not exist. Published via link(2), so it is never seen half-written.
function createExclusive(file, content) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try {
    fs.writeSync(fd, content);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.linkSync(tmp, file);
    return true;
  } catch (err) {
    if (err.code === 'EEXIST') return false;
    throw err;
  } finally {
    fs.unlinkSync(tmp);
  }
}

// Only valid while no one else may replace file: the caller holds it, or holds the guard that serialises its removal.
function unlinkIfContent(file, content) {
  try {
    if (readLockFile(file) === content) fs.unlinkSync(file);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

const BUSY = Symbol('busy');
const RETRY = Symbol('retry');

// Runs fn while holding the exclusive guard file. A guard left by a dead process is removed under a second guard
// (`<guard>.reap`) after re-checking it is unchanged; a reap guard is itself only left behind by a crash inside that
// short removal step, and is then removed if unchanged.
function withGuard(guard, fn) {
  const mine = ownerRecord();
  if (!createExclusive(guard, mine)) {
    const seen = readLockFile(guard);
    if (seen === null) return RETRY;
    if (!lockIsStale(parseLock(seen))) return BUSY;
    const reap = `${guard}.reap`;
    const reaper = ownerRecord();
    if (createExclusive(reap, reaper)) {
      try {
        raceDelay();
        unlinkIfContent(guard, seen);
      } finally {
        unlinkIfContent(reap, reaper);
      }
    } else {
      const reapSeen = readLockFile(reap);
      if (reapSeen !== null && lockIsStale(parseLock(reapSeen))) unlinkIfContent(reap, reapSeen);
    }
    return RETRY;
  }
  try {
    return fn();
  } finally {
    unlinkIfContent(guard, mine);
  }
}

// The lock is created atomically. A stale lock is replaced only under `<lock>.takeover`, and only if it still has
// the exact content (and so the nonce) that was judged stale; another instance's file is never moved or put back.
function acquireLock(file) {
  if (heldLocks.has(file)) throw new StateLockedError(process.pid);
  const content = ownerRecord();
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    if (createExclusive(file, content)) {
      heldLocks.set(file, content);
      return;
    }
    const seen = readLockFile(file);
    if (seen !== null) {
      const owner = parseLock(seen);
      if (!lockIsStale(owner)) throw new StateLockedError(owner.pid);
      raceDelay();
      const r = withGuard(`${file}.takeover`, () => {
        raceDelay();
        const current = readLockFile(file);
        if (current !== null && current !== seen) return RETRY;
        if (current !== null) {
          raceDelay();
          fs.unlinkSync(file);
        }
        raceDelay();
        return createExclusive(file, content);
      });
      if (r === true) {
        heldLocks.set(file, content);
        return;
      }
      if (r === BUSY) sleepMs(5);
    }
    if (Date.now() > deadline) throw new StateError('cannot acquire the state lock');
  }
}

function releaseLock(file) {
  const content = heldLocks.get(file);
  if (content === undefined) return;
  heldLocks.delete(file);
  try { unlinkIfContent(file, content); } catch { /* already gone */ }
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

// State lives under <dataDir>/state/<sha256(bff origin, primary org, member id)>/ so cursors, queues and journals of
// one market environment or agent are never applied to another; an API key rotation keeps them. The lock is per data dir.
export function openState(dataDir, { bffUrl, orgId, memberId, now = Date.now }) {
  const root = path.join(dataDir, 'state');
  ensureDir(dataDir);
  ensureDir(root);
  const lockFile = path.join(root, 'lock');
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
