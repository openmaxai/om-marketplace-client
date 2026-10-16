// Skill package policy from the vendored v1.json: top-level frontmatter key allowlist on every SKILL.md and an inline
// command scan of every .md. Results, codes and their order match the market's CheckSkillPolicy.
import fs from 'node:fs';
import { POLICY_FILE } from '../policy/pin.js';
import { PackageError } from './zip.js';
import { equalFoldAscii } from './paths.js';
import { MAX_SKILL_MD_BYTES, decodeUTF8, frontmatterKeys } from './frontmatter.js';

export const KEY_NOT_ALLOWED = 'SKILL_FRONTMATTER_KEY_NOT_ALLOWED';
export const COMMAND_INJECTION = 'SKILL_COMMAND_INJECTION';
// Not in v1.json; the same caps as the market's.
export const MAX_SKILL_ARGUMENT_NAMES = 64;
export const MAX_SKILL_LINE_BYTES = 1 << 20;

// The rules this client implements; a policy file with other patterns is refused.
export const GENERIC_PLACEHOLDER = /\$(\{[^}]*\}|ARGUMENTS(\[[0-9]+\])?|[0-9]+|[A-Za-z_][A-Za-z0-9_-]*)/g;
const BUILTIN_PLACEHOLDERS = [/\$ARGUMENTS\[[0-9]+\]/g, /\$[0-9]+/g, /\$ARGUMENTS/g];
const ARGUMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Violations sorted by (file bytes, line, code, key), at most max_violations of them.
export class SkillPolicyError extends Error {
  constructor(violations, truncated) {
    const v = violations[0];
    super(`skill policy: ${violations.length} violation(s), first ${v.code} ${v.file}:${v.line}`);
    this.name = 'SkillPolicyError';
    this.violations = violations;
    this.truncated = truncated;
  }
}

const isAscii = (s) => /^[\x20-\x7e]+$/.test(s);

export function loadPolicy(file = POLICY_FILE) {
  const p = JSON.parse(fs.readFileSync(file, 'utf8'));
  const fm = p.frontmatter;
  const inj = p.injection;
  if (p.policy !== 'skill-policy/v1' || inj.placeholder_sigil !== '$' || inj.placeholder_pattern !== GENERIC_PLACEHOLDER.source ||
    JSON.stringify(inj.builtin_placeholder_patterns) !== JSON.stringify(BUILTIN_PLACEHOLDERS.map((re) => re.source)) ||
    fm.argument_name_pattern !== ARGUMENT_NAME.source ||
    !(p.max_violations > 0) || !inj.substrings.every((x) => x.includes(inj.fence_bang)) ||
    !inj.fence_markers.every((m) => m.length > 1 && m === m[0].repeat(m.length)) || ![fm.file_basename, inj.file_extension, ...p.package.forbidden_path_segments].every(isAscii)) {
    throw new Error('skill policy: rules not supported by this client');
  }
  return {
    allowed: new Set(fm.allowed_keys),
    args: { key: fm.arguments_key, pattern: ARGUMENT_NAME, prefixes: fm.argument_name_forbidden_prefixes },
    basename: fm.file_basename,
    extension: inj.file_extension,
    forbidden: p.package.forbidden_path_segments,
    injection: { ...inj, builtin: BUILTIN_PLACEHOLDERS },
    maxViolations: p.max_violations,
    vectors: p.vectors,
  };
}

let loaded;
const policy = () => (loaded ??= loadPolicy());

const byteOrder = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));
const baseName = (p) => p.slice(p.lastIndexOf('/') + 1);
function extName(p) {
  const b = baseName(p);
  const i = b.lastIndexOf('.');
  return i < 0 ? '' : b.slice(i);
}

function longLine(buf) {
  let ln = 1;
  let start = 0;
  for (let i = 0; i <= buf.length; i++) {
    if (i < buf.length && buf[i] !== 10) continue;
    if (i - start > MAX_SKILL_LINE_BYTES) return ln;
    ln++;
    start = i + 1;
  }
  return 0;
}

function lessViolation(a, b) {
  if (a.file !== b.file) return byteOrder(a.file, b.file) < 0;
  if (a.line !== b.line) return a.line < b.line;
  if (a.code !== b.code) return a.code < b.code;
  return a.key < b.key;
}

// Keeps only the smallest max violations so a file with millions of hits stays small.
class ViolationSet {
  constructor(max) {
    this.max = max;
    this.total = 0;
    this.vs = [];
  }

  sort() {
    this.vs.sort((a, b) => (lessViolation(a, b) ? -1 : lessViolation(b, a) ? 1 : 0));
  }

  add(v) {
    this.total++;
    this.vs.push(v);
    if (this.vs.length >= 2 * this.max + 64) {
      this.sort();
      this.vs.length = this.max;
    }
  }

