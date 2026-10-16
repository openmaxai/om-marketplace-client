import crypto from 'node:crypto';
import { InstallFailure } from './failure.js';
import { MarketError, backoffMs } from './http.js';

export const GCS_HOST = 'storage.googleapis.com';
export const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
const MAX_ATTEMPTS = 3;
const EXPIRY_MARGIN_MS = 5_000;
const ENDED = new Set(['AGENT_NOT_SELF', 'NOT_FOUND', 'MEMBER_LEFT_ORG']);

const internal = (why) => new InstallFailure('CLIENT_INTERNAL', why);
const mismatch = (why) => new InstallFailure('PACKAGE_MISMATCH', why);

// package_url must be exactly {market origin}/api/v1/orgs/{order org}/agents/{own agent}/packages/{request_id}. Returns
// the C-03 path below the org prefix.
export function checkPackageUrl(raw, { bffUrl, orgId, agentId, requestId }) {
  const sub = `/agents/${encodeURIComponent(agentId)}/packages/${requestId}`;
  if (raw !== `${new URL(bffUrl).origin}/api/v1/orgs/${encodeURIComponent(orgId)}${sub}`) throw internal('package_url_invalid');
  return sub;
}

// Only https://storage.googleapis.com, or the dev emulator origin when one was admitted by the config.
export function downloadUrlAllowed(raw, emulatorOrigin = null) {
  let u;
  try { u = new URL(raw); } catch { return false; }
  if (u.username || u.password || u.hash) return false;
  if (u.protocol === 'https:' && u.host === GCS_HOST) return true;
  return emulatorOrigin !== null && u.origin === emulatorOrigin;
}

// One storage GET: no credentials, no redirects, exactly `size` bytes whose sha256 is `sha`.
async function fetchExact({ fetchImpl, url, size, sha, signal, timeoutMs }) {
  const signals = [AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])];
  let res;
  try {
    res = await fetchImpl(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.any(signals) });
  } catch {
    return { transient: true };
  }
  const drop = () => res.body?.cancel().catch(() => {});
  if (res.status === 403) return drop(), { expired: true };
  if (res.status === 429 || res.status >= 500) return drop(), { transient: true };
  if (res.status !== 200) {
    drop();
    throw internal(res.status >= 300 && res.status < 400 ? 'download_redirect' : 'download_refused');
  }
  if (Number(res.headers.get('content-length') ?? size) !== size) return drop(), mismatch('size_mismatch');
  const hash = crypto.createHash('sha256');
  const chunks = [];
  let total = 0;
  try {
    for await (const chunk of res.body ?? []) {
      total += chunk.length;
      if (total > size) return drop(), mismatch('size_mismatch');
      hash.update(chunk);
      chunks.push(chunk);
    }
  } catch {
    return { transient: true };
  }
  if (total !== size) return mismatch('size_mismatch');
  if (hash.digest('hex') !== sha) return mismatch('sha256_mismatch');
  return { bytes: Buffer.concat(chunks, total) };
}

// C-03 then a direct storage download. Storage 403 or an expired URL gets one fresh URL; transient failures are retried
// a few times and then rethrown. Throws InstallFailure for anything that must be reported.
export async function downloadPackage({
  api, orgId, subPath, sha, size, emulatorOrigin = null, fetchImpl = globalThis.fetch, now = Date.now,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)), signal = null, timeoutMs = DOWNLOAD_TIMEOUT_MS,
}) {
  let link = null;
  let urls = 0;
  let flaky = 0;
  const retry = async (err) => {
    if (++flaky >= MAX_ATTEMPTS || signal?.aborted) throw err;
    await sleep(backoffMs(err, flaky - 1));
  };
  for (;;) {
    if (!link || now() >= Date.parse(link.expires_at) - EXPIRY_MARGIN_MS) {
      if (urls === 2) throw internal('download_url_expired');
      try {
        link = await api.packageDownload({ orgId, subPath });
      } catch (err) {
        if (!(err instanceof MarketError)) throw err;
        if (err.code === 'VERSION_REVOKED') throw new InstallFailure('VERSION_REVOKED', 'version_revoked');
        if (ENDED.has(err.code) || err.code === 'CLIENT_VERSION_TOO_OLD') throw err;
        if (!err.transient) throw internal(err.code === 'RESPONSE_INVALID' ? 'download_response_invalid' : 'download_unavailable');
        link = null;
        await retry(err);
        continue;
      }
      urls++;
      if (link.sha256 !== sha || link.size !== size) throw internal('download_metadata_mismatch');
      if (!downloadUrlAllowed(link.download_url, emulatorOrigin)) throw internal('download_host_refused');
      continue;
    }
    const r = await fetchExact({ fetchImpl, url: link.download_url, size, sha, signal, timeoutMs });
    if (r instanceof InstallFailure) throw r;
    if (r.bytes) return r.bytes;
    if (r.expired) link = null;
    else await retry(new MarketError('storage download failed', { code: 'NETWORK_ERROR', transient: true }));
  }
}
