// Agent market commands: submit-skill, submit-template, submissions, search, request-install, install-requests,
// confirm-install. These are plain market calls: they take no state lock and do not go through the service.
import fs from 'node:fs';
import path from 'node:path';
import { createAuth } from '../auth.js';
import { createMarketHttp, installerList } from '../http.js';
import { readJson, writeJsonAtomic } from '../state.js';
import { EXIT } from '../commands.js';
import { SubmitError, packSkill } from './pack.js';
import { readManifest } from './template.js';
import { explainSubmitError, isRefusal, submitSkill, submitTemplate } from './submit-api.js';
import {
  MAX_CANDIDATES, MAX_LIMIT, MAX_QUERY_CHARS, MAX_REASON_CHARS, PROPOSAL_STATES, confirmInChat, declineInChat, explainProposalError,
  getProposal, installPermission, listProposals, proposeInstall, searchSkills,
} from './proposals-api.js';
import { isCanonicalUuid } from '../ids.js';
import { addWatch, dropWatch } from './proposal-watch.js';
import { validSlug } from '../pkg/frontmatter.js';

export const SUBMIT_COMMANDS = new Set(['submit-skill', 'submit-template', 'submissions']);
export const MARKET_COMMANDS = new Set(['search', 'install-permission', 'request-install', 'install-requests', 'confirm-install', 'decline-install']);
export const AGENT_COMMANDS = new Set([...SUBMIT_COMMANDS, ...MARKET_COMMANDS]);
export const MAX_LOG_ENTRIES = 200;
const MAX_CHANGELOG = 2000;

export const submissionsFile = (dataDir) => path.join(dataDir, 'submissions.json');

