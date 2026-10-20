import os from 'node:os';
import path from 'node:path';
import { EXIT_CONFIG, cfAccessFromConfig, loadConfig, resolveDataDir } from './config.js';
import { CLIENT_VERSION } from './version.js';
import { createLogger } from './logger.js';
import { createScheduler, POLL_INTERVAL_MS } from './scheduler.js';
import { createAuth } from './auth.js';
import { createMarketHttp } from './http.js';
import { createMarketApi } from './market-api.js';
import { StateLockedError, openState } from './state.js';
import { createOrgs } from './orgs.js';
import { createIntentPuller } from './intents.js';
import { createRevocationPuller } from './revocations.js';
import { createSkills } from './skills.js';
import { createTemplates } from './templates.js';
import { createReconciler } from './reconcile.js';
import { defaultZylosDir } from './shards.js';
import { vendoredPolicyMatchesPin } from './policy/pin.js';
import { EXIT, execute, spool } from './commands.js';

// Revocations are pulled before intents in every round so that a later install sees the newest revoked set; then the
// queued skill intents run, then at most one template intent, then reconcile when it is due (reconcile.maybeRun), so
// a scan never runs alongside an install. A round is skipped while the token's member id contradicts the configured one.
export function pollRound(logger, { revocations, intents, skills, templates, reconcile, identity, now = Date.now } = {}) {
  return async () => {
    if (!revocations || !intents) return logger.debug('poll: not wired');
    if (identity && !(await identity())) return undefined;
    try {
      await revocations.pull();
    } finally {
      await intents.pull();
    }
    try {
      try {
        await skills?.runRound();
      } finally {
        await templates?.runNext();
      }
    } finally {
      await reconcile?.maybeRun();
    }
    return { minDelayMs: Math.max(revocations.notBefore?.() ?? 0, intents.notBefore?.() ?? 0) - now() };
  };
}

// CLI requests waiting in `commands` run first, one at a time; a sync request is answered when the round ends.
export function buildTasks(logger, runtime = {}, commands = null) {
  const round = pollRound(logger, runtime);
  return [
    {
      name: 'poll',
      baseMs: POLL_INTERVAL_MS,
      run: async () => {
        const reqs = commands?.claim() ?? [];
        const syncs = reqs.filter((r) => r.cmd === 'sync');
        for (const r of reqs.filter((x) => x.cmd !== 'sync')) {
          let res;
          try { res = await execute(runtime, r); } catch (err) { res = { code: EXIT.FAILED, message: err.message }; }
          commands.answer(r.id, res);
        }
        try {
          const out = await round();
          for (const r of syncs) commands.answer(r.id, { code: EXIT.OK, message: 'poll round finished' });
          return out;
        } catch (err) {
          for (const r of syncs) commands.answer(r.id, { code: EXIT.FAILED, message: `poll round failed: ${err.message}` });
          throw err;
        }
      },
    },
  ];
}

// New revocations quarantine installed skills first, then template adoptions. Both always run; a failure is rethrown
// afterwards so the revocation cursor stays put and the page is enforced again.
export function revocationEnforcer({ skills, templates }) {
  return async () => {
    let failure = null;
    for (const step of [() => skills?.enforceRevocations(), () => templates()?.sweepRevoked()]) {
      try { step(); } catch (err) { failure ??= err; }
    }
    if (failure) throw failure;
  };
}

// Install-time variables must not linger in the service env; only names are logged.
export function scrubInstallEnv(env, logger) {
  const names = Object.keys(env).filter((k) => k.startsWith('COCO_')).sort();
  if (names.length) {
    logger.warn(`ignoring and removing install-time variables from the environment: ${names.join(', ')}; unset them after install`);
    for (const k of names) delete env[k];
  }
  return names;
}

// Checks once per process that the org-scoped token belongs to the configured member, so a key of another agent never
// continues this agent's cursors. A token without a member id claim, or a failed exchange, does not block.
function identityCheck({ config, auth, state, logger }) {
  let verified = false;
  return async () => {
    if (verified) return true;
    let claim;
    try {
      claim = await auth.memberId(config.org_id);
    } catch {
      return true;
    }
    if (claim && claim !== config.member_id) {
      const msg = `the API key belongs to member ${claim}, not the configured member ${config.member_id}; pulling is stopped until the configuration is fixed`;
      if (state.setAlert('identity_mismatch', msg)) logger.error(msg);
      return false;
    }
    verified = true;
    state.clearAlert('identity_mismatch');
    return true;
  };
}

