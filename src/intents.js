import { MarketError } from './http.js';
import { POLICY_SHA256 } from './policy/pin.js';

export const MAX_PAGES_PER_PULL = 50;
export const MAX_QUEUE = 1000;
export const MAX_UNREPORTED = 1000;
export const EMPTY_INTENTS = Object.freeze({ after_seq: 0, queue: [] });
export const EMPTY_GATE = Object.freeze({ too_old: null, policy_sha256: null });
const POLICY_MISMATCH = 'policy_mismatch';

// queued: runnable; org_not_configured: to be reported, never executed; org_suspended / org_invalid: the agent's
// membership in that org is suspended / gone.
export function intentStatus(orgs, orgId) {
  if (!orgs.isConfigured(orgId)) return 'org_not_configured';
  const m = orgs.membership(orgId);
  return m ? `org_${m}` : 'queued';
}

// Too-old mode: no new intents are executed; revocation pulls and reconcile continue.
export function tooOld(state) {
  return state.read('gate', EMPTY_GATE).too_old;
}

// Any version-gated call may answer CLIENT_VERSION_TOO_OLD.
export function enterTooOldMode(state, logger, reason, minVersion, policySha = null, at = new Date().toISOString()) {
  const gate = state.read('gate', EMPTY_GATE);
  gate.too_old = { reason, min_version: minVersion, since: gate.too_old?.since ?? at };
  if (policySha) gate.policy_sha256 = policySha;
  state.write('gate', gate);
  const msg = reason === POLICY_MISMATCH
    ? `market skill policy ${policySha} differs from the pinned policy; this client must be upgraded`
    : `market rejected this client version (${reason}${minVersion ? `, minimum ${minVersion}` : ''}); upgrade the client`;
  if (state.setAlert('client_too_old', msg)) logger.warn(`${msg}; no new install intents will be executed`);
}

export function createIntentPuller({ api, state, orgs, logger, now = Date.now }) {
  const iso = () => new Date(now()).toISOString();
  let notBefore = 0;

  const enterTooOld = (reason, minVersion, policySha) => enterTooOldMode(state, logger, reason, minVersion, policySha, iso());

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

  // Expired intents can no longer be executed and are dropped; org_not_configured ones are kept to be reported.
  function prune(queue) {
    const t = now();
    return queue.filter((it) => it.status === 'org_not_configured' || !(Date.parse(it.expires_at) <= t));
  }

  const unreported = (it) => it.status === 'org_not_configured';
  const runnableCount = (queue) => queue.filter((it) => !unreported(it)).length;

  // Queue and cursor are one document, so items are durable no later than the cursor that skips them. When the queue
  // is full the cursor stops at the last queued item, so nothing unqueued is skipped. org_not_configured intents do
  // not count toward MAX_QUEUE; beyond MAX_UNREPORTED of them the oldest are dropped.
  function persistPage(page) {
    const doc = state.read('intents', EMPTY_INTENTS);
    doc.queue = prune(doc.queue);
    const known = new Set(doc.queue.map((it) => it.id));
    let runnable = runnableCount(doc.queue);
    let added = 0;
    let cursor = doc.after_seq;
    let full = false;
    for (const it of page.items) {
      if (!known.has(it.id)) {
        const status = intentStatus(orgs, it.org_id);
        if (status !== 'org_not_configured' && runnable >= MAX_QUEUE) {
          full = true;
          break;
        }
        if (status === 'org_not_configured') logger.info(`intent ${it.id} is for org ${it.org_id}, which is not configured; it will not be executed`);
        else runnable += 1;
        doc.queue.push({ ...it, status, received_at: iso() });
        known.add(it.id);
        added += 1;
      }
      cursor = it.seq;
    }
    const excess = doc.queue.filter(unreported).length - MAX_UNREPORTED;
    if (excess > 0) {
      const drop = new Set(doc.queue.filter(unreported).slice(0, excess));
      doc.queue = doc.queue.filter((it) => !drop.has(it));
      logger.warn(`dropped ${excess} unreported intents for unconfigured orgs (limit ${MAX_UNREPORTED})`);
    }
    doc.after_seq = full ? cursor : page.next_after_seq;
    state.write('intents', doc);
    return { added, full };
  }

  function queueFull(full) {
    if (!full) return state.clearAlert('intents_queue_full');
    const msg = `install intent queue is full (${MAX_QUEUE}); new intents are not pulled until it drains`;
    if (state.setAlert('intents_queue_full', msg)) logger.warn(msg);
  }

  function handleError(err, orgId) {
    if (!(err instanceof MarketError)) throw err;
    if (err.code === 'CLIENT_VERSION_TOO_OLD') {
      enterTooOld(err.reason ?? 'unknown', err.min_version, null);
      return 'too_old';
    }
    if (err.code === 'MEMBER_LEFT_ORG') {
      orgs.markLeft(orgId, err.reason);
      return 'org_left';
    }
    if (err.transient) {
      if (err.retryAfterMs) notBefore = now() + err.retryAfterMs;
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
        const { after_seq: afterSeq, queue } = state.read('intents', EMPTY_INTENTS);
        if (runnableCount(prune(queue)) >= MAX_QUEUE) {
          queueFull(true);
          return { outcome: 'queue_full', added };
        }
        const page = await api.pullInstallIntents({ orgId, agentId, afterSeq });
        orgs.markActive(orgId);
        if (!page) {
          leaveTooOld(null);
          queueFull(false);
          return { outcome: 'ok', added };
        }
        if (page.policy_sha256 !== POLICY_SHA256) {
          enterTooOld(POLICY_MISMATCH, null, page.policy_sha256);
          return { outcome: 'too_old', added };
        }
        leaveTooOld(page.policy_sha256);
        const r = persistPage(page);
        added += r.added;
        queueFull(r.full);
        if (r.full) return { outcome: 'queue_full', added };
        if (!page.has_more) return { outcome: 'ok', added };
      }
      return { outcome: 'partial', added };
    } catch (err) {
      return { outcome: handleError(err, orgId), added };
    }
  }

  return {
    // Earliest time the next pull may be sent (server Retry-After).
    notBefore: () => notBefore,
    // C-01 is identity-wide and pulled through the primary org only.
    async pull() {
      const orgId = orgs.primary;
      let result = { outcome: 'error', added: 0 };
      try {
        if (now() < notBefore) {
          result = { outcome: 'backoff', added: 0 };
        } else if (!orgs.mayContact(orgId)) {
          logger.debug(`primary org ${orgId} is ${orgs.membership(orgId)}; install intents are not pulled`);
          result = { outcome: 'org_left', added: 0 };
        } else {
          result = await pullPages(orgId);
        }
        if (result.outcome === 'ok' || result.outcome === 'partial' || result.outcome === 'queue_full') state.clearAlert('intents_pull');
        if (result.added) logger.info(`queued ${result.added} install intent(s)`);
      } catch (err) {
        logger.error(`install intent pull failed: ${err.message}`);
        try { state.setAlert('intents_pull', `install intent pull failed: ${err.message}`); } catch { /* status unwritable */ }
      } finally {
        try { state.recordRun('intents', result.outcome); } catch { /* status unwritable */ }
      }
      return result;
    },
  };
}
