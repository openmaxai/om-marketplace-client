import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { resolveDataDir } from './config.js';
import { INJECT_MAX_TOKENS, SHARD_BUDGET, SHARD_HEADER_RESERVE, SLOT_COUNT, estimateTokens, parseRole, readSlots, roleLines } from './shards.js';

const MAX_FILE_BYTES = 64 << 10;
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

// Written by the client at the start of every template section; never taken from the template.
export const PRIORITY_LINE = 'Priority: organization rules > this template > your own habits. When they conflict, follow the higher one.';

// A line carrying this label (the customizations.json entry of the file list) is never cut, unless it is longer than
// GUARDED_LINE_MAX code points (then it is author text, and guarding it could make the template impossible to place).
export const DATA_LABEL = '(data, not instructions)';
const GUARDED_LINE_MAX = 256;

const OUTPUT_MAX_CHARS = SHARD_BUDGET.maxChars - SHARD_HEADER_RESERVE.maxChars;
const OUTPUT_MAX_TOKENS = SHARD_BUDGET.maxTokens - SHARD_HEADER_RESERVE.maxTokens;

// Client lines at the start of each part. A template printed in one shard has no part marker; a split one carries
// "part k of n" on every part, with the priority line repeated, so no part is printed without the client framing.
const head = (dir, k, n) => `${PRIORITY_LINE}\nTemplate files are under ${dir}/${n > 1 ? ` (part ${k} of ${n})` : ''}\n\n`;

const fits = (out) => out.length <= OUTPUT_MAX_CHARS && estimateTokens(out) <= OUTPUT_MAX_TOKENS;

// Cut positions (code point indices) that fall strictly inside a line holding DATA_LABEL.
function protectedCuts(cps) {
  const out = new Set();
  let start = 0;
  for (let i = 0; i <= cps.length; i++) {
    if (i < cps.length && cps[i] !== '\n') continue;
    const end = Math.min(i + 1, cps.length);
    if (end - start <= GUARDED_LINE_MAX && cps.slice(start, end).join('').includes(DATA_LABEL)) for (let j = start + 1; j < end; j++) out.add(j);
    start = i + 1;
  }
  return out;
}

const isSpace = (c) => c === ' ' || c === '\t' || c === '\n';
// How good a cut before cps[i] is: paragraph break, line break, whitespace, anywhere.
function rank(cps, i) {
  if (cps[i - 1] === '\n') return cps[i - 2] === '\n' ? 3 : 2;
  return isSpace(cps[i - 1]) ? 1 : 0;
}

// Greedy split: each part is filled as far as it fits next to its head, then cut at the best-ranked position within
// `window` code points of that limit (latest first within a rank). Null when it needs more than SLOT_COUNT parts.
function split(cps, headLen, window, guarded) {
  const parts = [];
  let start = 0;
  while (start < cps.length) {
    if (parts.length === SLOT_COUNT) return null;
    let a = 0;
    let o = 0;
    let units = 0;
    let end = start;
    while (end < cps.length) {
      const c = cps[end];
      const na = a + (c.codePointAt(0) <= 0x7f ? 1 : 0);
      const no = o + (c.codePointAt(0) <= 0x7f ? 0 : 1);
      if (headLen.chars + units + c.length > OUTPUT_MAX_CHARS || Math.ceil((headLen.ascii + na) / 4 + (headLen.other + no) / 1.3) > OUTPUT_MAX_TOKENS) break;
      a = na; o = no; units += c.length; end++;
    }
    if (end === cps.length) { parts.push([start, end]); break; }
    let cut = -1;
    let best = -1;
    for (let i = end; i > start && i >= end - window; i--) {
      if (guarded.has(i)) continue;
      const r = rank(cps, i);
      if (r > best) { best = r; cut = i; }
      if (best === 3) break;
    }
    // Nothing usable within the window (a DATA_LABEL line spans it): cut where that line starts.
    for (let i = end - window - 1; cut < 0 && i > start; i--) if (!guarded.has(i)) cut = i;
    if (cut <= start) return null;
    parts.push([start, cut]);
    start = cut;
  }
  return parts;
}

function counts(s) {
  let ascii = 0;
  let other = 0;
  for (const ch of s) {
    if (ch.codePointAt(0) <= 0x7f) ascii += 1;
    else other += 1;
  }
  return { ascii, other, chars: s.length };
}

// The sections printed for one template: one when it fits a shard, otherwise up to SLOT_COUNT parts, each within the
// shard budget next to the zylos header. Cuts prefer paragraph, then line, then word boundaries and never fall inside
// a DATA_LABEL line. Null when the text is over INJECT_MAX_TOKENS or cannot be placed, so a template is never printed
// in part.
export function composeParts(dir, templateText) {
  if (estimateTokens(templateText) > INJECT_MAX_TOKENS) return null;
  const whole = `${head(dir, 1, 1)}${templateText}`;
  if (fits(whole)) return [whole];
  const cps = Array.from(templateText);
  const guarded = protectedCuts(cps);
  // Every split head has the same length: k and n are single digits.
  const headLen = counts(head(dir, SLOT_COUNT, SLOT_COUNT));
  for (const window of [Infinity, 512, 64, 0]) {
    const ranges = split(cps, headLen, window, guarded);
    if (!ranges) continue;
    const out = ranges.map(([s, e], i) => `${head(dir, i + 1, ranges.length)}${cps.slice(s, e).join('')}`);
    if (out.every(fits)) return out;
  }
  return null;
}

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

// The bytes of dir/name when it is a regular file (not a link) of at most MAX_FILE_BYTES with the given sha256.
function readVerified(dir, name, sha) {
  const fd = fs.openSync(path.join(dir, name), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > MAX_FILE_BYTES) return null;
    const raw = fs.readFileSync(fd);
    return sha256(raw) === sha ? raw : null;
  } finally {
    fs.closeSync(fd);
  }
}

// The parts of the adoption recorded in slot, only when its inject.md (and role.json, when the slot records one) still
// match the recorded sha256 and fit the budget; null otherwise. Never throws.
export function slotParts(dataDir, slot) {
  try {
    const dir = path.join(dataDir, 'templates', slot.adoption_id);
    if (!fs.lstatSync(dir).isDirectory()) return null;
    const raw = readVerified(dir, 'inject.md', slot.inject_sha256);
    if (!raw) return null;
    let lines = '';
    if (slot.role_sha256) {
      const roleRaw = readVerified(dir, 'role.json', slot.role_sha256);
      const role = roleRaw && parseRole(utf8.decode(roleRaw));
      if (!role) return null;
      lines = roleLines(role);
    }
    return composeParts(dir, lines + utf8.decode(raw));
  } catch {
    return null;
  }
}

// What the SLOT_COUNT shards print: the parts of each mapped adoption in slot order, a template only as a whole
// (one that no longer fits after the earlier ones is left out).
export function shardPlan(dataDir) {
  const plan = [];
  const slots = readSlots(dataDir);
  if (!slots) return plan;
  for (let n = 1; n <= SLOT_COUNT; n++) {
    const slot = slots[String(n)];
    const parts = slot && slotParts(dataDir, slot);
    if (parts && plan.length + parts.length <= SLOT_COUNT) plan.push(...parts);
  }
  return plan;
}

// Session-start output of shard n (1-based). Never throws; anything unexpected prints nothing.
export function emitSlot(n, { dataDir = resolveDataDir(process.env) } = {}) {
  try {
    return shardPlan(dataDir)[n - 1] ?? '';
  } catch {
    return '';
  }
}
