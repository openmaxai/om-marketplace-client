#!/usr/bin/env node
import { main } from './app.js';
import { EXIT_CONFIG } from './config.js';

const flush = (stream) => new Promise((resolve) => stream.write('', resolve));

const code = await main();
if (code === EXIT_CONFIG) {
  // Exit explicitly: a supervisor's IPC channel (pm2) keeps the event loop alive, so exitCode alone never ends the process.
  await Promise.all([flush(process.stdout), flush(process.stderr)]);
  process.exit(code);
}
process.exitCode = code;
