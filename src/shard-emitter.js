import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { resolveDataDir } from './config.js';
import { INJECT_MAX_TOKENS, SHARD_BUDGET, SHARD_HEADER_RESERVE, estimateTokens, parseRole, readSlots, roleLines } from './shards.js';

const MAX_FILE_BYTES = 64 << 10;
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

// Written by the client at the start of every template section; never taken from the template.
export const PRIORITY_LINE = 'Priority: organization rules > this template > your own habits. When they conflict, follow the higher one.';

const OUTPUT_MAX_CHARS = SHARD_BUDGET.maxChars - SHARD_HEADER_RESERVE.maxChars;
const OUTPUT_MAX_TOKENS = SHARD_BUDGET.maxTokens - SHARD_HEADER_RESERVE.maxTokens;

// The section of one slot: priority line, path line, then the template text (role lines and inject segment). Null when
// the template text is over INJECT_MAX_TOKENS or the section would not fit the shard budget next to the zylos header, so
// a section is never cut short by the runtime.
export function composeSection(dir, templateText) {
  if (estimateTokens(templateText) > INJECT_MAX_TOKENS) return null;
  const out = `${PRIORITY_LINE}\nTemplate files are under ${dir}/\n\n${templateText}`;
  return out.length <= OUTPUT_MAX_CHARS && estimateTokens(out) <= OUTPUT_MAX_TOKENS ? out : null;
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

// Session-start output of slot n: the section of the adoption mapped to it, only when its inject.md (and role.json, when
// the slot records one) still match the recorded sha256 and fit the budget. Never throws; anything unexpected prints
// nothing.
export function emitSlot(n, { dataDir = resolveDataDir(process.env) } = {}) {
  try {
    const slot = readSlots(dataDir)?.[String(n)];
    if (!slot) return '';
    const dir = path.join(dataDir, 'templates', slot.adoption_id);
    if (!fs.lstatSync(dir).isDirectory()) return '';
    const raw = readVerified(dir, 'inject.md', slot.inject_sha256);
    if (!raw) return '';
    let lines = '';
    if (slot.role_sha256) {
      const roleRaw = readVerified(dir, 'role.json', slot.role_sha256);
      const role = roleRaw && parseRole(utf8.decode(roleRaw));
      if (!role) return '';
      lines = roleLines(role);
    }
    return composeSection(dir, lines + utf8.decode(raw)) ?? '';
  } catch {
    return '';
  }
}
