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

// Revocations are pulled before intents in every round so that a later install sees the newest revoked set.
export function buildTasks(logger, { revocations, intents } = {}) {
  return [
    {
      name: 'poll',
      baseMs: POLL_INTERVAL_MS,
      run: async () => {
        if (!revocations || !intents) return logger.debug('poll: not wired');
        try {
          await revocations.pull();
        } finally {
          await intents.pull();
        }
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

// Opens the state store (single-instance lock) and builds the pull loops.
export function createRuntime({ config, dataDir, logger, fetchImpl }) {
  const state = openState(dataDir, { bffUrl: config.bff_url, orgId: config.org_id, memberId: config.member_id });
  try {
    if (!vendoredPolicyMatchesPin()) {
      state.setAlert('policy_pin', 'vendored skill policy does not match its pin; installs are refused');
      logger.error('vendored skill policy does not match its pin; installs are refused');
    } else {
      state.clearAlert('policy_pin');
    }
    const auth = createAuth({ bffUrl: config.bff_url, apiKey: config.api_key, tokenDir: path.join(dataDir, 'tokens'), fetchImpl, logger });
    const api = createMarketApi({ http: createMarketHttp({ bffUrl: config.bff_url, auth, fetchImpl, logger }) });
    const orgs = createOrgs({ config, state, auth, logger });
    return {
      state,
      orgs,
      intents: createIntentPuller({ api, state, orgs, logger }),
      revocations: createRevocationPuller({ api, state, orgs, logger }),
    };
  } catch (err) {
    state.close();
    throw err;
  }
}

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
  logger.info(`om-marketplace-client ${CLIENT_VERSION} starting (bff_url=${config.bff_url}, org_id=${config.org_id})`);

  let runtime;
  try {
    runtime = createRuntime({ config, dataDir, logger });
  } catch (err) {
    logger.error(`cannot start: ${err.message}`);
    return EXIT_CONFIG;
  }
  const scheduler = createScheduler(buildTasks(logger, runtime), { logger });
  scheduler.start();
  const keepAlive = setInterval(() => {}, 1 << 30);

  return new Promise((resolve) => {
    let stopping = false;
    const shutdown = async (signal) => {
      if (stopping) return;
      stopping = true;
      logger.info(`${signal} received, shutting down`);
      clearInterval(keepAlive);
      await scheduler.stop();
      runtime.state.close();
      resolve(0);
    };
    process.once('SIGTERM', () => shutdown('SIGTERM'));
    process.once('SIGINT', () => shutdown('SIGINT'));
  });
}
