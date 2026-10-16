import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { FAKE_KEY, VALID_ENV, baseEnv, runHook, tmpHome } from './helpers.js';
import { startFakeMarket } from './fake/market.js';
import { fakeZylos } from './fake/zylos.js';
import { AGENT, ORG, U } from './fake/pull.js';
import { loadConfig, writeConfig } from '../src/config.js';
import { openState, processStartId, setLockHooks, writeJsonAtomic } from '../src/state.js';
import { declaration, ensureDeclarations, readSlots, shardName, shardsDir, writeSlots } from '../src/shards.js';
import { preUninstall } from '../hooks/lib/uninstall.js';

const ADOPTION = U(20);
const C10 = `/api/v1/orgs/${ORG}/agents/${AGENT}/reconcile`;
const VID = U(2);
const markedSkill = (dir, skillId = U(1)) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.market-managed'), JSON.stringify({ skill_id: skillId, version_no: 1, package_sha256: 'a'.repeat(64) }));
};
const QDIR = (dataDir, name = `1-${VID}`) => path.join(dataDir, 'quarantine', 'market--demo', name);
const declarations = (zylosDir) => fs.readdirSync(shardsDir(zylosDir)).filter((n) => n.startsWith('market-template-'));

async function setup(t, c10) {
  const fake = await startFakeMarket({ apiKey: FAKE_KEY, memberId: AGENT });
  t.after(fake.close);
  fake.script('POST', C10, c10);
  const dataDir = path.join(tmpHome(), 'd');
  writeConfig({ ...VALID_ENV, COCO_BFF_URL: fake.url }, dataDir);
  const zylosDir = fakeZylos();
  ensureDeclarations(zylosDir);
  fs.writeFileSync(path.join(shardsDir(zylosDir), 'other.json'), '{}');
  const skillsDir = path.join(zylosDir, '.claude', 'skills');
  markedSkill(path.join(skillsDir, 'market--demo'));
  fs.mkdirSync(path.join(skillsDir, 'market--manual'));
  fs.mkdirSync(path.join(dataDir, 'templates', ADOPTION), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'templates', ADOPTION, 'inject.md'), 'x');
  writeSlots(dataDir, { 1: { adoption_id: ADOPTION, inject_sha256: 'b'.repeat(64) } });
  const state = openState(dataDir, { bffUrl: loadConfig(dataDir).bff_url, orgId: ORG, memberId: AGENT });
  state.write('adoptions', { [ADOPTION]: { adoption_id: ADOPTION, org_id: ORG, state: 'active' } });
  state.write('installs', { [U(1)]: { org_id: ORG, slug: 'demo', skill_version_id: VID, version_no: 1, package_sha256: 'a'.repeat(64), state: 'enabled' } });
  return { fake, dataDir, zylosDir, skillsDir, state };
}

test('pre-uninstall waits for the stopped service, quarantines market content, drops the declarations and reports', async (t) => {
  const s = await setup(t, (req) => ({ status: 200, json: { results: req.json.items.map((_, index) => ({ index, outcome: 'recorded' })) } }));
  markedSkill(path.join(s.skillsDir, 'market--foreign'), U(3));
  fs.symlinkSync(path.join(s.skillsDir, 'market--foreign'), path.join(s.skillsDir, 'market--link'));
  fs.mkdirSync(QDIR(s.dataDir), { recursive: true });
  fs.writeFileSync(path.join(QDIR(s.dataDir), 'earlier'), 'kept');
  const calls = [];
  const lines = [];
  const ok = await preUninstall({
    env: baseEnv(s.dataDir), dataDir: s.dataDir, zylosDir: s.zylosDir, log: (l) => lines.push(l),
    stop: () => { calls.push('stop'); setTimeout(() => s.state.close(), 300); },
    sync: (dir) => calls.push(['sync', dir]),
  });
  assert.equal(ok, true);
  assert.deepEqual(calls, ['stop', ['sync', s.zylosDir]]);
  assert.ok(!fs.existsSync(path.join(s.skillsDir, 'market--demo')));
  assert.ok(fs.existsSync(path.join(s.skillsDir, 'market--manual')), 'unmarked directory left alone');
  assert.ok(fs.existsSync(path.join(s.skillsDir, 'market--foreign')), 'a marker of a skill not in the inventory is left alone');
  assert.ok(fs.lstatSync(path.join(s.skillsDir, 'market--link')).isSymbolicLink(), 'a link is left alone');
  assert.equal(fs.readFileSync(path.join(QDIR(s.dataDir), 'earlier'), 'utf8'), 'kept', 'an earlier quarantined copy is not replaced');
  assert.ok(fs.existsSync(path.join(QDIR(s.dataDir, `1-${VID}.2`), '.market-managed')));
  assert.ok(!fs.existsSync(path.join(s.dataDir, 'hook-sync-pending')));
  assert.ok(fs.existsSync(path.join(s.dataDir, 'quarantine', ADOPTION, 'inject.md')));
  assert.ok(Object.values(readSlots(s.dataDir)).every((v) => v === null));
  assert.deepEqual(fs.readdirSync(shardsDir(s.zylosDir)), ['other.json']);
  assert.deepEqual(s.fake.market().filter((r) => r.path === C10).map((r) => r.json), [{ items: [{ kind: 'client_uninstalled' }] }]);
  assert.ok(!fs.existsSync(path.join(s.dataDir, 'state', 'lock')), 'lock released');
  const st = openState(s.dataDir, { bffUrl: loadConfig(s.dataDir).bff_url, orgId: ORG, memberId: AGENT });
  assert.equal(st.read('adoptions', {})[ADOPTION].state, 'quarantined');
  st.close();
});

