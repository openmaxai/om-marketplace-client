import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadConfig } from '../../src/config.js';
import { createRuntime } from '../../src/app.js';
import { createLogger } from '../../src/logger.js';
import { StateLockedError, readJson } from '../../src/state.js';
import { isCanonicalUuid } from '../../src/ids.js';
import { MARKER, SKILL_DIR_PREFIX } from '../../src/land.js';
import { quarantine as quarantineTemplate } from '../../src/templates.js';
import { SLOT_COUNT, declaration, defaultZylosDir, emptySlots, shardName, shardsDir, syncHooks, writeSlots } from '../../src/shards.js';

export const SERVICE = 'zylos-om-marketplace-client';
export const REPORT_TIMEOUT_MS = 10_000;
const LOCK_WAIT_MS = 15_000;

export function stopService() {
  spawnSync('pm2', ['stop', SERVICE], { stdio: 'ignore', timeout: 30_000 });
}

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

// Opens the runtime once the stopped service has released the state lock; a holder still alive after the wait is
// sent SIGTERM once. Null when the lock stays held.
async function lockedRuntime(opts, dataDir, waitMs) {
  let termed = false;
  for (const start = Date.now(); ;) {
    try {
      return createRuntime(opts);
    } catch (err) {
      if (!(err instanceof StateLockedError)) throw err;
      if (Date.now() - start > waitMs) {
        if (termed) return null;
        termed = true;
        try {
          const pid = Number(JSON.parse(fs.readFileSync(path.join(dataDir, 'state', 'lock'), 'utf8')).pid);
          if (pid > 0 && pid !== process.pid) process.kill(pid, 'SIGTERM');
        } catch { /* gone */ }
      }
      await sleep(200);
    }
  }
}

function moveAside(src, dir, name) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const dest = fs.existsSync(path.join(dir, name)) ? path.join(dir, `${name}.${Date.now()}`) : path.join(dir, name);
  fs.renameSync(src, dest);
  return dest;
}

// Moves every market-managed skill out of the skills directory into quarantine; nothing is deleted.
function quarantineSkills(skillsDir, dataDir, log) {
  let names = [];
  try { names = fs.readdirSync(skillsDir); } catch { /* none */ }
  for (const n of names.filter((x) => x.startsWith(SKILL_DIR_PREFIX))) {
    const dir = path.join(skillsDir, n);
    if (!fs.lstatSync(dir).isDirectory() || !fs.existsSync(path.join(dir, MARKER))) continue;
    log(`skill ${n} moved to ${moveAside(dir, path.join(dataDir, 'quarantine'), n)}`);
  }
}

// The four slot declarations point at emitters inside this component, which is about to be removed. Only files
// identical to what this client declares are removed; the hook sync then drops the generated session-start hooks.
function removeDeclarations(zylosDir, { env, sync, log }) {
  let removed = 0;
  for (let n = 1; n <= SLOT_COUNT; n++) {
    const file = path.join(shardsDir(zylosDir), `${shardName(n)}.json`);
    let cur = null;
    try { cur = readJson(file, null); } catch { /* not ours */ }
    if (JSON.stringify(cur) !== JSON.stringify(declaration(n))) continue;
    fs.rmSync(file);
    removed += 1;
  }
  if (!removed) return;
  log(`removed ${removed} template shard declaration(s)`);
  try { sync(zylosDir, { env }); } catch (err) { log(`hook sync failed (${err.message}); run \`zylos init\` to refresh hooks`); }
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

// Stops the service, quarantines market-managed skills and templates, removes the slot declarations and reports
// client_uninstalled (best effort, bounded). Revoked set, inventory and quarantine stay in the data dir.
export async function preUninstall({
  env = process.env, dataDir, zylosDir = defaultZylosDir(env), skillsDir = path.join(zylosDir, '.claude', 'skills'),
  stop = stopService, sync = syncHooks, lockWaitMs = LOCK_WAIT_MS, reportTimeoutMs = REPORT_TIMEOUT_MS, log = (l) => console.log(`[om-marketplace-client] ${l}`),
}) {
  stop();
  let config = null;
  try { config = loadConfig(dataDir); } catch (err) { log(`no usable config (${err.message}); nothing is reported`); }
  const abort = new AbortController();
  const logger = createLogger('error', { log: () => {}, error: log });
  const rt = config && await lockedRuntime({ config, dataDir, logger, signal: abort.signal, skillsDir, zylosDir }, dataDir, lockWaitMs);
  if (config && !rt) {
    log('the service still holds the state lock; market content was left in place');
    return false;
  }
  try {
    quarantineSkills(skillsDir, dataDir, log);
    let tdirs = [];
    try { tdirs = fs.readdirSync(path.join(dataDir, 'templates')).filter(isCanonicalUuid); } catch { /* none */ }
    for (const id of tdirs) if (quarantineTemplate(dataDir, id)) log(`template ${id} moved to quarantine`);
    rt?.state.update('adoptions', {}, (d) => {
      for (const a of Object.values(d)) if (a.state === 'active' || a.state === 'writing') a.state = 'quarantined';
    });
    if (fs.existsSync(path.join(dataDir, 'slots.json'))) writeSlots(dataDir, emptySlots());
    removeDeclarations(zylosDir, { env, sync, log });
    if (rt) await reportUninstalled(rt, abort, log, reportTimeoutMs);
  } finally {
    rt?.state.close();
  }
  return true;
}
