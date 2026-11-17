// submit-skill, submit-template and submissions. These are plain market calls: they take no state lock and do not go
// through the service.
import fs from 'node:fs';
import path from 'node:path';
import { createAuth } from '../auth.js';
import { createMarketHttp } from '../http.js';
import { readJson, writeJsonAtomic } from '../state.js';
import { EXIT } from '../commands.js';
import { SubmitError, packSkill } from './pack.js';
import { readManifest } from './template.js';
import { explainSubmitError, isRefusal, submitSkill, submitTemplate } from './api.js';

export const SUBMIT_COMMANDS = new Set(['submit-skill', 'submit-template', 'submissions']);
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
  const auth = createAuth({ bffUrl: config.bff_url, apiKey: config.api_key, fetchImpl, logger });
  const http = createMarketHttp({ bffUrl: config.bff_url, auth, fetchImpl, logger });
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
