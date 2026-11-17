import crypto from 'node:crypto';
import { MarketError } from './http.js';
import { isCanonicalUuid, isOrgOrMemberId, uuidv7 } from './ids.js';
import { ImError } from './starter/im.js';
import {
  LIMITS, asksForCredential, cleanContent, cleanDisplayName, cleanText, fitContent, fitFallback, hasContent, renderStarter,
} from './starter/render.js';
import { withinLimits } from './starter/limits.js';

// sha256 of the content as canonical JSON (object keys sorted at every level).
const canonical = (v) => (Array.isArray(v) ? `[${v.map(canonical).join(',')}]`
  : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`
    : JSON.stringify(v ?? null));
export const contentHash = (raw) => crypto.createHash('sha256').update(canonical(raw)).digest('hex');

const RETRY_LATER = new Set(['CLIENT_VERSION_TOO_OLD', 'MEMBER_LEFT_ORG']);
export const MAX_STARTER_JOBS = 100;

// After a claim the message waits while the openmax activity store says a send into the DM would be a run's reply
// (an open run, or one closed by a reply within the last 10 minutes), checked every STARTER_CHECK_MS; STARTER_WAIT_MS
// after the claim it is given up as send_failed without any send. An openmax that supports noRun skips the wait.
export const STARTER_CHECK_MS = 30 * 1000;
// Must stay below the market's 10-minute fallback-card grace after the claim (app.StarterCardClaimGrace), so the
// card never shows while a send may still happen.
export const STARTER_WAIT_MS = 8 * 60 * 1000;
// No send starts later than this after the claim: the DM check before the send may take a few CLI calls (each tried
// twice), and the send itself up to IM_TIMEOUT_MS, all of which must end before the market's 10-minute grace.
export const STARTER_SEND_BY_MS = 9 * 60 * 1000;
// A send whose outcome is unknown is looked up in the conversation by its client message id. Not found is taken as not
// delivered only this long after the send started (the request may still be in flight); after STARTER_VERIFY_MS without
// an answer the job is dropped unmarked.
export const STARTER_VERIFY_SETTLE_MS = 60 * 1000;
export const STARTER_VERIFY_MS = 10 * 60 * 1000;
// Allowance for clock skew between this host and the IM service when the lookup decides how far back to read.
export const LOOKUP_SKEW_MS = 5 * 60 * 1000;

// The short reason code of an IM failure: http_<status>, timeout, exit, unreadable_output, refused, bad_answer (a
// readable answer of the wrong shape) or error (not an IM failure).
export function imReason(err) {
  if (!(err instanceof ImError)) return 'error';
  if (err.status) return `http_${err.status}`;
  return { timeout: 'timeout', exit: 'exit', unreadable: 'unreadable_output', refused: 'refused' }[err.kind] ?? 'bad_answer';
}

// The starter message of an adoption, sent at most once from the Agent's own IM account: claim it with the market,
// filter and render the content locally, check that the DM is exactly this Agent and the adopter, send it once, then
// mark the result. Jobs live in state document `starters`, keyed by adoption id, with stage
// claim -> checking -> waiting -> sending -> mark. After a restart a checking job is marked send_failed (nothing was
// sent) and a waiting job keeps waiting. A send whose outcome is unknown (a timeout, or a restart during the send) is
// never sent again: the job moves to stage verifying, where the message is looked up by its client message id and the
// job marked sent when found, send_failed when it is surely absent, or dropped unmarked when the lookup cannot tell.
// A send_failed or rejected_content job keeps a short reason code (job.reason), logged with the mark; the market's
// :mark-starter-shown takes only the result, so the reason stays local.
// A job queued with hold_until (a new session was requested for its template, or none could be requested yet) is not
// claimed before that time while activation.isPending(adoption) holds, so the message follows the session that has
// the template; the claim still happens right before the send, so a hold never shortens STARTER_WAIT_MS or
// STARTER_SEND_BY_MS, and the market's grace starts only at the claim. The hold is kept in the job, so it survives a
// restart.
// content(job) returns {templateName, firstGuide, starterTasks: [{title, prompt}]} or null when it is not available;
// by default it is the starter_content the market put on the write order.
// With structured (starter_message.structured, default true) and an openmax that supports it, the message is sent as
// AGENT_STRUCTURED with client_msg_id mkt-starter-<adoption id>, so the web chat can draw it as the welcome card; a
// definite refusal of that send is followed by one AGENT_TEXT send with id mkt-starter-<adoption id>-text. Otherwise
// it is sent as AGENT_TEXT with a cmsg_<uuidv7> id.
export function createStarter({
  api, state, orgs, logger, im, content = async (job) => job.content ?? null, enabled = true, now = Date.now, limits = {},
  activation = null, structured = true,
}) {
  const iso = () => new Date(now()).toISOString();
  const jobs = () => state.read('starters', {});
  const put = (id, patch) => state.update('starters', {}, (d) => { d[id] = { ...d[id], ...patch, updated_at: iso() }; });
  const drop = (id) => state.update('starters', {}, (d) => { delete d[id]; });
  const tag = (job) => `starter message of adoption ${job.adoption_id}`;

  // The market error says whether to keep the job for the next round.
  function keep(err, job, what) {
    if (!(err instanceof MarketError)) throw err;
    if (err.code === 'MEMBER_LEFT_ORG') orgs.markLeft(job.org_id, err.reason);
    const later = err.transient || RETRY_LATER.has(err.code);
    logger.warn(`${tag(job)}: ${what} failed (${err.code || err.status})${later ? '; retried next round' : '; dropped'}`);
    return later;
  }

  async function mark(job) {
    try {
      await api.markStarterShown({ orgId: job.org_id, agentId: await orgs.agentId(job.org_id), adoptionId: job.adoption_id, result: job.result });
    } catch (err) {
      if (keep(err, job, `mark ${job.result}`)) return;
    }
    drop(job.adoption_id);
  }

  const finish = (job, result, reason = null) => {
    put(job.adoption_id, { stage: 'mark', result, ...(reason ? { reason } : {}) });
    if (reason) logger.info(`${tag(job)}: marked ${result} (reason ${reason})`);
    return mark({ ...job, result, reason });
  };

  // True when the DM is exactly this Agent and the adopter; the adopter's member entry is returned for the greeting.
  async function verifiedDm(job, self) {
    const conversationId = await im.createDm({ orgId: job.org_id, peerMemberId: job.adopted_by_member_id });
    const conv = await im.getConversation({ orgId: job.org_id, conversationId });
    const members = await im.memberList({ orgId: job.org_id, conversationId });
    const ids = members.map((m) => m?.member_id);
    const ok = conv?.id === conversationId && String(conv?.type ?? '').toLowerCase() === 'dm'
      && ids.length === 2 && new Set(ids).size === 2 && ids.includes(self) && ids.includes(job.adopted_by_member_id);
    return ok ? { conversationId, adopter: members.find((m) => m.member_id === job.adopted_by_member_id) } : null;
  }

  // The message text from raw content through the whole pipeline, or null with the reason it may not be sent (why
  // for the log, reason as a code).
  function prepare(raw, addressee) {
    const filtered = raw && cleanContent({ ...raw, addressee: '' });
    if (!filtered || !hasContent(filtered)) return { why: 'no content', reason: 'no_content' };
    const clean = fitContent(filtered, limits);
    if (!clean) return { why: 'the message does not fit the IM size limit', reason: 'too_large' };
    if (asksForCredential(raw, clean) || (addressee && asksForCredential({ templateName: addressee }, { templateName: addressee }))) {
      return { why: 'it asks for a credential', reason: 'asks_for_credential', credential: true };
    }
    const text = renderStarter({ ...clean, addressee: addressee ?? '' });
    const fallbackText = fitFallback(clean, addressee ?? '', limits);
    if (!withinLimits({ text, fallbackText }, limits)) return { why: 'the message does not fit the IM size limit', reason: 'too_large' };
    return { text, fallbackText };
  }

  async function claimAndSend(job) {
    const id = job.adoption_id;
    if (!enabled) {
      logger.info(`${tag(job)} not sent: starter_message.enabled is false`);
      return drop(id);
    }
    if (!im.available()) {
      logger.warn(`${tag(job)} not sent: the openmax IM component is not installed`);
      return drop(id);
    }
    let raw;
    try {
      raw = await content(job);
    } catch (err) {
      logger.warn(`${tag(job)} not sent: content unavailable (${err.message})`);
      return drop(id);
    }
    const before = prepare(raw, null);
    if (before.why && !before.credential) {
      logger.info(`${tag(job)} not sent: ${before.why}`);
      return drop(id);
    }
    const self = await orgs.agentId(job.org_id);
    let claim;
    try {
      claim = await api.claimStarter({ orgId: job.org_id, agentId: self, adoptionId: id });
    } catch (err) {
      if (!keep(err, job, 'claim')) drop(id);
      return undefined;
    }
    if (claim.result !== 'claimed') {
      logger.info(`${tag(job)} not sent: claim answered ${claim.result}`);
      return drop(id);
    }
    put(id, { stage: 'checking', claimed_at: claim.claimed_at, claimed_local_at: now(), content_sha256: contentHash(raw) });
    if (before.credential) {
      logger.warn(`${tag(job)} not sent: it asks for a credential`);
      return finish(job, 'rejected_content', before.reason);
    }
    let dm;
    try {
      dm = await verifiedDm(job, self);
    } catch (err) {
      if (!(err instanceof ImError)) logger.error(`${tag(job)}: DM check failed: ${err.message}`);
      else logger.warn(`${tag(job)} not sent: DM check failed (${err.message})`);
      return finish(job, 'send_failed', `dm_check_${imReason(err)}`);
    }
    if (!dm) {
      logger.warn(`${tag(job)} not sent: the DM is not exactly this Agent and the adopter`);
      return finish(job, 'send_failed', 'dm_not_one_to_one');
    }
    put(id, { stage: 'waiting', conversation_id: dm.conversationId });
    return sendWhenFree(jobs()[id]);
  }

  // The text to send now, rendered again from the content checked at the claim and the adopter's current name; null
  // when the content changed since the claim, the DM is no longer the same 1:1 DM, or any pipeline step fails.
  async function renderAgain(job) {
    let raw;
    try {
      raw = await content(job);
    } catch (err) {
      return { why: `content unavailable (${err.message})`, reason: 'content_unavailable' };
    }
    if (!raw || contentHash(raw) !== job.content_sha256) return { why: 'the content changed after the claim', reason: 'content_changed' };
    let dm;
    try {
      dm = await verifiedDm(job, await orgs.agentId(job.org_id));
    } catch (err) {
      return { why: `DM check failed (${err.message})`, reason: `dm_check_${imReason(err)}` };
    }
    if (!dm) return { why: 'the DM is not exactly this Agent and the adopter', reason: 'dm_not_one_to_one' };
    if (dm.conversationId !== job.conversation_id) return { why: 'the DM changed after the claim', reason: 'dm_changed' };
    return prepare(raw, cleanText(cleanDisplayName(dm.adopter?.display_name), { max: LIMITS.addressee, multiline: false }));
  }

  // Sends once nothing in the DM would take the message as a run's reply; gives up after STARTER_WAIT_MS.
  async function sendWhenFree(job) {
    const noRun = im.supportsNoRun();
    if (!noRun) {
      let busy;
      try {
        busy = await im.runInProgress({ conversationId: job.conversation_id });
      } catch (err) {
        logger.warn(`${tag(job)}: run state unreadable (${err.message})`);
        busy = true;
      }
      if (busy) {
        if (now() - job.claimed_local_at < STARTER_WAIT_MS) return undefined;
        logger.warn(`${tag(job)} not sent: the DM still had an active run ${STARTER_WAIT_MS / 60000} minutes after the claim`);
        return finish(job, 'send_failed', 'dm_busy');
      }
    }
    const { text, fallbackText, why, reason } = await renderAgain(job);
    if (!text) {
      logger.warn(`${tag(job)} not sent: ${why}`);
      return finish(job, 'send_failed', reason);
    }
    if (now() - job.claimed_local_at >= STARTER_SEND_BY_MS) {
      logger.warn(`${tag(job)} not sent: the DM check ended ${STARTER_SEND_BY_MS / 60000} minutes or more after the claim`);
      return finish(job, 'send_failed', 'too_late');
    }
    const to = { orgId: job.org_id, conversationId: job.conversation_id, text, noRun };
    const id = job.adoption_id;
    // The id of the send about to start is stored first, so an unknown outcome can be looked up.
    const sending = (clientMsgId) => {
      put(id, { stage: 'sending', client_msg_id: clientMsgId, send_started_at: now() });
      return clientMsgId;
    };
    try {
      if (structured && im.supportsStructured?.()) {
        try {
          await im.sendStructured({ ...to, clientMsgId: sending(`mkt-starter-${id}`), adoptionId: id, fallbackText });
        } catch (err) {
          // Only a definite refusal is sure to have sent nothing, so only then is the plain text sent, once. It must
          // start within the same deadline as the first send, so it too ends before the market's grace.
          if (!(err instanceof ImError && err.definite)) throw err;
          if (now() - job.claimed_local_at >= STARTER_SEND_BY_MS) {
            logger.warn(`${tag(job)}: structured send refused (${err.message}); too late to send it as plain text`);
            throw err;
          }
          logger.warn(`${tag(job)}: structured send refused (${err.message}); sending it once as plain text`);
          await im.sendText({ ...to, clientMsgId: sending(`mkt-starter-${id}-text`) });
        }
      } else {
        await im.sendText({ ...to, clientMsgId: sending(`cmsg_${uuidv7(now())}`) });
      }
    } catch (err) {
      if (err instanceof ImError && err.definite) {
        logger.warn(`${tag(job)}: send refused (${err.message}); not retried`);
        return finish(job, 'send_failed', `send_refused_${imReason(err)}`);
      }
      return outcomeUnknown(jobs()[id], `send outcome unknown (${err.message})`);
    }
    logger.info(`${tag(job)} sent`);
    return finish(job, 'sent');
  }

  const canLookUp = (job) => typeof im.findMessage === 'function' && typeof job?.client_msg_id === 'string'
    && Number.isFinite(job?.send_started_at) && typeof job?.conversation_id === 'string';

  // The message is never sent again; it is looked up when it can be, else the job is dropped unmarked.
  function outcomeUnknown(job, why) {
    if (!canLookUp(job)) {
      logger.warn(`${tag(job)}: ${why}; not retried and not reported`);
      return drop(job.adoption_id);
    }
    logger.warn(`${tag(job)}: ${why}; not retried, looking it up in the conversation`);
    put(job.adoption_id, { stage: 'verifying' });
    return verify(jobs()[job.adoption_id]);
  }

  async function verify(job) {
    if (!canLookUp(job)) {
      logger.warn(`${tag(job)}: delivery cannot be looked up; not reported`);
      return drop(job.adoption_id);
    }
    let found = 'unknown';
    try {
      found = await im.findMessage({
        orgId: job.org_id, conversationId: job.conversation_id, clientMsgId: job.client_msg_id, since: job.send_started_at - LOOKUP_SKEW_MS,
      });
    } catch (err) {
      logger.debug(`${tag(job)}: lookup failed (${err.message})`);
    }
    if (found === 'found') {
      logger.info(`${tag(job)} found in the conversation; marked sent`);
      return finish(job, 'sent');
    }
    const age = now() - job.send_started_at;
    if (found === 'absent' && age >= STARTER_VERIFY_SETTLE_MS) {
      logger.warn(`${tag(job)} not found in the conversation; marked send_failed`);
      return finish(job, 'send_failed', 'send_lost');
    }
    if (age >= STARTER_VERIFY_MS) {
      logger.warn(`${tag(job)}: delivery still unknown ${STARTER_VERIFY_MS / 60000} minutes after the send; not reported`);
      return drop(job.adoption_id);
    }
    return undefined;
  }

  async function step(job) {
    if (job.stage === 'mark') return mark(job);
    if (job.stage === 'verifying') return verify(job);
    if (job.stage === 'waiting') return sendWhenFree(job);
    return claimAndSend(job);
  }

  // One run at a time, so the poll round and the wait checks never work on a job together.
  let chain = Promise.resolve();
  const serial = (fn) => {
    const p = chain.then(fn);
    chain = p.catch(() => {});
    return p;
  };

  // True while the job waits for its template to reach a session; a released hold is cleared, so the job is claimed
  // like any other.
  function held(job) {
    if (job.stage !== 'claim' || !job.hold_until) return false;
    let pending = false;
    try { pending = Boolean(activation?.isPending(job.adoption_id)); } catch { /* unreadable: released */ }
    if (pending && now() < job.hold_until) return true;
    put(job.adoption_id, { hold_until: null });
    return false;
  }

  async function runJobs(onlyWaiting) {
    for (const job of Object.values(jobs())) {
      if (onlyWaiting && job.stage !== 'waiting' && job.stage !== 'verifying' && !(job.stage === 'claim' && job.hold_until)) continue;
      if (held(job)) continue;
      if (job.stage === 'sending') {
        if (!canLookUp(job)) {
          logger.warn(`${tag(job)} was interrupted while sending; it is not sent again`);
          drop(job.adoption_id);
          continue;
        }
        logger.warn(`${tag(job)} was interrupted while sending; it is not sent again, looking it up in the conversation`);
        put(job.adoption_id, { stage: 'verifying' });
        job.stage = 'verifying';
      }
      if (job.stage === 'checking') {
        logger.warn(`${tag(job)} was interrupted before sending; reported as send_failed`);
        await finish(job, 'send_failed', 'interrupted');
        continue;
      }
      if (!orgs.mayContact(job.org_id)) continue;
      try {
        await step(job);
      } catch (err) {
        logger.error(`${tag(job)}: ${err.message}`);
        const cur = jobs()[job.adoption_id];
        if (cur?.stage === 'sending') drop(job.adoption_id);
        else if (cur?.stage === 'checking') await finish(cur, 'send_failed', 'internal_error');
      }
    }
  }

  return {
    // Queues the starter message of an adoption whose first write the market accepted; a known adoption is not queued again.
    // holdUntil (ms): the message waits for its template's session until then.
    enqueue({ orgId, adoptionId, adoptedBy, content = null, holdUntil = null }) {
      if (!isOrgOrMemberId(orgId) || !isCanonicalUuid(adoptionId) || !isOrgOrMemberId(adoptedBy)) return false;
      let added = false;
      state.update('starters', {}, (d) => {
        if (d[adoptionId] || Object.keys(d).length >= MAX_STARTER_JOBS) return;
        d[adoptionId] = {
          org_id: orgId, adoption_id: adoptionId, adopted_by_member_id: adoptedBy, content, stage: 'claim', created_at: iso(), updated_at: iso(),
          ...(Number.isFinite(holdUntil) ? { hold_until: holdUntil } : {}),
        };
        added = true;
      });
      if (!added) logger.warn(`starter message of adoption ${adoptionId} not queued`);
      return added;
    },

    // Runs every queued job once.
    runAll: () => serial(() => runJobs(false)),

    // Checks the jobs waiting for the DM to be free, for their template's session, or for a delivery lookup.
    runWaiting: () => serial(() => runJobs(true)),
  };
}