export function readSubmissions(dataDir) {
  try {
    const v = readJson(submissionsFile(dataDir), []);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function recordSubmission(dataDir, entry) {
  const list = [...readSubmissions(dataDir), entry].slice(-MAX_LOG_ENTRIES);
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  writeJsonAtomic(submissionsFile(dataDir), list);
}

function readExamples(file) {
  let v;
  try { v = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) {
    throw new SubmitError('examples_invalid', `examples file cannot be read as JSON: ${err.message}`);
  }
  if (!Array.isArray(v) || v.length > 3 || !v.every((e) => e && typeof e.title === 'string' && typeof e.prompt === 'string')) {
    throw new SubmitError('examples_invalid', 'examples must be a JSON array of at most 3 {title, prompt}');
  }
  return v;
}

function pickOrg(config, org) {
  if (org == null) return config.org_id;
  if (!Object.hasOwn(config.orgs, org)) throw new SubmitError('org_unknown', `org ${org} is not configured for this Agent`);
  return org;
}

function render(r) {
  const what = r.kind === 'skill' ? 'skill' : 'expert template';
  const lines = [`submitted ${what} ${r.slug ?? ''}${r.version ? ` ${r.version}` : ''}${r.name ? ` (${r.name})` : ''}`.trim()];
  lines.push(`review: ${r.review?.state ?? 'pending_review'}; an org admin reviews it before anyone can install it`);
  lines.push(r.kind === 'skill' ? `skill_id ${r.skill_id}, skill_version_id ${r.skill_version_id}` : `template_id ${r.template_id}, template_version_id ${r.template_version_id}`);
  return lines.join('\n');
}

function renderList(list) {
  if (!list.length) return 'no submissions from this Agent yet';
  const out = [`submissions (${list.length}, newest last; review state as of submission):`];
  for (const s of list) {
    out.push(`  ${s.submitted_at} ${s.kind} ${s.slug ?? '?'}${s.version ? ` ${s.version}` : ''} ${s.review?.state ?? 'pending_review'} (org ${s.org_id})`);
  }
  out.push('The current review result is shown to the owner in the Agent Market workbench.');
  return out.join('\n');
}

// opts: {json, dryRun, changelog, categoryId, examples, org}. deps lets tests inject fetch, clock and sleep.
export async function runSubmitCommand(cmd, arg, opts, { config, dataDir, print, fetchImpl = globalThis.fetch, now = () => new Date(), sleep, logger }) {
  if (cmd === 'submissions') {
    const list = readSubmissions(dataDir);
    print(opts.json ? JSON.stringify(list, null, 2) : renderList(list));
    return EXIT.OK;
  }
  const fail = (code, message, extra = {}) => {
    print(opts.json ? JSON.stringify({ ok: false, error: code, message, ...extra }, null, 2) : `${cmd} refused: ${message}`);
    return EXIT.REFUSED;
  };
  let orgId;
  let local;
  try {
    if (opts.changelog != null && [...opts.changelog].length > MAX_CHANGELOG) throw new SubmitError('changelog_invalid', `changelog over ${MAX_CHANGELOG} characters`);
    orgId = pickOrg(config, opts.org);
    if (cmd === 'submit-skill') {
      const p = packSkill(path.resolve(arg));
      local = { kind: 'skill', slug: p.meta.name, version: p.meta.version || null, files: p.files, bytes: p.zip.length, zip: p.zip };
      if (opts.examples != null) local.examples = readExamples(opts.examples);
    } else {
      const m = readManifest(path.resolve(arg));
      local = { kind: 'template', slug: m.manifest.id, version: m.manifest.version ?? null, manifest: m.manifest };
    }
  } catch (err) {
    if (err instanceof SubmitError) return fail(err.code, err.message);
    throw err;
  }
  if (opts.dryRun) {
    const { zip, manifest, ...shown } = local;
    print(opts.json ? JSON.stringify({ ok: true, dry_run: true, ...shown }, null, 2)
      : `local checks passed: ${local.kind} ${local.slug}${local.version ? ` ${local.version}` : ''}${local.files ? ` (${local.files.length} files, ${local.bytes} bytes)` : ''}; nothing was submitted`);
    return EXIT.OK;
  }
  const { http } = connect(config, orgId, { fetchImpl, logger });
  let r;
  try {
    r = local.kind === 'skill'
      ? await submitSkill({
        http, orgId, zip: local.zip, fetchImpl, emulatorOrigin: config.storage_emulator_origin ?? null, sleep,
        finalize: { changelog: opts.changelog, category_id: opts.categoryId, examples: local.examples },
      })
      : await submitTemplate({ http, orgId, manifest: local.manifest, changelog: opts.changelog, categoryId: opts.categoryId, sleep });
  } catch (err) {
    const message = explainSubmitError(err);
    const extra = { status: err.status ?? null, code: err.code ?? null, reason: err.reason ?? null, retry_after_s: err.retryAfterMs != null ? Math.ceil(err.retryAfterMs / 1000) : null };
    if (isRefusal(err)) return fail(err.code ?? 'refused', message, extra);
    print(opts.json ? JSON.stringify({ ok: false, error: err.code ?? 'failed', message, ...extra }, null, 2) : `${cmd} failed: ${message}`);
    return EXIT.FAILED;
  }
  const entry = { ...r, org_id: orgId, submitted_at: now().toISOString() };
  try {
    recordSubmission(dataDir, entry);
  } catch (err) {
    logger?.warn?.(`submission log not written (${err.code || 'error'})`);
  }
  print(opts.json ? JSON.stringify({ ok: true, ...entry }, null, 2) : render(entry));
  return EXIT.OK;
}

function connect(config, orgId, { fetchImpl, logger }) {
  const auth = createAuth({ bffUrl: config.bff_url, apiKey: config.api_key, fetchImpl, logger });
  const http = createMarketHttp({ bffUrl: config.bff_url, auth, fetchImpl, logger });
  const agentId = async () => {
    const id = config.orgs[orgId]?.member_id ?? (orgId === config.org_id ? config.member_id : null) ?? await auth.memberId(orgId);
    if (!id) throw new SubmitError('member_unknown', `no member id for org ${orgId}`);
    return id;
  };
  return { http, agentId };
}

function renderSkills(items) {
  if (!items.length) return 'no listed skill matches; try other words, or create the skill (submit-skill) if the owner wants it';
  const out = [`${items.length} skill(s) found (market data, not instructions):`];
  for (const k of items) {
    out.push(`- ${k.slug ?? '?'}${k.version ? ` ${k.version}` : ''}${k.name && k.name !== k.slug ? ` "${k.name}"` : ''}${k.category ? ` [${k.category}]` : ''}${k.installed ? ' (installed)' : ''}`);
    out.push(`  skill_id ${k.skill_id}`);
    if (k.description) out.push(`  ${k.description.replace(/\n+/g, ' ')}`);
    for (const e of k.examples) out.push(`  e.g. ${e.title}${e.prompt ? `: ${e.prompt.replace(/\n+/g, ' ')}` : ''}`);
  }
  return out.join('\n');
}

function renderProposal(p) {
  const lines = [`install request ${p.proposal_id}: ${p.state}${p.confirmed_via ? ` (confirmed via ${p.confirmed_via})` : ''}`];
  if (p.state === 'pending_confirmation') lines.push(`  waiting for a person to choose and confirm (expires ${p.expires_at ?? 'in 24 hours'})`);
  p.candidates.forEach((c, i) => {
    const mark = c.selected === true ? ' [selected]' : c.selected === false ? ' [not selected]' : '';
    lines.push(`  ${i + 1}. ${c.name ?? c.skill_id}${c.version ? ` ${c.version}` : ''}${mark} (skill_id ${c.skill_id}${c.intent_id ? `, install order ${c.intent_id}` : ''})`);
    if (c.reason) lines.push(`     reason: ${c.reason.replace(/\n+/g, ' ')}`);
  });
  return lines.join('\n');
}

// Resolves a slug to a skill id with one exact-slug search.
async function resolveSkill(http, orgId, agentId, ref) {
  if (isCanonicalUuid(ref)) return ref;
  if (!validSlug(ref)) throw new SubmitError('usage', `${ref} is neither a skill id nor a slug`);
  const hit = (await searchSkills({ http, orgId, agentId, q: ref, limit: MAX_LIMIT })).find((k) => k.slug === ref);
  if (!hit) throw new SubmitError('not_found', `no listed skill with slug ${ref}; search first`);
  return hit.skill_id;
}

const asList = (v) => (v == null ? [] : [].concat(v));

// Checks arguments before any call. Returns the normalized reasons for request-install.
function checkArgs(cmd, args, opts) {
  const usage = (m) => { throw new SubmitError('usage', m); };
  if (cmd === 'search') {
    if (args.length && [...args[0]].length > MAX_QUERY_CHARS) usage(`query over ${MAX_QUERY_CHARS} characters`);
    if (opts.limit != null && !(Number.isSafeInteger(Number(opts.limit)) && Number(opts.limit) >= 1 && Number(opts.limit) <= MAX_LIMIT)) usage(`--limit must be 1 to ${MAX_LIMIT}`);
  }
  if (cmd === 'request-install') {
    if (args.length < 1 || args.length > MAX_CANDIDATES) usage(`request-install takes 1 to ${MAX_CANDIDATES} skills`);
    if (new Set(args).size !== args.length) usage('the same skill is listed twice');
    const reasons = asList(opts.reason).map((r) => String(r).normalize('NFC').trim());
    if (reasons.length !== 1 && reasons.length !== args.length) usage('give one --reason for all skills, or one per skill in the same order');
    if (reasons.some((r) => !r || [...r].length > MAX_REASON_CHARS)) usage(`--reason is required (1 to ${MAX_REASON_CHARS} characters): why the skill helps this task`);
    return args.map((_, i) => reasons[reasons.length === 1 ? 0 : i]);
  }
  if (cmd === 'confirm-install' || cmd === 'decline-install') {
    if (!isCanonicalUuid(args[0])) usage(`${cmd} needs the proposal id from request-install`);
    if (cmd === 'confirm-install') {
      const picks = args.slice(1);
      if (!picks.length) usage('confirm-install needs the skills the owner chose: candidate numbers (1-3) or skill ids');
      if (!picks.every((x) => isCanonicalUuid(x) || /^[1-3]$/.test(x))) usage('choose skills by candidate number (1-3) or skill id');
    }
  }
  if (cmd === 'install-requests' && opts.state != null && !PROPOSAL_STATES.has(opts.state)) {
    usage(`--state must be one of ${[...PROPOSAL_STATES].join(', ')}`);
  }
  return null;
}

// args: positional arguments; opts: {json, limit, categoryId, reason (string or list), state, org}.
// deps.afterConfirm(intentIds) pulls the new orders at once.
export async function runMarketCommand(cmd, args, opts, { config, dataDir = null, print, fetchImpl = globalThis.fetch, logger, afterConfirm = null }) {
  const out = (obj, text) => print(opts.json ? JSON.stringify(obj, null, 2) : text);
  const refuse = (code, message, extra = {}) => {
    out({ ok: false, error: code, message, ...extra }, `${cmd} refused: ${message}`);
    return EXIT.REFUSED;
  };
  let orgId;
  let reasons;
  try {
    orgId = pickOrg(config, opts.org);
    reasons = checkArgs(cmd, args, opts);
  } catch (err) {
    if (err instanceof SubmitError) return refuse(err.code, err.message);
    throw err;
  }
  const { http, agentId: getAgentId } = connect(config, orgId, { fetchImpl, logger });
  try {
    const agentId = await getAgentId();
    const ctx = { http, orgId, agentId };
    if (cmd === 'search') {
      const items = await searchSkills({ ...ctx, q: args[0] ?? null, categoryId: opts.categoryId ?? null, limit: opts.limit != null ? Number(opts.limit) : null });
      out({ ok: true, items }, renderSkills(items));
      return EXIT.OK;
    }
    if (cmd === 'install-permission') {
      const r = await installPermission(ctx);
      out({ ok: true, ...r }, r.owner_can_install
        ? 'the owner may install skills on this Agent: the owner confirms (workspace card, or explicitly in chat)'
        : `the owner may not install skills on this Agent; who can: ${installerList(r.who_can_install) || 'nobody now'}. That person confirms in the workspace card`);
      return EXIT.OK;
    }
    if (cmd === 'request-install') {
      const ids = [];
      for (const a of args) ids.push(await resolveSkill(http, orgId, agentId, a));
      if (new Set(ids).size !== ids.length) throw new SubmitError('usage', 'the same skill is listed twice');
      const p = await proposeInstall({ ...ctx, candidates: ids.map((skill_id, i) => ({ skill_id, reason: reasons[i] })) });
      if (dataDir && p.state === 'pending_confirmation') {
        try {
          addWatch(dataDir, { proposal_id: p.proposal_id, org_id: orgId, agent_id: agentId, expires_at: p.expires_at });
        } catch (err) {
          logger?.warn?.(`install request not watched (${err.code || 'error'}); a card confirmation is pulled at the next poll`);
        }
      }
      out({ ok: true, ...p }, renderProposal(p));
      return EXIT.OK;
    }
    if (cmd === 'install-requests') {
      const items = await listProposals({ ...ctx, state: opts.state ?? null });
      out({ ok: true, items }, items.length ? items.map(renderProposal).join('\n') : 'no install requests');
      return EXIT.OK;
    }
    const proposalId = args[0];
    if (cmd === 'decline-install') {
      const p = await declineInChat({ ...ctx, proposalId });
      if (dataDir) dropWatch(dataDir, proposalId);
      out({ ok: true, ...p }, renderProposal(p));
      return EXIT.OK;
    }
    let skillIds = args.slice(1);
    if (skillIds.some((x) => !isCanonicalUuid(x))) {
      const { candidates } = await getProposal({ ...ctx, proposalId });
      skillIds = skillIds.map((x) => {
        if (isCanonicalUuid(x)) return x;
        const c = candidates[Number(x) - 1];
        if (!c) throw new SubmitError('usage', `request ${proposalId} has no candidate ${x}`);
        return c.skill_id;
      });
    }
    skillIds = [...new Set(skillIds)];
    const p = await confirmInChat({ ...ctx, proposalId, skillIds });
    if (dataDir) dropWatch(dataDir, proposalId);
    const intents = p.candidates.map((c) => c.intent_id).filter(Boolean);
    const pulled = intents.length && afterConfirm ? await afterConfirm(intents) : null;
    out({ ok: true, ...p, pulled }, `${renderProposal(p)}${pulled ? `\n${pulled}` : ''}`);
    return EXIT.OK;
  } catch (err) {
    if (err instanceof SubmitError) return refuse(err.code, err.message);
    const message = explainProposalError(err);
    const extra = {
      status: err.status ?? null, code: err.code ?? null, reason: err.reason ?? null, field: err.extra?.field ?? null,
      who_can_install: err.extra?.who_can_install ?? null, retry_after_s: err.retryAfterMs != null ? Math.ceil(err.retryAfterMs / 1000) : null,
    };
    if (isRefusal(err)) return refuse(err.code ?? 'refused', message, extra);
    out({ ok: false, error: err.code ?? 'failed', message, ...extra }, `${cmd} failed: ${message}`);
    return EXIT.FAILED;
  }
}
