#!/usr/bin/env node
// Writes config.json from COCO_* env vars; prompts for missing values only when stdin is a TTY.
import { runInstall } from './lib/install.js';
import { resolveDataDir } from '../src/config.js';

const code = await runInstall({
  env: process.env,
  isTTY: process.stdin.isTTY === true && process.stdout.isTTY === true,
  dataDir: resolveDataDir(process.env),
});
process.exit(code);
