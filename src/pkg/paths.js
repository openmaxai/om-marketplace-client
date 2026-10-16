// Entry path rules and name-collision checks for skill packages, in the server's order.
import { MAX_PACKAGE_FILES, PackageError } from './zip.js';

export const MAX_PATH_BYTES = 1024;
export const MAX_SEGMENT_BYTES = 255;
const FORBIDDEN_SEGMENTS = ['.claude'];

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const isControl = (cp) => cp < 0x20 || (cp >= 0x7f && cp <= 0x9f);

// Relative path, no `..`, no backslash, colon or control character, every segment non-empty and not `.`.
export function checkEntryPath(nameBytes) {
  let name = null;
  try {
    name = utf8.decode(nameBytes);
  } catch { /* reported below */ }
  if (!nameBytes.length || name === null) throw new PackageError('invalid_path', 'empty or non-UTF-8 name');
  if (nameBytes.length > MAX_PATH_BYTES) throw new PackageError('invalid_path', `name longer than ${MAX_PATH_BYTES} bytes`);
  if (nameBytes[0] === 0x2f || nameBytes[0] === 0x5c || nameBytes[1] === 0x3a) {
    throw new PackageError('absolute_path', `absolute path ${JSON.stringify(name)}`);
  }
  for (const ch of name) {
    const cp = ch.codePointAt(0);
    if (ch === '\\' || ch === ':' || isControl(cp) || cp === 0xfffd) {
      throw new PackageError('invalid_path', `name ${JSON.stringify(name)} has a forbidden character`);
    }
  }
  const segs = trimSlash(name).split('/');
  if (segs.includes('..')) throw new PackageError('path_traversal', `path ${JSON.stringify(name)} leaves the package`);
  for (const s of segs) {
    if (s === '' || s === '.' || Buffer.byteLength(s) > MAX_SEGMENT_BYTES) {
      throw new PackageError('invalid_path', `path ${JSON.stringify(name)} has an empty, '.' or overlong segment`);
    }
  }
  return name;
}

const trimSlash = (p) => (p.endsWith('/') ? p.slice(0, -1) : p);

// Matches Go strings.EqualFold for the policy's ASCII segment.
export function hasForbiddenSegment(p) {
  return trimSlash(p).split('/').some((s) => FORBIDDEN_SEGMENTS.includes(s.toLowerCase()));
}

// Full Unicode case folding of one code point, as Go cases.Fold does it: dotless i does not fold outside Turkic locales,
// and Cherokee letters never compare equal to their other case.
const noFold = (c) => c === '\u0131' || (c >= '\u13a0' && c <= '\u13fd') || (c >= '\uab70' && c <= '\uabbf');
const foldCache = new Map();
function foldChar(c) {
  let out = foldCache.get(c);
  if (out !== undefined) return out;
  out = c;
  if (noFold(c)) return out;
  for (;;) {
    const next = [...out].map((x) => (noFold(x) ? x : x.toUpperCase().toLowerCase())).join('');
    if (next === out) break;
    out = next;
  }
  foldCache.set(c, out);
  return out;
}

// Comparison form for "differs only by case or normalization": NFC, then full case folding.
export function canonSegment(seg) {
  let out = '';
  for (const c of seg.normalize('NFC')) out += foldChar(c);
  return out;
}

const byteOrder = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));

// Tracks every entry name: exact and canonical duplicates, one spelling per directory, file/directory clashes and
// forbidden segments. Directories are a tree keyed by (parent id, canonical segment) so cost stays linear in path length.
export class PathIndex {
  #seen = new Set();
  #folded = new Map();
  #dirs = new Map();
  #dirRaw = [];
  #fileCanon = [];
  #forbidden = null;

  add(e) {
    const clean = trimSlash(e.name);
    if (hasForbiddenSegment(clean) && (this.#forbidden === null || byteOrder(clean, this.#forbidden) < 0)) {
      this.#forbidden = clean;
    }
    if (this.#seen.has(clean)) throw new PackageError('invalid_path', `duplicate entry ${JSON.stringify(e.name)}`);
    const raw = clean.split('/');
    const canon = raw.map(canonSegment);
    const key = canon.join('/');
    const prev = this.#folded.get(key);
    if (prev !== undefined) {
      throw new PackageError('invalid_path', `entries ${JSON.stringify(prev)} and ${JSON.stringify(e.name)} differ only by case or normalization`);
    }
    this.#seen.add(clean);
    this.#folded.set(key, e.name);
    const levels = raw.length - (e.isDir ? 0 : 1);
    let parent = -1;
    let k = 0;
    for (; k < levels; k++) {
      const id = this.#dirs.get(`${parent}/${canon[k]}`);
      if (id === undefined) break;
      if (this.#dirRaw[id] !== raw[k]) {
        throw new PackageError('invalid_path', `directory ${JSON.stringify(raw.slice(0, k + 1).join('/'))} has two spellings`);
      }
      parent = id;
    }
    for (; k < levels; k++) {
      const id = this.#dirRaw.push(raw[k]) - 1;
      this.#dirs.set(`${parent}/${canon[k]}`, id);
      parent = id;
    }
    if (!e.isDir) this.#fileCanon.push([e.name, canon]);
  }

  // Runs once the whole central directory was added.
  finish(files) {
    if (this.#forbidden !== null) {
      throw new PackageError('forbidden_path', `${JSON.stringify(this.#forbidden)} has a forbidden path segment`);
    }
    if (files.length > MAX_PACKAGE_FILES) throw new PackageError('too_many_files', `${files.length} files`);
    for (const [name, canon] of this.#fileCanon) {
      let id = -1;
      for (const c of canon) {
        id = this.#dirs.get(`${id}/${c}`);
        if (id === undefined) break;
      }
      if (id !== undefined) throw new PackageError('invalid_path', `${JSON.stringify(name)} is both a file and a directory`);
    }
  }
}
