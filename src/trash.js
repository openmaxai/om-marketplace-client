import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { InstallFailure } from './failure.js';

export function fsyncDir(dir) {
  let fd;
  try {
    fd = fs.openSync(dir, 'r');
    fs.fsyncSync(fd);
  } catch { /* not supported, or already gone */ } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// Removes dir without ever leaving part of it in place: it is renamed into trashRoot (same filesystem, so the rename is
// atomic) and only then deleted. A crash in between leaves it in the trash, which emptyTrash clears at startup. The
// rename is the commit point: with onLeft, a delete failing with a filesystem error is passed to it instead of thrown.
export function discard(dir, trashRoot, onLeft = null) {
  let st;
  try { st = fs.lstatSync(dir); } catch (err) { if (err.code === 'ENOENT') return false; throw err; }
  fs.mkdirSync(trashRoot, { recursive: true, mode: 0o700 });
  const root = fs.lstatSync(trashRoot);
  if (!root.isDirectory() || root.dev !== st.dev) throw new InstallFailure('CLIENT_INTERNAL', 'trash_other_filesystem');
  const bin = path.join(trashRoot, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}`);
  fs.renameSync(dir, bin);
  fsyncDir(path.dirname(dir));
  fsyncDir(trashRoot);
  try {
    fs.rmSync(bin, { recursive: true, force: true });
  } catch (err) {
    if (!onLeft || typeof err?.code !== 'string') throw err;
    onLeft(bin, err);
  }
  return true;
}

export const TRASH_ALERT = 'trash_left';

// An onLeft for discard: the copy stays in the trash until emptyTrash at the next start, with an alert meanwhile.
export const leftInTrash = (state, logger) => (bin, err) => {
  logger.warn(`${bin} could not be deleted (${err.code ?? err.message}); it is removed at the next start`);
  state.setAlert(TRASH_ALERT, 'entries in the trash could not be deleted; they are removed at the next start');
};

// Deletes everything under dir; for areas nothing else can see (trash, staging). dir itself must be a real directory, so a
// link is never followed. Returns how many entries could not be removed.
export function emptyTrash(dir) {
  let names;
  try {
    if (!fs.lstatSync(dir).isDirectory()) return 0;
    names = fs.readdirSync(dir);
  } catch { return 0; }
  let left = 0;
  for (const n of names) {
    try { fs.rmSync(path.join(dir, n), { recursive: true, force: true }); } catch { left += 1; }
  }
  return left;
}
