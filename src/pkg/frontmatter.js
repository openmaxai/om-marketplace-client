// Strict SKILL.md frontmatter subsets, matching the market's parsers. parseSkillMD reads name / description / version of
// the root SKILL.md; frontmatterKeys lists the top-level keys and argument names the skill policy checks on every SKILL.md.
// Anything outside the subset is an error rather than a guess, so no YAML parser can read the file differently.
import { PackageError } from './zip.js';

export const MAX_SKILL_MD_BYTES = 256 << 10;
export const MAX_DESCRIPTION_CHARS = 500;
const MAX_SEMVER_BYTES = 64;

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-(0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(\.(0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?$/;
export const validSlug = (s) => s.length <= 64 && SLUG.test(s);
export const validSemver = (s) => s.length <= MAX_SEMVER_BYTES && SEMVER.test(s);

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
// Strict UTF-8 decoding; null when the bytes are not valid UTF-8. A BOM is kept.
export function decodeUTF8(buf) {
  try {
    return utf8.decode(buf);
  } catch {
    return null;
  }
}

// Hand-written trims: a regex like /[ \t]+$/ is quadratic on long runs of blanks.
const isWS = (c) => c === ' ' || c === '\t';
function trimLeftST(s) {
  let b = 0;
  while (isWS(s[b])) b++;
  return s.slice(b);
}
function trimRightST(s) {
  let e = s.length;
  while (e > 0 && isWS(s[e - 1])) e--;
  return s.slice(0, e);
}
const trimST = (s) => trimRightST(trimLeftST(s));
function trimLeftSpaces(s) {
  let b = 0;
  while (s[b] === ' ') b++;
  return s.slice(b);
}

// C0 / C1 controls except tab, and characters other parsers treat as line breaks or strip.
function checkChars(lines, last) {
  for (let i = 0; i <= last; i++) {
    for (const ch of lines[i]) {
      const cp = ch.codePointAt(0);
      if ((cp < 0x20 && cp !== 9) || (cp >= 0x7f && cp <= 0x9f) || cp === 0x2028 || cp === 0x2029 || cp === 0xfeff) {
        throw new Error(`frontmatter line ${i + 1} has a control or line-break character U+${cp.toString(16).toUpperCase().padStart(4, '0')}`);
      }
    }
  }
}

// [content, rest] for a quoted scalar starting at s[0] and closed on the same line, or null.
function scanQuoted(s) {
  const q = s[0];
  for (let i = 1; i < s.length; i++) {
    if (q === '"' && s[i] === '\\') i++;
    else if (s[i] === q && q === "'" && s[i + 1] === "'") i++;
    else if (s[i] === q) return [s.slice(1, i), s.slice(i + 1)];
  }
  return null;
}

function onlyComment(rest) {
  const t = trimLeftST(rest);
  return t === '' || (t[0] === '#' && t.length < rest.length);
}

// Quotes and flow collections must close on the same line, followed only by a comment.
function checkOtherValue(v) {
  if (v === '') return;
  if (v[0] === '"' || v[0] === "'") {
    const q = scanQuoted(v);
    if (!q) throw new Error('quoted value is not closed on the same line');
    if (!onlyComment(q[1])) throw new Error('text after the closing quote');
  } else if (v[0] === '[' || v[0] === '{') {
    let depth = 0;
    for (let i = 0; i < v.length; i++) {
      if (v[i] === '"' || v[i] === "'") {
        const q = scanQuoted(v.slice(i));
        if (!q) throw new Error('quoted value is not closed on the same line');
        i = v.length - q[1].length - 1;
      } else if (v[i] === '[' || v[i] === '{') {
        depth++;
      } else if (v[i] === ']' || v[i] === '}') {
        if (--depth === 0) {
          if (!onlyComment(v.slice(i + 1))) throw new Error('text after a flow collection');
          return;
        }
      }
    }
    throw new Error('flow collection is not closed on the same line');
  }
}

const KEY_LINE = /^([a-z_][a-z0-9_-]*):(?:[ \t](.*))?$/;
const INDICATORS = '&*!%@`[]{},#';

// A name / description / version value: a quoted scalar closed on the same line, or a plain scalar without ": ".
function scalar(v) {
  if (v === '') return '';
  if (v[0] === '"' || v[0] === "'") {
    const q = scanQuoted(v);
    if (!q) throw new Error('quoted value is not closed on the same line');
    if (!onlyComment(q[1])) throw new Error('text after the closing quote');
    if (v[0] === "'") return q[0].replaceAll("''", "'");
    if (q[0].includes('\\')) throw new Error('escapes in double-quoted values are not accepted');
    return q[0];
  }
  if (INDICATORS.includes(v[0]) || ('-?:'.includes(v[0]) && (v.length === 1 || isWS(v[1])))) {
    throw new Error(`value starts with the YAML indicator ${JSON.stringify(v[0])}`);
  }
  const ws = v.search(/[ \t]/);
  if (ws >= 0) {
    for (let j = ws; j < v.length; j++) {
      if (v[j] === '#' && isWS(v[j - 1])) {
        v = trimRightST(v.slice(0, j));
        break;
      }
    }
  }
  if (v.includes(': ') || v.includes(':\t') || v.endsWith(':')) throw new Error('plain value contains ": " (quote it)');
  return v;
}

// name, description and (optional) version of the root SKILL.md; skill_md_invalid on anything outside the subset.
export function parseSkillMD(raw) {
  const bad = (msg) => new PackageError('skill_md_invalid', msg);
  if (raw.length > MAX_SKILL_MD_BYTES) throw bad(`SKILL.md larger than ${MAX_SKILL_MD_BYTES} bytes`);
  const text = decodeUTF8(raw);
  if (text === null) throw bad('SKILL.md is not UTF-8');
  const lines = text.replaceAll('\r\n', '\n').split('\n');
  if (lines.length < 2 || lines[0] !== '---') throw bad('SKILL.md has no frontmatter');
  const end = lines.indexOf('---', 1);
  try {
    checkChars(lines, end < 0 ? lines.length - 1 : end);
  } catch (err) {
    throw bad(err.message);
  }
  if (end < 0) throw bad('SKILL.md frontmatter is not closed');
  const [NONE, OTHER, SCALAR, BLOCK] = [0, 1, 2, 3];
  const meta = { name: '', description: '', version: '' };
  const got = new Set();
  let state = NONE;
  let otherEmpty = false;
  let blockHead = '';
  let block = [];
  const finishBlock = () => {
    meta.description = block.join(blockHead[0] === '|' ? '\n' : ' ').trim();
    block = [];
  };
  for (let i = 1; i < end; i++) {
    const line = lines[i];
    const ln = i + 1;
    if (trimLeftSpaces(line) === '') {
      if (state === BLOCK) block.push('');
      continue;
    }
    if (line[0] === ' ') {
      if (state === BLOCK) block.push(line.trim());
      else if (state !== OTHER) throw bad(`frontmatter line ${ln}: indented line after a name / description / version value`);
      continue;
    }
    if (state === BLOCK) finishBlock();
    if (state === OTHER && otherEmpty && (line === '-' || line.startsWith('- '))) continue;
    const m = KEY_LINE.exec(line);
    if (!m) throw bad(`frontmatter line ${ln} is not a plain \`key: value\` line`);
    const key = m[1];
    const val = trimST(m[2] ?? '');
    if (key !== 'name' && key !== 'description' && key !== 'version') {
      try {
        checkOtherValue(val);
      } catch (err) {
        throw bad(`frontmatter line ${ln} (${key}): ${err.message}`);
      }
      state = OTHER;
      otherEmpty = val === '';
      continue;
    }
    if (got.has(key)) throw bad(`duplicate ${key}`);
    got.add(key);
    if (val[0] === '|' || val[0] === '>') {
      if (key !== 'description' || !['|', '>', '|-', '>-'].includes(val)) throw bad(`${key}: block scalar header is not accepted`);
      state = BLOCK;
      blockHead = val;
      continue;
    }
    let v;
    try {
      v = scalar(val);
    } catch (err) {
      throw bad(`${key}: ${err.message}`);
    }
    if (key === 'version' && !validSemver(v)) {
      throw bad(`version must be a SemVer 2.0.0 version without a leading v or build metadata (<= ${MAX_SEMVER_BYTES} bytes)`);
    }
    meta[key] = v;
    state = SCALAR;
  }
  if (state === BLOCK) finishBlock();
  if (!validSlug(meta.name)) throw bad("name must be lowercase letters, digits and single '-' (<= 64)");
  if (meta.description === '' || [...meta.description].length > MAX_DESCRIPTION_CHARS) {
    throw bad(`description is required and at most ${MAX_DESCRIPTION_CHARS} characters`);
  }
  return meta;
}

const TOP_KEY = /^([A-Za-z0-9_][A-Za-z0-9_.-]{0,63}):(?:[ \t](.*))?$/;
const BLOCK_HEADER = /^[|>][1-9+-]{0,2}(?:[ \t]+#.*)?[ \t]*$/;

// Flow collection closed on the same line: outside quotes, nothing after [ { , : (skipping blanks) may start with & * ! ?.
function checkFlow(v) {
  for (let i = 0; i < v.length; i++) {
    const c = v[i];
    if (c === '"' || c === "'") {
      const q = scanQuoted(v.slice(i));
      if (!q) throw new Error('quoted value is not closed on the same line');
      i = v.length - q[1].length - 1;
    } else if ('[{,:'.includes(c)) {
      let j = i + 1;
      while (isWS(v[j])) j++;
      if (j < v.length && '&*!?'.includes(v[j])) throw new Error(`flow collection has the YAML indicator ${JSON.stringify(v[j])}`);
    } else if (c === '#' && i > 0 && isWS(v[i - 1])) {
      return;
    }
  }
}

// Returns whether v is a block scalar header.
function checkValue(v) {
  if (v === '' || v[0] === '#') return false;
  if ('&*!%@`'.includes(v[0]) || v === '?' || v.startsWith('? ') || v.startsWith('?\t')) {
    throw new Error(`value starts with the YAML indicator ${JSON.stringify(v[0])}`);
  }
  if (v[0] === '|' || v[0] === '>') {
    if (!BLOCK_HEADER.test(v)) throw new Error('block scalar header is not accepted');
    return true;
  }
  if (v[0] === '"' || v[0] === "'") checkOtherValue(v);
  if (v[0] === '[' || v[0] === '{') {
    checkOtherValue(v);
    checkFlow(v);
  }
  return false;
}

// First colon followed by a blank or end of line, unless a comment starts first.
function cutKey(s) {
  for (let i = 0; i < s.length; i++) {
    if (s[i] === ':' && (i + 1 === s.length || isWS(s[i + 1]))) return [trimRightST(s.slice(0, i)), trimST(s.slice(i + 1))];
    if (s[i] === '#' && i > 0 && isWS(s[i - 1])) return null;
  }
  return null;
}

// A nested node (indentation and `- ` removed); returns whether it is a block scalar header.
function checkNode(rest) {
  if (rest === '' || rest[0] === '#') return false;
  if ('&*!?%@`'.includes(rest[0])) throw new Error(`node starts with the YAML indicator ${JSON.stringify(rest[0])}`);
  if (rest[0] === '"' || rest[0] === "'") {
    const q = scanQuoted(rest);
    if (!q) throw new Error('quoted value is not closed on the same line');
    const after = q[1];
    if (after[0] === ':' && (after.length === 1 || isWS(after[1]))) return checkValue(trimST(after.slice(1)));
    if (!onlyComment(after)) throw new Error('text after the closing quote');
    return false;
  }
  if (rest[0] === '[' || rest[0] === '{') return checkValue(rest);
  const kv = cutKey(rest);
  if (!kv) return checkValue(rest);
  if (kv[0] === '<<') throw new Error('merge key <<');
  return checkValue(kv[1]);
}

const asciiLower = (s) => s.replace(/[A-Z]+/g, (m) => m.toLowerCase());

// args: { key, pattern: RegExp, prefixes: string[] } from the policy's frontmatter rules.
export function validArgName(args, n) {
  if (!args.pattern.test(n)) return false;
  const ln = asciiLower(n);
  return !args.prefixes.some((p) => ln.startsWith(asciiLower(p)));
}

function inlineArguments(args, val) {
  const errForm = () => new Error('value must be empty, [a, b] or space-separated names without comments; names must be ASCII identifiers not starting with a digit or a forbidden prefix');
  if (val === '') return [];
  if (val.includes('#')) throw errForm();
  let items;
  if (val[0] === '[') {
    if (!val.endsWith(']')) throw errForm();
    const inner = val.slice(1, -1);
    if (trimST(inner) === '') return [];
    items = inner.split(',').map(trimST);
  } else {
    items = val.split(/[ \t]+/).filter((s) => s !== '');
  }
  if (!items.every((it) => validArgName(args, it))) throw errForm();
  return items;
}

// Top-level keys (in order, with 1-based line numbers) and declared argument names of a SKILL.md, by structural rules
// only; throws on anything uncertain. Messages carry line numbers and key names, never values.
export function frontmatterKeys(text, args) {
  const lines = text.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
  if (lines[0] !== '---') throw new Error('first line is not exactly ---');
  const end = lines.indexOf('---', 1);
  if (end < 0) throw new Error('frontmatter is not closed');
  checkChars(lines, end);
  const keys = [];
  const names = [];
  let blockCol = -1;
  let topEmpty = false;
  let inArgs = false;
  let argsCol = -1;
  for (let i = 1; i < end; i++) {
    const line = lines[i];
    const ln = i + 1;
    if (trimST(line) === '') continue;
    const ind = line.length - trimLeftSpaces(line).length;
    if (blockCol >= 0) {
      if (ind > blockCol) continue;
      blockCol = -1;
    }
    if (line[ind] === '\t') throw new Error(`line ${ln}: tab in indentation`);
    let rest = line.slice(ind);
    let col = ind;
    let seq = false;
    while (rest === '-' || rest.startsWith('- ') || rest.startsWith('-\t')) {
      if (rest.startsWith('-\t')) throw new Error(`line ${ln}: tab after a sequence indicator`);
      seq = true;
      const n = rest.length;
      rest = trimLeftSpaces(rest.slice(1));
      col += n - rest.length;
    }
    if (ind === 0 && !seq) {
      const m = TOP_KEY.exec(line);
      if (!m) throw new Error(`line ${ln} is not a plain top-level \`key: value\` line`);
      keys.push({ key: m[1], line: ln });
      const val = trimST(m[2] ?? '');
      topEmpty = val === '' || val[0] === '#';
      let block;
      try {
        block = checkValue(val);
        inArgs = false;
        argsCol = -1;
        if (m[1] === args.key) {
          names.push(...inlineArguments(args, val));
          inArgs = val === '';
        }
      } catch (err) {
        throw new Error(`line ${ln} (${m[1]}): ${err.message}`);
      }
      if (block) blockCol = 0;
      continue;
    }
    if (!topEmpty) throw new Error(`line ${ln}: indented line or sequence entry not under a top-level key with an empty value`);
    if (inArgs) {
      const item = trimRightST(rest);
      const first = trimLeftSpaces(line.slice(ind + 1));
      if (!seq || first === '-' || first.startsWith('- ') || (argsCol >= 0 && ind !== argsCol) || line.includes('#') ||
        !validArgName(args, item)) {
        throw new Error(`line ${ln} (${args.key}): only \`- name\` entries with the same indentation and valid names`);
      }
      argsCol = ind;
      names.push(item);
      continue;
    }
    try {
      if (checkNode(rest)) blockCol = col;
    } catch (err) {
      throw new Error(`line ${ln}: ${err.message}`);
    }
  }
  return { keys, names };
}
