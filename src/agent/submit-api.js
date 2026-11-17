// Market calls for an Agent submitting a new skill or expert template. Every submission lands as pending review.
import crypto from 'node:crypto';
import { MarketError, backoffMs, marketQuote } from '../http.js';
import { downloadUrlAllowed } from '../download.js';
import { isCanonicalUuid } from '../ids.js';

export const UPLOAD_TIMEOUT_MS = 5 * 60_000;
// Computed by fetch from the body; passing them would be refused or duplicated.
const FETCH_SET = new Set(['content-length', 'host']);

export const ATTEMPTS = 3;
const realSleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

// Retries network errors and 5xx; prepare (same request_id), finalize (same upload) and publish (same manifest) are
// replay-safe on the market. 429 is never retried here.
async function retrying(fn, sleep) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!(err instanceof MarketError) || !err.transient || err.status === 429 || attempt + 1 >= ATTEMPTS) throw err;
      await sleep(backoffMs(err, attempt));
    }
  }
}

const shape = (label, what) => new MarketError(`${label}: response ${what}`, { status: 200, code: 'RESPONSE_INVALID', transient: false });
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' ? v : null);

function reviewOf(v) {
  if (!isObject(v)) return null;
  return { review_id: str(v.review_id), state: str(v.state), market: str(v.market) };
}

