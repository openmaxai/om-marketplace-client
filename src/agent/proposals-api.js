// Market search and install proposals. The Agent only proposes; an install happens after a person confirms.
import crypto from 'node:crypto';
import { MarketError } from '../http.js';
import { isCanonicalUuid } from '../ids.js';
import { explainCommonError, explainOther } from './submit-api.js';

export const MAX_QUERY_CHARS = 100;
export const MAX_REASON_CHARS = 500;
export const MAX_LIMIT = 20;
export const PROPOSAL_STATES = new Set(['pending_confirmation', 'confirmed', 'declined', 'expired']);

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

export function proposalView(v) {
  if (!isObject(v) || !isCanonicalUuid(v.proposal_id) || !PROPOSAL_STATES.has(v.state)) return null;
  return {
    proposal_id: v.proposal_id,
    state: v.state,
    skill_id: isCanonicalUuid(v.skill_id) ? v.skill_id : null,
    name: clean(v.name, 100),
    version: clean(v.version, 64),
    reason: clean(v.reason, MAX_REASON_CHARS),
    created_at: clean(v.created_at, 40),
    expires_at: clean(v.expires_at, 40),
    decided_at: clean(v.decided_at, 40),
    confirmed_via: v.confirmed_via === 'card' || v.confirmed_via === 'chat' ? v.confirmed_via : null,
    intent_id: isCanonicalUuid(v.intent_id) ? v.intent_id : null,
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

export async function proposeInstall({ http, orgId, agentId, skillId, reason, requestId = crypto.randomUUID() }) {
  const d = (await http.request('POST', orgId, `${agentPath(agentId)}/install-proposals`, { request_id: requestId, skill_id: skillId, reason })).data;
  const p = proposalView(d);
  if (!p) throw shape('market install proposal', 'is not a proposal');
  return p;
}

export async function listProposals({ http, orgId, agentId, state = null }) {
  const d = (await http.request('GET', orgId, `${agentPath(agentId)}/install-proposals`, undefined, { query: state ? { state } : null })).data;
  if (!isObject(d) || !Array.isArray(d.items)) throw shape('market install proposals', 'has no items');
  return d.items.map(proposalView).filter(Boolean);
}

export async function getProposal({ http, orgId, agentId, proposalId }) {
  const p = proposalView((await http.request('GET', orgId, `${agentPath(agentId)}/install-proposals/${encodeURIComponent(proposalId)}`)).data);
  if (!p) throw shape('market install proposal', 'is not a proposal');
  return p;
}

// Chat path: the Agent attests that its owner confirmed in this conversation. The market checks the owner's rights.
export async function confirmInChat({ http, orgId, agentId, proposalId }) {
  const d = (await http.request('POST', orgId, `${agentPath(agentId)}/install-proposals/${encodeURIComponent(proposalId)}:confirm`, { confirmed_via: 'chat' })).data;
  const p = proposalView(d);
  if (!p) throw shape('market install proposal confirm', 'is not a proposal');
  return p;
}

export function explainProposalError(err) {
  const common = explainCommonError(err);
  if (common !== null) return common;
  const x = err.extra ?? {};
  switch (err.code) {
    case 'SKILL_ALREADY_INSTALLED':
      return 'this skill is already installed (or being installed) on this Agent';
    case 'INSTALL_PROPOSAL_NOT_PENDING':
      return `this install request is no longer pending (${err.reason ?? 'decided'}); ${err.reason === 'expired' ? 'make a new request if it is still wanted' : 'nothing to confirm'}`;
    case 'NOT_FOUND':
      return 'not found: the skill is not visible to this organization, the request does not exist, or Agent market requests are turned off';
    case 'AGENT_NO_CLIENT':
      return 'the market does not see this Agent\'s client as active; run `market-client status` and make sure the service is running, then try again';
    case 'AGENT_QUEUE_FULL':
      return `this Agent already has ${x.queue_limit ?? 'the maximum number of'} unfinished install orders; wait for them to finish`;
    case 'VERSION_NOT_FOUND':
    case 'NOT_APPROVED':
      return 'the skill version can no longer be installed (not listed or not approved now)';
    case 'VERSION_REVOKED':
      return 'the skill version was revoked and cannot be installed';
    case 'NOT_AGENT_OWNER':
    case 'PERMISSION_DENIED':
    case 'FORBIDDEN':
      return `the market refused the install for this Agent's owner (${err.code}${err.reason ? `, ${err.reason}` : ''}${x.detail ? `: ${x.detail}` : ''}). `
        + 'A person who may install skills on this Agent has to confirm the request in the workspace';
    default:
      return explainOther(err);
  }
}
