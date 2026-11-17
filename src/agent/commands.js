// Agent market commands: submit-skill, submit-template, submissions, search, request-install, install-requests,
// confirm-install. These are plain market calls: they take no state lock and do not go through the service.
import fs from 'node:fs';
import path from 'node:path';
import { createAuth } from '../auth.js';
import { createMarketHttp } from '../http.js';
import { readJson, writeJsonAtomic } from '../state.js';
import { EXIT } from '../commands.js';
import { SubmitError, packSkill } from './pack.js';
import { readManifest } from './template.js';
import { explainSubmitError, isRefusal, submitSkill, submitTemplate } from './submit-api.js';
import {
  MAX_LIMIT, MAX_QUERY_CHARS, MAX_REASON_CHARS, PROPOSAL_STATES, confirmInChat, explainProposalError, listProposals, proposeInstall, searchSkills,
} from './proposals-api.js';
import { isCanonicalUuid } from '../ids.js';
import { validSlug } from '../pkg/frontmatter.js';

export const SUBMIT_COMMANDS = new Set(['submit-skill', 'submit-template', 'submissions']);
export const MARKET_COMMANDS = new Set(['search', 'request-install', 'install-requests', 'confirm-install']);
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
  const head = `install request ${p.proposal_id}: ${p.name ?? p.skill_id}${p.version ? ` ${p.version}` : ''} ${p.state}`;
  const lines = [head];
  if (p.state === 'pending_confirmation') lines.push(`  waiting for a person to confirm (expires ${p.expires_at ?? 'in 24 hours'})`);
  if (p.state === 'confirmed') lines.push(`  confirmed via ${p.confirmed_via ?? '?'}${p.intent_id ? `; install order ${p.intent_id}` : ''}`);
  if (p.reason) lines.push(`  reason: ${p.reason.replace(/\n+/g, ' ')}`);
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

// opts: {json, q, categoryId, limit, reason, state, org}; deps.afterConfirm(intentId) pulls the order at once.
export async function runMarketCommand(cmd, arg, opts, { config, print, fetchImpl = globalThis.fetch, logger, afterConfirm = null }) {
  const out = (obj, text) => print(opts.json ? JSON.stringify(obj, null, 2) : text);
  const refuse = (code, message, extra = {}) => {
    out({ ok: false, error: code, message, ...extra }, `${cmd} refused: ${message}`);
    return EXIT.REFUSED;
  };
  let orgId;
  try {
    orgId = pickOrg(config, opts.org);
    if (cmd === 'search') {
      if (arg != null && [...arg].length > MAX_QUERY_CHARS) throw new SubmitError('usage', `query over ${MAX_QUERY_CHARS} characters`);
      if (opts.limit != null && !(Number.isSafeInteger(Number(opts.limit)) && Number(opts.limit) >= 1 && Number(opts.limit) <= MAX_LIMIT)) {
        throw new SubmitError('usage', `--limit must be 1 to ${MAX_LIMIT}`);
      }
    }
    if (cmd === 'request-install') {
      opts.reason = (opts.reason ?? '').normalize('NFC').trim();
      if (!opts.reason || [...opts.reason].length > MAX_REASON_CHARS) throw new SubmitError('usage', `--reason is required (1 to ${MAX_REASON_CHARS} characters): why this skill helps the task`);
    }
    if (cmd === 'confirm-install' && !isCanonicalUuid(arg)) throw new SubmitError('usage', 'confirm-install needs the proposal id from request-install');
    if (cmd === 'install-requests' && opts.state != null && !PROPOSAL_STATES.has(opts.state)) {
      throw new SubmitError('usage', `--state must be one of ${[...PROPOSAL_STATES].join(', ')}`);
    }
  } catch (err) {
    if (err instanceof SubmitError) return refuse(err.code, err.message);
    throw err;
  }
  const { http, agentId: getAgentId } = connect(config, orgId, { fetchImpl, logger });
  try {
    const agentId = await getAgentId();
    if (cmd === 'search') {
      const items = await searchSkills({ http, orgId, agentId, q: arg ?? null, categoryId: opts.categoryId ?? null, limit: opts.limit != null ? Number(opts.limit) : null });
      out({ ok: true, items }, renderSkills(items));
      return EXIT.OK;
    }
    if (cmd === 'request-install') {
      const skillId = await resolveSkill(http, orgId, agentId, arg);
      const p = await proposeInstall({ http, orgId, agentId, skillId, reason: opts.reason });
      out({ ok: true, ...p }, renderProposal(p));
      return EXIT.OK;
    }
    if (cmd === 'install-requests') {
      const items = await listProposals({ http, orgId, agentId, state: opts.state ?? null });
      out({ ok: true, items }, items.length ? items.map(renderProposal).join('\n') : 'no install requests');
      return EXIT.OK;
    }
    const p = await confirmInChat({ http, orgId, agentId, proposalId: arg });
    let pulled = null;
    if (p.intent_id && afterConfirm) pulled = await afterConfirm(p.intent_id);
    out({ ok: true, ...p, pulled }, `${renderProposal(p)}${pulled ? `\n${pulled}` : ''}`);
    return EXIT.OK;
  } catch (err) {
    if (err instanceof SubmitError) return refuse(err.code, err.message);
    const message = explainProposalError(err);
    const extra = { status: err.status ?? null, code: err.code ?? null, reason: err.reason ?? null, retry_after_s: err.retryAfterMs != null ? Math.ceil(err.retryAfterMs / 1000) : null };
    if (isRefusal(err)) return refuse(err.code ?? 'refused', message, extra);
    out({ ok: false, error: err.code ?? 'failed', message, ...extra }, `${cmd} failed: ${message}`);
    return EXIT.FAILED;
  }
}
