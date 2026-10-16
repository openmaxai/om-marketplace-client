import { MarketError } from './http.js';
import { POLICY_SHA256 } from './policy/pin.js';

export const MAX_PAGES_PER_PULL = 50;
export const EMPTY_INTENTS = Object.freeze({ after_seq: 0, queue: [] });
export const EMPTY_GATE = Object.freeze({ too_old: null, policy_sha256: null });
const POLICY_MISMATCH = 'policy_mismatch';

// queued: runnable; org_not_configured: to be reported, never executed; org_invalid: the agent left that org.
export function intentStatus(orgs, orgId) {
  if (!orgs.isConfigured(orgId)) return 'org_not_configured';
  return orgs.isInvalid(orgId) ? 'org_invalid' : 'queued';
}

// Too-old mode: no new intents are executed; revocation pulls and reconcile continue.
export function tooOld(state) {
  return state.read('gate', EMPTY_GATE).too_old;
}

export function createIntentPuller({ api, state, orgs, logger, now = Date.now }) {
  const iso = () => new Date(now()).toISOString();

  function enterTooOld(reason, minVersion, policySha) {
    const gate = state.read('gate', EMPTY_GATE);
    gate.too_old = { reason, min_version: minVersion, since: gate.too_old?.since ?? iso() };
    if (policySha) gate.policy_sha256 = policySha;
    state.write('gate', gate);
    const msg = reason === POLICY_MISMATCH
      ? `market skill policy ${policySha} differs from the pinned policy; this client must be upgraded`
      : `market rejected this client version (${reason}${minVersion ? `, minimum ${minVersion}` : ''}); upgrade the client`;
    if (state.setAlert('client_too_old', msg)) logger.warn(`${msg}; no new install intents will be executed`);
  }

  function leaveTooOld(policySha) {
    const gate = state.read('gate', EMPTY_GATE);
    if (!gate.too_old && gate.policy_sha256 === policySha) return;
    if (!policySha && gate.too_old?.reason === POLICY_MISMATCH) return;
    if (gate.too_old) logger.info('market accepts this client again; leaving too-old mode');
    gate.too_old = null;
    if (policySha) gate.policy_sha256 = policySha;
    state.write('gate', gate);
    state.clearAlert('client_too_old');
  }

  // Queue and cursor are one document, so items are durable no later than the cursor that skips them.
  function persistPage(doc, page) {
    const known = new Set(doc.queue.map((it) => it.id));
    let added = 0;
    for (const it of page.items) {
      if (known.has(it.id)) continue;
      const status = intentStatus(orgs, it.org_id);
      if (status === 'org_not_configured') logger.info(`intent ${it.id} is for org ${it.org_id}, which is not configured; it will not be executed`);
      doc.queue.push({ ...it, status, received_at: iso() });
      added += 1;
    }
    doc.after_seq = page.next_after_seq;
    state.write('intents', doc);
    return added;
  }

  function handleError(err, orgId) {
    if (!(err instanceof MarketError)) throw err;
    if (err.code === 'CLIENT_VERSION_TOO_OLD') {
      enterTooOld(err.reason ?? 'unknown', err.min_version, null);
      return 'too_old';
    }
    if (err.code === 'MEMBER_LEFT_ORG') {
      orgs.markInvalid(orgId, err.code);
      return 'org_invalid';
    }
    if (err.transient) {
      logger.warn(`install intent pull failed transiently (${err.code || err.status}); retrying next round`);
      return 'transient';
    }
    const what = err.status === 404 ? `agent id is not this agent in org ${orgId}` : `${err.status} ${err.code ?? ''}`.trim();
    state.setAlert('intents_pull', `install intent pull rejected: ${what}`);
    logger.error(`install intent pull rejected: ${what}`);
    return 'rejected';
  }

  async function pullPages(orgId) {
    let added = 0;
    try {
      const agentId = await orgs.agentId(orgId);
      for (let i = 0; i < MAX_PAGES_PER_PULL; i++) {
        const doc = state.read('intents', EMPTY_INTENTS);
        const page = await api.pullInstallIntents({ orgId, agentId, afterSeq: doc.after_seq });
        if (!page) {
          leaveTooOld(null);
          return { outcome: 'ok', added };
        }
        if (page.policy_sha256 !== POLICY_SHA256) {
          enterTooOld(POLICY_MISMATCH, null, page.policy_sha256);
          return { outcome: 'too_old', added };
        }
        leaveTooOld(page.policy_sha256);
        added += persistPage(doc, page);
        if (!page.has_more) return { outcome: 'ok', added };
      }
      return { outcome: 'partial', added };
    } catch (err) {
      return { outcome: handleError(err, orgId), added };
    }
  }

  return {
    // C-01 is identity-wide and pulled through the primary org only.
    async pull() {
      const orgId = orgs.primary;
      let result;
      if (orgs.isInvalid(orgId)) {
        logger.warn(`primary org ${orgId} is marked invalid; install intents are not pulled`);
        result = { outcome: 'org_invalid', added: 0 };
      } else {
        result = await pullPages(orgId);
      }
      if (result.outcome === 'ok' || result.outcome === 'partial') state.clearAlert('intents_pull');
      state.recordRun('intents', result.outcome);
      if (result.added) logger.info(`queued ${result.added} install intent(s)`);
      return result;
    },
  };
}
