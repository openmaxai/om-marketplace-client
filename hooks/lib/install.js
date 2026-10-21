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
  defaultDataDir,
} from '../../src/config.js';
import { defaultZylosDir } from '../../src/shards.js';
import { deriveFromOpenmax, openmaxConfigPath, readOpenmaxConfig } from './openmax.js';

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

// Fills required COCO_* values missing from the environment from the openmax component config. Returns the merged
// values, the source of every filled field, derived extra orgs and, when it could not help, why.
function fromOpenmax(values, zylosDir, home) {
  const read = readOpenmaxConfig(zylosDir, { home });
  if (!read.ok) return { values, sources: {}, reason: read.reason };
  const d = deriveFromOpenmax(read.data, values);
  return { values: d.values, sources: d.sources, extraOrgs: d.extraOrgs, reason: d.notes.join('; ') || null };
}

const SOURCE_CONTEXT = (from) => `value from the openmax component config field ${from}`;

/**
 * Returns a process exit code. Never prints configuration values; only
 * variable names and validation reasons.
 */
export async function runInstall({
  env = process.env,
  isTTY = false,
  ask = promptLine,
  dataDir,
  zylosDir = defaultZylosDir(env),
  log = console.log,
  error = console.error,
} = {}) {
  let values = envValues(env);
  const sources = Object.fromEntries(Object.keys(values).map((n) => [n, 'environment']));

  if (Object.keys(values).length === 0 && hasValidExisting(dataDir)) {
    log('[om-marketplace-client] no COCO_* variables set; keeping existing config.json');
    return 0;
  }

  let openmax = null;
  if (missingRequired(values).length) {
    openmax = fromOpenmax(values, zylosDir, env.HOME || undefined);
    values = openmax.values;
    for (const [name, from] of Object.entries(openmax.sources)) sources[name] = `openmax component config (${from})`;
  }

  if (missingRequired(values).length && isTTY) {
    log('[om-marketplace-client] some settings are missing; please enter them');
    const before = new Set(Object.keys(values));
    values = await fillInteractively(values, ask);
    for (const name of Object.keys(values)) if (!before.has(name)) sources[name] = 'prompt';
  }

  const missing = missingRequired(values);
  if (missing.length) {
    error(`[om-marketplace-client] missing required settings: ${missing.join(', ')}`);
    error(`[om-marketplace-client] not set in the environment and not provided by the openmax component config at ${openmaxConfigPath(zylosDir)}${openmax?.reason ? ` (${openmax.reason})` : ''}`);
    error('[om-marketplace-client] config.json was not written');
    return EXIT_CONFIG;
  }

  if (openmax?.reason) log(`[om-marketplace-client] openmax component config: ${openmax.reason}`);
  for (const [name] of ENV_FIELDS) if (sources[name]) log(`[om-marketplace-client] ${name}: from ${sources[name]}`);

  try {
    const { path: written, config } = writeConfig(values, dataDir, {
      tightenExisting: path.resolve(dataDir) === defaultDataDir(env),
      extraOrgs: openmax?.extraOrgs,
    });
    fs.mkdirSync(path.join(dataDir, 'logs'), { recursive: true, mode: 0o700 });
    log(`[om-marketplace-client] config written to ${written} (mode 0600)`);
    log(`[om-marketplace-client] bff_url=${config.bff_url} org_id=${config.org_id} member_id=${config.member_id} identity_id=${config.identity_id ?? '(unset)'}`);
    if (config.orgs) log(`[om-marketplace-client] additional orgs: ${Object.keys(config.orgs).join(', ')}`);
    return 0;
  } catch (err) {
    if (err instanceof ConfigError) {
      const name = ENV_FIELDS.map(([n]) => n).find((n) => err.message.startsWith(`${n} `));
      const context = name && openmax?.sources[name] ? ` (${SOURCE_CONTEXT(openmax.sources[name])})` : '';
      error(`[om-marketplace-client] invalid configuration: ${err.message}${context}`);
      return EXIT_CONFIG;
    }
    error(`[om-marketplace-client] failed to write config.json (${err.code || 'error'})`);
    return 1;
  }
}
