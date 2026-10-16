import fs from 'node:fs';
import path from 'node:path';
import { isCanonicalUuid } from './ids.js';
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
  return isCanonicalUuid(id) ? id : null;
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

// Org-scoped JWTs: the API key is exchanged at POST /auth/agent/token for one org at a time, cached per org in memory
// and (when tokenDir is set) on disk as <tokenDir>/<org_id>.json with mode 0600 in a 0700 directory.
export function createAuth({ bffUrl, apiKey, tokenDir = null, fetchImpl, timeoutMs = DEFAULT_TIMEOUT_MS, logger = SILENT_LOGGER, now = Date.now }) {
  if (!apiKey) throw new Error('api key is required');
  const base = new URL(bffUrl);
  const cache = new Map();
  const inflight = new Map();
  const last401 = new Map();

  const checkOrg = (orgId) => {
    if (!isCanonicalUuid(orgId)) throw new TypeError('orgId must be a lowercase canonical UUID');
  };
  const tokenFile = (orgId) => path.join(tokenDir, `${orgId}.json`);

  function readDisk(orgId) {
    if (!tokenDir) return null;
    try {
      const st = fs.lstatSync(tokenFile(orgId));
      if (!st.isFile()) return null;
      const s = JSON.parse(fs.readFileSync(tokenFile(orgId), 'utf8'));
      return s && typeof s.access_token === 'string' ? s : null;
    } catch {
      return null;
    }
  }

  function writeDisk(orgId, state) {
    if (!tokenDir) return;
    const file = tokenFile(orgId);
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.mkdirSync(tokenDir, { recursive: true, mode: 0o700 });
      fs.chmodSync(tokenDir, 0o700);
      const fd = fs.openSync(tmp, 'wx', 0o600);
      try {
        fs.writeSync(fd, JSON.stringify(state));
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
    // At most one 401-triggered refresh per org per window, so a persistent 401 cannot storm the auth endpoints.
    consume401Refresh(orgId) {
      const t = now();
      if (t - (last401.get(orgId) ?? -Infinity) < REFRESH_ON_401_WINDOW_MS) return false;
      last401.set(orgId, t);
      return true;
    },
  };
}
