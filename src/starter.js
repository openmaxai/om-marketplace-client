import { MarketError } from './http.js';
import { isCanonicalUuid, isOrgOrMemberId, uuidv7 } from './ids.js';
import { ImError } from './starter/im.js';
import { LIMITS, asksForCredential, cleanContent, cleanDisplayName, cleanText, fitContent, hasContent, renderStarter } from './starter/render.js';
import { withinLimits } from './starter/limits.js';

const RETRY_LATER = new Set(['CLIENT_VERSION_TOO_OLD', 'MEMBER_LEFT_ORG']);
export const MAX_STARTER_JOBS = 100;

// After a claim the message waits while the openmax activity store says a send into the DM would be a run's reply
// (an open run, or one closed by a reply within the last 10 minutes), checked every STARTER_CHECK_MS; STARTER_WAIT_MS
// after the claim it is given up as send_failed without any send. An openmax that supports noRun skips the wait.
export const STARTER_CHECK_MS = 30 * 1000;
export const STARTER_WAIT_MS = 8 * 60 * 1000;

// The starter message of an adoption, sent at most once from the Agent's own IM account: claim it with the market,
// filter and render the content locally, check that the DM is exactly this Agent and the adopter, send it once, then
// mark the result. Jobs live in state document `starters`, keyed by adoption id, with stage
// claim -> checking -> waiting -> sending -> mark. After a restart a checking job is marked send_failed (nothing was
// sent), a waiting job keeps waiting, and a sending job is dropped unmarked (delivery unknown, never sent again).
// content(job) returns {templateName, firstGuide, starterTasks: [{title, prompt}]} or null when it is not available;
// by default it is the starter_content the market put on the write order.
export function createStarter({
  api, state, orgs, logger, im, content = async (job) => job.content ?? null, enabled = true, now = Date.now, limits = {},
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

  const finish = (job, result) => {
    put(job.adoption_id, { stage: 'mark', result });
    return mark({ ...job, result });
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
    const filtered = raw && cleanContent({ ...raw, addressee: '' });
    if (!filtered || !hasContent(filtered)) {
      logger.info(`${tag(job)} not sent: no content`);
      return drop(id);
    }
    const clean = fitContent(filtered, limits);
    if (!clean) {
      logger.warn(`${tag(job)} not sent: the message does not fit the IM size limit`);
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
    put(id, { stage: 'checking', claimed_at: claim.claimed_at, claimed_local_at: now() });
    if (asksForCredential(raw, clean)) {
      logger.warn(`${tag(job)} not sent: it asks for a credential`);
      return finish(job, 'rejected_content');
    }
    let dm;
    try {
      dm = await verifiedDm(job, self);
    } catch (err) {
      if (!(err instanceof ImError)) logger.error(`${tag(job)}: DM check failed: ${err.message}`);
      else logger.warn(`${tag(job)} not sent: DM check failed (${err.message})`);
      return finish(job, 'send_failed');
    }
    if (!dm) {
      logger.warn(`${tag(job)} not sent: the DM is not exactly this Agent and the adopter`);
      return finish(job, 'send_failed');
    }
    const addressee = cleanText(cleanDisplayName(dm.adopter?.display_name), { max: LIMITS.addressee, multiline: false });
    const text = renderStarter({ ...clean, addressee });
    if (!withinLimits({ text }, limits)) {
      logger.error(`${tag(job)} not sent: the message does not fit the IM size limit`);
      return finish(job, 'send_failed');
    }
    put(id, { stage: 'waiting', conversation_id: dm.conversationId, text });
    return sendWhenFree(jobs()[id]);
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
        return finish(job, 'send_failed');
      }
    }
    put(job.adoption_id, { stage: 'sending' });
    try {
      await im.sendText({ orgId: job.org_id, conversationId: job.conversation_id, text: job.text, clientMsgId: `cmsg_${uuidv7(now())}`, noRun });
    } catch (err) {
      if (err instanceof ImError && err.definite) {
        logger.warn(`${tag(job)}: send refused (${err.message}); not retried`);
        return finish(job, 'send_failed');
      }
      logger.warn(`${tag(job)}: send outcome unknown (${err.message}); not retried and not reported`);
      return drop(job.adoption_id);
    }
    logger.info(`${tag(job)} sent`);
    return finish(job, 'sent');
  }

  async function step(job) {
    if (job.stage === 'mark') return mark(job);
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

  async function runJobs(onlyWaiting) {
    for (const job of Object.values(jobs())) {
      if (onlyWaiting && job.stage !== 'waiting') continue;
      if (job.stage === 'sending') {
        logger.warn(`${tag(job)} was interrupted while sending; it is not sent again`);
        drop(job.adoption_id);
        continue;
      }
      if (job.stage === 'checking') {
        logger.warn(`${tag(job)} was interrupted before sending; reported as send_failed`);
        await finish(job, 'send_failed');
        continue;
      }
      if (!orgs.mayContact(job.org_id)) continue;
      try {
        await step(job);
      } catch (err) {
        logger.error(`${tag(job)}: ${err.message}`);
        const cur = jobs()[job.adoption_id];
        if (cur?.stage === 'sending') drop(job.adoption_id);
        else if (cur?.stage === 'checking') await finish(cur, 'send_failed');
      }
    }
  }

  return {
    // Queues the starter message of an adoption whose first write the market accepted; a known adoption is not queued again.
    enqueue({ orgId, adoptionId, adoptedBy, content = null }) {
      if (!isOrgOrMemberId(orgId) || !isCanonicalUuid(adoptionId) || !isOrgOrMemberId(adoptedBy)) return false;
      let added = false;
      state.update('starters', {}, (d) => {
        if (d[adoptionId] || Object.keys(d).length >= MAX_STARTER_JOBS) return;
        d[adoptionId] = {
          org_id: orgId, adoption_id: adoptionId, adopted_by_member_id: adoptedBy, content, stage: 'claim', created_at: iso(), updated_at: iso(),
        };
        added = true;
      });
      if (!added) logger.warn(`starter message of adoption ${adoptionId} not queued`);
      return added;
    },

    // Runs every queued job once.
    runAll: () => serial(() => runJobs(false)),

    // Checks the jobs waiting for the DM to be free.
    runWaiting: () => serial(() => runJobs(true)),
  };
}
