import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { resolveDataDir } from './config.js';
import { INJECT_MAX_TOKENS, estimateTokens, readSlots } from './shards.js';

const MAX_INJECT_BYTES = 64 << 10;
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function readInject(dir) {
  if (!fs.lstatSync(dir).isDirectory()) return null;
  const fd = fs.openSync(path.join(dir, 'inject.md'), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const st = fs.fstatSync(fd);
    return st.isFile() && st.size <= MAX_INJECT_BYTES ? fs.readFileSync(fd) : null;
  } finally {
    fs.closeSync(fd);
  }
}

// Session-start output of slot n: the inject segment of the adoption mapped to it, only when its bytes still match the
// recorded sha256 and fit the budget. Never throws; anything unexpected prints nothing.
export function emitSlot(n, { dataDir = resolveDataDir(process.env) } = {}) {
  try {
    const slot = readSlots(dataDir)?.[String(n)];
    if (!slot) return '';
    const dir = path.join(dataDir, 'templates', slot.adoption_id);
    const raw = readInject(dir);
    if (!raw || crypto.createHash('sha256').update(raw).digest('hex') !== slot.inject_sha256) return '';
    const text = utf8.decode(raw);
    if (estimateTokens(text) > INJECT_MAX_TOKENS) return '';
    return `Template files are under ${dir}/\n\n${text}`;
  } catch {
    return '';
  }
}
