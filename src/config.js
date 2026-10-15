import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const COMPONENT_NAME = 'om-marketplace-client';
export const CONFIG_SCHEMA_VERSION = 1;
// sysexits EX_CONFIG; PM2 is told not to restart on it.
export const EXIT_CONFIG = 78;

// Env var -> config.json field. Order defines the key order in config.json.
export const ENV_FIELDS = [
  ['COCO_BFF_URL', 'bff_url'],
  ['COCO_ORG_ID', 'org_id'],
  ['COCO_MEMBER_ID', 'member_id'],
  ['COCO_IDENTITY_ID', 'identity_id'],
  ['COCO_API_KEY', 'api_key'],
];

export const REQUIRED_ENV = ['COCO_BFF_URL', 'COCO_API_KEY', 'COCO_ORG_ID', 'COCO_MEMBER_ID'];

export const SECRET_ENV = new Set(['COCO_API_KEY']);

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);
const LOG_LEVELS = new Set(['debug', 'info', 'warn', 'error']);

// Messages never contain configuration values, only field names and reasons.
export class ConfigError extends Error {
  constructor(message, { missing = [] } = {}) {
    super(message);
    this.name = 'ConfigError';
    this.missing = missing;
  }
}

export function defaultDataDir(env = process.env) {
  return path.join(env.HOME || os.homedir(), 'zylos', 'components', COMPONENT_NAME);
}

export function resolveDataDir(env = process.env) {
  if (env.OM_MARKETPLACE_CLIENT_HOME) return path.resolve(env.OM_MARKETPLACE_CLIENT_HOME);
  return defaultDataDir(env);
}

export function configPath(dataDir) {
  return path.join(dataDir, 'config.json');
}

export function normalizeBffUrl(raw) {
  let u;
  try {
    u = new URL(String(raw).trim());
  } catch {
    throw new ConfigError('COCO_BFF_URL is not a valid URL');
  }
  if (u.username || u.password) throw new ConfigError('COCO_BFF_URL must not contain credentials');
  if (u.protocol === 'http:') {
    if (!LOCAL_HOSTS.has(u.hostname)) {
      throw new ConfigError('COCO_BFF_URL must use https (http is allowed only for localhost/127.0.0.1)');
    }
  } else if (u.protocol !== 'https:') {
    throw new ConfigError('COCO_BFF_URL must use https');
  }
  if (u.pathname !== '/' && u.pathname !== '') throw new ConfigError('COCO_BFF_URL must not contain a path');
  if (u.search || u.hash) throw new ConfigError('COCO_BFF_URL must not contain a query or fragment');
  return `${u.protocol}//${u.host}`;
}

function cleanId(name, value) {
  const v = String(value).trim();
  if (/[\s\u0000-\u001f\u007f]/.test(v)) throw new ConfigError(`${name} contains whitespace or control characters`);
  return v;
}

export function missingRequired(values) {
  return REQUIRED_ENV.filter((name) => !String(values[name] ?? '').trim());
}

// Builds the canonical config object from env-style values (COCO_* keys).
export function buildConfig(values) {
  const missing = missingRequired(values);
  if (missing.length) {
    throw new ConfigError(`missing required variables: ${missing.join(', ')}`, { missing });
  }
  const config = { schema_version: CONFIG_SCHEMA_VERSION };
  for (const [envName, field] of ENV_FIELDS) {
    const raw = String(values[envName] ?? '').trim();
    if (envName === 'COCO_BFF_URL') config[field] = normalizeBffUrl(raw);
    else config[field] = raw ? cleanId(envName, raw) : null;
  }
  return config;
}

export function serializeConfig(config) {
  return JSON.stringify(config, null, 2) + '\n';
}

// tightenExisting: an existing directory owned by this user is narrowed to 0700 instead of refused. Only for the
// component's own data directory, which zylos add creates with the default umask before post-install runs; a directory
// chosen through OM_MARKETPLACE_CLIENT_HOME is never changed.
function prepareDataDir(dataDir, tightenExisting) {
  let st;
  try {
    st = fs.lstatSync(dataDir);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dataDir, 0o700);
    return;
  }
  if (!st.isDirectory()) throw new ConfigError(`${dataDir} exists and is not a directory`);
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) {
    throw new ConfigError(`${dataDir} is not owned by the current user`);
  }
  if (process.platform !== 'win32' && (st.mode & 0o077) !== 0) {
    if (tightenExisting) {
      fs.chmodSync(dataDir, 0o700);
      return;
    }
    throw new ConfigError(`${dataDir} is accessible by group/other (mode ${(st.mode & 0o777).toString(8)}); run chmod 700`);
  }
}

// Single write path for every install route (env, interactive, configure hook).
// Always rewrites the whole file, so a complete value set also rotates the key.
export function writeConfig(values, dataDir, { tightenExisting = false } = {}) {
  const config = buildConfig(values);
  prepareDataDir(dataDir, tightenExisting);
  const target = configPath(dataDir);
  const tmp = path.join(dataDir, `.config.json.${process.pid}.${Date.now()}.tmp`);
  try {
    const fd = fs.openSync(tmp, 'wx', 0o600);
    try {
      fs.writeSync(fd, serializeConfig(config));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, target);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* already gone */ }
    throw err;
  }
  return { path: target, config };
}

export function validateConfig(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new ConfigError('config.json must be a JSON object');
  if (obj.schema_version !== CONFIG_SCHEMA_VERSION) throw new ConfigError('config.json has an unsupported schema_version');
  const values = {};
  for (const [envName, field] of ENV_FIELDS) {
    const v = obj[field];
    if (v != null && typeof v !== 'string') throw new ConfigError(`config.json field ${field} must be a string`);
    values[envName] = v ?? '';
  }
  const missing = missingRequired(values).map((n) => ENV_FIELDS.find(([e]) => e === n)[1]);
  if (missing.length) throw new ConfigError(`config.json is missing fields: ${missing.join(', ')}`, { missing });
  const config = buildConfig(values);
  if (obj.bff_url !== config.bff_url) throw new ConfigError('config.json bff_url is not normalized');
  if (obj.log_level != null) {
    if (!LOG_LEVELS.has(obj.log_level)) throw new ConfigError('config.json log_level must be one of debug, info, warn, error');
    config.log_level = obj.log_level;
  }
  return config;
}

// Runtime entry point: reads only config.json, never env credentials.
export function loadConfig(dataDir, { uid = process.getuid?.() } = {}) {
  const file = configPath(dataDir);
  let st;
  try {
    st = fs.lstatSync(file);
  } catch {
    throw new ConfigError(`config not found at ${file}; run the post-install hook`);
  }
  if (st.isSymbolicLink()) throw new ConfigError(`${file} is a symlink`);
  if (!st.isFile()) throw new ConfigError(`${file} is not a regular file`);
  if (uid !== undefined && st.uid !== uid) throw new ConfigError(`${file} is not owned by the current user`);
  if (process.platform !== 'win32' && (st.mode & 0o077) !== 0) {
    throw new ConfigError(`${file} is accessible by group/other (mode ${(st.mode & 0o777).toString(8)}); run chmod 600`);
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new ConfigError(`${file} is not valid JSON`);
  }
  return validateConfig(parsed);
}
