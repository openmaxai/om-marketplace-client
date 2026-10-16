// Crash sweep for one scenario. The parent holds the fake market; each round a child (kill-child.mjs) runs the
// scenario's skills round and is SIGKILLed, then two clean children restart it, and the final state is checked.
// MODE=count kills before the Nth write-like fs call, N = 1, 2, ... until a child completes without being killed.
// MODE=timer kills at a random time in [0, MAXD) ms after the round starts.
// SCEN: install, upgrade, disabled-upgrade, disable, enable, uninstall, refused (rollback after the market refuses),
// rollback (local rollback to the kept version; the killed child runs it instead of a round), template (a template
// adoption written at v1 is rewritten at v2; the killed child runs one template intent).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { skillPackage } from '../test/fake/package.js';
import { SKILL, skillHarness } from '../test/fake/skills.js';
import { AGENT, ORG, U } from '../test/fake/pull.js';
import { templateBundle } from '../test/fake/bundle.js';
import { fakeZylos } from '../test/fake/zylos.js';
import { createIntentPuller } from '../src/intents.js';
import { createTemplates } from '../src/templates.js';
import { ensureDeclarations, readSlots } from '../src/shards.js';
import { POLICY_SHA256 } from '../src/policy/pin.js';
import { openState } from '../src/state.js';
import { VALID_ENV } from '../test/helpers.js';

const MODE = process.env.MODE ?? 'timer';
const ROUNDS = Number(process.env.ROUNDS ?? 20);
const SCEN = process.env.SCEN ?? 'upgrade';
const MAXD = Number(process.env.MAXD ?? 400);
const SCENARIOS = ['install', 'upgrade', 'disabled-upgrade', 'disable', 'enable', 'uninstall', 'refused', 'rollback', 'template'];
if (!SCENARIOS.includes(SCEN)) throw new Error(`unknown SCEN ${SCEN}`);

const many = (tag) => Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`docs/f${i}.md`, `${tag} ${i}\n`.repeat(50)]));
const V1 = skillPackage('demo-skill', many('v1'));
const V2 = skillPackage('demo-skill', many('v2'));
const CHILD = path.join(import.meta.dirname, 'kill-child.mjs');
const ADOPTION = U(11);
const tmany = (tag) => Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`knowledge/f${i}.md`, `${tag} ${i}\n`.repeat(50)]));
const T1 = templateBundle({ files: tmany('t1') });
const T2 = templateBundle({ inject: '# Demo v2\n', files: tmany('t2') });
const TFILES = (tag) => ({ 'inject.md': tag === 't1' ? '# Demo\n\nHelp with demos.\n' : '# Demo v2\n', 'connectors.json': '[]', 'customizations.json': '{}', 'sop/triage.md': '# Triage\n', ...tmany(tag) });

function runChild(h, killAfter, killAt = 0, action = 'round') {
  return new Promise((resolve) => {
    const arg = JSON.stringify({ url: h.fake.url, dataDir: h.dataDir, skillsDir: h.skillsDir, zylosDir: h.zylosDir, origin: h.storage.origin, action, skillId: SKILL });
    const c = spawn(process.execPath, [CHILD, arg], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, KILL_AT: String(killAt) } });
    let out = '';
    let err = '';
    let armed = false;
    c.stdout.on('data', (d) => {
      out += d;
      if (killAfter != null && out.includes('GO\n') && !armed) {
        armed = true;
        setTimeout(() => c.kill('SIGKILL'), killAfter);
      }
    });
    c.stderr.on('data', (d) => { err += d; });
    c.on('exit', (code, sig) => resolve({ code, sig, out, err }));
  });
}

function tree(dir) {
  const out = {};
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(p);
      else out[p] = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, p))).digest('hex').slice(0, 8);
    }
  };
  walk('');
  return out;
}
const flat = (o) => JSON.stringify(Object.keys(o).sort().map((k) => [k, o[k]]));
// 'ok' when dir holds exactly pkg's files plus a marker for pkg.
function same(dir, pkg) {
  if (!fs.existsSync(dir)) return 'missing';
  const t = tree(dir);
  let m = null;
  try { m = JSON.parse(fs.readFileSync(path.join(dir, '.market-managed'), 'utf8')); } catch { /* none */ }
  delete t['.market-managed'];
  if (m?.package_sha256 !== pkg.sha) return `marker ${m ? 'other' : 'missing'} (${Object.keys(t).length} files)`;
  return flat(t) === flat(Object.fromEntries(pkg.manifest.map((e) => [e.path, e.sha256.slice(0, 8)]))) ? 'ok' : `diff(${Object.keys(t).length} files)`;
}
const ls = (d) => (fs.existsSync(d) ? fs.readdirSync(d) : []);

