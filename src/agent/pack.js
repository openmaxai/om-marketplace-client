// Packs a skill directory into the zip the market accepts and checks it with the same rules the install path uses.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { MAX_PACKAGE_BYTES, MAX_PACKAGE_FILES, PackageError, crc32 } from '../pkg/zip.js';
import { inspectPackage } from '../pkg/hygiene.js';
import { SkillPolicyError } from '../pkg/policy.js';
import { validSlug } from '../pkg/frontmatter.js';

// Version-control and OS metadata never belong in a package.
const SKIP = new Set(['.git', '.DS_Store', 'Thumbs.db']);
// Files that usually hold credentials. Their presence refuses the package instead of being skipped, so the author
// moves them out knowingly.
const SECRET_FILE = [/^\.env/i, /\.pem$/i, /\.key$/i, /^id_(rsa|dsa|ecdsa|ed25519)/i, /^\.npmrc$/i, /^\.netrc$/i, /^credentials(\..*)?$/i];
export const isSecretFile = (name) => SECRET_FILE.some((re) => re.test(name));

export class SubmitError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SubmitError';
    this.code = code;
  }
}

// Regular files under dir, as [relative posix path, absolute path], sorted. Links and special files are refused.
export function listFiles(dir) {
  let st;
  try { st = fs.lstatSync(dir); } catch { throw new SubmitError('not_found', `${dir} does not exist`); }
  if (!st.isDirectory()) throw new SubmitError('not_directory', `${dir} is not a directory`);
  const out = [];
  const secrets = [];
  let total = 0;
  const walk = (abs, rel) => {
    for (const d of fs.readdirSync(abs, { withFileTypes: true })) {
      if (SKIP.has(d.name)) continue;
      const a = path.join(abs, d.name);
      const r = rel ? `${rel}/${d.name}` : d.name;
      if (d.isSymbolicLink()) throw new SubmitError('link', `${r} is a symbolic link; copy the file instead`);
      if (d.isDirectory()) walk(a, r);
      else if (d.isFile() && isSecretFile(d.name)) secrets.push(r);
      else if (d.isFile()) {
        total += fs.statSync(a).size;
        if (out.length >= MAX_PACKAGE_FILES) throw new SubmitError('too_many_files', `more than ${MAX_PACKAGE_FILES} files`);
        if (total > MAX_PACKAGE_BYTES) throw new SubmitError('too_large', `files exceed ${MAX_PACKAGE_BYTES} bytes`);
        out.push([r, a]);
      } else throw new SubmitError('special_file', `${r} is not a regular file`);
    }
  };
  walk(dir, '');
  if (secrets.length) {
    const shown = secrets.sort().slice(0, 20).join(', ');
    throw new SubmitError('secret_file', `the directory has files that may hold credentials: ${shown}${secrets.length > 20 ? ', ...' : ''}. Move them out of the skill directory (never package credentials) and submit again`);
  }
  return out.sort((x, y) => Buffer.compare(Buffer.from(x[0]), Buffer.from(y[0])));
}

const u16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b; };
const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); return b; };
// 1980-01-01 00:00 in MS-DOS format, so the same files always give the same bytes.
const DOS_DATE = (0 << 9) | (1 << 5) | 1;

// Deflated regular-file entries, no extra fields, unix mode 0644; reproducible for the same input. File modes are not
// carried: the install path writes every file 0600 whatever the archive says, so a skill runs its scripts through an
// interpreter (`bash scripts/x.sh`, `node x.js`).
export function buildZip(entries) {
  const parts = [];
  const central = [];
  let off = 0;
  for (const { name, data } of entries) {
    const n = Buffer.from(name, 'utf8');
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const [method, payload] = deflated.length < data.length ? [8, deflated] : [0, data];
    const crc = crc32(data);
    const head = [u16(20), u16(0x800), u16(method), u16(0), u16(DOS_DATE), u32(crc), u32(payload.length), u32(data.length), u16(n.length), u16(0)];
    const local = Buffer.concat([u32(0x04034b50), ...head, n, payload]);
    central.push(Buffer.concat([
      u32(0x02014b50), u16((3 << 8) | 20), ...head, u16(0), u16(0), u16(0), u32((0o100644 << 16) >>> 0), u32(off), n,
    ]));
    parts.push(local);
    off += local.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.concat([u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length), u32(cd.length), u32(off), u16(0)]);
  return Buffer.concat([...parts, cd, eocd]);
}

// Returns { zip, meta: {name, description, version}, files }. Throws SubmitError with the reason the market would give.
export function packSkill(dir) {
  const files = listFiles(dir);
  if (!files.some(([r]) => r === 'SKILL.md')) throw new SubmitError('skill_md_missing', 'no SKILL.md at the top of the directory');
  const zip = buildZip(files.map(([name, abs]) => ({ name, data: fs.readFileSync(abs) })));
  if (zip.length > MAX_PACKAGE_BYTES) throw new SubmitError('too_large', `package is ${zip.length} bytes (limit ${MAX_PACKAGE_BYTES})`);
  let meta;
  try {
    ({ meta } = inspectPackage(zip));
  } catch (err) {
    if (err instanceof PackageError) throw new SubmitError(err.reason, `${err.reason}: ${err.detail ?? err.message}`);
    if (err instanceof SkillPolicyError) {
      const v = err.violations.slice(0, 5).map((x) => `${x.code} ${x.file}:${x.line}${x.key ? ` (${x.key})` : ''}`);
      throw new SubmitError('skill_policy', `skill policy: ${v.join('; ')}${err.violations.length > 5 ? '; ...' : ''}`);
    }
    throw err;
  }
  if (!validSlug(meta.name)) {
    throw new SubmitError('skill_md_invalid', `SKILL.md name ${JSON.stringify(meta.name)} is not a valid slug (lowercase letters, digits and hyphens)`);
  }
  return { zip, meta, files: files.map(([r]) => r) };
}
