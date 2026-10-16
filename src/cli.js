#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigError, loadConfig, resolveDataDir } from './config.js';
import { CLIENT_VERSION } from './version.js';
import { createLogger } from './logger.js';
import { StateLockedError, readJson, stateScope, verifiedLockHolder } from './state.js';
import { createRuntime, pollRound } from './app.js';
import { EXIT, execute, spool } from './commands.js';
import { membershipMessage } from './orgs.js';
import { STALE_AFTER_MS } from './revocations.js';

const USAGE = `usage: market-client <command>
  status [--json]           orgs, client version gate, last pulls, installed content, queue, alerts
  sync                      run one poll round now
  rollback <slug>           restore the version kept by the last upgrade
  enable <slug>             move a disabled skill back into the skills directory
  disable <slug>            move a skill out of the skills directory
  uninstall <slug>          remove a skill and its kept versions
commands other than status wait up to --wait <seconds> (default 900) for a running service to answer`;
const SKILL_COMMANDS = new Set(['rollback', 'enable', 'disable', 'uninstall']);
const DEFAULT_WAIT_S = 900;
const POLL_MS = 250;
const RELOCK_MS = 2000;

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

// The service pid when the lock provably belongs to it; -1 when a live process whose identity cannot be checked holds
// it; null when no process holds it.
function lockHolder(dataDir) {
  const pid = verifiedLockHolder(dataDir);
  if (pid !== null) return pid;
  try {
    const other = Number(JSON.parse(fs.readFileSync(path.join(dataDir, 'state', 'lock'), 'utf8')).pid);
    if (!Number.isSafeInteger(other) || other <= 0 || other === process.pid) return null;
    process.kill(other, 0);
    return -1;
  } catch (err) {
    return err.code === 'EPERM' ? -1 : null;
  }
}

// Read-only view of the state files; takes no lock.
export function readStatus(dataDir, config, now = Date.now()) {
  const dir = path.join(dataDir, 'state', stateScope(config.bff_url, config.org_id, config.member_id));
  const doc = (name, fallback) => { try { return readJson(path.join(dir, `${name}.json`), fallback) ?? fallback; } catch { return fallback; } };
  const count = (sub) => { try { return fs.readdirSync(path.join(dir, sub)).filter((n) => n.endsWith('.json')).length; } catch { return 0; } };
  const st = doc('status', { alerts: {}, runs: {} });
  const marks = doc('orgs', {});
  const revs = doc('revocations', {});
  const queue = doc('intents', { queue: [] }).queue ?? [];
  const lastRev = revs.last_success_at ?? null;
  const orgs = Object.keys(config.orgs).map((id) => {
    const m = marks[id];
    const s = m ? (m.state === 'suspended' ? 'suspended' : 'invalid') : 'ok';
    return { org_id: id, primary: id === config.org_id, state: s, since: m?.since ?? null, message: m ? membershipMessage(id, s, id === config.org_id) : null };
  });
  const byStatus = {};
  for (const q of queue) byStatus[q.status] = (byStatus[q.status] ?? 0) + 1;
  return {
    version: CLIENT_VERSION,
    service: lockHolder(dataDir),
    orgs,
    too_old: doc('gate', {}).too_old ?? null,
    runs: st.runs ?? {},
    revocations: {
      last_success_at: lastRev,
      stale: Boolean(st.alerts?.revocations_stale) || (lastRev !== null && now - Date.parse(lastRev) > STALE_AFTER_MS),
    },
    skills: Object.entries(doc('installs', {})).map(([id, r]) => ({
      skill_id: id, slug: r.slug, version_no: r.version_no, state: r.state, org_id: r.org_id, rollback_version_no: r.rollback?.version_no ?? null,
    })),
    templates: Object.values(doc('adoptions', {})).filter((a) => a.state !== 'removed').map((a) => ({
      adoption_id: a.adoption_id, template: a.template ?? a.template_id, version: a.version ?? null, state: a.state, org_id: a.org_id,
    })),
    queue: { total: queue.length, by_status: byStatus },
    outbox: count('outbox') + Object.keys(doc('template_reports', {})).length,
    last_reconcile: doc('reconcile', {}).last ?? null,
    alerts: Object.fromEntries(Object.entries(st.alerts ?? {}).filter(([k]) => !k.startsWith('org_membership:'))),
  };
}

