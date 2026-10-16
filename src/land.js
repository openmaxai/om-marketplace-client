import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { InstallFailure } from './failure.js';
import { PackageError } from './pkg/zip.js';
import { SkillPolicyError } from './pkg/policy.js';
import { MAX_SKILL_MD_BYTES } from './pkg/frontmatter.js';

export const MARKER = '.market-managed';
export const SKILL_DIR_PREFIX = 'market--';
const { O_RDONLY, O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW } = fs.constants;

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
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function lstatOrNull(p) {
  try { return fs.lstatSync(p); } catch (err) { if (err.code === 'ENOENT') return null; throw err; }
}

// Reads a regular file without following a final symlink; null when absent, a link, or larger than max.
function readNoFollow(file, max) {
  let fd;
  try {
    fd = fs.openSync(file, O_RDONLY | O_NOFOLLOW);
    const st = fs.fstatSync(fd);
    return st.isFile() && st.size <= max ? fs.readFileSync(fd) : null;
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

// The slug may not be the name of any other local skill directory or of any local SKILL.md. Links are not followed.
function checkNames(skillsDir, slug, own) {
  for (const ent of fs.readdirSync(skillsDir, { withFileTypes: true })) {
    if (ent.name === own) continue;
    if (ent.name.toLowerCase() === slug) throw conflict('name_taken');
    if (ent.isDirectory() && localSkillName(path.join(skillsDir, ent.name, 'SKILL.md')) === slug) throw conflict('name_taken');
  }
}

function writeConfined(root, rel, data) {
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
function scan(root, rel = '', out = []) {
  for (const ent of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const p = rel ? `${rel}/${ent.name}` : ent.name;
    if (ent.isDirectory()) scan(root, p, out);
    else if (!ent.isFile()) throw new InstallFailure('PACKAGE_MISMATCH', 'staged_files_mismatch');
    else {
      const data = readNoFollow(path.join(root, p), Infinity);
      if (!data) throw new InstallFailure('PACKAGE_MISMATCH', 'staged_files_mismatch');
      out.push({ path: p, size: data.length, sha256: sha256(data) });
    }
  }
  return out;
}

function fsyncDir(dir) {
  const fd = fs.openSync(dir, 'r');
  try { fs.fsyncSync(fd); } catch { /* not supported */ } finally { fs.closeSync(fd); }
}

function realDir(dir) {
  const st = lstatOrNull(dir);
  if (!st?.isDirectory()) throw new InstallFailure('CLIENT_INTERNAL', 'skills_dir_invalid');
  return st;
}

// Lands an inspected package as <skillsDir>/market--<slug>/. Every check that needs no disk write runs first; files are
// then written to <stagingRoot>/<requestId>/, re-read and compared with the manifest, marked, and the directory is renamed
// into place. A previous version of the same skill is moved to <rollbackRoot>/<slug>/<version_no>/.
export function landSkill({ skillsDir, stagingRoot, rollbackRoot, requestId, install, inspected }) {
  const { slug, skill_id: skillId, version_no: versionNo, package_sha256: packageSha, file_manifest: want } = install;
  if (skillNameReserved(slug) || skillNameReserved(inspected.meta.name)) throw new InstallFailure('PACKAGE_UNSAFE', 'SKILL_NAME_RESERVED');
  if (inspected.meta.name !== slug) throw new InstallFailure('PACKAGE_MISMATCH', 'skill_name_mismatch');
  if (!sameManifest(inspected.manifest, want)) throw new InstallFailure('PACKAGE_MISMATCH', 'file_manifest_mismatch');
  if (inspected.files.some((f) => f.path === MARKER)) throw new InstallFailure('PACKAGE_UNSAFE', 'reserved_path');
  const skillsSt = realDir(skillsDir);
  const own = `${SKILL_DIR_PREFIX}${slug}`;
  const target = path.join(skillsDir, own);
  const prior = targetState(target, skillId);
  checkNames(skillsDir, slug, own);

  fs.mkdirSync(stagingRoot, { recursive: true, mode: 0o700 });
  if (realDir(stagingRoot).dev !== skillsSt.dev) throw new InstallFailure('CLIENT_INTERNAL', 'staging_other_filesystem');
  const stage = path.join(stagingRoot, requestId);
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage, { mode: 0o700 });
  let previous = null;
  try {
    for (const f of inspected.files) writeConfined(stage, f.path, f.data);
    if (!sameManifest(scan(stage), want)) throw new InstallFailure('PACKAGE_MISMATCH', 'staged_files_mismatch');
    writeConfined(stage, MARKER, JSON.stringify({ skill_id: skillId, version_no: versionNo, package_sha256: packageSha }));
    fsyncDir(stage);
    if (targetState(target, skillId) !== prior) throw conflict('target_changed');
    if (prior === 'ours') {
      let oldNo = 'unknown';
      try { oldNo = String(JSON.parse(readNoFollow(path.join(target, MARKER), 4096)).version_no); } catch { /* kept as unknown */ }
      const slot = path.join(rollbackRoot, slug);
      fs.mkdirSync(slot, { recursive: true, mode: 0o700 });
      realDir(slot);
      previous = path.join(slot, /^\d+$/.test(oldNo) ? oldNo : 'unknown');
      fs.rmSync(previous, { recursive: true, force: true });
      fs.renameSync(target, previous);
    }
    try {
      fs.renameSync(stage, target);
    } catch (err) {
      if (previous) fs.renameSync(previous, target);
      throw err;
    }
    fsyncDir(skillsDir);
    return { dir: target, previous };
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}
