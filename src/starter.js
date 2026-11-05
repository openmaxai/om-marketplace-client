import { MarketError } from './http.js';
import { isCanonicalUuid, isOrgOrMemberId, uuidv7 } from './ids.js';
import { ImError } from './starter/im.js';
import { LIMITS, asksForCredential, cleanContent, cleanDisplayName, cleanText, hasContent, renderStarter } from './starter/render.js';

const RETRY_LATER = new Set(['CLIENT_VERSION_TOO_OLD', 'MEMBER_LEFT_ORG']);
export const MAX_STARTER_JOBS = 100;

// The starter message of an adoption, sent at most once from the Agent's own IM account: claim it with the market,
// filter and render the content locally, check that the DM is exactly this Agent and the adopter, send it once, then
// mark the result. Jobs live in state document `starters`, keyed by adoption id, with stage claim -> sending -> mark.
// A job found in stage sending was interrupted mid-send and is dropped: nothing is sent again and nothing is marked.
// content(job) returns {templateName, firstGuide, starterTasks: [{title, prompt}]} or null when it is not available.
export function createStarter({
  api, state, orgs, logger, im, content = async () => null, enabled = true, now = Date.now,
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
    const clean = raw && cleanContent({ ...raw, addressee: '' });
    if (!clean || !hasContent(clean)) {
      logger.info(`${tag(job)} not sent: no content`);
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
    put(id, { stage: 'sending', claimed_at: claim.claimed_at });
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
    try {
      await im.sendText({ orgId: job.org_id, conversationId: dm.conversationId, text, clientMsgId: `cmsg_${uuidv7(now())}` });
    } catch (err) {
      const known = err instanceof ImError && err.definite;
      logger.warn(`${tag(job)}: send failed (${err.message})${known ? '' : '; delivery unknown'}; not retried`);
      return finish(job, 'send_failed');
    }
    logger.info(`${tag(job)} sent`);
    return finish(job, 'sent');
  }

  return {
    // Queues the starter message of an adoption whose first write the market accepted; a known adoption is not queued again.
    enqueue({ orgId, adoptionId, adoptedBy }) {
      if (!isOrgOrMemberId(orgId) || !isCanonicalUuid(adoptionId) || !isOrgOrMemberId(adoptedBy)) return false;
      let added = false;
      state.update('starters', {}, (d) => {
        if (d[adoptionId] || Object.keys(d).length >= MAX_STARTER_JOBS) return;
        d[adoptionId] = { org_id: orgId, adoption_id: adoptionId, adopted_by_member_id: adoptedBy, stage: 'claim', created_at: iso(), updated_at: iso() };
        added = true;
      });
      if (!added) logger.warn(`starter message of adoption ${adoptionId} not queued`);
      return added;
    },

    // Runs every queued job once.
    async runAll() {
      for (const job of Object.values(jobs())) {
        if (job.stage === 'sending') {
          logger.warn(`${tag(job)} was interrupted while sending; it is not sent again`);
          drop(job.adoption_id);
          continue;
        }
        if (!orgs.mayContact(job.org_id)) continue;
        try {
          if (job.stage === 'mark') await mark(job);
          else await claimAndSend(job);
        } catch (err) {
          logger.error(`${tag(job)}: ${err.message}`);
          if (jobs()[job.adoption_id]?.stage === 'sending') drop(job.adoption_id);
        }
      }
    },
  };
}
