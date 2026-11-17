// Market search and install proposals. The Agent attests that its owner confirmed or declined in a direct
// conversation with it (agent_attested); anyone else installs manually in the Workspace market.
import crypto from 'node:crypto';
import { MarketError, installers, marketQuote } from '../http.js';
import { isCanonicalUuid, isOrgOrMemberId } from '../ids.js';
import { explainCommonError, explainOther } from './submit-api.js';

export const MAX_QUERY_CHARS = 100;
export const MAX_REASON_CHARS = 500;
export const MAX_LIMIT = 20;
export const MAX_CANDIDATES = 3;
export const PROPOSAL_STATES = new Set(['pending_confirmation', 'confirming', 'confirmed', 'declined', 'superseded', 'expired']);
export const CHANNELS = new Set(['workspace', 'lark', 'telegram', 'other']);
export const MAX_CHANNEL_DETAIL = 64;
export const MAX_MESSAGE_ID = 200;
export const MAX_MESSAGE_TEXT = 500;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
// The Workspace web origin, taken from the proposal's confirm_url (the market builds it from its web origin; the page
// itself is not linked). https (http only on loopback), no credentials, at most 2048 characters.
export function workspaceOrigin(v) {
  if (typeof v !== 'string' || v.length > 2048) return null;
  let u;
  try { u = new URL(v); } catch { return null; }
  if (u.username || u.password) return null;
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && LOOPBACK.has(u.hostname))) return null;
  return u.origin;
}

// Workspace pages where a person installs manually: the market skill detail (/market/skills/{skill_id}) and the
// Agent detail (/agents?id={agent_id}). Without an origin the pages are named instead.
export function manualInstallPages({ origin, agentId, candidates }) {
  const skills = candidates.map((c) => ({
    name: c.name ?? c.skill_id,
    url: origin ? `${origin}/market/skills/${encodeURIComponent(c.skill_id)}` : null,
  }));
  return { skills, agent_url: origin && agentId ? `${origin}/agents?id=${encodeURIComponent(agentId)}` : null };
}

export function manualInstallWhere(pages) {
  if (pages.skills.some((k) => k.url)) {
    return `${pages.skills.map((k) => `「${k.name}」${k.url}`).join('，')}${pages.agent_url ? `；或在我的详情页里装：${pages.agent_url}` : ''}`;
  }
  return `在 Workspace「市场」里打开${pages.skills.map((k) => `「${k.name}」`).join('')}安装`;
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
// Market text is shown to the Agent as data: control characters other than newline are dropped and length is capped.
export const clean = (v, max = 500) => {
  if (typeof v !== 'string') return null;
  const t = v.replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '').trim();
  return [...t].length > max ? `${[...t].slice(0, max).join('')}…` : t;
};
const shape = (label, what) => new MarketError(`${label}: response ${what}`, { status: 200, code: 'RESPONSE_INVALID', transient: false });

function skillItem(v) {
  if (!isObject(v) || !isCanonicalUuid(v.skill_id)) return null;
  return {
    skill_id: v.skill_id,
    slug: clean(v.slug, 64),
    name: clean(v.name, 100),
    description: clean(v.description, 500),
    category: isObject(v.category) ? clean(v.category.name_en ?? v.category.name, 64) : null,
    version: clean(v.version, 64),
    skill_version_id: isCanonicalUuid(v.skill_version_id) ? v.skill_version_id : null,
    examples: Array.isArray(v.examples) ? v.examples.slice(0, 3).filter(isObject).map((e) => ({ title: clean(e.title, 40), prompt: clean(e.prompt, 300) })) : [],
    installed: v.installed === true,
  };
}

// Characters the market drops from free text: controls (CR included), format characters, line and paragraph separators
// and Other_Default_Ignorable_Code_Point (fillers such as U+115F, U+3164, U+FFA0).
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\u034f\u115f\u1160\u17b4\u17b5\u2065\u3164\uffa0\ufff0-\ufff8\u{e0000}\u{e0002}-\u{e001f}\u{e0080}-\u{e00ff}\u{e01f0}-\u{e0fff}]/gu;

// The market's stored form of evidence text (test/vectors/evidence-sanitize.json): NFC; LF, tab, U+2028, U+2029 to
// spaces; invisible characters deleted; trimmed; cut to max characters; trimmed again. Used only to tell whether
// anything visible is left; the text itself is sent as received and the market cleans it.
export function marketCleanText(v, max) {
  if (typeof v !== 'string') return '';
  const t = v.normalize('NFC').replace(/[\n\t\u2028\u2029]/g, ' ').replace(INVISIBLE, '').trim();
  return [...t].length > max ? [...t].slice(0, max).join('').trim() : t;
}

// Raw evidence is capped at this many times the market's limit before sending.
export const RAW_EVIDENCE_FACTOR = 4;

// The text to send: as received, cut to RAW_EVIDENCE_FACTOR * max characters; null when nothing visible is left in
// what would be sent.
export function rawEvidence(v, max) {
  if (typeof v !== 'string') return null;
  const chars = [...v];
  const sent = chars.length > RAW_EVIDENCE_FACTOR * max ? chars.slice(0, RAW_EVIDENCE_FACTOR * max).join('') : v;
  return marketCleanText(sent, max) ? sent : null;
}

