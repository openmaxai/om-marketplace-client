import fs from 'node:fs';
import path from 'node:path';
import { AGENT, ORG, U, pullHarness } from './pull.js';
import { startFakeStorage } from './storage.js';
import { skillPackage } from './package.js';
import { createIntentPuller } from '../../src/intents.js';
import { createSkills } from '../../src/skills.js';
import { POLICY_SHA256 } from '../../src/policy/pin.js';

export const SKILL = U(1);
export const MARKET = U(3);
export const B = `/api/v1/orgs/${ORG}`;
export const C02 = `${B}/agents/${AGENT}/install-requests`;
export const VID = (n) => U(100 + n);
export const problem = (status, code, extra = {}) => ({ status, problem: { status, code, ...extra } });

export class Crash extends Error {}

// State whose writes stop after `at(kind, name, value)` answers 'before' or 'after' for one write, like a process that died.
export function crashingState(state, at) {
  let dead = false;
  const guard = (kind, fn) => (...args) => {
    if (dead) throw new Crash('dead');
    const when = at(kind, ...args);
    if (when === 'before') dead = true;
    if (dead) throw new Crash(kind);
    const r = fn(...args);
    if (when === 'after') {
      dead = true;
      throw new Crash(kind);
    }
    return r;
  };
  const col = (c, kind) => ({ ...c, put: guard(kind, c.put), remove: guard(kind, c.remove) });
  return {
    ...state, write: guard('write', state.write), update: guard('update', state.update), setAlert: guard('alert', state.setAlert),
    journal: col(state.journal, 'journal'), outbox: col(state.outbox, 'outbox'),
  };
}

// Stateful fake of C-02, C-03, C-06, C-07, C-08 and C-09 for one skill. `over.<endpoint>` queues replace the next answers.
export async function skillHarness(t, { versions = { 1: skillPackage() }, slug = 'demo-skill' } = {}) {
  const h = await pullHarness(t, { orgs: {} });
  const storage = await startFakeStorage();
  t.after(storage.close);
  const skillsDir = path.join(path.dirname(h.dataDir), 'skills');
  fs.mkdirSync(skillsDir);
  const reqs = new Map();
  const over = { c02: [], c03: [], c06: [], c07: [], manage: [] };
  let downloads = 0;
  let seq = 0;
  const forever = (method, p, fn) => {
    const step = (req) => {
      h.fake.script(method, p, step);
      const o = over[fn.key].shift();
      return (typeof o === 'function' ? o(req) : o) ?? fn(req);
    };
    h.fake.script(method, p, step);
  };
  const route = (key, fn) => Object.assign(fn, { key });

  function perRequest(rid) {
    const sub = `${B}/agents/${AGENT}/packages/${rid}`;
    forever('GET', sub, route('c03', () => {
      const pkg = versions[reqs.get(rid).n];
      const url = storage.serve(`/b/${rid}/${downloads++}`, { status: 200, body: pkg.zip });
      return { status: 200, json: { download_url: url, expires_at: '2026-10-16T00:05:00Z', sha256: pkg.sha, size: pkg.size } };
    }));
    forever('POST', `${B}/install-requests/${rid}/result`, route('c06', (req) => {
      const r = reqs.get(rid);
      if (r.status !== 'running') return r.result === req.body ? { status: 200, json: r.reply } : problem(409, 'REQUEST_ID_CONFLICT');
      Object.assign(r, { status: req.json.status, result: req.body, reply: { request_id: rid, status: req.json.status, error_code: req.json.error_code } });
      return { status: 200, json: r.reply };
    }));
    forever('GET', `${B}/install-requests/${rid}`, route('c07', () => {
      const r = reqs.get(rid);
      return { status: 200, json: { request_id: rid, op: r.op, skill_id: SKILL, status: r.status, created_at: '2026-10-16T00:00:00Z' } };
    }));
  }

  forever('POST', C02, route('c02', (req) => {
    const b = req.json;
    const rid = b.request_id;
    const n = Number(Object.keys(versions).find((k) => VID(Number(k)) === b.skill_version_id));
    const known = reqs.get(rid);
    if (known && known.raw !== req.body) return problem(409, 'REQUEST_ID_CONFLICT');
    if (!known) {
      reqs.set(rid, { raw: req.body, status: 'running', n, op: b.op });
      perRequest(rid);
    }
    const pkg = versions[n];
    return { status: 201, json: {
      request_id: rid, install_id: U(5), skill_id: SKILL, slug, skill_version_id: VID(n), version_no: n, source_market_id: MARKET,
      package_url: `${h.fake.url}${B}/agents/${AGENT}/packages/${rid}`, package_sha256: pkg.sha, size_bytes: pkg.size,
      file_manifest: pkg.manifest, skill_md: { name: slug, description: 'A test skill' }, status: 'running',
    } };
  }));
  for (const verb of ['set-enabled', 'uninstall']) {
    forever('POST', `${B}/agents/${AGENT}/skills/${SKILL}:${verb}`, route('manage', (req) => ({
      status: 200, json: verb === 'uninstall' ? { install_id: U(5), install_state: 'uninstalled' } : { install_id: U(5), enabled: req.json.enabled },
    })));
  }

  const make = (state = h.state, opts = {}) => createSkills({
    api: h.api, state, orgs: h.orgs, logger: h.logger, bffUrl: h.fake.url, skillsDir, dataDir: h.dataDir,
    emulatorOrigin: storage.origin, now: h.now, sleep: async () => {}, ...opts,
  });

  // Queues intents through one C-01 page: [op, version n] pairs.
  async function queue(...ops) {
    const items = ops.map(([op, n = null, skillId = SKILL]) => ({
      id: U(1000 + ++seq), org_id: ORG, op, skill_id: skillId, skill_version_id: n ? VID(n) : null, template_id: null,
      source_market_id: n ? MARKET : null, adoption_id: null, discard_local_changes: false, expires_at: '2026-10-17T00:00:00Z', seq,
    }));
    h.fake.script('POST', `${B}/agents/${AGENT}/install-intents:query`, { status: 200, json: { items, has_more: false, next_after_seq: seq, policy_sha256: POLICY_SHA256 } });
    await createIntentPuller({ api: h.api, state: h.state, orgs: h.orgs, logger: h.logger, now: h.now }).pull();
    return items;
  }

  const sent = (suffix) => h.fake.requests.filter((r) => r.path.endsWith(suffix));
  const target = path.join(skillsDir, `market--${slug}`);
  const marker = (dir = target) => { try { return JSON.parse(fs.readFileSync(path.join(dir, '.market-managed'), 'utf8')); } catch { return null; } };
  return { ...h, storage, skillsDir, reqs, over, make, queue, sent, target, marker, versions, results: () => sent('/result') };
}
