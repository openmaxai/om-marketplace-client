import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { FAKE_KEY, ROOT, VALID_ENV, baseEnv, tmpHome } from './helpers.js';
import { startFakeMarket } from './fake/market.js';
import { AGENT, ORG, ORG2, U } from './fake/pull.js';
import { loadConfig, writeConfig } from '../src/config.js';
import { openState, stateScope, writeJsonAtomic } from '../src/state.js';

const SKILL = U(1);
const VID = (n) => U(100 + n);
const SHA = (n) => String(n).repeat(64);
const B = `/api/v1/orgs/${ORG}/agents/${AGENT}`;

function cli(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'src/cli.js'), ...args], { env });
    let stdout = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', () => {});
    child.on('exit', (code) => resolve({ code, stdout }));
  });
}

const marker = (dir, no) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.market-managed'), JSON.stringify({ skill_id: SKILL, version_no: no, package_sha256: SHA(no) }));
};

// Data dir with skill demo v2 enabled and v1 kept for rollback.
async function setup(t, { config = {} } = {}) {
  const fake = await startFakeMarket({ apiKey: FAKE_KEY, memberId: AGENT });
  t.after(fake.close);
  const home = tmpHome();
  const dataDir = path.join(home, 'd');
  writeConfig({ ...VALID_ENV, COCO_BFF_URL: fake.url }, dataDir);
  const cfg = loadConfig(dataDir);
  if (config.orgs) {
    const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
    writeJsonAtomic(path.join(dataDir, 'config.json'), { ...raw, orgs: config.orgs });
  }
  const sdir = path.join(dataDir, 'state', stateScope(cfg.bff_url, ORG, AGENT));
  fs.mkdirSync(sdir, { recursive: true, mode: 0o700 });
  const put = (name, v) => writeJsonAtomic(path.join(sdir, `${name}.json`), v);
  put('installs', { [SKILL]: {
    org_id: ORG, install_id: U(5), slug: 'demo', skill_version_id: VID(2), version_no: 2, package_sha256: SHA(2), state: 'enabled',
    rollback: { version_no: 1, skill_version_id: VID(1) },
  } });
  const skillsDir = path.join(home, 'zylos', '.claude', 'skills');
  marker(path.join(skillsDir, 'market--demo'), 2);
  marker(path.join(dataDir, 'rollback', 'demo', '1'), 1);
  const ok = (json) => ({ status: 200, json });
  for (const verb of ['set-enabled', 'uninstall']) {
    fake.script('POST', `${B}/skills/${SKILL}:${verb}`, ...Array(3).fill((req) => ok(verb === 'uninstall'
      ? { install_id: U(5), install_state: 'uninstalled' } : { install_id: U(5), enabled: req.json.enabled })));
  }
  return { fake, dataDir, sdir, put, skillsDir, env: baseEnv(dataDir), read: (n) => JSON.parse(fs.readFileSync(path.join(sdir, `${n}.json`), 'utf8')) };
}

test('usage, unknown skill and configuration errors have distinct exit codes', async (t) => {
  const s = await setup(t);
  assert.equal((await cli([], s.env)).code, 2);
  assert.equal((await cli(['enable'], s.env)).code, 2);
  assert.equal((await cli(['sync', '--wait', 'x'], s.env)).code, 2);
  assert.equal((await cli(['--help'], s.env)).code, 0);
  const r = await cli(['disable', 'nosuch'], s.env);
  assert.equal(r.code, 3);
  assert.match(r.stdout, /not installed/);
  const none = await cli(['status'], baseEnv(path.join(tmpHome(), 'd')));
  assert.equal(none.code, 78);
  assert.match(none.stdout, /configuration error/);
});