test('pre-uninstall bounds the report and leaves content in place while the lock stays held', async (t) => {
  const s = await setup(t, { status: 200, delayMs: 5000, json: { results: [] } });
  s.state.close();
  const started = Date.now();
  const opts = { env: baseEnv(s.dataDir), dataDir: s.dataDir, zylosDir: s.zylosDir, log: () => {}, stop: () => {}, sync: () => {}, reportTimeoutMs: 300 };
  assert.equal(await preUninstall(opts), true);
  assert.ok(Date.now() - started < 3000, 'report abandoned after its timeout');

  const again = await setup(t, { status: 200, json: { results: [] } });
  const held = { ...opts, dataDir: again.dataDir, zylosDir: again.zylosDir, lockWaitMs: 200 };
  assert.equal(await preUninstall(held), false);
  assert.ok(fs.existsSync(path.join(again.skillsDir, 'market--demo')));
  assert.deepEqual(declarations(again.zylosDir), [], 'declarations go even when the lock is unavailable');
  again.state.close();
});

test('the pre-uninstall hook stops the service, works without a config and exits 0', () => {
  const home = tmpHome();
  const dataDir = path.join(home, 'd');
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin);
  const log = path.join(home, 'pm2.log');
  fs.writeFileSync(path.join(bin, 'pm2'), `#!/bin/sh\necho "$@" >> '${log}'\n`, { mode: 0o755 });
  markedSkill(path.join(home, 'zylos', '.claude', 'skills', 'market--demo'));
  markedSkill(path.join(home, 'elsewhere'), U(4));
  fs.symlinkSync(path.join(home, 'elsewhere'), path.join(home, 'zylos', '.claude', 'skills', 'market--alias'));
  const r = runHook('pre-uninstall.js', { env: { ...baseEnv(dataDir), PATH: bin } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(log, 'utf8').trim(), 'stop zylos-om-marketplace-client');
  assert.ok(fs.existsSync(path.join(QDIR(dataDir, '1-unrecorded'), '.market-managed')));
  assert.ok(fs.lstatSync(path.join(home, 'zylos', '.claude', 'skills', 'market--alias')).isSymbolicLink(), 'a link is not moved');
  assert.match(r.stdout, /no usable config/);
  writeJsonAtomic(path.join(dataDir, 'config.json'), { broken: true });
  assert.equal(runHook('pre-uninstall.js', { env: { ...baseEnv(dataDir), PATH: bin } }).status, 0);

  const file = path.join(home, 'not-a-dir');
  fs.writeFileSync(file, '');
  const failed = runHook('pre-uninstall.js', { env: { ...baseEnv(file), PATH: bin } });
  assert.equal(failed.status, 0);
  assert.match(failed.stderr, /pre-uninstall: /, 'a failure is logged and the hook still exits 0');
});

const opts = (s, extra = {}) => ({
  env: baseEnv(s.dataDir), dataDir: s.dataDir, zylosDir: s.zylosDir, log: () => {}, stop: () => {}, sync: () => {}, reportTimeoutMs: 300, ...extra,
});
const recordAll = (req) => ({ status: 200, json: { results: req.json.items.map((_, index) => ({ index, outcome: 'recorded' })) } });

test('a corrupt adoptions file still removes the declarations, syncs hooks and quarantines skills', async (t) => {
  const s = await setup(t, recordAll);
  fs.writeFileSync(path.join(s.state.dir, 'adoptions.json'), '{broken');
  s.state.close();
  const syncs = [];
  assert.equal(await preUninstall(opts(s, { sync: (d) => syncs.push(d) })), true);
  assert.deepEqual(declarations(s.zylosDir), []);
  assert.deepEqual(syncs, [s.zylosDir]);
  assert.ok(fs.existsSync(path.join(QDIR(s.dataDir), '.market-managed')));
});

test('a hook sync that did not finish is redone on the next run; nothing to sync is not synced', async (t) => {
  const s = await setup(t, recordAll);
  s.state.close();
  let syncs = 0;
  const failing = () => { syncs += 1; throw new Error('boom'); };
  await preUninstall(opts(s, { sync: failing }));
  assert.equal(syncs, 1);
  assert.deepEqual(declarations(s.zylosDir), []);
  assert.ok(fs.existsSync(path.join(s.dataDir, 'hook-sync-pending')));
  await preUninstall(opts(s, { sync: () => { syncs += 1; } }));
  assert.equal(syncs, 2, 'redone although no declaration was left');
  await preUninstall(opts(s, { sync: () => { syncs += 1; } }));
  assert.equal(syncs, 2);
});