function candidateView(v, i) {
  if (!isObject(v) || !isCanonicalUuid(v.skill_id)) return null;
  return {
    position: i + 1,
    skill_id: v.skill_id,
    skill_version_id: isCanonicalUuid(v.skill_version_id) ? v.skill_version_id : null,
    name: clean(v.name, 100),
    description: clean(v.description, 500),
    version: clean(v.version, 64),
    reason: clean(v.reason, MAX_REASON_CHARS),
    selected: typeof v.selected === 'boolean' ? v.selected : null,
    intent_id: isCanonicalUuid(v.intent_id) ? v.intent_id : null,
  };
}

export function proposalView(v) {
  if (!isObject(v) || !isCanonicalUuid(v.proposal_id) || !PROPOSAL_STATES.has(v.state) || !Array.isArray(v.candidates)) return null;
  const candidates = v.candidates.map((c, i) => candidateView(c, i));
  if (!candidates.length || candidates.some((c) => c === null)) return null;
  return {
    proposal_id: v.proposal_id,
    state: v.state,
    candidates,
    created_at: clean(v.created_at, 40),
    expires_at: clean(v.expires_at, 40),
    decided_at: clean(v.decided_at, 40),
    confirmed_via: v.confirmed_via === 'card' || v.confirmed_via === 'agent_attested' ? v.confirmed_via : null,
    confirmed_by_member_id: isOrgOrMemberId(v.confirmed_by_member_id) ? v.confirmed_by_member_id : null,
    attestation: attestationView(v.attestation),
    workspace_origin: workspaceOrigin(v.confirm_url),
  };
}

function attestationView(v) {
  if (!isObject(v)) return null;
  return {
    agent_id: isOrgOrMemberId(v.agent_id) ? v.agent_id : null,
    channel: clean(v.channel, MAX_CHANNEL_DETAIL),
    channel_detail: clean(v.channel_detail, MAX_CHANNEL_DETAIL),
    owner_message_id: clean(v.owner_message_id, MAX_MESSAGE_ID),
    owner_message_text: clean(v.owner_message_text, MAX_MESSAGE_TEXT),
  };
}

const agentPath = (agentId) => `/agents/${encodeURIComponent(agentId)}`;

export async function searchSkills({ http, orgId, agentId, q = null, categoryId = null, limit = null }) {
  const body = {};
  if (q != null && q !== '') body.q = q;
  if (categoryId != null) body.category_id = categoryId;
  if (limit != null) body.limit = limit;
  const label = 'market search';
  const d = (await http.request('POST', orgId, `${agentPath(agentId)}/market-skills:search`, body)).data;
  if (!isObject(d) || !Array.isArray(d.items)) throw shape(label, 'has no items');
  return d.items.map(skillItem).filter(Boolean);
}

// candidates: [{skill_id, reason}], 1 to MAX_CANDIDATES distinct skills.
export async function proposeInstall({ http, orgId, agentId, candidates, requestId = crypto.randomUUID() }) {
  const d = (await http.request('POST', orgId, `${agentPath(agentId)}/install-proposals`, { request_id: requestId, candidates })).data;
  const p = proposalView(d);
  if (!p) throw shape('market install proposal', 'is not a proposal');
  return p;
}

export async function getProposal({ http, orgId, agentId, proposalId }) {
  const p = proposalView((await http.request('GET', orgId, `${agentPath(agentId)}/install-proposals/${encodeURIComponent(proposalId)}`)).data);
  if (!p) throw shape('market install proposal', 'is not a proposal');
  return p;
}

export class AttestationError extends Error {}

// The owner's decision as the Agent attests it. Throws AttestationError (nothing sent) when the channel is unknown
// or neither the message id nor the text has anything visible.
export function attestationBody({ ownerMemberId, channel, channelDetail = null, messageId = null, messageText = null }) {
  if (!CHANNELS.has(channel)) throw new AttestationError(`--channel must be one of ${[...CHANNELS].join(', ')}`);
  if (!isOrgOrMemberId(ownerMemberId)) throw new AttestationError('no owner member id');
  const body = { confirmed_via: 'agent_attested', confirmed_by_member_id: ownerMemberId, channel };
  const detail = rawEvidence(channelDetail, MAX_CHANNEL_DETAIL);
  const id = rawEvidence(messageId, MAX_MESSAGE_ID);
  const text = rawEvidence(messageText, MAX_MESSAGE_TEXT);
  if (!id && !text) throw new AttestationError('give the owner\'s reply: --owner-message-id and/or --owner-message-text (verbatim)');
  if (detail) body.channel_detail = detail;
  if (id) body.owner_message_id = id;
  if (text) body.owner_message_text = text;
  return body;
}

const proposalPath = (agentId, proposalId, verb) => `${agentPath(agentId)}/install-proposals/${encodeURIComponent(proposalId)}:${verb}`;