test('status shows org validity, too-old mode, stale revocations, content, queue, outbox and alerts', async (t) => {
  const s = await setup(t, { config: { orgs: { [ORG2]: {} } } });
  s.put('orgs', { [ORG]: { state: 'suspended', since: '2026-10-15T00:00:00Z' }, [ORG2]: { state: 'invalid', since: '2026-10-14T00:00:00Z' } });
  s.put('gate', { too_old: { reason: 'below_minimum', min_version: '0.2.0', since: '2026-10-15T00:00:00Z' } });
  s.put('revocations', { last_success_at: '2026-10-01T00:00:00Z' });
  s.put('intents', { after_seq: 3, queue: [{ id: U(9), status: 'queued' }, { id: U(10), status: 'org_not_configured' }] });
  s.put('status', { alerts: { 'intent:x': { message: 'refused', since: 'then' }, 'org_membership:y': { message: 'dup', since: 'then' } }, runs: { intents: { outcome: 'ok', at: 'now' } } });
  s.put('adoptions', { [U(20)]: { adoption_id: U(20), template: 'analyst', version: '1.0.0', state: 'active', org_id: ORG } });
  fs.mkdirSync(path.join(s.sdir, 'outbox'));
  fs.writeFileSync(path.join(s.sdir, 'outbox', `${U(30)}.json`), '{}');

  const text = await cli(['status'], s.env);
  assert.equal(text.code, 0);
  for (const re of [/service: not running/, /\(primary\): suspended since/, /suspended; pulling has stopped for ALL orgs/, /: invalid since/,
    /has left org/, /TOO OLD \(below_minimum, minimum 0\.2\.0\)/, /STALE/, /demo v2 enabled, v1 kept for rollback/, /analyst 1\.0\.0 active/,
    /queue: 2 order\(s\) \(1 queued, 1 org_not_configured\); outbox: 1 report\(s\)/, /intent:x: refused/, /intents ok at now/]) {
    assert.match(text.stdout, re);
  }
  assert.doesNotMatch(text.stdout, /org_membership/);
  const json = JSON.parse((await cli(['status', '--json'], s.env)).stdout);
  assert.equal(json.orgs.length, 2);
  assert.equal(json.revocations.stale, true);
  assert.equal(json.skills[0].slug, 'demo');
});

test('disable, enable and uninstall change the skill locally first, then report without an order', async (t) => {
  const s = await setup(t);
  const dir = path.join(s.skillsDir, 'market--demo');
  let r = await cli(['disable', 'demo'], s.env);
  assert.deepEqual([r.code, r.stdout.trim()], [0, 'demo disabled; reported to the market']);
  assert.ok(!fs.existsSync(dir) && fs.existsSync(path.join(s.dataDir, 'disabled', 'market--demo')));
  r = await cli(['enable', SKILL], s.env);
  assert.equal(r.code, 0);
  assert.ok(fs.existsSync(dir));
  r = await cli(['uninstall', 'demo'], s.env);
  assert.equal(r.code, 0);
  assert.ok(!fs.existsSync(dir) && !fs.existsSync(path.join(s.dataDir, 'rollback', 'demo')));
  assert.deepEqual(s.read('installs'), {});
  const bodies = s.fake.market().filter((q) => q.path.includes('/skills/')).map((q) => [q.path.split(':').at(-1), q.json.enabled, q.json.intent_id]);
  assert.deepEqual(bodies, [['set-enabled', false, undefined], ['set-enabled', true, undefined], ['uninstall', undefined, undefined]]);
  assert.ok(fs.readdirSync(path.join(s.sdir, 'outbox')).length === 0);
});

test('rollback swaps the kept version in, reports local_rollback, and refuses a revoked one', async (t) => {
  const s = await setup(t);
  s.fake.script('GET', `${B}/skills`, ...Array(2).fill({ status: 200, json: { items: [
    { install_id: U(5), skill_id: SKILL, slug: 'demo', skill_version_id: VID(2), version_no: 2, source_market_id: U(3), install_state: 'installed', enabled: true },
  ] } }));
  s.fake.script('POST', `${B}/reconcile`, (req) => ({ status: 200, json: { results: req.json.items.map((_, index) => ({ index, outcome: 'recorded' })) } }));
  const r = await cli(['rollback', 'demo'], s.env);
  assert.equal(r.code, 0, r.stdout);
  assert.match(r.stdout, /demo rolled back to version 1; reported to the market/);
  const rec = s.read('installs')[SKILL];
  assert.deepEqual([rec.version_no, rec.skill_version_id, rec.package_sha256, rec.rollback.version_no], [1, VID(1), SHA(1), 2]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(s.skillsDir, 'market--demo', '.market-managed'), 'utf8')).version_no, 1);
  assert.ok(fs.existsSync(path.join(s.dataDir, 'rollback', 'demo', '2', '.market-managed')));
  const c10 = s.fake.market().find((q) => q.path.endsWith('/reconcile'));
  assert.deepEqual(c10.json.items, [{ kind: 'local_rollback', skill_id: SKILL, skill_version_id: VID(1), installed_sha256: SHA(1) }]);

  s.put('revoked', { skill_version_id: [VID(2)] });
  const again = await cli(['rollback', 'demo'], s.env);
  assert.equal(again.code, 3);
  assert.match(again.stdout, /previous version is revoked/);
});

