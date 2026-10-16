import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isOrgOrMemberId } from './ids.js';
import { normalizeBffUrl } from './config.js';
import { DEFAULT_TIMEOUT_MS, MarketError, SILENT_LOGGER, errorFromResponse, sendJson } from './http.js';

export const REFRESH_MARGIN_MS = 60_000;
export const REFRESH_ON_401_WINDOW_MS = 10 * 60_000;

// Claims are read without signature verification; used only to learn this agent's member_id per org.
export function decodeJwtClaims(jwt) {
  try {
    const parts = String(jwt).split('.');
    if (parts.length !== 3) return null;
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return claims && typeof claims === 'object' && !Array.isArray(claims) ? claims : null;
  } catch {
    return null;
  }
}

export function memberIdFromJwt(jwt) {
  const claims = decodeJwtClaims(jwt);
  const id = claims?.member_id ?? claims?.mid;
  return isOrgOrMemberId(id) ? id : null;
}

function toMs(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') return Date.parse(v) || 0;
  return 0;
}

function toState(d, label) {
  if (!d || typeof d !== 'object' || typeof d.access_token !== 'string' || !d.access_token) {
    throw new MarketError(`${label}: response has no access_token`, { status: 200, code: 'RESPONSE_INVALID', transient: false });
  }
  const exp = decodeJwtClaims(d.access_token)?.exp;
  return {
    access_token: d.access_token,
    access_token_expires_at: toMs(d.access_token_expires_at) || (Number.isFinite(exp) ? exp * 1000 : 0),
    refresh_token: typeof d.refresh_token === 'string' && d.refresh_token ? d.refresh_token : null,
    refresh_token_expires_at: toMs(d.refresh_token_expires_at),
  };
}

const sha256Hex = (v) => crypto.createHash('sha256').update(String(v), 'utf8').digest('hex');

