import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadConfig } from '../../src/config.js';
import { createRuntime } from '../../src/app.js';
import { createLogger } from '../../src/logger.js';
import { StateLockedError, lockDataDir, readJson, verifiedLockHolder } from '../../src/state.js';
import { isCanonicalUuid } from '../../src/ids.js';
import { SKILL_DIR_PREFIX } from '../../src/land.js';
import { readMarker } from '../../src/skills.js';
import { quarantine as quarantineTemplate } from '../../src/templates.js';
import { SLOT_COUNT, declaration, defaultZylosDir, emptySlots, shardName, shardsDir, syncHooks, writeSlots } from '../../src/shards.js';

export const SERVICE = 'zylos-om-marketplace-client';
export const REPORT_TIMEOUT_MS = 10_000;
const LOCK_WAIT_MS = 15_000;
const TERM_GRACE_MS = 5_000;
const POLL_MS = 200;
const SYNC_PENDING = 'hook-sync-pending';

export function stopService() {
  spawnSync('pm2', ['stop', SERVICE], { stdio: 'ignore', timeout: 30_000 });
}

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

// Calls open() until the stopped service has released the state lock. A holder still there after waitMs is sent
// SIGTERM once, only when the lock provably belongs to it (pid, start time and boot id match), and then gets
// termGraceMs to exit. Null when the lock stays held.
async function whenUnlocked(open, dataDir, { waitMs, termGraceMs, log }) {
  let deadline = Date.now() + waitMs;
  let termed = false;
  for (;;) {
    try {
      return open();
    } catch (err) {
      if (!(err instanceof StateLockedError)) throw err;
    }
    if (Date.now() >= deadline) {
      if (termed) return null;
      termed = true;
      const pid = verifiedLockHolder(dataDir);
      if (pid === null) {
        log('the state lock holder cannot be identified, so it is not signalled');
        return null;
      }
      try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ }
      deadline = Date.now() + termGraceMs;
    }
    await sleep(POLL_MS);
  }
}

function uniqueDest(base, name) {
  let dest = path.join(base, name);
  for (let n = 2; fs.existsSync(dest) || isLink(dest); n++) dest = path.join(base, `${name}.${n}`);
  return dest;
}

function isLink(p) {
  try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; }
}

// Moves market-managed skills out of the skills directory into quarantine/market--<slug>/<version>-<id>[.n]/; nothing is
// deleted and no earlier copy is replaced. A directory counts as ours when its marker (read without following links)
// names a skill recorded under that slug; without an inventory, when the marker names a skill id.
function quarantineSkills(skillsDir, dataDir, installs, log) {
  let names = [];
  try { names = fs.readdirSync(skillsDir); } catch { /* none */ }
  for (const n of names.filter((x) => x.startsWith(SKILL_DIR_PREFIX))) {
    const dir = path.join(skillsDir, n);
    try {
      if (!fs.lstatSync(dir).isDirectory()) continue;
      const m = readMarker(dir);
      if (!isCanonicalUuid(m?.skill_id)) continue;
      const rec = installs ? (Object.hasOwn(installs, m.skill_id) ? installs[m.skill_id] : null) : undefined;
      if (rec === null || (rec && `${SKILL_DIR_PREFIX}${rec.slug}` !== n)) continue;
      const base = path.join(dataDir, 'quarantine', n);
      fs.mkdirSync(base, { recursive: true, mode: 0o700 });
      const dest = uniqueDest(base, `${m.version_no ?? 0}-${rec?.skill_version_id ?? 'unrecorded'}`);
      fs.renameSync(dir, dest);
      log(`skill ${n} moved to ${dest}`);
    } catch (err) {
      log(`skill ${n} left in place (${err.message})`);
    }
  }
}