test('with the service running, commands are handed to it; a holder that never answers times out', async (t) => {
  const s = await setup(t);
  const svc = spawn(process.execPath, [path.join(ROOT, 'src/main.js')], { env: s.env, stdio: 'ignore' });
  t.after(() => svc.kill('SIGKILL'));
  const lock = path.join(s.dataDir, 'state', 'lock');
  for (const end = Date.now() + 5000; !fs.existsSync(lock);) {
    assert.ok(Date.now() < end, 'service took the lock');
    await new Promise((r) => setTimeout(r, 20));
  }
  const pulls = () => s.fake.market().filter((q) => q.path.endsWith('/revocations:query')).length;
  const before = pulls();
  let r = await cli(['sync', '--wait', '20'], s.env);
  assert.equal(r.code, 0, r.stdout);
  assert.match(r.stdout, /handed to it[\s\S]*poll round finished/);
  assert.ok(pulls() > before);
  assert.equal((await cli(['disable', 'demo', 'extra'], s.env)).code, 2);
  r = await cli(['disable', 'demo', '--wait', '20'], s.env);
  assert.equal(r.code, 0, r.stdout);
  assert.ok(fs.existsSync(path.join(s.dataDir, 'disabled', 'market--demo')));
  assert.match((await cli(['status'], s.env)).stdout, new RegExp(`service: running \\(pid ${svc.pid}\\)`));
  const exited = new Promise((resolve) => svc.on('exit', resolve));
  svc.kill('SIGTERM');
  assert.equal(await exited, 0);

  const holder = openState(s.dataDir, { bffUrl: loadConfig(s.dataDir).bff_url, orgId: ORG, memberId: AGENT });
  t.after(() => holder.close());
  r = await cli(['sync', '--wait', '1'], s.env);
  assert.equal(r.code, 4);
  assert.match(r.stdout, /did not take the request in time; nothing was done/);
  assert.deepEqual(fs.readdirSync(path.join(s.dataDir, 'cli')), []);
});

function snapshot(root) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      const st = fs.lstatSync(p);
      out[path.relative(root, p)] = [st.mtimeMs, st.mode, st.size];
      if (e.isDirectory()) walk(p);
    }
  };
  walk(root);
  return out;
}

test('status changes nothing in the data dir and does not call a lock of an unidentifiable process running', async (t) => {
  const s = await setup(t);
  const before = snapshot(s.dataDir);
  assert.equal((await cli(['status'], s.env)).code, 0);
  assert.deepEqual(snapshot(s.dataDir), before);
  const other = spawn('sleep', ['30'], { stdio: 'ignore' });
  t.after(() => other.kill('SIGKILL'));
  fs.writeFileSync(path.join(s.dataDir, 'state', 'lock'), JSON.stringify({ pid: other.pid, start: 'another-boot:1' }));
  const r = await cli(['status'], s.env);
  assert.doesNotMatch(r.stdout, /service: running/);
  assert.match(r.stdout, /cannot be identified/);
});

test('a signal during a local command lets it finish, releases the lock and exits 130', async (t) => {
  const s = await setup(t);
  s.fake.script('POST', `/api/v1/orgs/${ORG}/revocations:query`, { status: 200, delayMs: 1500, json: { items: [], next_cursor: null, has_more: false } });
  const child = spawn(process.execPath, [path.join(ROOT, 'src/cli.js'), 'sync'], { env: s.env });
  let stdout = '';
  child.stdout.on('data', (c) => { stdout += c; });
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  const lock = path.join(s.dataDir, 'state', 'lock');
  for (const end = Date.now() + 5000; !fs.existsSync(lock);) {
    assert.ok(Date.now() < end, 'cli took the lock');
    await new Promise((r) => setTimeout(r, 10));
  }
  child.kill('SIGINT');
  child.kill('SIGTERM');
  assert.equal(await exited, 130);
  assert.match(stdout, /finishing the current step/);
  assert.ok(!fs.existsSync(lock), 'the lock was released, so the command ran to its end');
});
