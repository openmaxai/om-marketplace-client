import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { Writable } from 'node:stream';
import {
  ENV_FIELDS,
  REQUIRED_ENV,
  SECRET_ENV,
  ConfigError,
  EXIT_CONFIG,
  configPath,
  loadConfig,
  missingRequired,
  writeConfig,
} from '../../src/config.js';

const PROMPTS = {
  COCO_BFF_URL: 'Workspace BFF URL (https://...)',
  COCO_API_KEY: 'Agent Workspace API key',
  COCO_ORG_ID: 'Organization ID',
  COCO_MEMBER_ID: "This Agent's member ID",
  COCO_IDENTITY_ID: "This Agent's identity ID (optional)",
};

export function envValues(env) {
  const values = {};
  for (const [name] of ENV_FIELDS) {
    const v = env[name];
    if (v != null && String(v).trim() !== '') values[name] = String(v);
  }
  return values;
}

// Reads one line from the terminal; hidden input is not echoed.
export function promptLine(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    let output = process.stdout;
    if (hidden) {
      process.stdout.write(question);
      output = new Writable({ write(_chunk, _enc, cb) { cb(); } });
    }
    const rl = readline.createInterface({ input: process.stdin, output, terminal: true });
    rl.question(hidden ? '' : question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      resolve(answer.trim());
    });
  });
}

async function fillInteractively(values, ask) {
  const filled = { ...values };
  for (const [name] of ENV_FIELDS) {
    if (filled[name]) continue;
    const optional = !REQUIRED_ENV.includes(name);
    const answer = await ask(`  ${PROMPTS[name]} [${name}]: `, { hidden: SECRET_ENV.has(name) });
    if (answer) filled[name] = answer;
    else if (!optional) break;
  }
  return filled;
}

function hasValidExisting(dataDir) {
  if (!fs.existsSync(configPath(dataDir))) return false;
  try {
    loadConfig(dataDir);
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns a process exit code. Never prints configuration values; only
 * variable names and validation reasons.
 */
export async function runInstall({
  env = process.env,
  isTTY = false,
  ask = promptLine,
  dataDir,
  log = console.log,
  error = console.error,
} = {}) {
  let values = envValues(env);

  if (Object.keys(values).length === 0 && hasValidExisting(dataDir)) {
    log('[om-marketplace-client] no COCO_* variables set; keeping existing config.json');
    return 0;
  }

  if (missingRequired(values).length && isTTY) {
    log('[om-marketplace-client] some settings are missing; please enter them');
    values = await fillInteractively(values, ask);
  }

  const missing = missingRequired(values);
  if (missing.length) {
    error(`[om-marketplace-client] missing required environment variables: ${missing.join(', ')}`);
    error('[om-marketplace-client] config.json was not written');
    return EXIT_CONFIG;
  }

  try {
    const { path: written, config } = writeConfig(values, dataDir);
    fs.mkdirSync(path.join(dataDir, 'logs'), { recursive: true, mode: 0o700 });
    log(`[om-marketplace-client] config written to ${written} (mode 0600)`);
    log(`[om-marketplace-client] bff_url=${config.bff_url} org_id=${config.org_id} member_id=${config.member_id} identity_id=${config.identity_id ?? '(unset)'}`);
    return 0;
  } catch (err) {
    if (err instanceof ConfigError) {
      error(`[om-marketplace-client] invalid configuration: ${err.message}`);
      return EXIT_CONFIG;
    }
    error(`[om-marketplace-client] failed to write config.json (${err.code || 'error'})`);
    return 1;
  }
}
