// Package hygiene for skill packages: path rules, npm hooks and dependencies, SKILL.md presence. Reasons and the order in
// which they are reported match the server's InspectSkillPackage.
import crypto from 'node:crypto';
import { PackageError, readFiles, readZip } from './zip.js';
import { PathIndex, checkEntryPath } from './paths.js';

const MAX_MANIFEST_JSON_BYTES = 1 << 20;
const MAX_JSON_DEPTH = 10000;

const NPM_FILES = new Set(['.npmrc', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml']);
const NPM_INSTALL_HOOKS = ['preinstall', 'install', 'postinstall', 'preprepare', 'prepare', 'postprepare', 'prepublish',
  'prepack', 'postpack', 'dependencies'];
const NPM_DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies',
  'bundleDependencies', 'bundledDependencies', 'overrides'];

const singleCp = (s) => s.length === 1 || (s.length === 2 && s.codePointAt(0) > 0xffff);

// Go unicode.ToLower / unicode.ToUpper: one code point to one code point.
function simpleLowerChar(c) {
  if (c === '\u0130') return 'i';
  const l = c.toLowerCase();
  return singleCp(l) ? l : c;
}
function simpleUpperChar(c) {
  const u = c.toUpperCase();
  return singleCp(u) ? u : c;
}
export const simpleLower = (s) => [...s].map(simpleLowerChar).join('');
// "Differs only in case" for JSON keys: Go strings.ToLower(strings.ToUpper(k)).
export const foldKey = (s) => [...s].map((c) => simpleLowerChar(simpleUpperChar(c))).join('');

// Go strings.EqualFold against an ASCII target.
const ASCII_FOLD_PARTNERS = { '\u212a': 'k', '\u017f': 's' };
export function equalFoldAscii(s, target) {
  const a = [...s];
  if (a.length !== target.length) return false;
  return a.every((r, i) => (ASCII_FOLD_PARTNERS[r] ?? (r < '\x80' ? r.toLowerCase() : r)) === target[i].toLowerCase());
}

const baseName = (p) => p.slice(p.lastIndexOf('/') + 1);
const extName = (p) => {
  const b = baseName(p);
  const i = b.lastIndexOf('.');
  return i < 0 ? '' : b.slice(i);
};
export const isSkillMDPath = (p) => equalFoldAscii(baseName(p), 'SKILL.md');
export const isMarkdownPath = (p) => equalFoldAscii(extName(p), '.md');

// Reads the zip, checks hygiene and returns the file manifest (sorted by path bytes), the root SKILL.md and every .md file.
export function inspectPackage(buf) {
  const index = new PathIndex();
  const { files } = readZip(buf, {
    onEntry: (e) => checkEntryPath(e.nameBytes),
    onChecked: (e) => {
      index.add(e);
      if (!e.isDir && NPM_FILES.has(simpleLower(baseName(e.name)))) {
        throw new PackageError('npm_dependencies', `${JSON.stringify(e.name)} is an npm / yarn / pnpm dependency file`);
      }
    },
    onCentral: () => index.checkForbidden(),
    onCounted: () => index.checkFileDirClashes(),
  });
  const manifest = [];
  const jsons = [];
  const markdown = [];
  let skillMD = null;
  for (const [e, data] of readFiles(buf, files)) {
    manifest.push({ path: e.name, size: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex') });
    const base = baseName(e.name);
    if (e.name === 'SKILL.md') skillMD = data;
    if (equalFoldAscii(base, 'package.json')) jsons.push([e.name, data]);
    if (isMarkdownPath(e.name) || isSkillMDPath(e.name)) markdown.push({ path: e.name, content: data });
    if (equalFoldAscii(base, 'binding.gyp')) {
      throw new PackageError('install_hook', `${JSON.stringify(e.name)} triggers node-gyp on install`);
    }
  }
  for (const [name, raw] of jsons) checkPackageJSON(name, raw);
  if (!skillMD) throw new PackageError('skill_md_missing', 'no SKILL.md at the package root');
  manifest.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  return { manifest, skillMD, markdown };
}

// Rejects npm install hooks and dependencies. Keys are read level by level with duplicates and case variants rejected,
// so a later `"Scripts": null` cannot hide `"scripts"` from the check.
export function checkPackageJSON(name, raw) {
  const q = JSON.stringify(name);
  if (raw.length > MAX_MANIFEST_JSON_BYTES) throw new PackageError('install_hook', `${q} too large to check`);
  const sensitive = new Map([['scripts', ['scripts', 'install_hook']], ['gypfile', ['gypfile', 'install_hook']],
    ...NPM_DEPENDENCY_FIELDS.map((k) => [foldKey(k), [k, 'npm_dependencies']])]);
  let top;
  try {
    top = jsonObjectFields(decodeUTF8(raw));
  } catch (err) {
    throw new PackageError('install_hook', `${q} is not a JSON object npm could read: ${err.message}`);
  }
  for (const k of top.keys()) {
    const s = sensitive.get(foldKey(k));
    if (s && k !== s[0]) throw new PackageError(s[1], `${q} has the key ${JSON.stringify(k)}`);
  }
  const scripts = top.get('scripts');
  if (scripts !== undefined && scripts !== 'null') {
    let fields;
    try {
      fields = jsonObjectFields(scripts);
    } catch (err) {
      throw new PackageError('install_hook', `${q}: scripts is not an object npm could read: ${err.message}`);
    }
    for (const k of fields.keys()) {
      if (NPM_INSTALL_HOOKS.includes(foldKey(k))) throw new PackageError('install_hook', `${q} declares scripts.${k}`);
    }
  }
  const gyp = top.get('gypfile');
  if (gyp !== undefined && gyp !== 'null' && gyp !== 'false') throw new PackageError('install_hook', `${q} sets gypfile`);
  for (const field of NPM_DEPENDENCY_FIELDS) {
    const v = top.get(field);
    if (v === undefined) continue;
    let nonEmpty;
    try {
      nonEmpty = jsonNonEmpty(v);
    } catch (err) {
      throw new PackageError('npm_dependencies', `${q}: ${field} is not something npm could read: ${err.message}`);
    }
    if (nonEmpty) throw new PackageError('npm_dependencies', `${q} declares ${field}`);
  }
}

function jsonNonEmpty(v) {
  if (v === 'null' || v === 'false') return false;
  if (v[0] === '{') return jsonObjectFields(v).size > 0;
  if (v[0] === '[') return v[skipWs(v, 1)] !== ']';
  return true;
}

// UTF-8 decoding as Go's encoding/json sees it: each byte of an invalid sequence becomes one U+FFFD.
const strictUTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
function decodeUTF8(buf) {
  try {
    return strictUTF8.decode(buf);
  } catch { /* slow path below */ }
  let out = '';
  for (let i = 0; i < buf.length;) {
    const n = buf[i] < 0x80 ? 1 : buf[i] >= 0xc2 && buf[i] <= 0xdf ? 2 : buf[i] >= 0xe0 && buf[i] <= 0xef ? 3
      : buf[i] >= 0xf0 && buf[i] <= 0xf4 ? 4 : 0;
    let ch = null;
    if (n) {
      try {
        ch = strictUTF8.decode(buf.subarray(i, i + n));
      } catch { /* invalid sequence */ }
    }
    if (ch !== null && singleCp(ch)) {
      out += ch;
      i += n;
    } else {
      out += '\ufffd';
      i += 1;
    }
  }
  return out;
}

const skipWs = (s, i) => {
  while (s[i] === ' ' || s[i] === '\t' || s[i] === '\n' || s[i] === '\r') i++;
  return i;
};
const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const ESCAPES = '"\\/bfnrtu';

function syntax(i) {
  return new Error(`invalid JSON at offset ${i}`);
}

// Returns [decoded string, end index] for the JSON string starting at s[i] === '"'.
function scanString(s, i) {
  const start = i++;
  for (;;) {
    const c = s.charCodeAt(i);
    if (Number.isNaN(c) || c < 0x20) throw syntax(i);
    if (c === 0x22) break;
    if (c === 0x5c) {
      if (!ESCAPES.includes(s[i + 1])) throw syntax(i);
      if (s[i + 1] === 'u' && !/^[0-9a-fA-F]{4}$/.test(s.slice(i + 2, i + 6))) throw syntax(i);
      i += s[i + 1] === 'u' ? 6 : 2;
    } else {
      i++;
    }
  }
  return [JSON.parse(s.slice(start, i + 1)).toWellFormed(), i + 1];
}

function scanKey(s, i) {
  i = skipWs(s, i);
  if (s[i] !== '"') throw syntax(i);
  const [key, end] = scanString(s, i);
  i = skipWs(s, end);
  if (s[i] !== ':') throw syntax(i);
  return [key, i + 1];
}

// Validates one JSON value starting at s[i] and returns its end index; nesting is limited like Go's scanner.
function scanValue(s, i) {
  const stack = [];
  for (;;) {
    i = skipWs(s, i);
    const c = s[i];
    if (c === '{' || c === '[') {
      if (stack.length >= MAX_JSON_DEPTH) throw new Error('exceeded max depth');
      i = skipWs(s, i + 1);
      if (s[i] !== (c === '{' ? '}' : ']')) {
        stack.push(c);
        if (c === '{') i = scanKey(s, i)[1];
        continue;
      }
      i++;
    } else if (c === '"') {
      i = scanString(s, i)[1];
    } else if (s.startsWith('true', i) || s.startsWith('null', i)) {
      i += 4;
    } else if (s.startsWith('false', i)) {
      i += 5;
    } else {
      NUMBER.lastIndex = i;
      if (!NUMBER.test(s)) throw syntax(i);
      i = NUMBER.lastIndex;
    }
    for (;;) {
      if (!stack.length) return i;
      i = skipWs(s, i);
      const top = stack[stack.length - 1];
      if (s[i] === ',') {
        i++;
        if (top === '{') i = scanKey(s, i)[1];
        break;
      }
      if (s[i] !== (top === '{' ? '}' : ']')) throw syntax(i);
      stack.pop();
      i++;
    }
  }
}

// One level of a JSON object, values kept raw. Repeated keys or keys differing only by case are an error.
function jsonObjectFields(s) {
  let i = skipWs(s, 0);
  if (s[i] !== '{') throw new Error('not an object');
  const out = new Map();
  const folded = new Map();
  i = skipWs(s, i + 1);
  if (s[i] === '}') {
    i++;
  } else {
    for (;;) {
      const [key, valueStart] = scanKey(s, i);
      const start = skipWs(s, valueStart);
      i = scanValue(s, start);
      const fk = foldKey(key);
      if (folded.has(fk)) throw new Error(`keys ${JSON.stringify(folded.get(fk))} and ${JSON.stringify(key)} differ only by case or repeat`);
      folded.set(fk, key);
      out.set(key, s.slice(start, i));
      i = skipWs(s, i);
      if (s[i] === '}') {
        i++;
        break;
      }
      if (s[i] !== ',') throw syntax(i);
      i++;
    }
  }
  if (skipWs(s, i) !== s.length) throw new Error('data after the object');
  return out;
}
