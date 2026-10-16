// Crash sweep for one scenario. The parent holds the fake market; each round a child (kill-child.mjs) runs the
// scenario's skills round and is SIGKILLed, then two clean children restart it, and the final state is checked.
// MODE=count kills before the Nth write-like fs call, N = 1, 2, ... until a child completes without being killed.
// MODE=timer kills at a random time in [0, MAXD) ms after the round starts.
// SCEN: install, upgrade, disabled-upgrade, disable, enable, uninstall, refused (rollback after the market refuses).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { skillPackage } from '../test/fake/package.js';
import { SKILL, skillHarness } from '../test/fake/skills.js';
import { openState } from '../src/state.js';
import { VALID_ENV } from '../test/helpers.js';

const MODE = process.env.MODE ?? 'timer';
const ROUNDS = Number(process.env.ROUNDS ?? 20);
const SCEN = process.env.SCEN ?? 'upgrade';
const MAXD = Number(process.env.MAXD ?? 400);
const SCENARIOS = ['install', 'upgrade', 'disabled-upgrade', 'disable', 'enable', 'uninstall', 'refused'];
if (!SCENARIOS.includes(SCEN)) throw new Error(`unknown SCEN ${SCEN}`);

const many = (tag) => Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`docs/f${i}.md`, `${tag} ${i}\n`.repeat(50)]));
const V1 = skillPackage('demo-skill', many('v1'));
const V2 = skillPackage('demo-skill', many('v2'));
const CHILD = path.join(import.meta.dirname, 'kill-child.mjs');

function runChild(h, killAfter, killAt = 0) {
  return new Promise((resolve) => {
    const arg = JSON.stringify({ url: h.fake.url, dataDir: h.dataDir, skillsDir: h.skillsDir, origin: h.storage.origin });
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

async function setup(h) {
  if (SCEN !== 'install') {
    await h.queue(['install', 1]);
    await h.make().runRound();
  }
  if (SCEN === 'install') await h.queue(['install', 1]);
  else if (SCEN === 'upgrade') await h.queue(['upgrade', 2]);
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
  if (SCEN === 'install') {
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
  const k = MODE === 'count' ? await runChild(h, null, at) : await runChild(h, at);
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
  const r2 = await runChild(h, null);
  const r3 = await runChild(h, null);
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
