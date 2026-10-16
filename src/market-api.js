import { MarketError } from './http.js';
import { isCanonicalUuid, isOrgOrMemberId, isSha256Hex } from './ids.js';
import { validSlug } from './pkg/frontmatter.js';

export const INTENT_OPS = new Set(['install', 'upgrade', 'enable', 'disable', 'uninstall', 'write_template']);
export const REVOCATION_KINDS = new Set(['version_revoke', 'template_revoke', 'shelf_revoke', 'sha_block']);
export const MAX_INTENT_LIMIT = 100;
const INSTALL_STATES = new Set(['installing', 'installed', 'failed']);
const RECONCILE_OUTCOMES = new Set(['recorded', 'skipped']);
// <revocation log epoch (canonical UUID)>:<seq as int64 decimal without leading zeros>, as the server writes it.
const CURSOR_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:(0|[1-9]\d{0,18})$/;
const INT64_MAX = 2n ** 63n - 1n;
const RFC3339_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

class ShapeError extends Error {}

const fail = (p, what) => { throw new ShapeError(`${p} ${what}`); };
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const object = (v, p) => (isObject(v) ? v : fail(p, 'must be an object'));
const array = (v, p) => (Array.isArray(v) ? v : fail(p, 'must be an array'));
const bool = (v, p) => (typeof v === 'boolean' ? v : fail(p, 'must be a boolean'));
const uint = (v, p) => (Number.isSafeInteger(v) && v >= 0 ? v : fail(p, 'must be a non-negative integer'));
const uuid = (v, p) => (isCanonicalUuid(v) ? v : fail(p, 'must be a canonical UUID'));
const sha = (v, p) => (isSha256Hex(v) ? v : fail(p, 'must be 64 lowercase hex'));
const nullable = (check) => (v, p) => (v == null ? null : check(v, p));
const time = (v, p) => (typeof v === 'string' && RFC3339_RE.test(v) && !Number.isNaN(Date.parse(v)) ? v : fail(p, 'must be an RFC 3339 time'));
export const isRevocationCursor = (v) => typeof v === 'string' && CURSOR_RE.test(v) && BigInt(v.slice(37)) <= INT64_MAX;
const cursor = (v, p) => (isRevocationCursor(v) ? v : fail(p, 'must be an <epoch>:<seq> cursor'));
const orgId = (v, p) => (isOrgOrMemberId(v) ? v : fail(p, 'must be an org id'));
const oneOf = (set) => (v, p) => (set.has(v) ? v : fail(p, 'has an unknown value'));
const text = (max) => (v, p) => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : fail(p, 'must be a non-empty string'));
const slug = (v, p) => (typeof v === 'string' && validSlug(v) ? v : fail(p, 'must be a skill slug'));
const posInt = (v, p) => (Number.isSafeInteger(v) && v > 0 ? v : fail(p, 'must be a positive integer'));

// Builds a fresh object from the known fields only, so unvalidated server data never reaches callers.
function pick(src, p, spec) {
  const out = {};
  for (const [k, check] of Object.entries(spec)) out[k] = check(src[k], `${p}.${k}`);
  return out;
}

function parseIntent(raw, p) {
  const it = pick(object(raw, p), p, {
    id: uuid, org_id: orgId, op: oneOf(INTENT_OPS),
    skill_id: nullable(uuid), skill_version_id: nullable(uuid), template_id: nullable(uuid),
    source_market_id: nullable(uuid), adoption_id: nullable(uuid),
    discard_local_changes: bool, expires_at: time, seq: uint,
  });
  if (it.op === 'write_template') {
    it.bundle_sha256 = sha(raw.bundle_sha256, `${p}.bundle_sha256`);
    if (!it.template_id || !it.adoption_id) fail(p, 'write_template needs template_id and adoption_id');
  } else {
    if (raw.bundle_sha256 != null) fail(`${p}.bundle_sha256`, `must be absent for ${it.op}`);
    if (!it.skill_id && !(it.template_id && it.adoption_id)) fail(p, 'needs skill_id or template_id and adoption_id');
  }
  return it;
}

function parseIntentPage(raw, afterSeq, limit) {
  const page = pick(object(raw, 'body'), 'body', {
    items: array, has_more: bool, next_after_seq: uint, policy_sha256: sha,
  });
  if (page.items.length > limit) fail('body.items', 'exceeds the requested limit');
  let prev = afterSeq;
  page.items = page.items.map((it, i) => {
    const item = parseIntent(it, `body.items[${i}]`);
    if (item.seq <= prev) fail(`body.items[${i}].seq`, 'is not increasing past after_seq');
    prev = item.seq;
    return item;
  });
  if (page.next_after_seq < prev) fail('body.next_after_seq', 'is behind the last item');
  return page;
}

