// Market search and install proposals. The Agent only proposes; an install happens after a person confirms.
import crypto from 'node:crypto';
import { MarketError, installers, marketQuote } from '../http.js';
import { isCanonicalUuid } from '../ids.js';
import { explainCommonError, explainOther } from './submit-api.js';

export const MAX_QUERY_CHARS = 100;
export const MAX_REASON_CHARS = 500;
export const MAX_LIMIT = 20;
export const MAX_CANDIDATES = 3;
export const PROPOSAL_STATES = new Set(['pending_confirmation', 'confirming', 'confirmed', 'declined', 'superseded', 'expired']);
// Where the user confirms when the market gives no link.
export const CONFIRM_HINT = '请到工作台和我的私聊里确认';
export const confirmPhrase = (url) => (url ? `请点这个链接确认：${url}` : CONFIRM_HINT);

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
// The workspace link to confirm a request: https (http only on loopback), no credentials, at most 2048 characters.
export function confirmUrl(v) {
  if (typeof v !== 'string' || v.length > 2048) return null;
  let u;
  try { u = new URL(v); } catch { return null; }
  if (u.username || u.password) return null;
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && LOOPBACK.has(u.hostname))) return null;
  return u.href;
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

function candidateView(v) {
  if (!isObject(v) || !isCanonicalUuid(v.skill_id)) return null;
  return {
    skill_id: v.skill_id,
    name: clean(v.name, 100),
    version: clean(v.version, 64),
    reason: clean(v.reason, MAX_REASON_CHARS),
    selected: typeof v.selected === 'boolean' ? v.selected : null,
    intent_id: isCanonicalUuid(v.intent_id) ? v.intent_id : null,
  };
}

export function proposalView(v) {
  if (!isObject(v) || !isCanonicalUuid(v.proposal_id) || !PROPOSAL_STATES.has(v.state) || !Array.isArray(v.candidates)) return null;
  const candidates = v.candidates.map(candidateView);
  if (!candidates.length || candidates.some((c) => c === null)) return null;
  return {
    proposal_id: v.proposal_id,
    state: v.state,
    candidates,
    created_at: clean(v.created_at, 40),
    expires_at: clean(v.expires_at, 40),
    decided_at: clean(v.decided_at, 40),
    confirmed_via: v.confirmed_via === 'card' ? 'card' : null,
    confirm_url: confirmUrl(v.confirm_url),
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

export async function installPermission({ http, orgId, agentId }) {
  const d = (await http.request('GET', orgId, `${agentPath(agentId)}/install-permission`)).data;
  if (!isObject(d)) throw shape('market install permission', 'is not an object');
  return {
    who_can_install: installers(d.who_can_install),
    caller_can_install: d.caller_can_install === true,
  };
}

export function explainProposalError(err) {
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
    case 'AGENT_CONFIRM_DISABLED':
      return `only a person can confirm or decline an install request, in the workspace (${CONFIRM_HINT})`;
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