  error() {
    if (this.total === 0) return null;
    this.sort();
    return new SkillPolicyError(this.vs.slice(0, this.max), this.total > this.max);
  }
}

// files: [{ path, content: Buffer }] of one package (only .md content is read). Throws PackageError (forbidden_path or
// skill_md_invalid, with .file set) or SkillPolicyError.
export function checkSkillPolicy(files, rules = policy()) {
  const invalid = (path, msg) => new PackageError('skill_md_invalid', `${path}: ${msg}`, path);
  const sorted = [...files].sort((a, b) => byteOrder(a.path, b.path));
  for (const f of sorted) {
    if (f.path.replace(/\/$/, '').split('/').some((seg) => rules.forbidden.some((bad) => equalFoldAscii(seg, bad)))) {
      throw new PackageError('forbidden_path', `${f.path}: has a forbidden path segment`, f.path);
    }
  }
  const isSkill = (p) => equalFoldAscii(baseName(p), rules.basename);
  const isMD = (p) => equalFoldAscii(extName(p), rules.extension);
  const declared = new Set();
  const texts = new Map();
  const vs = new ViolationSet(rules.maxViolations);
  for (const f of sorted) {
    const md = isMD(f.path);
    if (!md && !isSkill(f.path)) continue;
    const text = decodeUTF8(f.content);
    if (text === null) throw invalid(f.path, 'not UTF-8');
    const nul = f.content.indexOf(0);
    if (nul >= 0) throw invalid(f.path, `NUL byte at offset ${nul} (UTF-16 / UTF-32?)`);
    if (md) {
      const ln = longLine(f.content);
      if (ln > 0) throw invalid(f.path, `line ${ln} is longer than ${MAX_SKILL_LINE_BYTES} bytes`);
      texts.set(f.path, text);
    }
    if (!isSkill(f.path)) continue;
    if (f.content.length > MAX_SKILL_MD_BYTES) throw invalid(f.path, `larger than ${MAX_SKILL_MD_BYTES} bytes`);
    let parsed;
    try {
      parsed = frontmatterKeys(text, rules.args);
    } catch (err) {
      throw invalid(f.path, err.message);
    }
    for (const n of parsed.names) declared.add(n);
    if (declared.size > MAX_SKILL_ARGUMENT_NAMES) {
      throw invalid(f.path, `more than ${MAX_SKILL_ARGUMENT_NAMES} distinct argument names in the package`);
    }
    const seen = new Set();
    for (const k of parsed.keys) {
      if (!rules.allowed.has(k.key) || seen.has(k.key)) vs.add({ code: KEY_NOT_ALLOWED, file: f.path, key: k.key, line: k.line });
      seen.add(k.key);
    }
  }
  const names = [...declared].sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0));
  for (const [path, text] of texts) scanInjections(rules.injection, path, text, names, vs);
  const err = vs.error();
  if (err) throw err;
}

// Line by line (split on \n). Declared names are deleted over the whole text first; names never span lines, so the
// lines of both texts pair up one to one.
function scanInjections(r, path, text, names, vs) {
  let deleted = text;
  for (const n of names) deleted = deleted.replaceAll(r.placeholder_sigil + n, '');
  const same = deleted === text;
  let a = 0;
  let b = 0;
  for (let ln = 1; ; ln++) {
    let i = text.indexOf('\n', a);
    let j = same ? i : deleted.indexOf('\n', b);
    if ((i < 0) !== (j < 0)) throw new PackageError('skill_md_invalid', `${path}: deleting argument names changed the line count`, path);
    const last = i < 0;
    if (last) {
      i = text.length;
      j = deleted.length;
    }
    if (i > a || j > b) {
      const line = text.slice(a, i);
      if (injectionLine(r, line, same ? line : deleted.slice(b, j))) vs.add({ code: COMMAND_INJECTION, file: path, line: ln });
    }
    if (last) return;
    a = i + 1;
    b = j + 1;
  }
}

// line: raw text; s: line with declared argument names deleted. A hit on the raw line, after each deletion step of
// strategy 1 (names, then builtin placeholders), or after strategy 2 (generic placeholders until nothing changes).
export function injectionLine(r, line, s) {
  if (cannotHit(r, line)) return false;
  if (injectionRaw(r, line)) return true;
  if (s !== line && injectionRaw(r, s)) return true;
  let t = s;
  for (const re of r.builtin) t = t.replace(re, '');
  if (t !== s && injectionRaw(r, t)) return true;
  const u = deleteGeneric(line);
  return u !== line && injectionRaw(r, u);
}

// Deleting placeholders only removes characters, so a line without the bang and with fewer characters than any fence
// marker of its kind cannot hit in any form.
function cannotHit(r, line) {
  if (line.includes(r.fence_bang)) return false;
  for (const m of r.fence_markers) {
    let n = 0;
    for (let i = line.indexOf(m[0]); i >= 0 && n < m.length; i = line.indexOf(m[0], i + 1)) n++;
    if (n >= m.length) return false;
  }
  return true;
}

