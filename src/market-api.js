import { MarketError } from './http.js';
import { isCanonicalUuid, isOrgOrMemberId, isSha256Hex } from './ids.js';

export const INTENT_OPS = new Set(['install', 'upgrade', 'enable', 'disable', 'uninstall', 'write_template']);
export const REVOCATION_KINDS = new Set(['version_revoke', 'template_revoke', 'shelf_revoke', 'sha_block']);
export const MAX_INTENT_LIMIT = 100;
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
const isCursor = (v) => typeof v === 'string' && CURSOR_RE.test(v) && BigInt(v.slice(37)) <= INT64_MAX;
const cursor = (v, p) => (isCursor(v) ? v : fail(p, 'must be an <epoch>:<seq> cursor'));
const orgId = (v, p) => (isOrgOrMemberId(v) ? v : fail(p, 'must be an org id'));
const oneOf = (set) => (v, p) => (set.has(v) ? v : fail(p, 'has an unknown value'));

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

    async pullRevocations({ orgId, cursor: from = null }) {
      if (from !== null && !isCursor(from)) throw new TypeError('cursor must be <epoch>:<seq> or null');
      const r = await http.request('POST', orgId, '/revocations:query', from === null ? {} : { cursor: from });
      const label = 'revocations:query';
      if (r.status !== 200) return validated(label, r, () => fail('status', `${r.status} is not expected`));
      return validated(label, r, parseRevocationPage);
    },
  };
}
