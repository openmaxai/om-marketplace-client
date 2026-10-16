import path from 'node:path';
import { EXIT_CONFIG, loadConfig, resolveDataDir } from './config.js';
import { CLIENT_VERSION } from './version.js';
import { createLogger } from './logger.js';
import { createScheduler, POLL_INTERVAL_MS, RECONCILE_INTERVAL_MS } from './scheduler.js';
import { createAuth } from './auth.js';
import { createMarketHttp } from './http.js';
import { createMarketApi } from './market-api.js';
import { openState } from './state.js';
import { createOrgs } from './orgs.js';
import { createIntentPuller } from './intents.js';
import { createRevocationPuller } from './revocations.js';
import { vendoredPolicyMatchesPin } from './policy/pin.js';

// Revocations are pulled before intents in every round so that a later install sees the newest revoked set. A round
// is skipped while the token's member id contradicts the configured one.
export function buildTasks(logger, { revocations, intents, identity, now = Date.now } = {}) {
  return [
    {
      name: 'poll',
      baseMs: POLL_INTERVAL_MS,
      run: async () => {
        if (!revocations || !intents) return logger.debug('poll: not wired');
        if (identity && !(await identity())) return undefined;
        try {
          await revocations.pull();
        } finally {
          await intents.pull();
        }
        return { minDelayMs: Math.max(revocations.notBefore?.() ?? 0, intents.notBefore?.() ?? 0) - now() };
      },
    },
    {
      name: 'reconcile',
      baseMs: RECONCILE_INTERVAL_MS,
      run: async () => logger.debug('reconcile: not implemented'),
    },
  ];
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
export function createRuntime({ config, dataDir, logger, fetchImpl, signal = null }) {
  const state = openState(dataDir, { bffUrl: config.bff_url, orgId: config.org_id, memberId: config.member_id });
  try {
    if (!vendoredPolicyMatchesPin()) {
      state.setAlert('policy_pin', 'vendored skill policy does not match its pin; installs are refused');
      logger.error('vendored skill policy does not match its pin; installs are refused');
    } else {
      state.clearAlert('policy_pin');
    }
    const auth = createAuth({ bffUrl: config.bff_url, apiKey: config.api_key, tokenDir: path.join(dataDir, 'tokens'), fetchImpl, logger, signal });
    const api = createMarketApi({ http: createMarketHttp({ bffUrl: config.bff_url, auth, fetchImpl, logger, signal }) });
    const orgs = createOrgs({ config, state, auth, logger });
    return {
      state,
      orgs,
      identity: identityCheck({ config, auth, state, logger }),
      intents: createIntentPuller({ api, state, orgs, logger }),
      revocations: createRevocationPuller({ api, state, orgs, logger }),
    };
  } catch (err) {
    state.close();
    throw err;
  }
}

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
  let stopping = false;
  const abort = new AbortController();
  let finish;
  const done = new Promise((resolve) => { finish = resolve; });
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    logger.info(`${signal} received, shutting down`);
    clearInterval(keepAlive);
    abort.abort();
    await scheduler?.stop();
    runtime?.state.close();
    finish(0);
  };
  const onTerm = () => shutdown('SIGTERM');
  const onInt = () => shutdown('SIGINT');
  process.once('SIGTERM', onTerm);
  process.once('SIGINT', onInt);

  logger.info(`om-marketplace-client ${CLIENT_VERSION} starting (bff_url=${config.bff_url}, org_id=${config.org_id})`);
  try {
    runtime = createRuntime({ config, dataDir, logger, signal: abort.signal });
  } catch (err) {
    process.off('SIGTERM', onTerm);
    process.off('SIGINT', onInt);
    logger.error(`cannot start: ${err.message}`);
    return EXIT_CONFIG;
  }
  scheduler = createScheduler(buildTasks(logger, runtime), { logger });
  scheduler.start();
  keepAlive = setInterval(() => {}, 1 << 30);
  return done;
}
