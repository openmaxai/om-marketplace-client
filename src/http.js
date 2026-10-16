import { buildHeaders } from './version.js';
import { isOrgOrMemberId } from './ids.js';
import { normalizeBffUrl } from './config.js';

export const DEFAULT_TIMEOUT_MS = 30_000;
export const MAX_RESPONSE_BYTES = 1024 * 1024;
export const MAX_RETRY_AFTER_MS = 60 * 60 * 1000;
const TRANSIENT_STATUS = new Set([408, 429]);
const CODE_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
const JSON_TYPES = new Set(['application/json', 'application/problem+json']);
export const SILENT_LOGGER = Object.freeze({ debug() {}, info() {}, warn() {}, error() {} });

// Messages carry method, path, status and code only; never headers, bodies or credentials.
export class MarketError extends Error {
  constructor(message, {
    status = 0, code = null, reason = null, min_version = null, installed_by_org_id = null,
    errors = null, details = null, retryAfterMs = null, transient,
  } = {}) {
    super(message);
    this.name = 'MarketError';
    Object.assign(this, { status, code, reason, min_version, installed_by_org_id, errors, details, retryAfterMs });
    this.transient = transient ?? (TRANSIENT_STATUS.has(status) || status >= 500);
  }
}

// Retry-After as delta-seconds or IMF-fixdate; capped so a hostile value cannot park the client.
export function parseRetryAfter(value, nowMs = Date.now()) {
  if (value == null) return null;
  const v = String(value).trim();
  let ms;
  if (/^\d{1,10}$/.test(v)) ms = Number(v) * 1000;
  else if (/GMT$/.test(v) && !Number.isNaN(Date.parse(v))) ms = Math.max(0, Date.parse(v) - nowMs);
  else return null;
  return Math.min(ms, MAX_RETRY_AFTER_MS);
}

// Jittered exponential backoff that never undercuts the server's Retry-After.
export function backoffMs(err, attempt, rand = Math.random) {
  const base = Math.min(1000 * 2 ** Math.max(0, attempt), 5 * 60_000);
  return Math.max(err?.retryAfterMs ?? 0, Math.round(base * (0.5 + rand() / 2)));
}

function problemFields(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
  const str = (v) => (typeof v === 'string' && v.length <= 256 ? v : null);
  return {
    code: typeof data.code === 'string' && CODE_RE.test(data.code) ? data.code : null,
    reason: str(data.reason),
    min_version: str(data.min_version),
    installed_by_org_id: isOrgOrMemberId(data.installed_by_org_id) ? data.installed_by_org_id : null,
    errors: Array.isArray(data.errors) ? data.errors : null,
    details: data.details && typeof data.details === 'object' ? data.details : null,
  };
}

export function errorFromResponse(label, r, nowMs = Date.now()) {
  const p = problemFields(r.data);
  const retryAfterMs = parseRetryAfter(r.headers.get('retry-after'), nowMs);
  return new MarketError(`${label}: HTTP ${r.status}${p.code ? ` ${p.code}` : ''}`, { status: r.status, ...p, retryAfterMs });
}

async function readLimited(res, max, label) {
  const tooLarge = () => new MarketError(`${label}: response too large`, { status: res.status, code: 'RESPONSE_TOO_LARGE', transient: false });
  if (Number(res.headers.get('content-length')) > max) {
    await res.body?.cancel().catch(() => {});
    throw tooLarge();
  }
  if (!res.body) return Buffer.alloc(0);
  const chunks = [];
  let total = 0;
  for await (const chunk of res.body) {
    total += chunk.length;
    if (total > max) throw tooLarge();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// One HTTP exchange: timeout covers headers and body, redirects are never followed, body size is capped. An abort
// of `signal` (shutdown) ends the exchange early.
export async function sendJson({
  fetchImpl = globalThis.fetch, url, method, headers, body, timeoutMs = DEFAULT_TIMEOUT_MS, label, signal: stop = null,
}) {
  const timeout = AbortSignal.timeout(timeoutMs);
  const ctl = new AbortController();
  const onAbort = () => ctl.abort();
  timeout.addEventListener('abort', onAbort, { once: true });
  stop?.addEventListener('abort', onAbort, { once: true });
  if (stop?.aborted) ctl.abort();
  const { signal } = ctl;
  const netError = () => {
    const [code, what] = stop?.aborted ? ['ABORTED', 'aborted'] : timeout.aborted ? ['TIMEOUT', 'timed out'] : ['NETWORK_ERROR', 'network error'];
    return new MarketError(`${label}: ${what}`, { code, transient: true });
  };
  let res;
  let raw;
  try {
    res = await fetchImpl(url, {
      method, headers, redirect: 'manual', signal, body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel().catch(() => {});
      throw new MarketError(`${label}: redirect refused`, { status: res.status, code: 'REDIRECT_REFUSED', transient: false });
    }
    raw = await readLimited(res, MAX_RESPONSE_BYTES, label);
  } catch (err) {
    if (err instanceof MarketError) throw err;
    throw netError();
  } finally {
    timeout.removeEventListener('abort', onAbort);
    stop?.removeEventListener('abort', onAbort);
  }
  const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  let data = null;
  if (raw.length && JSON_TYPES.has(type)) {
    try { data = JSON.parse(raw.toString('utf8')); } catch { data = null; }
  }
  return { status: res.status, headers: res.headers, type, data, empty: raw.length === 0 };
}

// Market calls under {bffUrl}/api/v1/orgs/{orgId}. Only the bearer token, the client version and content
// negotiation headers are sent; callers cannot add headers. subPath segments must already be percent-encoded.
export function createMarketHttp({
  bffUrl, auth, fetchImpl, timeoutMs = DEFAULT_TIMEOUT_MS, logger = SILENT_LOGGER, now = Date.now, signal = null,
}) {
  const base = new URL(normalizeBffUrl(bffUrl));
  async function request(method, orgId, subPath, body) {
    if (!isOrgOrMemberId(orgId)) throw new TypeError('invalid orgId');
    // %2E and %2F are refused because URL parsing treats them as dot segments or separators.
    if (!/^\/(?:[A-Za-z0-9\-._~:/]|%[0-9A-F]{2})*$/.test(subPath) || /%2[EF]/.test(subPath)
      || subPath.includes('//') || /(^|\/)\.\.?(\/|$)/.test(subPath)) {
      throw new TypeError('invalid market path');
    }
    const url = new URL(`/api/v1/orgs/${encodeURIComponent(orgId)}${subPath}`, base);
    if (url.origin !== base.origin) throw new TypeError('market path left the configured origin');
    const label = `market ${method} ${url.pathname}`;
    const send = async () => {
      const token = await auth.getAccessToken(orgId);
      const headers = buildHeaders(token, {
        Accept: 'application/json, application/problem+json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      });
      logger.debug(label);
      return { token, r: await sendJson({ fetchImpl, url, method, headers, body, timeoutMs, label, signal }) };
    };
    let { token, r } = await send();
    if (r.status === 401 && await auth.renewAfter401(orgId, token)) {
      logger.warn(`${label}: HTTP 401, retrying once with a renewed token for org ${orgId}`);
      ({ r } = await send());
    }
    if (r.status >= 200 && r.status < 300) {
      logger.debug(`${label}: HTTP ${r.status}`);
      return r;
    }
    const err = errorFromResponse(label, r, now());
    logger.warn(err.message);
    throw err;
  }
  return { request };
}
