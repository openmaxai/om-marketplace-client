import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { COMPONENT_NAME } from './config.js';
import { isCanonicalUuid, isSha256Hex } from './ids.js';
import { readJson, writeJsonAtomic } from './state.js';

export const SLOT_COUNT = 4;
export const SLOTS_FILE = 'slots.json';
export const INJECT_MAX_TOKENS = 2000;
export const SHARD_BUDGET = Object.freeze({ maxChars: 10000, maxTokens: 2200 });
const ORDER_BASE = 60;
const SLOTS = Array.from({ length: SLOT_COUNT }, (_, i) => i + 1);
const ENTRY_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'shards');

export const shardName = (n) => `market-template-${n}`;

// zylos's estimate (shard-registry.js estimateTokens): ceil(ascii/4 + other/1.3) over code points.
export function estimateTokens(text) {
  let ascii = 0;
  let other = 0;
  for (const ch of text) {
    if (ch.codePointAt(0) <= 0x7f) ascii += 1;
    else other += 1;
  }
  return Math.ceil(ascii / 4 + other / 1.3);
}

export function defaultZylosDir(env = process.env) {
  return path.resolve(env.ZYLOS_DIR || path.join(env.HOME || os.homedir(), 'zylos'));
}

export const shardsDir = (zylosDir) => path.join(zylosDir, '.zylos', 'shards.d');
const registryPresent = (zylosDir) => fs.existsSync(path.join(zylosDir, '.claude', 'skills', 'activity-monitor', 'scripts', 'shard-registry.js'));
const emitterRel = (n) => `skills/${COMPONENT_NAME}/src/shards/${shardName(n)}.js`;

export function declaration(n) {
  return { name: shardName(n), order: ORDER_BASE + n, emitter: emitterRel(n), budget: { ...SHARD_BUDGET } };
}

const realOrNull = (p) => { try { return fs.realpathSync(p); } catch { return null; } };

// The active zylos runtime, 'claude' or 'codex'.
export function runtimeOf(zylosDir) {
  let runtime = 'claude';
  try { runtime = JSON.parse(fs.readFileSync(path.join(zylosDir, '.zylos', 'config.json'), 'utf8')).runtime ?? 'claude'; } catch { /* default */ }
  return runtime === 'codex' ? 'codex' : 'claude';
}

// The hook file of the active zylos runtime: Codex reads .codex/hooks.json, Claude .claude/settings.json.
export function hookFile(zylosDir) {
  return runtimeOf(zylosDir) === 'codex' ? path.join(zylosDir, '.codex', 'hooks.json') : path.join(zylosDir, '.claude', 'settings.json');
}

// True when the hook sync has turned all four declarations into session-start hooks.
export function hooksPresent(zylosDir) {
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(hookFile(zylosDir), 'utf8')); } catch { return false; }
  const groups = cfg?.hooks?.SessionStart;
  if (!Array.isArray(groups)) return false;
  const commands = groups.flatMap((g) => (Array.isArray(g?.hooks) ? g.hooks : [])).map((h) => h?.command).filter((c) => typeof c === 'string');
  return SLOTS.every((n) => commands.some((c) => c.includes('session-start-orchestrator.js') && c.trim().endsWith(` --shard ${shardName(n)}`)));
}

// True when every declaration is in place, its emitter resolves to this client's entry file, and its hook exists.
export function declarationsReady(zylosDir) {
  return hooksPresent(zylosDir) && SLOTS.every((n) => {
    let raw;
    try { raw = readJson(path.join(shardsDir(zylosDir), `${shardName(n)}.json`), null); } catch { return false; }
    const real = realOrNull(path.join(zylosDir, '.claude', emitterRel(n)));
    return JSON.stringify(raw) === JSON.stringify(declaration(n)) && real !== null && real === realOrNull(path.join(ENTRY_DIR, `${shardName(n)}.js`));
  });
}

// Writes the four static declarations; returns the names written. Existing identical files are left alone and no
// other file in shards.d is touched.
export function ensureDeclarations(zylosDir) {
  if (!registryPresent(zylosDir)) throw new Error('this zylos has no session-start shard registry');
  const dir = shardsDir(zylosDir);
  for (const n of SLOTS) {
    if (realOrNull(path.join(zylosDir, '.claude', emitterRel(n))) !== realOrNull(path.join(ENTRY_DIR, `${shardName(n)}.js`))) {
      throw new Error(`the client is not installed under ${path.join(zylosDir, '.claude', 'skills', COMPONENT_NAME)}`);
    }
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!fs.lstatSync(dir).isDirectory()) throw new Error(`${dir} is not a directory`);
  const written = [];
  for (const n of SLOTS) {
    const file = path.join(dir, `${shardName(n)}.json`);
    let cur = null;
    try { cur = readJson(file, null); } catch { /* replaced below */ }
    if (JSON.stringify(cur) === JSON.stringify(declaration(n))) continue;
    writeJsonAtomic(file, declaration(n));
    written.push(shardName(n));
  }
  return written;
}

// zylos generates session-start hooks from the declarations only during its hook sync (cli/lib/sync-settings-hooks.js
// in the installed zylos package, found through the zylos command on PATH).
export function findHookSyncScript(env = process.env) {
  for (const dir of (env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    const bin = realOrNull(path.join(dir, 'zylos'));
    if (!bin) continue;
    const script = path.join(path.dirname(bin), 'lib', 'sync-settings-hooks.js');
    if (fs.existsSync(script)) return script;
  }
  return null;
}

export function syncHooks(zylosDir, { env = process.env, spawn = spawnSync } = {}) {
  const script = findHookSyncScript(env);
  if (!script) throw new Error('zylos hook sync script not found');
  const r = spawn(process.execPath, [script], { env: { ...env, ZYLOS_DIR: zylosDir }, stdio: 'inherit', timeout: 60_000 });
  if (r.status !== 0) throw new Error(`zylos hook sync failed (${r.error?.code ?? `exit ${r.status}`})`);
}

const EMPTY_SLOTS = Object.freeze(Object.fromEntries(SLOTS.map((n) => [String(n), null])));
const validSlot = (v) => v === null || (v && typeof v === 'object' && isCanonicalUuid(v.adoption_id) && isSha256Hex(v.inject_sha256));

// D/slots.json: slot n -> {adoption_id, inject_sha256} or null. Returns null when missing; throws when unusable.
export function readSlots(dataDir) {
  const raw = readJson(path.join(dataDir, SLOTS_FILE), null);
  if (raw === null) return null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !SLOTS.every((n) => validSlot(raw[String(n)]))) {
    throw new Error('slots.json is malformed');
  }
  return Object.fromEntries(SLOTS.map((n) => [String(n), raw[String(n)]]));
}

export function writeSlots(dataDir, slots) {
  writeJsonAtomic(path.join(dataDir, SLOTS_FILE), { ...EMPTY_SLOTS, ...slots });
}

export const emptySlots = () => ({ ...EMPTY_SLOTS });