function parseRevocation(raw, p) {
  const it = pick(object(raw, p), p, {
    kind: oneOf(REVOCATION_KINDS), source_market_id: nullable(uuid), skill_id: nullable(uuid),
    skill_version_id: nullable(uuid), template_version_id: nullable(uuid),
    package_sha256: nullable(sha), manifest_sha256: nullable(sha), revoked_at: time,
  });
  if (it.kind === 'version_revoke' && !it.skill_version_id) fail(p, 'version_revoke needs skill_version_id');
  if (it.kind === 'template_revoke' && !it.template_version_id) fail(p, 'template_revoke needs template_version_id');
  if (it.kind === 'sha_block' && !it.package_sha256 && !it.manifest_sha256) fail(p, 'sha_block needs a sha256');
  return it;
}

function parseRevocationPage(raw) {
  const page = pick(object(raw, 'body'), 'body', { items: array, has_more: bool, next_cursor: cursor });
  page.items = page.items.map((it, i) => parseRevocation(it, `body.items[${i}]`));
  return page;
}

// C-02: 201 running with the package and its manifest, or 200 ALREADY_INSTALLED.
function parseInstall(raw, status, req) {
  const b = object(raw, 'body');
  if (status === 200) {
    if (b.status !== 'succeeded' || b.code !== 'ALREADY_INSTALLED') fail('body', 'is not ALREADY_INSTALLED');
    if (b.request_id !== req.request_id) fail('body.request_id', 'does not match the request');
    return { already_installed: true, request_id: b.request_id };
  }
  const r = pick(b, 'body', {
    request_id: uuid, install_id: uuid, skill_id: uuid, slug, skill_version_id: uuid, version_no: posInt,
    source_market_id: uuid, package_url: text(2048), package_sha256: sha, size_bytes: posInt,
    file_manifest: array, skill_md: object, status: oneOf(new Set(['running'])),
  });
  if (r.request_id !== req.request_id || r.skill_id !== req.skill_id
    || (req.skill_version_id && r.skill_version_id !== req.skill_version_id)) fail('body', 'does not match the request');
  // Sizes and file counts over the package caps pass here; the installer reports them as PACKAGE_UNSAFE.
  r.file_manifest = r.file_manifest.map((e, i) => pick(object(e, `body.file_manifest[${i}]`), `body.file_manifest[${i}]`, {
    path: text(1024), size: uint, sha256: sha,
  }));
  r.skill_md = pick(r.skill_md, 'body.skill_md', { name: text(64), description: text(2000) });
  if (r.skill_md.name !== r.slug) fail('body.skill_md.name', 'differs from the slug');
  return r;
}

function validated(label, r, parse) {
  try {
    return parse(r.data);
  } catch (err) {
    if (!(err instanceof ShapeError)) throw err;
    throw new MarketError(`${label}: invalid response: ${err.message}`, {
      status: r.status, code: 'RESPONSE_INVALID', reason: err.message, transient: false,
    });
  }
}

