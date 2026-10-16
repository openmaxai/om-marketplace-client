import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { InstallFailure } from './failure.js';
import { PackageError } from './pkg/zip.js';
import { SkillPolicyError } from './pkg/policy.js';
import { MAX_SKILL_MD_BYTES } from './pkg/frontmatter.js';
import { discard, fsyncDir } from './trash.js';

export const MARKER = '.market-managed';
export const SKILL_DIR_PREFIX = 'market--';
const { O_RDONLY, O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW, O_NONBLOCK } = fs.constants;

// The market's config/reserved-skill-names.txt; names starting with zylos- or market- are reserved too.
export const RESERVED_SKILL_NAMES = new Set([
  'activity-monitor', 'audio-gateway', 'botshub', 'browser', 'check-context', 'clawvita', 'comm-bridge',
  'component-management', 'create-skill', 'dashboard', 'doccraft', 'health-check', 'http', 'hxa-link', 'lark', 'ms-teams',
  'new-session', 'openmax', 'openmax-kb', 'restart-claude', 'scheduler', 'shell', 'telegram', 'thinking-patterns',
  'upgrade-claude', 'web-console', 'wechat', 'wecom', 'whatsapp', 'zylos-memory', 'zylos', 'market', 'agent-market',
  'market-client',
]);

export function skillNameReserved(name) {
  const n = name.toLowerCase();
  return RESERVED_SKILL_NAMES.has(n) || n.startsWith('zylos-') || n.startsWith('market-');
}

// Maps any landing-pipeline error to what C-06 reports.
export function failureFor(err) {
  if (err instanceof InstallFailure) return err;
  if (err instanceof PackageError) return new InstallFailure('PACKAGE_UNSAFE', err.reason);
  if (err instanceof SkillPolicyError) return new InstallFailure('PACKAGE_UNSAFE', `${err.violations[0].code} at line ${err.violations[0].line}`);
  return new InstallFailure('CLIENT_INTERNAL', 'client internal error');
}

const conflict = (why) => new InstallFailure('INSTALL_TARGET_CONFLICT', why);
const stagedMismatch = () => new InstallFailure('CLIENT_INTERNAL', 'staged_files_mismatch');
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function lstatOrNull(p) {
  try { return fs.lstatSync(p); } catch (err) { if (err.code === 'ENOENT') return null; throw err; }
}

// At most max bytes from fd, or null when there are more: the file may grow after fstat.
function readCapped(fd, max) {
  if (max === Infinity) return fs.readFileSync(fd);
  const buf = Buffer.alloc(max + 1);
  let n = 0;
  while (n < buf.length) {
    const got = fs.readSync(fd, buf, n, buf.length - n, null);
    if (got === 0) break;
    n += got;
  }
  return n > max ? null : buf.subarray(0, n);
}