// C-01, C-04 and C-15 for one adoption; `h.bundle` is what C-04 serves.
async function templateSetup(h) {
  h.zylosDir = fakeZylos({ hooks: true });
  ensureDeclarations(h.zylosDir);
  const B = `/api/v1/orgs/${ORG}/agents/${AGENT}`;
  const c04 = () => {
    h.fake.script('GET', `${B}/packages/templates/${ADOPTION}`, c04);
    const url = h.storage.serve(`/t/${crypto.randomBytes(4).toString('hex')}`, { status: 200, body: h.bundle.zip });
    return { status: 200, json: { download_url: url, expires_at: '2026-10-16T00:05:00Z', sha256: h.bundle.sha, size: h.bundle.size } };
  };
  const c15 = (req) => {
    h.fake.script('POST', `${B}/adoptions/${ADOPTION}/write-results`, c15);
    return { status: 200, json: { adoption_id: ADOPTION, status: 'active', outcome: 'applied' } };
  };
  h.fake.script('GET', `${B}/packages/templates/${ADOPTION}`, c04);
  h.fake.script('POST', `${B}/adoptions/${ADOPTION}/write-results`, c15);
  const write = async (seq, bundle) => {
    h.bundle = bundle;
    const it = {
      id: U(1000 + seq), org_id: ORG, op: 'write_template', skill_id: null, skill_version_id: null, template_id: U(13), source_market_id: null,
      adoption_id: ADOPTION, discard_local_changes: false, expires_at: '2026-10-17T00:00:00Z', seq: 100 + seq, bundle_sha256: bundle.sha,
    };
    h.fake.script('POST', `${B}/install-intents:query`, { status: 200, json: { items: [it], has_more: false, next_after_seq: it.seq, policy_sha256: POLICY_SHA256 } });
    await createIntentPuller({ api: h.api, state: h.state, orgs: h.orgs, logger: h.logger, now: h.now }).pull();
  };
  await write(1, T1);
  const t = createTemplates({ api: h.api, state: h.state, orgs: h.orgs, logger: h.logger, dataDir: h.dataDir, zylosDir: h.zylosDir, emulatorOrigin: h.storage.origin, now: h.now, sleep: async () => {} });
  if (await t.runNext() !== 'succeeded') throw new Error('template setup failed');
  await write(2, T2);
}

// 'ok' when dir holds exactly the files of bundle tag (t1 / t2).
function sameTemplate(dir, tag) {
  if (!fs.existsSync(dir)) return 'missing';
  const want = Object.fromEntries(Object.entries(TFILES(tag)).map(([p, c]) => [p, crypto.createHash('sha256').update(c).digest('hex').slice(0, 8)]));
  const t = tree(dir);
  delete t['bundle.json'];
  return flat(t) === flat(want) ? 'ok' : `diff(${Object.keys(t).length} files)`;
}

async function setup(h) {
  if (SCEN === 'template') return templateSetup(h);
  if (SCEN !== 'install') {
    await h.queue(['install', 1]);
    await h.make().runRound();
  }
  if (SCEN === 'install') await h.queue(['install', 1]);
  else if (SCEN === 'upgrade') await h.queue(['upgrade', 2]);
  else if (SCEN === 'rollback') {
    await h.queue(['upgrade', 2]);
    await h.make().runRound();
  }
  else if (SCEN === 'uninstall') await h.queue(['uninstall']);
  else if (SCEN === 'disable') await h.queue(['disable']);
  else if (SCEN === 'enable') {
    await h.queue(['disable']);
    await h.make().runRound();
    await h.queue(['enable']);
  } else if (SCEN === 'refused') {
    h.over.c06.push((req) => {
      const id = req.path.split('/')[6];
      const r = h.reqs.get(id);
      Object.assign(r, { status: 'failed', result: req.body, reply: { request_id: id, status: 'failed', error_code: 'PACKAGE_MISMATCH' } });
      return { status: 200, json: r.reply };
    });
    await h.queue(['upgrade', 2]);
  } else if (SCEN === 'disabled-upgrade') {
    await h.queue(['disable']);
    await h.make().runRound();
    await h.queue(['upgrade', 2]);
  }
}

