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

// O_EXCL lock file holding the owner's pid; a lock left by a dead process is taken over.
function acquireLock(file) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      fs.writeSync(fd, `${process.pid}\n`);
      fs.closeSync(fd);
      return;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    const pid = Number.parseInt(fs.readFileSync(file, 'utf8'), 10);
    if (Number.isSafeInteger(pid) && pid > 0 && pidAlive(pid)) throw new StateLockedError(pid);
    fs.unlinkSync(file);
  }
  throw new StateError('cannot acquire the state lock');
}

function releaseLock(file) {
  try {
    if (Number.parseInt(fs.readFileSync(file, 'utf8'), 10) === process.pid) fs.unlinkSync(file);
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
