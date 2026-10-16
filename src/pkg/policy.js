// Skill package policy from the vendored v1.json: top-level frontmatter key allowlist on every SKILL.md and an inline
// command scan of every .md. Results, codes and their order match the market's CheckSkillPolicy.
import { POLICY_FILE, POLICY_SHA256, readPinnedPolicy } from '../policy/pin.js';
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
export const BUILTIN_PLACEHOLDERS = [/\$ARGUMENTS\[[0-9]+\]/g, /\$[0-9]+/g, /\$ARGUMENTS/g];
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

// Parses the same bytes whose hash was checked against pin.
export function loadPolicy(file = POLICY_FILE, pin = POLICY_SHA256) {
  const p = JSON.parse(readPinnedPolicy(file, pin).toString('utf8'));
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
    injection: inj,
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

// Line by line (split on \n). Only lines that can hit need declared names deleted, and only those with the sigil
// directly before a possible name's first character; those are deleted in batches joined by \n (names never contain \n,
// so this equals deleting per line).
const NAME_START = /\$[A-Za-z_]/;
const NAME_BATCH_CHARS = 256 << 10;

function scanInjections(r, path, text, names, vs) {
  let batch = [];
  let batchLines = [];
  let batchChars = 0;
  const flush = () => {
    let joined = batch.join('\n');
    for (const n of names) {
      const p = r.placeholder_sigil + n;
      if (joined.includes(p)) joined = joined.replaceAll(p, '');
    }
    const deleted = joined.split('\n');
    if (deleted.length !== batch.length) throw new PackageError('skill_md_invalid', `${path}: deleting argument names changed the line count`, path);
    for (let k = 0; k < batch.length; k++) {
      if (injectionLine(r, batch[k], deleted[k])) vs.add({ code: COMMAND_INJECTION, file: path, line: batchLines[k] });
    }
    [batch, batchLines, batchChars] = [[], [], 0];
  };
  // cannotHit holds for a line without any of these characters, so only lines containing one are visited.
  const triggers = [...new Set([r.fence_bang, ...r.fence_markers.map((m) => m[0])])];
  const at = triggers.map((c) => text.indexOf(c));
  let ln = 1;
  let counted = 0; // newlines before this index are counted in ln
  for (;;) {
    let t = -1;
    for (const x of at) if (x >= 0 && (t < 0 || x < t)) t = x;
    if (t < 0) break;
    const a = text.lastIndexOf('\n', t) + 1;
    let i = text.indexOf('\n', t);
    if (i < 0) i = text.length;
    if (a > counted) for (let k = text.indexOf('\n', counted); k >= 0 && k < a; k = text.indexOf('\n', k + 1)) ln++;
    const line = text.slice(a, i);
    if (!cannotHit(r, line)) {
      if (names.length > 0 && NAME_START.test(line)) {
        batch.push(line);
        batchLines.push(ln);
        batchChars += line.length + 1;
        if (batchChars >= NAME_BATCH_CHARS) flush();
      } else if (injectionLine(r, line, line)) {
        vs.add({ code: COMMAND_INJECTION, file: path, line: ln });
      }
    }
    if (i === text.length) break;
    ln++;
    counted = i + 1;
    for (let k = 0; k < at.length; k++) if (at[k] >= 0 && at[k] <= i) at[k] = text.indexOf(triggers[k], i + 1);
  }
  if (batch.length > 0) flush();
}

// line: raw text; s: line with declared argument names deleted. A hit on the raw line, after each deletion step of
// strategy 1 (names, then builtin placeholders), or after strategy 2 (generic placeholders until nothing changes).
function injectionLine(r, line, s) {
  if (injectionRaw(r, line)) return true;
  if (s !== line && injectionRaw(r, s)) return true;
  const t = deleteBuiltin(s);
  if (t !== s && injectionRaw(r, t)) return true;
  const u = deleteGeneric(line);
  return u !== line && u !== s && u !== t && injectionRaw(r, u);
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
  for (const s of r.substrings) if (line.includes(s)) return true;
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
const OPEN_BRACKET = 0x5b;
const CLOSE_BRACKET = 0x5d;
const ARGUMENTS = 'ARGUMENTS';
const DEAD = -2;

// Deletes each match of fn(s, i) (the end of a match at the $ at i, or -1) left to right without overlap.
function deleteDollarMatches(s, fn) {
  let out = '';
  let kept = 0;
  for (let i = s.indexOf('$'); i >= 0; i = s.indexOf('$', i)) {
    const e = fn(s, i);
    if (e < 0) {
      i++;
      continue;
    }
    out += s.slice(kept, i);
    kept = i = e;
  }
  return kept === 0 ? s : out + s.slice(kept);
}

const digitsEnd = (s, i) => {
  while (i < s.length && isDigit(s.charCodeAt(i))) i++;
  return i;
};
const ARGUMENTS_INDEX = '$ARGUMENTS[';

// Same result as deleting BUILTIN_PLACEHOLDERS matches in order, one pass each.
export function deleteBuiltin(s) {
  s = deleteDollarMatches(s, (x, i) => {
    if (!x.startsWith(ARGUMENTS_INDEX, i)) return -1;
    const j = i + ARGUMENTS_INDEX.length;
    const k = digitsEnd(x, j);
    return k > j && x.charCodeAt(k) === CLOSE_BRACKET ? k + 1 : -1;
  });
  s = deleteDollarMatches(s, (x, i) => {
    const k = digitsEnd(x, i + 1);
    return k > i + 1 ? k : -1;
  });
  return s.includes('$ARGUMENTS') ? s.replaceAll('$ARGUMENTS', '') : s;
}

// Same result as deleting GENERIC_PLACEHOLDER matches from one line repeatedly until nothing changes, in linear time.
// The line is a linked list of surviving characters. Each pass tries every surviving $ left to right in the pattern's
// branch order; a $ that failed can only match again once a span right after it is deleted, so later passes only retry
// the $ directly left of a deleted span. "First surviving } at or after i" is a union-find over original indices.
// State is module-level and buffers are reused across calls (not reentrant).
let nextBuf = new Int32Array(0);
let prevBuf = new Int32Array(0);
let upBuf = new Int32Array(0);
const grow = (buf, n) => (buf.length >= n ? buf : new Int32Array(Math.max(n, 2 * buf.length)));
let g = '';
let gn = 0;
let next = nextBuf;
let prev = prevBuf;
let up = null;
let head = 0;
let digitsTo = null;
let removed = false;
let later = [];

function findBrace(i) {
  if (!up) {
    up = upBuf = grow(upBuf, gn + 1);
    up[gn] = gn;
    for (let j = gn - 1; j >= 0; j--) up[j] = g.charCodeAt(j) === CLOSE_BRACE && prev[j] !== DEAD ? j : up[j + 1];
  }
  let r = i;
  while (up[r] !== r) r = up[r];
  while (i !== r) {
    const u = up[i];
    up[i] = r;
    i = u;
  }
  return r;
}

// Index of the last character of the match at the $ at p, or -1.
function matchAt(p) {
  const n = gn;
  const q = next[p];
  if (q >= n) return -1;
  const c = g.charCodeAt(q);
  if (c === OPEN_BRACE) {
    const b = findBrace(q + 1);
    return b < n ? b : -1;
  }
  let last = p;
  let r = q;
  let k = 0;
  while (k < ARGUMENTS.length && r < n && g.charCodeAt(r) === ARGUMENTS.charCodeAt(k)) {
    last = r;
    r = next[r];
    k++;
  }
  if (k === ARGUMENTS.length) {
    if (r < n && g.charCodeAt(r) === OPEN_BRACKET) {
      digitsTo ??= new Map();
      let d = digitsTo.get(r) ?? r;
      while (next[d] < n && isDigit(g.charCodeAt(next[d]))) d = next[d];
      digitsTo.set(r, d);
      if (d !== r && next[d] < n && g.charCodeAt(next[d]) === CLOSE_BRACKET) return next[d];
    }
    return last;
  }
  const part = isDigit(c) ? isDigit : isIdentStart(c) ? isIdentPart : null;
  if (!part) return -1;
  let e = q;
  while (next[e] < n && part(g.charCodeAt(next[e]))) e = next[e];
  return e;
}

function tryAt(p) {
  if (prev[p] === DEAD) return;
  const e = matchAt(p);
  if (e < 0) return;
  const l = prev[p];
  const r = next[e];
  for (let i = p; ; i = next[i]) {
    prev[i] = DEAD;
    if (up && g.charCodeAt(i) === CLOSE_BRACE) up[i] = i + 1;
    if (i === e) break;
  }
  if (l >= 0) next[l] = r;
  else head = r;
  if (r < gn) prev[r] = l;
  removed = true;
  if (l >= 0 && g.charCodeAt(l) === DOLLAR && later[later.length - 1] !== l) later.push(l);
}

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
  g = line;
  gn = n;
  next = nextBuf = grow(nextBuf, n);
  prev = prevBuf = grow(prevBuf, n);
  for (let i = 0; i < n; i++) {
    next[i] = i + 1;
    prev[i] = i - 1;
  }
  head = 0;
  up = null;
  digitsTo = null;
  removed = false;
  later = [];
  for (let i = first; i >= 0; i = line.indexOf('$', i + 1)) tryAt(i);
  while (later.length) {
    const cands = later;
    later = [];
    for (const p of cands) tryAt(p);
  }
  g = '';
  if (!removed) return line;
  let out = '';
  for (let i = head; i < n;) {
    let j = i;
    while (j + 1 < n && next[j] === j + 1) j++;
    out += line.slice(i, j + 1);
    i = next[j];
  }
  return out;
}