// PUT of the package to the signed storage URL with exactly the headers the market gave.
export async function putPackage({ fetchImpl = globalThis.fetch, url, headers, body, emulatorOrigin = null, timeoutMs = UPLOAD_TIMEOUT_MS }) {
  const label = 'package upload';
  if (!downloadUrlAllowed(url, emulatorOrigin)) throw new MarketError(`${label}: storage host refused`, { code: 'UPLOAD_HOST_REFUSED', transient: false });
  const h = {};
  for (const [k, v] of Object.entries(headers ?? {})) {
    if (typeof v !== 'string') throw shape(label, 'has a non-string upload header');
    if (!FETCH_SET.has(k.toLowerCase())) h[k] = v;
  }
  let res;
  try {
    res = await fetchImpl(new URL(url).href, { method: 'PUT', headers: h, body, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    throw new MarketError(`${label}: network error`, { code: 'NETWORK_ERROR', transient: true });
  }
  await res.body?.cancel().catch(() => {});
  if (res.status >= 200 && res.status < 300) return;
  throw new MarketError(`${label}: HTTP ${res.status}`, { status: res.status, code: res.status === 403 ? 'UPLOAD_URL_EXPIRED' : 'UPLOAD_FAILED' });
}

// prepare -> PUT -> finalize. Returns the created draft with its review.
export async function submitSkill({
  http, orgId, zip, finalize = {}, emulatorOrigin = null, fetchImpl, requestId = crypto.randomUUID(), sleep = realSleep,
}) {
  const sha256 = crypto.createHash('sha256').update(zip).digest('hex');
  const prep = (await retrying(() => http.request('POST', orgId, '/skill-uploads', { request_id: requestId, size_bytes: zip.length, sha256 }), sleep)).data;
  if (!isObject(prep) || typeof prep.upload_id !== 'string' || !/^[A-Za-z0-9._~-]{1,128}$/.test(prep.upload_id)
    || typeof prep.upload_url !== 'string' || (prep.upload_headers != null && !isObject(prep.upload_headers))) {
    throw shape('market POST /skill-uploads', 'is not an upload session');
  }
  await retrying(() => putPackage({ fetchImpl, url: prep.upload_url, headers: prep.upload_headers, body: zip, emulatorOrigin }), sleep);
  const body = {};
  for (const k of ['name', 'description', 'changelog', 'category_id', 'examples']) if (finalize[k] != null) body[k] = finalize[k];
  const d = (await retrying(() => http.request('POST', orgId, `/skill-uploads/${encodeURIComponent(prep.upload_id)}:finalize`, body), sleep)).data;
  if (!isObject(d) || !isCanonicalUuid(d.skill_id) || !isCanonicalUuid(d.skill_version_id)) {
    throw shape('market POST /skill-uploads:finalize', 'has no skill version');
  }
  return {
    kind: 'skill', skill_id: d.skill_id, skill_version_id: d.skill_version_id, slug: str(d.slug), name: str(d.name),
    version: str(d.version) ?? str(d.version_label), package_sha256: sha256, review: reviewOf(d.review), submitted_via: str(d.submitted_via),
  };
}

export async function submitTemplate({ http, orgId, manifest, changelog = null, categoryId = null, sleep = realSleep }) {
  const body = { manifest };
  if (changelog != null) body.changelog = changelog;
  if (categoryId != null) body.category_id = categoryId;
  const d = (await retrying(() => http.request('POST', orgId, '/templates:publish', body), sleep)).data;
  if (!isObject(d) || !isCanonicalUuid(d.template_id) || !isCanonicalUuid(d.template_version_id)) {
    throw shape('market POST /templates:publish', 'has no template version');
  }
  return {
    kind: 'template', template_id: d.template_id, template_version_id: d.template_version_id, slug: str(manifest.id),
    name: str(manifest.role?.name), version: str(d.version), manifest_sha256: str(d.manifest_sha256), review: reviewOf(d.review),
    submitted_via: str(d.submitted_via),
  };
}

const minutes = (ms) => Math.max(1, Math.ceil(ms / 60_000));

const RATE_WHAT = {
  agent_submissions: "the owner's Agents reached the hourly submission limit",
  agent_search: 'this Agent reached the search limit',
  agent_proposals: 'this Agent reached the hourly limit of install requests',
};

// Codes shared by every Agent market route; null when err is not one of them.
export function explainCommonError(err) {
  if (!(err instanceof MarketError)) return err?.message ?? String(err);
  switch (err.code) {
    case 'CLIENT_VERSION_TOO_OLD':
      return `the market needs om-marketplace-client ${err.min_version ?? 'newer than this one'} or later for this; the owner can run \`zylos upgrade om-marketplace-client\``;
    case 'AGENT_OWNER_REQUIRED':
      return 'refused: this Agent has no active human owner in the organization';
    case 'RATE_LIMITED': {
      const wait = err.retryAfterMs != null ? `; try again in about ${minutes(err.retryAfterMs)} minute(s)` : '; try again later';
      return `rate limited: ${RATE_WHAT[err.reason] ?? `by the market${err.reason ? ` (${err.reason})` : ''}`}${wait}`;
    }
    default:
      return null;
  }
}

export function explainOther(err) {
  const x = err.extra ?? {};
  const tail = x.detail ? ` ${marketQuote(x.detail)}` : '';
  if (err.transient) return `${err.message}${tail}; the market did not confirm it. Try again later`;
  return `${err.message}${err.reason ? ` (${err.reason})` : ''}${tail}`;
}

// One message the Agent can relay to its owner for a refused or failed submission.
export function explainSubmitError(err) {
  const common = explainCommonError(err);
  if (common !== null) return common;
  const x = err.extra ?? {};
  const at = x.field ? ` at ${x.field}` : '';
  switch (err.code) {
    case 'AGENT_UPLOAD_DISABLED':
      if (err.reason === 'agent_owner_required') return 'refused: this Agent has no active human owner in the organization';
      if (err.reason === 'existing_skill') return 'refused: a skill with this name already exists in the organization. An Agent can only create new skills: rename it (SKILL.md name) or ask a person to upload a new version in the workbench';
      if (err.reason === 'existing_template') return 'refused: an expert template with this id already exists. An Agent can only create new templates: change the manifest id or ask a person to publish a new version in the workbench';
      return 'refused: Agent submissions are turned off in this market';
    case 'TEMPLATE_MANIFEST_INVALID':
      if (x.rule_class) return `manifest refused: unsafe instruction (${x.rule_class})${at}${x.sentence ? ` ${marketQuote(x.sentence)}` : ''}`;
      if (err.reason === 'version_not_greater') return `manifest refused: version must be greater than ${x.previous_version ?? 'the existing one'}`;
      return `manifest refused: ${err.reason ?? 'invalid'}${at}${x.rule ? ` (rule ${x.rule})` : ''}`;
    case 'TEMPLATE_REF_INVALID':
      return `manifest refused: a referenced skill or knowledge file is not usable (${err.reason ?? 'invalid'})${at}`;
    case 'PACKAGE_UNSAFE':
      return `package refused by the market scan: ${err.reason ?? 'unsafe'}${x.skill_md_rule ? ` (${x.skill_md_rule})` : ''}${x.file ? ` in ${x.file}` : ''}`;
    case 'SKILL_FRONTMATTER_KEY_NOT_ALLOWED':
    case 'SKILL_COMMAND_INJECTION': {
      const v = Array.isArray(err.details?.violations) ? err.details.violations.slice(0, 5) : [];
      const where = v.map((e) => `${e.file}:${e.line}${e.key ? ` (${e.key})` : ''}`).join('; ');
      return `package refused by the skill policy: ${err.code}${where ? ` at ${where}` : ''}`;
    }
    case 'VALIDATION_FAILED': {
      if (err.reason === 'unsafe_instruction') return `refused: unsafe instruction (${x.rule_class ?? 'unknown'})${x.sentence ? ` ${marketQuote(x.sentence)}` : ''}`;
      if (err.reason === 'skill_md_name_mismatch') return `refused: SKILL.md name must be ${x.expected_slug ?? 'the skill slug'}`;
      const list = (err.errors ?? []).slice(0, 5).map((e) => `${e?.field ?? 'request'}: ${e?.message ?? 'invalid'}`).join('; ');
      return `refused: validation failed${list ? ` (${list})` : ''}`;
    }
    case 'VERSION_REVOKED':
      return 'refused: this exact content was blocked by the market';
    case 'REVIEW_STATE_CONFLICT':
      if (err.reason === 'already_submitted') return 'this exact manifest was already submitted and is waiting for review; nothing new was submitted';
      return `refused: ${err.reason === 'personal_templates_disabled' ? 'expert templates cannot be submitted in this market now' : `review state conflict (${err.reason ?? 'unknown'})`}`;
    default:
      return err.transient
        ? `${explainOther(err)}; if a skill retry then answers that the skill already exists, the first attempt went through`
        : explainOther(err);
  }
}

// Refusals the Agent should explain and not retry unchanged.
export const isRefusal = (err) => err instanceof MarketError && err.status >= 400 && err.status < 500 && err.status !== 408;
