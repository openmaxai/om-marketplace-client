#!/usr/bin/env node
// Writes config.json from COCO_* env vars; prompts for missing values only when stdin is a TTY. Then declares the
// template session-start shards.
import { runInstall } from './lib/install.js';
import { installShards } from './lib/shards.js';
import { resolveDataDir } from '../src/config.js';

const code = await runInstall({
  env: process.env,
  isTTY: process.stdin.isTTY === true && process.stdout.isTTY === true,
  dataDir: resolveDataDir(process.env),
});
installShards();
process.exit(code);