// What may be in skills/ at the instant of the kill: nothing, or a complete marked copy. A disabled skill never.
function atKill(h) {
  if (SCEN === 'template') {
    const d = path.join(h.dataDir, 'templates', ADOPTION);
    return !fs.existsSync(d) || ['t1', 't2'].some((x) => sameTemplate(d, x) === 'ok') ? [] : [`partial template dir at the kill: ${sameTemplate(d, 't2')}`];
  }
  if (!fs.existsSync(h.target)) return [];
  if (['disabled-upgrade'].includes(SCEN)) return ['disabled skill present in skills/ at the kill'];
  const ok = [V1, V2].some((p) => same(h.target, p) === 'ok');
  return ok ? [] : [`partial skills dir at the kill: ${same(h.target, V1)}`];
}

function finalIssues(h, st) {
  const rec = st.read('installs', {})[SKILL];
  const en = h.target;
  const dis = path.join(h.dataDir, 'disabled', 'market--demo-skill');
  const rb = path.join(h.dataDir, 'rollback', 'demo-skill');
  const issues = [];
  if (st.outbox.list().length) issues.push('outbox not empty');
  if (st.read('intents', { queue: [] }).queue.length) issues.push('queue not empty');
  if (ls(path.join(h.dataDir, 'staging')).length) issues.push('staging not empty');
  if (ls(path.join(h.dataDir, 'trash')).length) issues.push('trash not empty');
  if (SCEN === 'template') {
    const s = sameTemplate(path.join(h.dataDir, 'templates', ADOPTION), 't2');
    if (s !== 'ok') issues.push(`v2 template ${s}`);
    if (JSON.stringify(ls(path.join(h.dataDir, 'templates'))) !== JSON.stringify([ADOPTION])) issues.push(`templates/ holds ${ls(path.join(h.dataDir, 'templates'))}`);
    const a = st.read('adoptions', {})[ADOPTION];
    const inject = crypto.createHash('sha256').update('# Demo v2\n').digest('hex');
    if (a?.state !== 'active' || a.bundle_sha256 !== T2.sha || a.inject_sha256 !== inject) issues.push(`adoption ${a?.state}`);
    const slot = readSlots(h.dataDir)?.['1'];
    if (slot?.adoption_id !== ADOPTION || slot.inject_sha256 !== inject) issues.push('slot not on v2');
    if (Object.keys(st.read('template_reports', {})).length) issues.push('template report not sent');
    const sent = h.fake.requests.filter((r) => r.path.endsWith('/write-results') && r.json.intent_id === U(1002));
    if (!sent.length || !sent.every((r) => r.body === sent[0].body) || sent[0].json.status !== 'succeeded') issues.push('C-15 bodies');
  } else if (SCEN === 'install') {
    const req = [...h.reqs.values()].find((x) => x.op === 'install');
    if (req?.status !== 'succeeded') issues.push(`install req status ${req?.status}`);
    if (rec?.version_no !== 1 || rec?.state !== 'enabled') issues.push(`rec ${rec?.version_no}/${rec?.state}`);
    const s = same(en, V1);
    if (s !== 'ok') issues.push(`v1 tree ${s}`);
    if (fs.existsSync(dis) || fs.existsSync(rb)) issues.push('stray disabled or rollback dir');
  } else if (SCEN === 'upgrade' || SCEN === 'disabled-upgrade') {
    const where = SCEN === 'upgrade' ? en : dis;
    const other = SCEN === 'upgrade' ? dis : en;
    const up = [...h.reqs.values()].find((x) => x.op === 'upgrade');
    if (up?.status !== 'succeeded') issues.push(`upgrade req status ${up?.status}; rec ${rec?.version_no}/${rec?.state}`);
    if (rec?.version_no !== 2 || rec?.state !== (SCEN === 'upgrade' ? 'enabled' : 'disabled')) issues.push(`rec ${rec?.version_no}/${rec?.state}`);
    const s = same(where, V2);
    if (s !== 'ok') issues.push(`v2 tree ${s}`);
    if (fs.existsSync(other)) issues.push('stray dir in the other area');
    const rbs = ls(rb);
    if (JSON.stringify(rbs) !== '["1"]' || same(path.join(rb, '1'), V1) !== 'ok') issues.push(`rollback ${rbs}`);
  } else if (SCEN === 'refused') {
    if (rec?.version_no !== 1 || rec?.state !== 'enabled') issues.push(`rec ${rec?.version_no}/${rec?.state}`);
    const s = same(en, V1);
    if (s !== 'ok') issues.push(`v1 tree ${s}`);
    if (ls(rb).length) issues.push(`rollback left ${ls(rb)}`);
    if (fs.existsSync(dis)) issues.push('stray disabled dir');
  } else if (SCEN === 'rollback') {
    // Either not started or complete, with the record matching the directories.
    const done = rec?.version_no === 1;
    const [live, kept, keptNo] = done ? [V1, V2, '2'] : [V2, V1, '1'];
    if (rec?.state !== 'enabled' || rec.rollback?.version_no !== Number(keptNo) || rec.package_sha256 !== live.sha) issues.push(`rec ${rec?.version_no}/${rec?.state}/${rec?.rollback?.version_no}`);
    const s = same(en, live);
    if (s !== 'ok') issues.push(`live tree ${s} (rec v${rec?.version_no})`);
    if (JSON.stringify(ls(rb)) !== JSON.stringify([keptNo]) || same(path.join(rb, keptNo), kept) !== 'ok') issues.push(`rollback ${ls(rb)}`);
    if (fs.existsSync(dis)) issues.push('stray disabled dir');
    if (st.journal.list().some((id) => st.journal.get(id)?.op === 'rollback' && st.journal.get(id).phase !== 'closed')) issues.push('rollback journal open');
  } else if (SCEN === 'uninstall') {
    if (rec) issues.push('rec still present');
    if (fs.existsSync(en)) issues.push(`skills dir left: ${Object.keys(tree(en)).length} files`);
    if (fs.existsSync(dis) || fs.existsSync(rb)) issues.push('disabled or rollback dir left');
    if (h.sent(':uninstall').length < 1) issues.push('no C-09');
  } else if (SCEN === 'disable' || SCEN === 'enable') {
    const want = SCEN === 'disable' ? 'disabled' : 'enabled';
    const [here, there] = SCEN === 'disable' ? [dis, en] : [en, dis];
    if (rec?.state !== want) issues.push(`rec ${rec?.state}`);
    const s = same(here, V1);
    if (s !== 'ok') issues.push(`${want} tree ${s}`);
    if (fs.existsSync(there)) issues.push('dir still in the other area');
    const sent = h.sent(':set-enabled').filter((x) => x.json.enabled === (SCEN === 'enable'));
    if (!sent.length || !sent.every((x) => x.body === sent[0].body)) issues.push('C-08 bodies');
  }
  return issues;
}