// Org-scoped JWTs: the API key is exchanged at POST /auth/agent/token for one org at a time, cached per org in memory
// and (when tokenDir is set) on disk as <tokenDir>/<sha256(org_id)>.json with mode 0600 in a 0700 directory. A cached
// file is used only if it was written for the same BFF origin and API key; otherwise it is deleted and the key is
// exchanged again.
export function createAuth({
  bffUrl, apiKey, tokenDir = null, fetchImpl, timeoutMs = DEFAULT_TIMEOUT_MS, logger = SILENT_LOGGER, now = Date.now,
  uid = process.getuid?.(), signal = null,
}) {
  if (!apiKey) throw new Error('api key is required');
  const origin = normalizeBffUrl(bffUrl);
  const base = new URL(origin);
  const keyFingerprint = sha256Hex(apiKey);
  const cache = new Map();
  const inflight = new Map();
  const last401 = new Map();

  const checkOrg = (orgId) => {
    if (!isOrgOrMemberId(orgId)) throw new TypeError('invalid orgId');
  };
  const tokenFile = (orgId) => path.join(tokenDir, `${sha256Hex(orgId)}.json`);

  function discard(file, why) {
    logger.warn(`ignoring cached token file ${path.basename(file)}: ${why}`);
    try { fs.unlinkSync(file); } catch { /* already gone or not ours to remove */ }
    return null;
  }

  function readDisk(orgId) {
    if (!tokenDir) return null;
    const file = tokenFile(orgId);
    let st;
    try {
      st = fs.lstatSync(file);
    } catch {
      return null;
    }
    if (!st.isFile()) return discard(file, 'not a regular file');
    if (uid !== undefined && st.uid !== uid) return discard(file, 'not owned by the current user');
    if (process.platform !== 'win32' && (st.mode & 0o077) !== 0) return discard(file, 'accessible by group/other');
    let s;
    try {
      s = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return discard(file, 'unreadable');
    }
    if (!s || typeof s !== 'object' || typeof s.access_token !== 'string') return discard(file, 'malformed');
    if (s.bff_origin !== origin || s.api_key_sha256 !== keyFingerprint || s.org_id !== orgId) {
      return discard(file, 'written for another BFF origin, API key or org');
    }
    const { bff_origin: _o, api_key_sha256: _k, org_id: _g, ...state } = s;
    return state;
  }

  // The token directory must be a real directory owned by this user; a symlink is never followed.
  function prepareTokenDir() {
    let st;
    try {
      st = fs.lstatSync(tokenDir);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      fs.mkdirSync(tokenDir, { recursive: true, mode: 0o700 });
      st = fs.lstatSync(tokenDir);
    }
    if (!st.isDirectory()) throw Object.assign(new Error('token dir is not a directory'), { code: 'ENOTDIR' });
    if (uid !== undefined && st.uid !== uid) throw Object.assign(new Error('token dir owner'), { code: 'EPERM' });
    if ((st.mode & 0o777) !== 0o700) fs.chmodSync(tokenDir, 0o700);
  }

  function writeDisk(orgId, state) {
    if (!tokenDir) return;
    const file = tokenFile(orgId);
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    try {
      prepareTokenDir();
      const fd = fs.openSync(tmp, 'wx', 0o600);
      try {
        fs.writeSync(fd, JSON.stringify({ bff_origin: origin, api_key_sha256: keyFingerprint, org_id: orgId, ...state }));
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmp, file);
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch { /* not created */ }
      logger.warn(`token cache write failed for org ${orgId} (${err.code || 'error'})`);
    }
  }

  function load(orgId) {
    let s = cache.get(orgId);
    if (!s) {
      s = readDisk(orgId);
      if (s) cache.set(orgId, s);
    }
    return s ?? null;
  }

  function store(orgId, state) {
    cache.set(orgId, state);
    writeDisk(orgId, state);
    return state;
  }

  async function post(endpoint, body, bearer) {
    const label = `auth POST ${endpoint}`;
    const r = await sendJson({
      fetchImpl,
      url: new URL(endpoint, base),
      method: 'POST',
      headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body,
      timeoutMs,
      label,
      signal,
    });
    if (r.status < 200 || r.status >= 300) throw errorFromResponse(label, r, now());
    const d = r.data && typeof r.data === 'object' && r.data.data && typeof r.data.data === 'object' ? r.data.data : r.data;
    return toState(d, label);
  }

  async function exchange(orgId) {
    logger.info(`token exchange for org ${orgId}`);
    return store(orgId, await post('/auth/agent/token', { org_id: orgId }, apiKey));
  }

  async function refreshOrExchange(orgId) {
    const s = load(orgId);
    const usable = s?.refresh_token && (!s.refresh_token_expires_at || s.refresh_token_expires_at > now());
    if (usable) {
      try {
        logger.info(`token refresh for org ${orgId}`);
        const next = await post('/auth/refresh', { refresh_token: s.refresh_token, org_id: orgId }, s.access_token);
        next.refresh_token ??= s.refresh_token;
        next.refresh_token_expires_at ||= s.refresh_token_expires_at;
        return store(orgId, next);
      } catch (err) {
        logger.warn(`token refresh for org ${orgId} failed (${err.code || err.status || 'error'}); exchanging the API key`);
      }
    }
    return exchange(orgId);
  }

  function renew(orgId) {
    if (!inflight.has(orgId)) inflight.set(orgId, refreshOrExchange(orgId).finally(() => inflight.delete(orgId)));
    return inflight.get(orgId);
  }

  async function getAccessToken(orgId) {
    checkOrg(orgId);
    const s = load(orgId);
    if (s?.access_token && s.access_token_expires_at - now() > REFRESH_MARGIN_MS) return s.access_token;
    return (await renew(orgId)).access_token;
  }

  return {
    getAccessToken,
    async refresh(orgId) {
      checkOrg(orgId);
      return (await renew(orgId)).access_token;
    },
    // The org-scoped token's member_id is this agent's {agent_id} in that org.
    async memberId(orgId) {
      return memberIdFromJwt(await getAccessToken(orgId));
    },
    // Called after a market 401 on staleToken. Resolves to true when a retry is worthwhile: another caller already
    // renewed the token, a renewal is in flight, or this call renews it. At most one 401-triggered renewal per org per
    // window, so a persistent 401 cannot storm the auth endpoints.
    async renewAfter401(orgId, staleToken) {
      checkOrg(orgId);
      const current = load(orgId)?.access_token;
      if (current && current !== staleToken) return true;
      if (inflight.has(orgId)) {
        await inflight.get(orgId);
        return true;
      }
      const t = now();
      if (t - (last401.get(orgId) ?? -Infinity) < REFRESH_ON_401_WINDOW_MS) return false;
      last401.set(orgId, t);
      await renew(orgId);
      return true;
    },
  };
}