// skillIds and skillVersionIds: the selection, same order, versions as pinned by the proposal.
export async function confirmProposal({ http, orgId, agentId, proposalId, skillIds, skillVersionIds, ...att }) {
  const body = { skill_ids: skillIds, skill_version_ids: skillVersionIds, ...attestationBody(att) };
  const p = proposalView((await http.request('POST', orgId, proposalPath(agentId, proposalId, 'confirm'), body)).data);
  if (!p) throw shape('market install proposal', 'is not a proposal');
  return p;
}

export async function declineProposal({ http, orgId, agentId, proposalId, ...att }) {
  const p = proposalView((await http.request('POST', orgId, proposalPath(agentId, proposalId, 'decline'), attestationBody(att))).data);
  if (!p) throw shape('market install proposal', 'is not a proposal');
  return p;
}

export async function installPermission({ http, orgId, agentId }) {
  const d = (await http.request('GET', orgId, `${agentPath(agentId)}/install-permission`)).data;
  if (!isObject(d)) throw shape('market install permission', 'is not an object');
  return {
    who_can_install: installers(d.who_can_install),
    caller_can_install: d.caller_can_install === true,
  };
}

const REQUEST_HINT = 'propose again with `market-client request-install` and ask the owner again';

export function explainProposalError(err) {
  if (err?.code === 'AGENT_OWNER_REQUIRED') {
    return 'refused: this Agent has no active human owner in the organization; only an org admin can install skills on it, manually in the Workspace market';
  }
  const common = explainCommonError(err);
  if (common !== null) return common;
  const x = err.extra ?? {};
  const at = x.field ? ` (${x.field})` : x.detail ? ` ${marketQuote(x.detail)}` : '';
  switch (err.code) {
    case 'SKILL_ALREADY_INSTALLED':
      return `a skill is already installed (or being installed) on this Agent${at}; leave it out`;
    case 'INSTALL_PROPOSAL_PENDING':
      return `your previous install request is being confirmed or installed${x.detail ? ` ${marketQuote(x.detail)}` : ''}; nothing new was requested. `
        + 'Wait for it to finish (`market-client install-requests`), then propose again. Tell the user: 「上一条安装请求正在确认或安装中，请稍后再提新的。」';
    case 'SKILL_RECENTLY_DECLINED':
      return `a person declined this skill for this Agent recently (no new request for it for 7 days by default)${at}; do not propose it again before then`;
    case 'AGENT_ATTESTATION_REFUSED':
      if (err.reason === 'owner_changed') return `this install request was made for a previous owner; nothing was installed. ${REQUEST_HINT}`;
      return 'refused: only your current owner\'s own reply counts; nothing was installed. Your owner confirms in chat; an org admin can install manually in the Workspace market';
    case 'AGENT_CONFIRM_DISABLED':
      if (err.reason === 'attested_off') {
        return 'chat confirmation is turned off in this market; nothing was changed. Don\'t retry and don\'t decline (the request expires by itself); the owner installs manually in the Workspace market';
      }
      return 'the market refused the confirmation method: a client bug (confirmed_via must be agent_attested), or the market predates '
        + 'confirming in conversation; nothing was changed. Report it; do not retry. Meanwhile the owner can install manually in the Workspace market';
    case 'INSTALL_PROPOSAL_STALE':
      return `${err.reason === 'agent_changed' ? 'this Agent' : 'a skill version'} changed since the request${err.reason ? ` (${err.reason})` : ''}; nothing was installed. ${REQUEST_HINT}`;
    case 'INSTALL_PROPOSAL_NOT_PENDING':
      return `this install request is no longer waiting for a decision (${err.reason ?? 'decided or gone'}); nothing was changed. `
        + 'Tell the owner it was already decided or has expired (`market-client install-requests` shows it)';
    case 'VALIDATION_FAILED': {
      const list = (err.errors ?? []).slice(0, 5).map((e) => `${e?.field ?? 'request'}${e?.message ? `: ${e.message}` : ''}`).join('; ');
      return `refused: invalid request${list ? ` (${list})` : x.field ? ` (${x.field})` : ''}; nothing was changed`;
    }
    case 'REQUEST_ID_CONFLICT':
      return 'the market saw this request id with other content; run the command again';
    case 'NOT_FOUND':
      return `not found${at}: the skill is not listed for this organization, the request does not exist, or Agent market requests are turned off`;
    case 'AGENT_NO_CLIENT':
      return 'the market does not see this Agent\'s client as active; run `market-client status` and make sure the service is running, then try again';
    case 'AGENT_QUEUE_FULL':
      return `this Agent already has ${x.queue_limit ?? 'the maximum number of'} unfinished install orders; wait for them to finish`;
    case 'VERSION_NOT_FOUND':
    case 'NOT_APPROVED':
      return `the skill version can no longer be installed${at} (not listed or not approved now)`;
    case 'VERSION_REVOKED':
      return `the skill version was revoked and cannot be installed${at}`;
    case 'NOT_AGENT_OWNER':
      return 'the market refused this for the Agent (it may have no active owner). `market-client install-permission` shows who may install; that person installs it in the workspace';
    default:
      return explainOther(err);
  }
}