export function createMarketApi({ http }) {
  return {
    // Resolves to null on 204 (nothing after afterSeq), otherwise to the validated page.
    async pullInstallIntents({ orgId, agentId, afterSeq = 0, limit = MAX_INTENT_LIMIT }) {
      if (!isOrgOrMemberId(agentId)) throw new TypeError('invalid agentId');
      if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) throw new TypeError('afterSeq must be a non-negative integer');
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_INTENT_LIMIT) throw new TypeError('limit must be 1..100');
      const r = await http.request('POST', orgId, `/agents/${encodeURIComponent(agentId)}/install-intents:query`, {
        status: 'pending', after_seq: afterSeq, limit,
      });
      const label = 'install-intents:query';
      if (r.status === 204) return r.empty ? null : validated(label, r, () => fail('body', 'must be empty on 204'));
      if (r.status !== 200) return validated(label, r, () => fail('status', `${r.status} is not expected`));
      return validated(label, r, (data) => parseIntentPage(data, afterSeq, limit));
    },

    // body is sent as given, so a retry replays it byte for byte.
    async requestInstall({ orgId, agentId, body }) {
      const r = await http.request('POST', orgId, `/agents/${encodeURIComponent(agentId)}/install-requests`, body);
      if (r.status !== 200 && r.status !== 201) return validated('install-requests', r, () => fail('status', `${r.status} is not expected`));
      return validated('install-requests', r, (data) => parseInstall(data, r.status, body));
    },

    // C-03 at subPath, which the caller derived from a checked package_url.
    async packageDownload({ orgId, subPath, signal = null }) {
      const r = await http.request('GET', orgId, subPath, undefined, { cancel: signal });
      return validated('packages', r, (data) => {
        if (r.status !== 200) fail('status', `${r.status} is not expected`);
        return pick(object(data, 'body'), 'body', { download_url: text(8192), expires_at: time, sha256: sha, size: posInt });
      });
    },

    async reportInstallResult({ orgId, requestId, body }) {
      if (!isCanonicalUuid(requestId)) throw new TypeError('invalid requestId');
      const r = await http.request('POST', orgId, `/install-requests/${requestId}/result`, body);
      return validated('install result', r, (data) => {
        if (r.status !== 200) fail('status', `${r.status} is not expected`);
        const out = pick(object(data, 'body'), 'body', { request_id: uuid, status: oneOf(new Set(['succeeded', 'failed'])) });
        if (out.request_id !== requestId) fail('body.request_id', 'does not match the request');
        out.error_code = typeof data.error_code === 'string' ? data.error_code : null;
        return out;
      });
    },

    // C-07.
    async requestStatus({ orgId, requestId }) {
      if (!isCanonicalUuid(requestId)) throw new TypeError('invalid requestId');
      const r = await http.request('GET', orgId, `/install-requests/${requestId}`);
      return validated('install request status', r, (data) => {
        if (r.status !== 200) fail('status', `${r.status} is not expected`);
        const out = pick(object(data, 'body'), 'body', { request_id: uuid, status: oneOf(new Set(['running', 'succeeded', 'failed'])) });
        if (out.request_id !== requestId) fail('body.request_id', 'does not match the request');
        out.error_code = typeof data.error_code === 'string' ? data.error_code : null;
        return out;
      });
    },

    // C-08 (body has enabled) and C-09.
    async manageSkill({ orgId, agentId, skillId, verb, body }) {
      if (!isOrgOrMemberId(agentId) || !isCanonicalUuid(skillId) || !['set-enabled', 'uninstall'].includes(verb)) throw new TypeError('invalid manage call');
      const r = await http.request('POST', orgId, `/agents/${encodeURIComponent(agentId)}/skills/${skillId}:${verb}`, body);
      return validated(`skills:${verb}`, r, (data) => {
        if (r.status !== 200) fail('status', `${r.status} is not expected`);
        return pick(object(data, 'body'), 'body', verb === 'uninstall' ? { install_id: uuid, install_state: text(32) } : { install_id: uuid, enabled: bool });
      });
    },

    // C-15; body is sent as given so a resend is identical.
    async reportTemplateResult({ orgId, agentId, adoptionId, body }) {
      if (!isOrgOrMemberId(agentId) || !isCanonicalUuid(adoptionId)) throw new TypeError('invalid agentId or adoptionId');
      const r = await http.request('POST', orgId, `/agents/${encodeURIComponent(agentId)}/adoptions/${adoptionId}/write-results`, body);
      return validated('write-results', r, (data) => {
        if (r.status !== 200) fail('status', `${r.status} is not expected`);
        const out = pick(object(data, 'body'), 'body', { adoption_id: uuid, status: text(64), outcome: oneOf(new Set(['applied', 'stale'])) });
        if (out.adoption_id !== adoptionId) fail('body.adoption_id', 'does not match the request');
        out.error_code = typeof data.error_code === 'string' ? data.error_code : null;
        return out;
      });
    },

    // C-12: the agent's installs in orgId.
    async listInstalls({ orgId, agentId }) {
      if (!isOrgOrMemberId(agentId)) throw new TypeError('invalid agentId');
      const r = await http.request('GET', orgId, `/agents/${encodeURIComponent(agentId)}/skills`);
      return validated('skills', r, (data) => {
        if (r.status !== 200) fail('status', `${r.status} is not expected`);
        return array(object(data, 'body').items, 'body.items').map((it, i) => pick(object(it, `body.items[${i}]`), `body.items[${i}]`, {
          install_id: uuid, skill_id: uuid, slug, skill_version_id: uuid, version_no: posInt, source_market_id: uuid,
          install_state: oneOf(INSTALL_STATES), enabled: bool,
        }));
      });
    },

    // C-10: resolves to one outcome per item, in item order.
    async reportReconcile({ orgId, agentId, items }) {
      if (!isOrgOrMemberId(agentId)) throw new TypeError('invalid agentId');
      const r = await http.request('POST', orgId, `/agents/${encodeURIComponent(agentId)}/reconcile`, { items });
      return validated('reconcile', r, (data) => {
        if (r.status !== 200) fail('status', `${r.status} is not expected`);
        const results = array(object(data, 'body').results, 'body.results');
        if (results.length !== items.length) fail('body.results', 'does not match the items');
        return results.map((x, i) => {
          const o = pick(object(x, `body.results[${i}]`), `body.results[${i}]`, { index: uint, outcome: oneOf(RECONCILE_OUTCOMES) });
          if (o.index !== i) fail(`body.results[${i}].index`, 'is out of order');
          return o.outcome;
        });
      });
    },

    async pullRevocations({ orgId, cursor: from = null }) {
      if (from !== null && !isRevocationCursor(from)) throw new TypeError('cursor must be <epoch>:<seq> or null');
      const r = await http.request('POST', orgId, '/revocations:query', from === null ? {} : { cursor: from });
      const label = 'revocations:query';
      if (r.status !== 200) return validated(label, r, () => fail('status', `${r.status} is not expected`));
      return validated(label, r, parseRevocationPage);
    },
  };
}
