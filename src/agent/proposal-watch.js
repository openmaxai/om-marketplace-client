// Watches this Agent's pending install requests so a confirmation on the workspace card is acted on within seconds.
// The CLI adds one file per pending request (<dataDir>/proposal-watch/<proposal_id>.json); only the service rewrites
// or removes them, so the two never write the same file at the same time.
import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from '../state.js';
import { MarketError } from '../http.js';
import { isCanonicalUuid, isOrgOrMemberId } from '../ids.js';
import { getProposal } from './proposals-api.js';

export const WATCH_INTERVAL_MS = 15_000;
export const MAX_BACKOFF_MS = 5 * 60_000;
// Kept a little past expires_at so a confirmation in the last seconds is still seen.
const EXPIRY_GRACE_MS = 2 * 60_000;
// Without a readable expiry the market default (24 h) bounds the watch.
const DEFAULT_TTL_MS = 24 * 60 * 60_000;

export const watchDir = (dataDir) => path.join(dataDir, 'proposal-watch');
const fileOf = (dataDir, id) => path.join(watchDir(dataDir), `${id}.json`);

export function addWatch(dataDir, { proposal_id: id, org_id: orgId, agent_id: agentId, expires_at: expiresAt }, now = Date.now()) {
  if (!isCanonicalUuid(id) || !isOrgOrMemberId(orgId) || !isOrgOrMemberId(agentId)) return;
  fs.mkdirSync(watchDir(dataDir), { recursive: true, mode: 0o700 });
  const exp = Date.parse(expiresAt ?? '');
  writeJsonAtomic(fileOf(dataDir, id), {
    proposal_id: id, org_id: orgId, agent_id: agentId, expires_at_ms: Number.isFinite(exp) ? exp : now + DEFAULT_TTL_MS, failures: 0, next_at: 0,
  });
}

export function dropWatch(dataDir, id) {
  if (!isCanonicalUuid(id)) return;
  try { fs.unlinkSync(fileOf(dataDir, id)); } catch { /* already gone */ }
}

function readWatches(dataDir) {
  let names;
  try { names = fs.readdirSync(watchDir(dataDir)); } catch { return []; }
  const out = [];
  for (const n of names) {
    const id = n.endsWith('.json') ? n.slice(0, -5) : null;
    if (!isCanonicalUuid(id)) continue;
    try {
      const w = JSON.parse(fs.readFileSync(fileOf(dataDir, id), 'utf8'));
      if (w?.proposal_id === id && isOrgOrMemberId(w.org_id) && isOrgOrMemberId(w.agent_id)) out.push(w);
      else dropWatch(dataDir, id);
    } catch {
      dropWatch(dataDir, id);
    }
  }
  return out;
}

// tick() checks every due request once. A confirmed request calls onConfirmed (pull the orders now); a request that
// is decided, expired or gone is dropped; a failed read backs off that request exponentially up to MAX_BACKOFF_MS.
export function createProposalWatch({ http, dataDir, logger, now = Date.now }) {
  return {
    pending: () => readWatches(dataDir).length,
    async tick({ onConfirmed = () => {} } = {}) {
      let confirmed = 0;
      for (const w of readWatches(dataDir)) {
        const t = now();
        if (t > w.expires_at_ms + EXPIRY_GRACE_MS) {
          dropWatch(dataDir, w.proposal_id);
          continue;
        }
        if (t < (w.next_at ?? 0)) continue;
        try {
          const p = await getProposal({ http, orgId: w.org_id, agentId: w.agent_id, proposalId: w.proposal_id });
          if (p.state === 'pending_confirmation') {
            if (w.failures) writeJsonAtomic(fileOf(dataDir, w.proposal_id), { ...w, failures: 0, next_at: 0 });
            continue;
          }
          dropWatch(dataDir, w.proposal_id);
          if (p.state === 'confirmed') {
            confirmed++;
            logger.info(`install request ${w.proposal_id} confirmed via ${p.confirmed_via ?? '?'}; pulling the orders now`);
          }
        } catch (err) {
          if (err instanceof MarketError && (err.status === 404 || err.status === 403)) {
            logger.warn(`install request ${w.proposal_id} no longer readable (${err.code ?? err.status}); stopped watching it`);
            dropWatch(dataDir, w.proposal_id);
            continue;
          }
          const failures = (w.failures ?? 0) + 1;
          const wait = Math.max(err?.retryAfterMs ?? 0, Math.min(WATCH_INTERVAL_MS * 2 ** failures, MAX_BACKOFF_MS));
          logger.warn(`install request ${w.proposal_id} check failed (${err?.message ?? err}); next check in ${Math.round(wait / 1000)} s`);
          writeJsonAtomic(fileOf(dataDir, w.proposal_id), { ...w, failures, next_at: t + wait });
        }
      }
      if (confirmed) onConfirmed();
      return confirmed;
    },
  };
}