// Opens the state store (single-instance lock) and builds the pull loops; aborting `signal` cancels in-flight requests.
export function createRuntime({
  config, dataDir, logger, fetchImpl, signal = null, skillsDir = path.join(process.env.HOME || os.homedir(), 'zylos', '.claude', 'skills'),
  zylosDir = defaultZylosDir(),
}) {
  const state = openState(dataDir, { bffUrl: config.bff_url, orgId: config.org_id, memberId: config.member_id });
  try {
    const pinned = vendoredPolicyMatchesPin();
    if (!pinned) {
      state.setAlert('policy_pin', 'vendored skill policy does not match its pin; installs are refused');
      logger.error('vendored skill policy does not match its pin; installs are refused');
    } else {
      state.clearAlert('policy_pin');
    }
    const cfAccess = cfAccessFromConfig(config);
    const auth = createAuth({
      bffUrl: config.bff_url, apiKey: config.api_key, tokenDir: path.join(dataDir, 'tokens'), fetchImpl, logger, signal, cfAccess,
    });
    const api = createMarketApi({ http: createMarketHttp({ bffUrl: config.bff_url, auth, fetchImpl, logger, signal, cfAccess }) });
    const orgs = createOrgs({ config, state, auth, logger });
    const skills = createSkills({
      api, state, orgs, logger, bffUrl: config.bff_url, skillsDir, dataDir, emulatorOrigin: config.storage_emulator_origin ?? null, fetchImpl, signal,
      installsAllowed: pinned,
    });
    let templates = null;
    const revocations = createRevocationPuller({ api, state, orgs, logger, enforce: revocationEnforcer({ skills, templates: () => templates }) });
    templates = createTemplates({
      api, state, orgs, logger, dataDir, zylosDir, revocations, emulatorOrigin: config.storage_emulator_origin ?? null, fetchImpl, signal,
    });
    return {
      state,
      api,
      orgs,
      skills,
      identity: identityCheck({ config, auth, state, logger }),
      intents: createIntentPuller({ api, state, orgs, logger }),
      revocations,
      templates,
      reconcile: createReconciler({ api, state, orgs, skills, templates, logger }),
    };
  } catch (err) {
    state.close();
    throw err;
  }
}

const LOCK_RETRY_MS = 2000;
const SPOOL_CHECK_MS = 1000;

// Signal handlers are installed before any state is opened, so a stop request during start-up still releases the lock.
export async function main({ dataDir } = {}) {
  scrubInstallEnv(process.env, createLogger());
  dataDir ??= resolveDataDir(process.env);
  let config;
  try {
    config = loadConfig(dataDir);
  } catch (err) {
    createLogger().error(`cannot start: ${err.message}`);
    return EXIT_CONFIG;
  }
  const logger = createLogger(config.log_level);

  let runtime = null;
  let scheduler = null;
  let keepAlive = null;
  let lockWait = null;
  let stopping = false;
  const abort = new AbortController();
  let finish;
  const done = new Promise((resolve) => { finish = resolve; });
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    logger.info(`${signal} received, shutting down`);
    clearInterval(keepAlive);
    lockWait?.();
    abort.abort();
    await scheduler?.stop();
    runtime?.state.close();
    finish(0);
  };
  const onTerm = () => shutdown('SIGTERM');
  const onInt = () => shutdown('SIGINT');
  process.once('SIGTERM', onTerm);
  process.once('SIGINT', onInt);

  logger.info(`om-marketplace-client ${CLIENT_VERSION} starting (bff_url=${config.bff_url}, org_id=${config.org_id}, cf_access=${cfAccessFromConfig(config) ? 'on' : 'off'})`);
  // A CLI command may hold the lock for a while; wait for it rather than exit.
  for (let waited = false; !stopping && !runtime;) {
    try {
      runtime = createRuntime({ config, dataDir, logger, signal: abort.signal });
    } catch (err) {
      if (err instanceof StateLockedError) {
        if (!waited) logger.warn(`${err.message}; waiting for it to finish`);
        waited = true;
        await new Promise((r) => { lockWait = r; setTimeout(r, LOCK_RETRY_MS); });
        continue;
      }
      process.off('SIGTERM', onTerm);
      process.off('SIGINT', onInt);
      logger.error(`cannot start: ${err.message}`);
      return EXIT_CONFIG;
    }
  }
  if (stopping) {
    runtime?.state.close();
    return done;
  }
  const commands = spool(dataDir);
  scheduler = createScheduler(buildTasks(logger, runtime, commands), { logger });
  scheduler.start();
  keepAlive = setInterval(() => { if (commands.pending()) scheduler.runNow('poll'); }, SPOOL_CHECK_MS);
  return done;
}
