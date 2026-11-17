// Market search and install proposals. The Agent only proposes; an install happens after a person confirms.
import crypto from 'node:crypto';
import { MarketError } from '../http.js';
import { isCanonicalUuid, isOrgOrMemberId } from '../ids.js';
import { explainCommonError, explainOther } from './submit-api.js';

export const MAX_QUERY_CHARS = 100;
export const MAX_REASON_CHARS = 500;
export const MAX_LIMIT = 20;
export const MAX_CANDIDATES = 3;
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
    confirmed_via: v.confirmed_via === 'card' || v.confirmed_via === 'chat' ? v.confirmed_via : null,
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

// Chat path: the Agent attests that its owner chose these skills in this conversation; no confirmer is sent, the
// market takes the owner and checks the owner's right.
export async function confirmInChat({ http, orgId, agentId, proposalId, skillIds }) {
  const d = (await http.request('POST', orgId, `${agentPath(agentId)}/install-proposals/${encodeURIComponent(proposalId)}:confirm`, { skill_ids: skillIds, confirmed_via: 'chat' })).data;
  const p = proposalView(d);
  if (!p) throw shape('market install proposal confirm', 'is not a proposal');
  return p;
}

export async function declineInChat({ http, orgId, agentId, proposalId }) {
  const d = (await http.request('POST', orgId, `${agentPath(agentId)}/install-proposals/${encodeURIComponent(proposalId)}:decline`, { confirmed_via: 'chat' })).data;
  const p = proposalView(d);
  if (!p) throw shape('market install proposal decline', 'is not a proposal');
  return p;
}

export async function installPermission({ http, orgId, agentId }) {
  const d = (await http.request('GET', orgId, `${agentPath(agentId)}/install-permission`)).data;
  if (!isObject(d)) throw shape('market install permission', 'is not an object');
  const ids = Array.isArray(d.who_can_install) ? d.who_can_install.filter(isOrgOrMemberId).slice(0, 50) : [];
  return {
    owner_member_id: isOrgOrMemberId(d.owner_member_id) ? d.owner_member_id : null,
    who_can_install: ids,
    owner_can_install: d.owner_can_install === true,
  };
}

export function explainProposalError(err) {
  const common = explainCommonError(err);
  if (common !== null) return common;
  const x = err.extra ?? {};
  const at = x.field ? ` (${x.field})` : '';
  switch (err.code) {
    case 'SKILL_ALREADY_INSTALLED':
      return `a skill is already installed (or being installed) on this Agent${at}; leave it out`;
    case 'INSTALL_PROPOSAL_NOT_PENDING':
      return `this install request is no longer pending (${err.reason ?? 'decided'}); ${err.reason === 'expired' ? 'make a new request if it is still wanted' : 'nothing to confirm'}`;
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
    case 'NOT_AGENT_OWNER': {
      const who = x.who_can_install?.length ? ` Who can install (member ids): ${x.who_can_install.join(', ')}.` : '';
      return `the owner may not install skills on this Agent.${who} That person has to confirm the request in the workspace (the install card)`;
    }
    default:
      return explainOther(err);
  }
}
