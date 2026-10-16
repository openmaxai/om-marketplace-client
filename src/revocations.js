import { MarketError } from './http.js';
import { isRevocationCursor } from './market-api.js';

export const MAX_PAGES_PER_PULL = 50;
export const STALE_AFTER_MS = 24 * 60 * 60 * 1000;
export const EMPTY_REVOCATIONS = Object.freeze({ cursor: null, last_success_at: null, first_attempt_at: null });
export const EMPTY_REVOKED = Object.freeze({
  skill_version_id: [], template_version_id: [], package_sha256: [], manifest_sha256: [], sha_block: [],
});
const ID_FIELDS = ['skill_version_id', 'template_version_id', 'package_sha256', 'manifest_sha256'];

// The revoked set only grows; it is never cleared, also not on uninstall. It is the persisted result of every earlier
// pull: when this round's pull fails, installs are checked against the set as of the last successful page. That is
// accepted because C-03 re-checks revocations and sha blocks on the market before handing out a download URL.
export function revokedSet(state) {
  const doc = { ...structuredClone(EMPTY_REVOKED), ...state.read('revoked', EMPTY_REVOKED) };
  const sets = Object.fromEntries(Object.entries(doc).map(([k, v]) => [k, new Set(v)]));
  return {
    has: (field, value) => Boolean(value) && Boolean(sets[field]?.has(value)),
    // A package sha is blocked by either its own revocation or a sha_block entry.
    blocksSha: (sha) => Boolean(sha) && (sets.package_sha256.has(sha) || sets.manifest_sha256.has(sha) || sets.sha_block.has(sha)),
  };
}

function addRevoked(state, items) {
  const doc = { ...structuredClone(EMPTY_REVOKED), ...state.read('revoked', EMPTY_REVOKED) };
  let changed = false;
  const add = (field, v) => {
    if (v && !doc[field].includes(v)) {
      doc[field].push(v);
      changed = true;
    }
  };
  for (const it of items) {
    if (it.kind === 'sha_block') {
      add('sha_block', it.package_sha256);
      add('sha_block', it.manifest_sha256);
    } else {
      for (const f of ID_FIELDS) add(f, it[f]);
    }
  }
  if (changed) state.write('revoked', doc);
}

// enforce(items) applies new revocations to installed content and must be idempotent: it runs after the items are added
// to the revoked set and before the cursor moves past them, so a crash re-delivers them.
export function createRevocationPuller({ api, state, orgs, logger, now = Date.now, enforce = async () => {} }) {
  const iso = () => new Date(now()).toISOString();
  const doc = () => ({ ...EMPTY_REVOCATIONS, ...state.read('revocations', EMPTY_REVOCATIONS) });
  // In-memory fallback for the staleness check when revocations.json cannot be read.
  const startedAt = iso();
  let lastSuccessAt = null;
  let notBefore = 0;

  function checkStale() {
    let d;
    try { d = doc(); } catch { d = { last_success_at: lastSuccessAt, first_attempt_at: startedAt }; }
    const base = Date.parse(d.last_success_at ?? d.first_attempt_at ?? '');
    if (Number.isNaN(base) || now() - base <= STALE_AFTER_MS) {
      state.clearAlert('revocations_stale');
      return false;
    }
    const msg = `no successful revocation pull since ${d.last_success_at ?? `start-up at ${d.first_attempt_at}`}; installed skills stay enabled`;
    if (state.setAlert('revocations_stale', msg)) logger.warn(msg);
    return true;
  }

  function handleError(err, orgId) {
    if (!(err instanceof MarketError)) throw err;
    if (err.code === 'MEMBER_LEFT_ORG') {
      orgs.markLeft(orgId, err.reason);
      return 'org_left';
    }
    if (err.transient) {
      if (err.retryAfterMs) notBefore = now() + err.retryAfterMs;
      logger.warn(`revocation pull failed transiently (${err.code || err.status}); retrying next round`);
      return 'transient';
    }
    const what = err.status === 404 ? `caller is not an agent in org ${orgId}` : `${err.status} ${err.code ?? ''}`.trim();
    state.setAlert('revocations_pull', `revocation pull rejected: ${what}`);
    logger.error(`revocation pull rejected: ${what}`);
    return 'rejected';
  }

  async function pullPages(orgId) {
    let reset = false;
    const restart = (d) => {
      logger.warn('revocation cursor is invalid; pulling from the start');
      reset = true;
      state.write('revocations', { ...d, cursor: null });
    };
    for (let i = 0; i < MAX_PAGES_PER_PULL; i++) {
      const d = doc();
      if (d.cursor !== null && !isRevocationCursor(d.cursor)) {
        restart(d);
        continue;
      }
      let page;
      try {
        page = await api.pullRevocations({ orgId, cursor: d.cursor });
      } catch (err) {
        if (err instanceof MarketError && err.code === 'CURSOR_INVALID' && d.cursor && !reset) {
          restart(d);
          continue;
        }
        throw err;
      }
      orgs.markActive(orgId);
      addRevoked(state, page.items);
      if (page.items.length) await enforce(page.items);
      if (page.next_cursor) d.cursor = page.next_cursor;
      if (!page.has_more) d.last_success_at = iso();
      state.write('revocations', d);
      if (!page.has_more) {
        lastSuccessAt = d.last_success_at;
        return 'ok';
      }
    }
    return 'partial';
  }

  return {
    checkStale,
    // Earliest time the next pull may be sent (server Retry-After).
    notBefore: () => notBefore,
    // C-11 is identity-wide and pulled through the primary org only.
    async pull() {
      const orgId = orgs.primary;
      let outcome = 'error';
      try {
        if (!doc().first_attempt_at) state.write('revocations', { ...doc(), first_attempt_at: startedAt });
        if (now() < notBefore) {
          outcome = 'backoff';
        } else if (!orgs.mayContact(orgId)) {
          logger.debug(`primary org ${orgId} is ${orgs.membership(orgId)}; revocations are not pulled`);
          outcome = 'org_left';
        } else {
          try {
            outcome = await pullPages(orgId);
          } catch (err) {
            outcome = handleError(err, orgId);
          }
        }
        if (outcome === 'ok' || outcome === 'partial') state.clearAlert('revocations_pull');
      } catch (err) {
        logger.error(`revocation pull failed: ${err.message}`);
        try { state.setAlert('revocations_pull', `revocation pull failed: ${err.message}`); } catch { /* status unwritable */ }
      } finally {
        try { state.recordRun('revocations', outcome); } catch { /* status unwritable */ }
        try { checkStale(); } catch (err) { logger.error(`revocation staleness check failed: ${err.message}`); }
      }
      return { outcome };
    },
  };
}
