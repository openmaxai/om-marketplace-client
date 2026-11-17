import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigError, EXIT_CONFIG, configPath, loadConfig } from './config.js';

export const SERVICE_NAME = 'zylos-om-marketplace-client';
export const SKILL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ECOSYSTEM = path.join(SKILL_ROOT, 'ecosystem.config.cjs');
export const POST_INSTALL = path.join(SKILL_ROOT, 'hooks', 'post-install.js');
// How long the service is given to take the state lock after pm2 started it.
export const LOCK_WAIT_MS = 30 * 1000;
// Intent pull outcomes that mean the market answered the pull.
const PULLED = new Set(['ok', 'partial', 'queue_full']);
const PM2_TIMEOUT_MS = 30 * 1000;

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

// pm2 through its CLI. status(name) is the app's pm2 status (online, stopped, errored, ...) or null when pm2 does not
// know it.
export function createPm2({ run = execFile, bin = 'pm2' } = {}) {
  const call = (args) => new Promise((resolve, reject) => {
    run(bin, args, { timeout: PM2_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`pm2 ${args[0]} failed: ${String(stderr ?? '').trim().split('\n').at(-1) || err.message}`));
      return resolve(String(stdout ?? ''));
    });
  });
  return {
    async status(name) {
      const out = await call(['jlist']);
      const start = out.indexOf('[');
      let list;
      try { list = JSON.parse(out.slice(start)); } catch { throw new Error('pm2 jlist output unreadable'); }
      if (start < 0 || !Array.isArray(list)) throw new Error('pm2 jlist output unreadable');
      return list.find((p) => p?.name === name)?.pm2_env?.status ?? null;
    },
    start: (ecosystem) => call(['start', ecosystem]),
    remove: (name) => call(['delete', name]),
    save: () => call(['save']),
  };
}

// Runs the post-install hook in this process's environment; resolves to its exit code.
export function runPostInstall({ env = process.env, hook = POST_INSTALL } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [hook], { cwd: SKILL_ROOT, env, stdio: 'inherit' });
    child.on('error', () => resolve(1));
    child.on('exit', (code, signal) => resolve(signal ? 1 : code ?? 1));
  });
}

const readText = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } };

// Makes sure the service runs and has pulled install orders from the market: runs the post-install hook (keeps an
// existing config), starts the pm2 app when it is not online or its config changed, saves the pm2 process list, asks
// the service for one poll round and checks that its install order pull succeeded. Returns {code, message}.
// sync(config) runs one poll round (handed to the service); readStatus(config) is the `status --json` view.
export async function startService({
  dataDir, pm2 = createPm2(), postInstall = () => runPostInstall(), sync, readStatus, print = () => {}, now = Date.now, wait = sleep,
  lockWaitMs = LOCK_WAIT_MS, ecosystem = ECOSYSTEM,
}) {
  const fail = (message, code = 1) => ({ code, message });
  const before = readText(configPath(dataDir));
  const hook = await postInstall();
  if (hook !== 0) return fail(`post-install failed (exit ${hook}); the service was not started`, hook === EXIT_CONFIG ? EXIT_CONFIG : 1);
  let config;
  try {
    config = loadConfig(dataDir);
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    return fail(`configuration error: ${err.message}`, EXIT_CONFIG);
  }
  const changed = before !== null && readText(configPath(dataDir)) !== before;
  const since = now();
  let st;
  try {
    st = await pm2.status(SERVICE_NAME);
  } catch (err) {
    return fail(`${err.message}; the service cannot be started without pm2`);
  }
  try {
    if (st !== 'online' || changed) {
      if (st !== null) await pm2.remove(SERVICE_NAME);
      print(st === 'online' ? 'configuration changed; restarting the service' : `starting the service (pm2 status: ${st ?? 'not registered'})`);
      await pm2.start(ecosystem);
    }
    await pm2.save();
  } catch (err) {
    return fail(err.message);
  }
  // A poll round run before the service holds the lock would run in this process instead, so wait for it first.
  for (const end = now() + lockWaitMs; !(readStatus(config).service > 0);) {
    if (now() >= end) return fail(`the service did not start within ${lockWaitMs / 1000} s; see pm2 logs ${SERVICE_NAME}`);
    await wait(500);
  }
  const round = await sync(config);
  const s = readStatus(config);
  const run = s.runs?.intents;
  const pulled = run && PULLED.has(run.outcome) && Date.parse(run.at) >= since - 1000;
  try {
    st = await pm2.status(SERVICE_NAME);
  } catch (err) {
    return fail(err.message);
  }
  if (st !== 'online' || !(s.service > 0)) return fail(`the service is not running (pm2 status: ${st ?? 'not registered'}); see pm2 logs ${SERVICE_NAME}`);
  if (!pulled) {
    const alerts = Object.entries(s.alerts ?? {}).map(([k, a]) => `${k}: ${a.message}`);
    return fail([
      `the service runs but has not pulled install orders from the market (${round.message}; last pull: ${run ? `${run.outcome} at ${run.at}` : 'none'})`,
      ...alerts.map((a) => `  ${a}`),
    ].join('\n'));
  }
  return { code: 0, message: `service running (pid ${s.service}) and install orders pulled at ${run.at}` };
}