// The four slot declarations point at emitters inside this component, which is about to be removed. Only files whose
// JSON equals what this client declares are removed; the hook sync then drops the generated session-start hooks. A
// sync that did not finish (failed, or the hook was killed) is retried on the next run.
function removeDeclarations(zylosDir, dataDir, { env, sync, log }) {
  const pending = path.join(dataDir, SYNC_PENDING);
  let removed = 0;
  for (let n = 1; n <= SLOT_COUNT; n++) {
    const file = path.join(shardsDir(zylosDir), `${shardName(n)}.json`);
    let cur = null;
    try { cur = readJson(file, null); } catch { /* not ours */ }
    if (JSON.stringify(cur) !== JSON.stringify(declaration(n))) continue;
    if (!removed) {
      fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(pending, '');
    }
    fs.rmSync(file);
    removed += 1;
  }
  if (removed) log(`removed ${removed} template shard declaration(s)`);
  if (!removed && !fs.existsSync(pending)) return;
  try {
    sync(zylosDir, { env });
    fs.rmSync(pending, { force: true });
  } catch (err) {
    log(`hook sync failed (${err.message}); run \`zylos init\` to refresh hooks`);
  }
}

function step(log, what, fn) {
  try {
    return fn();
  } catch (err) {
    log(`${what} failed (${err.message})`);
    return undefined;
  }
}

async function reportUninstalled(rt, abort, log, timeoutMs) {
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    for (const orgId of rt.orgs.ids()) {
      if (abort.signal.aborted) break;
      if (rt.orgs.isBlocked(orgId)) continue;
      try {
        const agentId = await rt.orgs.agentId(orgId);
        await rt.api.reportReconcile({ orgId, agentId, items: [{ kind: 'client_uninstalled' }] });
        log(`reported client_uninstalled to org ${orgId}`);
      } catch (err) {
        log(`client_uninstalled not reported to org ${orgId} (${err.code || err.status || err.message})`);
      }
    }
  } finally {
    clearTimeout(timer);
  }
}

// Stops the service, removes the slot declarations (no lock needed), then with the state lock quarantines market-managed
// skills and templates and reports client_uninstalled (best effort, bounded). When the lock cannot be taken, content is
// left in place. Revoked set, inventory and quarantine stay in the data dir.
export async function preUninstall({
  env = process.env, dataDir, zylosDir = defaultZylosDir(env), skillsDir = path.join(zylosDir, '.claude', 'skills'),
  stop = stopService, sync = syncHooks, lockWaitMs = LOCK_WAIT_MS, termGraceMs = TERM_GRACE_MS, reportTimeoutMs = REPORT_TIMEOUT_MS,
  log = (l) => console.log(`[om-marketplace-client] ${l}`),
}) {
  stop();
  step(log, 'removing the template shard declarations', () => removeDeclarations(zylosDir, dataDir, { env, sync, log }));
  let config = null;
  try { config = loadConfig(dataDir); } catch (err) { log(`no usable config (${err.message}); nothing is reported`); }
  const abort = new AbortController();
  const logger = createLogger('error', { log: () => {}, error: log });
  const wait = { waitMs: lockWaitMs, termGraceMs, log };
  const rt = config ? await whenUnlocked(() => createRuntime({ config, dataDir, logger, signal: abort.signal, skillsDir, zylosDir }), dataDir, wait) : null;
  const release = config ? null : await whenUnlocked(() => lockDataDir(dataDir), dataDir, wait);
  if (!rt && !release) {
    log('the service still holds the state lock; market content was left in place');
    return false;
  }
  try {
    // An unreadable inventory falls back to the marker check alone.
    const installs = rt ? step(log, 'reading the inventory', () => rt.state.read('installs', {})) : null;
    quarantineSkills(skillsDir, dataDir, installs ?? null, log);
    let tdirs = [];
    try { tdirs = fs.readdirSync(path.join(dataDir, 'templates')).filter(isCanonicalUuid); } catch { /* none */ }
    for (const id of tdirs) step(log, `quarantining template ${id}`, () => { if (quarantineTemplate(dataDir, id)) log(`template ${id} moved to quarantine`); });
    if (rt) {
      step(log, 'marking adoptions quarantined', () => rt.state.update('adoptions', {}, (d) => {
        for (const a of Object.values(d)) if (a.state === 'active' || a.state === 'writing') a.state = 'quarantined';
      }));
    }
    step(log, 'clearing slots', () => { if (fs.existsSync(path.join(dataDir, 'slots.json'))) writeSlots(dataDir, emptySlots()); });
    if (rt) await reportUninstalled(rt, abort, log, reportTimeoutMs);
  } finally {
    rt?.state.close();
    release?.();
  }
  return true;
}
