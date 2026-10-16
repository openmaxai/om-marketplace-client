#!/usr/bin/env node
// Never blocks the uninstall: every failure is logged and the hook exits 0.
import { resolveDataDir } from '../src/config.js';
import { preUninstall } from './lib/uninstall.js';

try {
  await preUninstall({ dataDir: resolveDataDir(process.env) });
} catch (err) {
  console.error(`[om-marketplace-client] pre-uninstall: ${err.message}`);
}
process.exit(0);