test('an edited declaration is not removed', async (t) => {
  const s = await setup(t, recordAll);
  s.state.close();
  const file = path.join(shardsDir(s.zylosDir), `${shardName(2)}.json`);
  fs.writeFileSync(file, JSON.stringify({ ...declaration(2), order: 1 }));
  await preUninstall(opts(s));
  assert.deepEqual(declarations(s.zylosDir), [`${shardName(2)}.json`]);
});

test('without a config the data dir lock is still required', async (t) => {
  const s = await setup(t, recordAll);
  fs.rmSync(path.join(s.dataDir, 'config.json'));
  assert.equal(await preUninstall(opts(s, { lockWaitMs: 200, termGraceMs: 200 })), false);
  assert.ok(fs.existsSync(path.join(s.skillsDir, 'market--demo')));
  assert.ok(fs.existsSync(path.join(s.dataDir, 'templates', ADOPTION)));
  s.state.close();
});

function sleeper() {
  const c = spawn('sleep', ['30'], { stdio: 'ignore' });
  return c;
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('without start times anywhere (no /proc), a lock holder is never signalled', async (t) => {
  setLockHooks({ startId: () => null });
  t.after(() => setLockHooks({ startId: processStartId }));
  const s = await setup(t, recordAll);
  s.state.close();
  const other = sleeper();
  t.after(() => other.kill('SIGKILL'));
  fs.writeFileSync(path.join(s.dataDir, 'state', 'lock'), JSON.stringify({ pid: other.pid, start: null, nonce: 'x' }));
  assert.equal(await preUninstall(opts(s, { lockWaitMs: 200, termGraceMs: 300 })), false);
  assert.ok(alive(other.pid));
});

test('a lock naming an unrelated process without a start time, or with another one, is never signalled', async (t) => {
  for (const start of [null, 'not-its-boot:1']) {
    const s = await setup(t, recordAll);
    s.state.close();
    const other = sleeper();
    t.after(() => other.kill('SIGKILL'));
    const lock = path.join(s.dataDir, 'state', 'lock');
    fs.writeFileSync(lock, JSON.stringify({ pid: other.pid, start, nonce: 'x' }));
    const r = await preUninstall(opts(s, { lockWaitMs: 200, termGraceMs: 300 }));
    assert.ok(alive(other.pid), `start ${start}: unrelated process was not signalled`);
    if (start === null) {
      assert.equal(r, false);
      assert.ok(fs.existsSync(path.join(s.skillsDir, 'market--demo')));
    } else assert.equal(r, true, 'a lock whose start time does not match is stale');
  }
});

// A child that holds the state lock and exits exitAfterMs after SIGTERM (or never), recording each SIGTERM.
async function holder(t, s, { exitAfterMs = 1500, ignore = false } = {}) {
  const log = path.join(path.dirname(s.dataDir), 'signals.log');
  const code = `
    import fs from 'node:fs';
    import { openState } from ${JSON.stringify(path.resolve('src/state.js'))};
    const st = openState(${JSON.stringify(s.dataDir)}, ${JSON.stringify({ bffUrl: loadConfig(s.dataDir).bff_url, orgId: ORG, memberId: AGENT })});
    process.on('SIGTERM', () => {
      fs.appendFileSync(${JSON.stringify(log)}, 'SIGTERM,');
      if (!${ignore}) setTimeout(() => { st.close(); process.exit(0); }, ${exitAfterMs});
    });
    process.stdout.write('READY');
    setInterval(() => {}, 1000);
  `;
  const c = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => c.kill('SIGKILL'));
  let err = '';
  c.stderr.on('data', (d) => { err += d; });
  await new Promise((resolve, reject) => {
    c.stdout.on('data', (d) => { if (String(d).includes('READY')) resolve(); });
    c.on('exit', () => reject(new Error(`holder exited: ${err}`)));
  });
  return { child: c, signals: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split(',').filter(Boolean) : []) };
}

test('a verified lock holder gets one SIGTERM and a bounded grace period to exit', async (t) => {
  const s = await setup(t, recordAll);
  s.state.close();
  const h = await holder(t, s, { exitAfterMs: 1500 });
  const started = Date.now();
  assert.equal(await preUninstall(opts(s, { lockWaitMs: 200, termGraceMs: 5000 })), true);
  assert.deepEqual(h.signals(), ['SIGTERM']);
  assert.ok(Date.now() - started >= 1500, 'waited for the holder to exit');
  assert.ok(fs.existsSync(path.join(QDIR(s.dataDir), '.market-managed')));

  const g = await setup(t, recordAll);
  g.state.close();
  const stubborn = await holder(t, g, { ignore: true });
  const t0 = Date.now();
  assert.equal(await preUninstall(opts(g, { lockWaitMs: 200, termGraceMs: 600 })), false);
  assert.ok(Date.now() - t0 < 3000, 'the grace period is bounded');
  assert.deepEqual(stubborn.signals(), ['SIGTERM'], 'signalled once');
  assert.ok(alive(stubborn.child.pid));
  assert.ok(fs.existsSync(path.join(g.skillsDir, 'market--demo')));
});
