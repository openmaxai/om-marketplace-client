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

// A lock is stale when its pid is not a live process, is this process (a previous incarnation with the same pid,
// e.g. pid 1 in a container), or now belongs to a process with a different start time.
function lockIsStale({ pid, start }) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid || !pidAlive(pid)) return true;
  const current = start ? processStartId(pid) : null;
  return current !== null && current !== start;
}

function readLockFile(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch (err) { if (err.code === 'ENOENT') return null; throw err; }
}

// The lock is published complete via link(2), so it is never seen half-written. A stale lock is moved aside with
// rename(2); if what was moved is not the lock judged stale, another instance just took it and it is put back.
function acquireLock(file) {
  if (heldLocks.has(file)) throw new StateLockedError(process.pid);
  const content = JSON.stringify({ pid: process.pid, start: processStartId(process.pid), nonce: crypto.randomBytes(8).toString('hex') });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try {
    fs.writeSync(fd, content);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        fs.linkSync(tmp, file);
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
        const seen = readLockFile(file);
        if (seen === null) continue;
        const owner = parseLock(seen);
        if (!lockIsStale(owner)) throw new StateLockedError(owner.pid);
        const aside = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.stale`;
        try {
          fs.renameSync(file, aside);
        } catch (e) {
          if (e.code === 'ENOENT') continue;
          throw e;
        }
        if (readLockFile(aside) !== seen) {
          try { fs.linkSync(aside, file); } catch { /* a third instance holds it now */ }
          fs.unlinkSync(aside);
          throw new StateLockedError(parseLock(readLockFile(file) ?? '').pid);
        }
        fs.unlinkSync(aside);
        continue;
      }
      if (readLockFile(file) !== content) throw new StateLockedError(parseLock(readLockFile(file) ?? '').pid);
      heldLocks.set(file, content);
      return;
    }
    throw new StateError('cannot acquire the state lock');
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* already gone */ }
  }
}

function releaseLock(file) {
  const content = heldLocks.get(file);
  if (content === undefined) return;
  heldLocks.delete(file);
  try {
    if (readLockFile(file) === content) fs.unlinkSync(file);
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
