#!/usr/bin/env node
// zylos configure hook: reads COCO_* values as stdin JSON and writes config.json via the shared writer.
import fs from 'node:fs';
import { runInstall } from './lib/install.js';
import { EXIT_CONFIG, resolveDataDir } from '../src/config.js';

let values = {};
try {
  const raw = fs.readFileSync(0, 'utf8');
  if (raw.trim()) values = JSON.parse(raw);
} catch {
  console.error('[om-marketplace-client] configure: stdin is not valid JSON');
  process.exit(EXIT_CONFIG);
}
if (!values || typeof values !== 'object' || Array.isArray(values)) {
  console.error('[om-marketplace-client] configure: stdin must be a JSON object');
  process.exit(EXIT_CONFIG);
}

// Stdin values take precedence over the process environment.
const env = { ...process.env, ...values };
const code = await runInstall({ env, isTTY: false, dataDir: resolveDataDir(process.env) });
process.exit(code);
