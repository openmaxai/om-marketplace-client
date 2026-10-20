import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isOrgOrMemberId } from './ids.js';

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
  ['COCO_CF_ACCESS_CLIENT_ID', 'cf_access_client_id'],
  ['COCO_CF_ACCESS_CLIENT_SECRET', 'cf_access_client_secret'],
];

export const REQUIRED_ENV = ['COCO_BFF_URL', 'COCO_API_KEY', 'COCO_ORG_ID', 'COCO_MEMBER_ID'];

export const SECRET_ENV = new Set(['COCO_API_KEY', 'COCO_CF_ACCESS_CLIENT_SECRET']);

// Cloudflare Access service token: optional, but both values or neither. Omitted from config.json when unset.
const CF_ACCESS_ENV = ['COCO_CF_ACCESS_CLIENT_ID', 'COCO_CF_ACCESS_CLIENT_SECRET'];
const OMIT_WHEN_UNSET = new Set(CF_ACCESS_ENV);

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

// Dev only: a storage emulator origin is accepted only with a loopback http market and must itself be loopback.
export function emulatorOrigin(raw, bffUrl) {
  const bad = () => new ConfigError('config.json storage_emulator_origin is allowed only as a loopback origin with a loopback http bff_url');
  let u;
  try { u = new URL(String(raw)); } catch { throw bad(); }
  const bff = new URL(bffUrl);
  if (bff.protocol !== 'http:' || !LOCAL_HOSTS.has(bff.hostname) || !LOCAL_HOSTS.has(u.hostname)
    || !['http:', 'https:'].includes(u.protocol) || String(raw).replace(/\/$/, '') !== u.origin) throw bad();
  return u.origin;
}

function cleanId(name, value) {
  const v = String(value).trim();
  if (/[\s\u0000-\u001f\u007f]/.test(v)) throw new ConfigError(`${name} contains whitespace or control characters`);
  return v;
}

// Sent as an HTTP header value: visible ASCII only.
function headerValue(name, value) {
  if (!/^[\x21-\x7e]{1,4096}$/.test(value)) throw new ConfigError(`${name} must be visible ASCII without spaces`);
  return value;
}

// {clientId, clientSecret} when a Cloudflare Access service token is configured, else null.
export function cfAccessFromConfig(config) {
  if (!config?.cf_access_client_id || !config?.cf_access_client_secret) return null;
  return { clientId: config.cf_access_client_id, clientSecret: config.cf_access_client_secret };
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
  const set = CF_ACCESS_ENV.filter((n) => String(values[n] ?? '').trim());
  if (set.length === 1) throw new ConfigError('Cloudflare Access client id and client secret must be set together');
  const config = { schema_version: CONFIG_SCHEMA_VERSION };
  for (const [envName, field] of ENV_FIELDS) {
    const raw = String(values[envName] ?? '').trim();
    if (envName === 'COCO_BFF_URL') config[field] = normalizeBffUrl(raw);
    else if (raw && OMIT_WHEN_UNSET.has(envName)) config[field] = headerValue(envName, raw);
    else if (!OMIT_WHEN_UNSET.has(envName)) config[field] = raw ? cleanId(envName, raw) : null;
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

// orgs: {<org_id>: {member_id?}}. The primary org_id/member_id is always part of the map; a member_id left out is read
// from that org's token at run time.
export function normalizeOrgs(raw, primaryOrg, primaryMember) {
  if (raw != null && (typeof raw !== 'object' || Array.isArray(raw))) throw new ConfigError('config.json orgs must be an object');
  const orgs = {};
  for (const [orgId, entry] of Object.entries(raw ?? {})) {
    if (!isOrgOrMemberId(orgId) || orgId === '__proto__') throw new ConfigError('config.json orgs has an invalid org id');
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new ConfigError('config.json orgs entries must be objects');
    if (Object.keys(entry).some((k) => k !== 'member_id')) throw new ConfigError('config.json orgs entries allow only member_id');
    const m = entry.member_id ?? null;
    if (m !== null && !isOrgOrMemberId(m)) throw new ConfigError('config.json orgs has an invalid member_id');
    orgs[orgId] = { member_id: m };
  }
  if (!isOrgOrMemberId(primaryOrg) || primaryOrg === '__proto__') throw new ConfigError('config.json org_id is not a valid id');
  if (!isOrgOrMemberId(primaryMember)) throw new ConfigError('config.json member_id is not a valid id');
  const listed = orgs[primaryOrg]?.member_id;
  if (listed && listed !== primaryMember) throw new ConfigError('config.json orgs disagrees with member_id for org_id');
  return { [primaryOrg]: { member_id: primaryMember }, ...Object.fromEntries(Object.entries(orgs).filter(([k]) => k !== primaryOrg)) };
}

// The primary entry is dropped so a rewritten org_id/member_id cannot conflict with it.
function existingOrgs(dataDir, primaryOrg) {
  try {
    const orgs = JSON.parse(fs.readFileSync(configPath(dataDir), 'utf8'))?.orgs;
    if (!orgs || typeof orgs !== 'object' || Array.isArray(orgs)) return undefined;
    const rest = Object.entries(orgs).filter(([k]) => k !== primaryOrg);
    return rest.length ? Object.fromEntries(rest) : undefined;
  } catch {
    return undefined;
  }
}

// Single write path for every install route (env, interactive, configure hook).
// Always rewrites the whole file, so a complete value set also rotates the key; a hand-edited orgs map is kept.
export function writeConfig(values, dataDir, { tightenExisting = false } = {}) {
  const config = buildConfig(values);
  prepareDataDir(dataDir, tightenExisting);
  const orgs = existingOrgs(dataDir, config.org_id);
  if (orgs) config.orgs = orgs;
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
  config.orgs = normalizeOrgs(obj.orgs, config.org_id, config.member_id);
  if (obj.storage_emulator_origin != null) config.storage_emulator_origin = emulatorOrigin(obj.storage_emulator_origin, config.bff_url);
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