export function renderStatus(s) {
  const out = [`om-marketplace-client ${s.version}`];
  out.push(`service: ${s.service === null ? 'not running' : s.service > 0 ? `running (pid ${s.service})` : 'state lock held by a process that cannot be identified'}`);
  out.push('orgs:');
  for (const o of s.orgs) {
    out.push(`  ${o.org_id}${o.primary ? ' (primary)' : ''}: ${o.state}${o.since ? ` since ${o.since}` : ''}`);
    if (o.message) out.push(`    ${o.message}`);
  }
  out.push(s.too_old
    ? `client version: TOO OLD (${s.too_old.reason}${s.too_old.min_version ? `, minimum ${s.too_old.min_version}` : ''}) since ${s.too_old.since}; new orders are not executed until \`zylos upgrade om-marketplace-client\``
    : 'client version: accepted');
  const runs = Object.entries(s.runs).map(([k, r]) => `${k} ${r.outcome} at ${r.at}`);
  out.push(`last runs: ${runs.length ? runs.join('; ') : 'none yet'}`);
  out.push(`revocations last pulled: ${s.revocations.last_success_at ?? 'never'}${s.revocations.stale ? ' (STALE: no successful pull for over 24 h)' : ''}`);
  out.push(`skills (${s.skills.length}):`);
  for (const k of s.skills) {
    out.push(`  ${k.slug} v${k.version_no} ${k.state}${k.rollback_version_no ? `, v${k.rollback_version_no} kept for rollback` : ''} (org ${k.org_id})`);
  }
  out.push(`templates (${s.templates.length}):`);
  for (const t of s.templates) out.push(`  ${t.template}${t.version ? ` ${t.version}` : ''} ${t.state} (adoption ${t.adoption_id})`);
  const by = Object.entries(s.queue.by_status).map(([k, n]) => `${n} ${k}`).join(', ');
  out.push(`queue: ${s.queue.total} order(s)${by ? ` (${by})` : ''}; outbox: ${s.outbox} report(s) waiting`);
  if (s.last_reconcile) out.push(`last reconcile: ${s.last_reconcile.outcome} at ${s.last_reconcile.at}`);
  const alerts = Object.entries(s.alerts);
  out.push(`alerts (${alerts.length}):`);
  for (const [k, a] of alerts) out.push(`  ${k}: ${a.message} (since ${a.since})`);
  return out.join('\n');
}

// Runs the command with the state lock, or hands it to the lock holder (the service) and waits for its answer. A signal
// while the command runs here aborts what can be aborted and exits once the current step has finished.
async function runCommand({ cmd, arg, config, dataDir, logger, waitMs, print }) {
  const abort = new AbortController();
  const sp = spool(dataDir);
  let reqId = null;
  let local = false;
  let interrupted = false;
  const onSignal = () => {
    abort.abort();
    if (local) {
      if (!interrupted) print('interrupted; finishing the current step first');
      interrupted = true;
      return;
    }
    if (reqId && sp.withdraw(reqId)) print('request withdrawn');
    else if (reqId) print('the service already started the request; see `market-client status`');
    process.exit(130);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  try {
    const r = await commandLoop();
    return interrupted ? { ...r, code: 130 } : r;
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }

  async function commandLoop() {
    const deadline = Date.now() + waitMs;
    let nextLock = 0;
    for (;;) {
      if (Date.now() >= nextLock) {
        nextLock = Date.now() + RELOCK_MS;
        let runtime = null;
        try {
          runtime = createRuntime({ config, dataDir, logger, signal: abort.signal });
        } catch (err) {
          if (!(err instanceof StateLockedError)) throw err;
        }
        if (runtime) {
          local = true;
          try {
            if (reqId && !sp.withdraw(reqId)) return sp.take(reqId) ?? { code: EXIT.FAILED, message: 'the service stopped while running the request; check status' };
            return await execute(runtime, { cmd, arg }, pollRound(logger, runtime));
          } finally {
            runtime.state.close();
          }
        }
        if (!reqId) {
          reqId = sp.submit(cmd, arg);
          print('the service holds the state lock; the request was handed to it');
        }
      }
      const r = sp.take(reqId);
      if (r) return r;
      if (Date.now() >= deadline) {
        return sp.withdraw(reqId)
          ? { code: EXIT.BUSY, message: 'the service did not take the request in time; nothing was done' }
          : { code: EXIT.BUSY, message: 'the request is still running in the service; check `market-client status` later' };
      }
      await sleep(POLL_MS);
    }
  }
}

export async function main(argv = process.argv.slice(2), { env = process.env, print = (l) => process.stdout.write(`${l}\n`) } = {}) {
  const [cmd, ...rest] = argv;
  const opts = { json: false, wait: DEFAULT_WAIT_S };
  const pos = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--json') opts.json = true;
    else if (rest[i] === '--wait') opts.wait = Number(rest[++i]);
    else pos.push(rest[i]);
  }
  const arity = cmd === 'status' || cmd === 'sync' ? 0 : SKILL_COMMANDS.has(cmd) ? 1 : -1;
  if (arity !== pos.length || !(opts.wait >= 0)) {
    print(USAGE);
    return cmd === 'help' || cmd === '--help' ? EXIT.OK : EXIT.USAGE;
  }
  const arg = pos[0];
  const dataDir = resolveDataDir(env);
  let config;
  try {
    config = loadConfig(dataDir);
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    print(`configuration error: ${err.message}`);
    return EXIT.CONFIG;
  }
  if (cmd === 'status') {
    const s = readStatus(dataDir, config);
    print(opts.json ? JSON.stringify(s, null, 2) : renderStatus(s));
    return EXIT.OK;
  }
  const logger = createLogger(env.MARKET_CLIENT_LOG_LEVEL || 'warn', { log: (l) => process.stderr.write(`${l}\n`), error: (l) => process.stderr.write(`${l}\n`) });
  try {
    const r = await runCommand({ cmd, arg, config, dataDir, logger, waitMs: opts.wait * 1000, print });
    print(r.message);
    return r.code;
  } catch (err) {
    print(`${cmd} failed: ${err.message}`);
    return EXIT.FAILED;
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
