import crypto from 'node:crypto';
import path from 'node:path';
import { MarketError } from './http.js';
import { uuidv7 } from './ids.js';
import { EMPTY_INTENTS, tooOld } from './intents.js';
import { revokedSet } from './revocations.js';
import { checkPackageUrl, downloadPackage } from './download.js';
import { inspectInWorker } from './inspect.js';
import { failureFor, landSkill } from './land.js';

// Left for a later round: the request is replayed with the same id and body.
const RETRY_LATER = new Set(['INTENT_OUT_OF_ORDER', 'CLIENT_VERSION_TOO_OLD', 'MEMBER_LEFT_ORG']);
const ALERT = new Set(['AGENT_NOT_SELF', 'REQUEST_ID_CONFLICT', 'VALIDATION_FAILED']);

// Executes queued install intents one at a time: C-02, C-03 and download, inspection, landing, C-06. Results not yet
// accepted stay in the outbox and are resent unchanged first.
export function createInstaller({
  api, state, orgs, logger, bffUrl, skillsDir, dataDir, emulatorOrigin = null, fetchImpl, inspect = inspectInWorker,
  now = Date.now, sleep, signal = null,
}) {
  const iso = () => new Date(now()).toISOString();
  const journal = (id, patch) => state.journal.put(id, { ...state.journal.get(id), ...patch, updated_at: iso() });
  const setIntent = (id, patch) => state.update('intents', EMPTY_INTENTS, (d) => {
    d.queue = patch ? d.queue.map((q) => (q.id === id ? { ...q, ...patch } : q)) : d.queue.filter((q) => q.id !== id);
  });

  function marketFailure(err, it, what) {
    if (!(err instanceof MarketError)) throw err;
    if (err.code === 'MEMBER_LEFT_ORG') orgs.markLeft(it.org_id, err.reason);
    if (err.transient || RETRY_LATER.has(err.code)) {
      logger.warn(`install intent ${it.id}: ${what} deferred (${err.code || err.status})`);
      return 'deferred';
    }
    const msg = `install intent ${it.id}: ${what} rejected (${err.code || err.status})`;
    if (ALERT.has(err.code)) state.setAlert(`install:${it.id}`, msg);
    logger.warn(msg);
    setIntent(it.id, null);
    return 'closed';
  }

  async function report(requestId, orgId, intentId, body) {
    state.outbox.put(requestId, { org_id: orgId, intent_id: intentId, body });
    journal(requestId, { phase: 'reporting', result: body });
    let res;
    try {
      res = await api.reportInstallResult({ orgId, requestId, body });
    } catch (err) {
      if (!(err instanceof MarketError) || err.transient) {
        logger.warn(`install result for ${requestId} not delivered; kept for resend`);
        return 'deferred';
      }
      state.setAlert(`install_result:${requestId}`, `install result for ${requestId} rejected (${err.code || err.status})`);
      res = { status: 'rejected', error_code: err.code };
    }
    state.outbox.remove(requestId);
    journal(requestId, { phase: 'reported', response: res });
    if (intentId) setIntent(intentId, null);
    if (res.status !== body.status) logger.warn(`install ${requestId}: market recorded ${res.status} ${res.error_code ?? ''}`.trim());
    return body.status;
  }

  async function flushOutbox() {
    for (const id of state.outbox.list()) {
      const o = state.outbox.get(id);
      if (o && (await report(id, o.org_id, o.intent_id, o.body)) === 'deferred') return false;
    }
    return true;
  }

  async function execute(it) {
    const agentId = await orgs.agentId(it.org_id);
    const requestId = it.request_id ?? uuidv7(now());
    const body = state.journal.get(requestId)?.body ?? {
      request_id: requestId, skill_id: it.skill_id, ...(it.skill_version_id ? { skill_version_id: it.skill_version_id } : {}),
      op: 'install', intent_id: it.id, ...(it.source_market_id ? { market: it.source_market_id } : {}),
    };
    journal(requestId, { intent_id: it.id, org_id: it.org_id, op: 'install', body, phase: 'requested' });
    setIntent(it.id, { status: 'running', request_id: requestId });
    let res;
    try {
      res = await api.requestInstall({ orgId: it.org_id, agentId, body });
    } catch (err) {
      if (!(err instanceof MarketError) || err.code !== 'RESPONSE_INVALID') return marketFailure(err, it, 'install request');
      return report(requestId, it.org_id, it.id, { status: 'failed', error_code: 'CLIENT_INTERNAL', error_message: 'install_response_invalid' });
    }
    if (res.already_installed) {
      journal(requestId, { phase: 'closed', response: res });
      setIntent(it.id, null);
      return 'already_installed';
    }
    journal(requestId, { phase: 'downloading', response: res });
    let result;
    try {
      const subPath = checkPackageUrl(res.package_url, { bffUrl, orgId: it.org_id, agentId, requestId });
      const bytes = await downloadPackage({
        api, orgId: it.org_id, subPath, sha: res.package_sha256, size: res.size_bytes, emulatorOrigin, fetchImpl, now, sleep, signal,
      });
      const inspected = await inspect(bytes, { signal });
      landSkill({
        skillsDir, stagingRoot: path.join(dataDir, 'staging'), rollbackRoot: path.join(dataDir, 'rollback'), requestId, install: res, inspected,
      });
      result = { status: 'succeeded', installed_sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
    } catch (err) {
      if (signal?.aborted) return 'deferred';
      if (err instanceof MarketError) return marketFailure(err, it, 'package download');
      const f = failureFor(err);
      if (f.reason === 'client internal error') logger.error(`install ${requestId}: ${err.message}`);
      result = { status: 'failed', error_code: f.code, error_message: f.reason };
    }
    return report(requestId, it.org_id, it.id, result);
  }

  return {
    // Resolves to the outcome of the one intent run, or null when there was none to run.
    async runNext() {
      if (!(await flushOutbox()) || tooOld(state)) return null;
      const revoked = revokedSet(state);
      const t = now();
      for (const it of state.read('intents', EMPTY_INTENTS).queue) {
        if (it.op !== 'install' || (it.status !== 'queued' && it.status !== 'running')) continue;
        if (Date.parse(it.expires_at) <= t || revoked.has('skill_version_id', it.skill_version_id)) {
          logger.info(`install intent ${it.id} dropped: ${Date.parse(it.expires_at) <= t ? 'expired' : 'version revoked'}`);
          setIntent(it.id, null);
          continue;
        }
        if (!orgs.mayContact(it.org_id)) continue;
        return execute(it);
      }
      return null;
    },
  };
}