const results = { ok: 0, bad: [], killed: 0, notKilled: 0 };
for (let r = 0; r < ROUNDS; r++) {
  const afters = [];
  const h = await skillHarness({ after: (fn) => afters.push(fn) }, { versions: { 1: V1, 2: V2 } });
  await setup(h);
  h.state.close();
  const at = MODE === 'count' ? r + 1 : Math.floor(Math.random() * MAXD);
  const action = SCEN === 'rollback' ? 'rollback' : SCEN === 'template' ? 'template' : 'round';
  const k = MODE === 'count' ? await runChild(h, null, at, action) : await runChild(h, at, 0, action);
  const cleanup = async () => { for (const f of afters.reverse()) { try { await f(); } catch { /* best effort */ } } };
  if (MODE === 'count' && !k.sig) {
    if (k.code !== 0) results.bad.push({ r, at, why: 'unkilled child failed', err: k.err.slice(0, 500) });
    results.completedAt = at;
    await cleanup();
    break;
  }
  if (k.sig === 'SIGKILL') results.killed++;
  else results.notKilled++;
  const issues = atKill(h);
  const restart = SCEN === 'template' ? 'template' : 'round';
  const r2 = await runChild(h, null, 0, restart);
  const r3 = await runChild(h, null, 0, restart);
  if (r2.code !== 0 || r3.code !== 0) {
    results.bad.push({ r, at, why: 'restart failed', err: (r2.err + r3.err).slice(0, 500) });
    await cleanup();
    continue;
  }
  const st = openState(h.dataDir, { bffUrl: h.fake.url, orgId: VALID_ENV.COCO_ORG_ID, memberId: VALID_ENV.COCO_MEMBER_ID, now: h.now });
  issues.push(...finalIssues(h, st));
  st.close();
  if (issues.length) results.bad.push({ r, at, killedAt: k.out.split('\n').find((l) => l.startsWith('KILL')), issues });
  else results.ok++;
  await cleanup();
}
const rounds = results.ok + results.bad.length;
console.log(JSON.stringify({ SCEN, MODE, rounds, ...results }));