// Reads a regular file without following a final symlink; null when absent, a link, not a regular file, or larger than
// max. O_NONBLOCK keeps a FIFO from blocking the open.
function readNoFollow(file, max) {
  let fd;
  try {
    fd = fs.openSync(file, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    const st = fs.fstatSync(fd);
    return st.isFile() && st.size <= max ? readCapped(fd, max) : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function sameManifest(got, want) {
  if (got.length !== want.length) return false;
  const byPath = new Map(want.map((e) => [e.path, e]));
  return got.every((e) => byPath.get(e.path)?.size === e.size && byPath.get(e.path).sha256 === e.sha256);
}

// The name: value of a local SKILL.md frontmatter, read leniently.
function localSkillName(file) {
  const raw = readNoFollow(file, MAX_SKILL_MD_BYTES);
  const m = raw && /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw.toString('utf8'));
  const line = m && /^name:[ \t]*(.*?)[ \t]*$/m.exec(m[1]);
  return line ? line[1].replace(/^(['"])(.*)\1$/, '$2').toLowerCase() : null;
}

// absent, or ours: a real directory whose marker names this skill. Anything else is a conflict.
function targetState(target, skillId) {
  const st = lstatOrNull(target);
  if (!st) return 'absent';
  if (!st.isDirectory()) throw conflict('target_exists');
  let marker = null;
  try { marker = JSON.parse(readNoFollow(path.join(target, MARKER), 4096)); } catch { /* unreadable */ }
  if (marker?.skill_id !== skillId) throw conflict('target_exists');
  return 'ours';
}

// The stat of a directory, or of what a link resolves to when that is a directory: local tools load linked skills, so
// their names count. null for dangling and unreadable links and links to anything else, compared by entry name only.
function skillDirStat(dir, ent) {
  if (!ent.isDirectory() && !ent.isSymbolicLink()) return null;
  try {
    const st = fs.statSync(dir);
    return st.isDirectory() ? st : null;
  } catch {
    return null;
  }
}

// The slug may not be the name of any other local skill directory or of any local SKILL.md. Linked skills are only read;
// SKILL.md itself is opened without following a final link. A link that resolves to our own target is an alias of this
// skill, not another one.
function checkNames(skillsDir, slug, own) {
  const ownSt = lstatOrNull(path.join(skillsDir, own));
  for (const ent of fs.readdirSync(skillsDir, { withFileTypes: true })) {
    if (ent.name === own) continue;
    if (ent.name.toLowerCase() === slug) throw conflict('name_taken');
    const dir = path.join(skillsDir, ent.name);
    const st = skillDirStat(dir, ent);
    if (!st || (ownSt && st.dev === ownSt.dev && st.ino === ownSt.ino)) continue;
    if (localSkillName(path.join(dir, 'SKILL.md')) === slug) throw conflict('name_taken');
  }
}

export function writeConfined(root, rel, data) {
  const segs = rel.split('/');
  if (segs.some((s) => s === '' || s === '.' || s === '..')) throw new InstallFailure('CLIENT_INTERNAL', 'client internal error');
  let dir = root;
  for (const seg of segs.slice(0, -1)) {
    dir = path.join(dir, seg);
    try { fs.mkdirSync(dir, { mode: 0o700 }); } catch (err) { if (err.code !== 'EEXIST') throw err; }
    if (!fs.lstatSync(dir).isDirectory()) throw new InstallFailure('PACKAGE_UNSAFE', 'link');
  }
  const file = path.join(dir, segs.at(-1));
  if (!file.startsWith(root + path.sep)) throw new InstallFailure('CLIENT_INTERNAL', 'client internal error');
  const fd = fs.openSync(file, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600);
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

// Manifest of what is on disk under root; any link or special file fails.
export function scan(root, rel = '', out = []) {
  for (const ent of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const p = rel ? `${rel}/${ent.name}` : ent.name;
    if (ent.isDirectory()) scan(root, p, out);
    else if (!ent.isFile()) throw stagedMismatch();
    else {
      const data = readNoFollow(path.join(root, p), Infinity);
      if (!data) throw stagedMismatch();
      out.push({ path: p, size: data.length, sha256: sha256(data) });
    }
  }
  return out;
}

function realDir(dir) {
  const st = lstatOrNull(dir);
  if (!st?.isDirectory()) throw new InstallFailure('CLIENT_INTERNAL', 'skills_dir_invalid');
  return st;
}

// Lands an inspected package as <targetRoot>/market--<slug>/ (targetRoot is skillsDir, or the disabled area for a disabled
// skill). Every check that needs no disk write runs first; files are then written to <stagingRoot>/<requestId>/, re-read and
// compared with the manifest, marked, and the directory is renamed into place. A previous version of the same skill is moved
// to <rollbackRoot>/<slug>/<version_no>/. Directories are only ever replaced by renames; what is removed goes through trashRoot.
export function landSkill({ skillsDir, targetRoot = skillsDir, stagingRoot, rollbackRoot, trashRoot = path.join(path.dirname(stagingRoot), 'trash'), requestId, install, inspected }) {
  const { slug, skill_id: skillId, version_no: versionNo, package_sha256: packageSha, file_manifest: want } = install;
  if (skillNameReserved(slug) || skillNameReserved(inspected.meta.name)) throw new InstallFailure('PACKAGE_UNSAFE', 'SKILL_NAME_RESERVED');
  if (inspected.meta.name !== slug) throw new InstallFailure('PACKAGE_MISMATCH', 'skill_name_mismatch');
  if (!sameManifest(inspected.manifest, want)) throw new InstallFailure('PACKAGE_MISMATCH', 'file_manifest_mismatch');
  if (inspected.files.some((f) => f.path === MARKER)) throw new InstallFailure('PACKAGE_UNSAFE', 'reserved_path');
  realDir(skillsDir);
  const rootSt = realDir(targetRoot);
  const own = `${SKILL_DIR_PREFIX}${slug}`;
  const target = path.join(targetRoot, own);
  const prior = targetState(target, skillId);
  // A disabled skill is moved back to skillsDir when enabled, so its name there must be free or ours too.
  if (targetRoot !== skillsDir) targetState(path.join(skillsDir, own), skillId);
  checkNames(skillsDir, slug, own);

  fs.mkdirSync(stagingRoot, { recursive: true, mode: 0o700 });
  if (realDir(stagingRoot).dev !== rootSt.dev) throw new InstallFailure('CLIENT_INTERNAL', 'staging_other_filesystem');
  const stage = path.join(stagingRoot, requestId);
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage, { mode: 0o700 });
  let previous = null;
  try {
    for (const f of inspected.files) writeConfined(stage, f.path, f.data);
    if (!sameManifest(scan(stage), want)) throw stagedMismatch();
    writeConfined(stage, MARKER, JSON.stringify({ skill_id: skillId, version_no: versionNo, package_sha256: packageSha }));
    fsyncDir(stage);
    if (prior === 'ours') {
      let oldNo = 'unknown';
      try { oldNo = String(JSON.parse(readNoFollow(path.join(target, MARKER), 4096)).version_no); } catch { /* kept as unknown */ }
      const slot = path.join(rollbackRoot, slug);
      fs.mkdirSync(slot, { recursive: true, mode: 0o700 });
      realDir(slot);
      previous = path.join(slot, /^\d+$/.test(oldNo) ? oldNo : 'unknown');
      discard(previous, trashRoot);
    }
    // Last check, kept as close to the renames as possible.
    if (targetState(target, skillId) !== prior) throw conflict('target_changed');
    if (previous) {
      fs.renameSync(target, previous);
      fsyncDir(path.dirname(previous));
    }
    try {
      // rename(2) has no no-replace mode here. On Linux it replaces only an empty directory; a non-empty one fails with
      // ENOTEMPTY and a file or symlink with ENOTDIR. Only the owner of skillsDir can create an entry there, so a racing
      // empty directory does not cross a privilege boundary and no data is lost.
      fs.renameSync(stage, target);
    } catch (err) {
      if (previous) fs.renameSync(previous, target);
      throw err;
    }
    fsyncDir(targetRoot);
    return { dir: target, previous };
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}
