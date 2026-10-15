import { loadConfig, resolveDataDir } from './config.js';
import { CLIENT_VERSION } from './version.js';
import { createLogger } from './logger.js';
import { createScheduler, POLL_INTERVAL_MS, RECONCILE_INTERVAL_MS } from './scheduler.js';

export function buildTasks(logger) {
  return [
    {
      name: 'poll',
      baseMs: POLL_INTERVAL_MS,
      run: async () => logger.debug('poll (install intents + revocations): not implemented'),
    },
    {
      name: 'reconcile',
      baseMs: RECONCILE_INTERVAL_MS,
      run: async () => logger.debug('reconcile: not implemented'),
    },
  ];
}

export async function main({ dataDir = resolveDataDir(process.env) } = {}) {
  let config;
  try {
    config = loadConfig(dataDir);
  } catch (err) {
    createLogger().error(`cannot start: ${err.message}`);
    return 1;
  }
  const logger = createLogger(config.log_level);
  logger.info(`om-marketplace-client ${CLIENT_VERSION} starting (bff_url=${config.bff_url}, org_id=${config.org_id})`);

  const scheduler = createScheduler(buildTasks(logger), { logger });
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
      resolve(0);
    };
    process.once('SIGTERM', () => shutdown('SIGTERM'));
    process.once('SIGINT', () => shutdown('SIGINT'));
  });
}
