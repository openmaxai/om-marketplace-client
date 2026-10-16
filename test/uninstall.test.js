import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { FAKE_KEY, VALID_ENV, baseEnv, runHook, tmpHome } from './helpers.js';
import { startFakeMarket } from './fake/market.js';
import { fakeZylos } from './fake/zylos.js';
import { AGENT, ORG, U } from './fake/pull.js';
import { loadConfig, writeConfig } from '../src/config.js';
import { openState, writeJsonAtomic } from '../src/state.js';
import { ensureDeclarations, readSlots, shardsDir, writeSlots } from '../src/shards.js';
import { preUninstall } from '../hooks/lib/uninstall.js';

const ADOPTION = U(20);
const C10 = `/api/v1/orgs/${ORG}/agents/${AGENT}/reconcile`;
const markedSkill = (dir) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.market-managed'), JSON.stringify({ skill_id: U(1), version_no: 1, package_sha256: 'a'.repeat(64) }));
};

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
  return { fake, dataDir, zylosDir, skillsDir, state };
}

test('pre-uninstall waits for the stopped service, quarantines market content, drops the declarations and reports', async (t) => {
  const s = await setup(t, (req) => ({ status: 200, json: { results: req.json.items.map((_, index) => ({ index, outcome: 'recorded' })) } }));
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
  assert.ok(fs.existsSync(path.join(s.dataDir, 'quarantine', 'market--demo', '.market-managed')));
  assert.ok(fs.existsSync(path.join(s.skillsDir, 'market--manual')), 'unmarked directory left alone');
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
  const r = runHook('pre-uninstall.js', { env: { ...baseEnv(dataDir), PATH: bin } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(log, 'utf8').trim(), 'stop zylos-om-marketplace-client');
  assert.ok(fs.existsSync(path.join(dataDir, 'quarantine', 'market--demo', '.market-managed')));
  assert.match(r.stdout, /no usable config/);
  writeJsonAtomic(path.join(dataDir, 'config.json'), { broken: true });
  assert.equal(runHook('pre-uninstall.js', { env: { ...baseEnv(dataDir), PATH: bin } }).status, 0);
});