function injectionRaw(r, line) {
  if (r.substrings.some((s) => line.includes(s))) return true;
  for (const m of r.fence_markers) {
    for (let j = line.indexOf(m); j >= 0; j = line.indexOf(m, j + 1)) {
      let k = j + m.length;
      while (k < line.length && r.fence_gap.includes(line[k])) k++;
      if (line.startsWith(r.fence_bang, k) || line.startsWith(r.placeholder_sigil, k)) return true;
    }
  }
  return false;
}

const isDigit = (c) => c >= 0x30 && c <= 0x39;
const isIdentStart = (c) => (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c === 0x5f;
const isIdentPart = (c) => isIdentStart(c) || isDigit(c) || c === 0x2d;
const DOLLAR = 0x24;
const OPEN_BRACE = 0x7b;
const CLOSE_BRACE = 0x7d;
const ARGUMENTS = 'ARGUMENTS';
const DEAD = -2;

// Same result as deleting GENERIC_PLACEHOLDER matches from one line repeatedly until nothing changes, in linear time.
// The line is a linked list of surviving characters. Each pass tries every surviving $ left to right in the pattern's
// branch order; a $ that failed can only match again once a span right after it is deleted, so later passes only retry
// the $ directly left of a deleted span. "First surviving } at or after i" is a union-find over original indices.
export function deleteGeneric(line) {
  const n = line.length;
  let first = -1;
  for (let i = line.indexOf('$'); i >= 0 && i + 1 < n; i = line.indexOf('$', i + 1)) {
    const c = line.charCodeAt(i + 1);
    if (c === OPEN_BRACE || isDigit(c) || isIdentStart(c)) {
      first = i;
      break;
    }
  }
  if (first < 0) return line;
  const next = new Int32Array(n);
  const prev = new Int32Array(n);
  for (let i = 0; i < n; i++) [next[i], prev[i]] = [i + 1, i - 1];
  let head = 0;
  let up = null;
  const findBrace = (i) => {
    if (!up) {
      up = new Int32Array(n + 1);
      up[n] = n;
      for (let j = n - 1; j >= 0; j--) up[j] = line.charCodeAt(j) === CLOSE_BRACE && prev[j] !== DEAD ? j : up[j + 1];
    }
    let r = i;
    while (up[r] !== r) r = up[r];
    while (i !== r) [i, up[i]] = [up[i], r];
    return r;
  };
  const digitsTo = new Map();
  // Index of the last character of the match at the $ at p, or -1.
  const matchAt = (p) => {
    const q = next[p];
    if (q >= n) return -1;
    const c = line.charCodeAt(q);
    if (c === OPEN_BRACE) {
      const b = findBrace(q + 1);
      return b < n ? b : -1;
    }
    let [last, r, k] = [p, q, 0];
    while (k < ARGUMENTS.length && r < n && line.charCodeAt(r) === ARGUMENTS.charCodeAt(k)) [last, r, k] = [r, next[r], k + 1];
    if (k === ARGUMENTS.length) {
      if (r < n && line[r] === '[') {
        let d = digitsTo.get(r) ?? r;
        while (next[d] < n && isDigit(line.charCodeAt(next[d]))) d = next[d];
        digitsTo.set(r, d);
        if (d !== r && next[d] < n && line[next[d]] === ']') return next[d];
      }
      return last;
    }
    const part = isDigit(c) ? isDigit : isIdentStart(c) ? isIdentPart : null;
    if (!part) return -1;
    let e = q;
    while (next[e] < n && part(line.charCodeAt(next[e]))) e = next[e];
    return e;
  };
  let removed = false;
  let later = [];
  const tryAt = (p) => {
    if (prev[p] === DEAD) return;
    const e = matchAt(p);
    if (e < 0) return;
    const [l, r] = [prev[p], next[e]];
    for (let i = p; ; i = next[i]) {
      prev[i] = DEAD;
      if (up && line.charCodeAt(i) === CLOSE_BRACE) up[i] = i + 1;
      if (i === e) break;
    }
    if (l >= 0) next[l] = r;
    else head = r;
    if (r < n) prev[r] = l;
    removed = true;
    if (l >= 0 && line.charCodeAt(l) === DOLLAR && later[later.length - 1] !== l) later.push(l);
  };
  for (let i = first; i >= 0; i = line.indexOf('$', i + 1)) tryAt(i);
  while (later.length) {
    const cands = later;
    later = [];
    for (const p of cands) tryAt(p);
  }
  if (!removed) return line;
  const parts = [];
  for (let i = head; i < n;) {
    let j = i;
    while (j + 1 < n && next[j] === j + 1) j++;
    parts.push(line.slice(i, j + 1));
    i = next[j];
  }
  return parts.join('');
}
