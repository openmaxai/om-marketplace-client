import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { FAKE_KEY, ROOT, VALID_ENV, baseEnv, tmpHome } from './helpers.js';
import { startFakeMarket } from './fake/market.js';
import { AGENT, ORG } from './fake/pull.js';
import { writeConfig } from '../src/config.js';
import { POLICY_SHA256 } from '../src/policy/pin.js';
import { SERVICE_NAME, createPm2, startService } from '../src/service.js';

// startService with a fake pm2, post-install, status view and poll round. The status view reports the service as
// holding the lock once pm2 started it, and the intents pull as `pull` at the fake time.
function harness({ pm2Status = null, hook = 0, pull = 'ok', takesLock = true, writeConfigFile = true, configChanges = false } = {}) {
  const dataDir = path.join(tmpHome(), 'd');
  if (writeConfigFile) writeConfig(VALID_ENV, dataDir);
  const clock = { t: Date.parse('2026-11-17T00:00:00Z') };
  const calls = [];
  let status = pm2Status;
  let pulledAt = null;
  const pm2 = {
    async status(name) { calls.push(['status', name]); if (status instanceof Error) throw status; return status; },
    async start(eco) { calls.push(['start', eco]); status = 'online'; },
    async remove(name) { calls.push(['delete', name]); status = null; },
    async save() { calls.push(['save']); },
  };
  const postInstall = async () => {
    calls.push(['post-install']);
    if (configChanges) writeConfig({ ...VALID_ENV, COCO_API_KEY: `${FAKE_KEY}x` }, dataDir);
    return hook;
  };
  const readStatus = () => ({
    service: takesLock && status === 'online' ? 4242 : null,
    runs: pulledAt ? { intents: { outcome: pull, at: new Date(pulledAt).toISOString() } } : {},
    alerts: pull === 'ok' ? {} : { intents_pull: { message: 'install intent pull rejected: 401 UNAUTHENTICATED' } },
  });
  const sync = async () => { calls.push(['sync']); pulledAt = clock.t; return { code: 0, message: 'poll round finished' }; };
  const run = (extra = {}) => startService({
    dataDir, pm2, postInstall, readStatus, sync, now: () => clock.t, wait: async (ms) => { clock.t += ms; }, ecosystem: '/eco.cjs', ...extra,
  });
  return { dataDir, calls, run, names: () => calls.map(([c]) => c) };
}

test('start: not registered in pm2 -> post-install, pm2 start, pm2 save, one poll round, verified pull', async () => {
  const h = harness();
  const r = await h.run();
  assert.equal(r.code, 0, r.message);
  assert.match(r.message, /service running \(pid 4242\) and install orders pulled at 2026-11-17T00:00:00.000Z/);
  assert.deepEqual(h.names(), ['post-install', 'status', 'start', 'save', 'sync', 'status']);
  assert.deepEqual(h.calls[2], ['start', '/eco.cjs']);
});

for (const st of ['stopped', 'errored']) {
  test(`start: an app ${st} in pm2 is deleted and started again`, async () => {
    const h = harness({ pm2Status: st });
    assert.equal((await h.run()).code, 0);
    assert.deepEqual(h.names(), ['post-install', 'status', 'delete', 'start', 'save', 'sync', 'status']);
    assert.deepEqual(h.calls[2], ['delete', SERVICE_NAME]);
  });
}

test('start: an online service is left running; the process list is still saved and the pull checked', async () => {
  const h = harness({ pm2Status: 'online' });
  assert.equal((await h.run()).code, 0);
  assert.deepEqual(h.names(), ['post-install', 'status', 'save', 'sync', 'status']);
});

test('start: an online service is restarted when post-install changed the configuration', async () => {
  const h = harness({ pm2Status: 'online', configChanges: true });
  assert.equal((await h.run()).code, 0);
  assert.deepEqual(h.names(), ['post-install', 'status', 'delete', 'start', 'save', 'sync', 'status']);
});

test('start: a post-install configuration error is returned as is and pm2 is not touched', async () => {
  const h = harness({ hook: 78, writeConfigFile: false });
  const r = await h.run();
  assert.equal(r.code, 78);
  assert.match(r.message, /post-install failed \(exit 78\)/);
  assert.deepEqual(h.names(), ['post-install']);
});

test('start: without pm2 the command fails and says why', async () => {
  const h = harness({ pm2Status: new Error('pm2 jlist failed: spawn pm2 ENOENT') });
  const r = await h.run();
  assert.equal(r.code, 1);
  assert.match(r.message, /ENOENT; the service cannot be started without pm2/);
});

test('start: a service that never takes the lock fails after the wait', async () => {
  const h = harness({ takesLock: false });
  const r = await h.run({ lockWaitMs: 5000 });
  assert.equal(r.code, 1);
  assert.match(r.message, /did not start within 5 s/);
  assert.ok(!h.names().includes('sync'));
});

test('start: a pull the market did not answer fails with the last outcome and the alerts', async () => {
  const h = harness({ pull: 'rejected' });
  const r = await h.run();
  assert.equal(r.code, 1);
  assert.match(r.message, /has not pulled install orders from the market .*last pull: rejected at/);
  assert.match(r.message, /intents_pull: install intent pull rejected: 401/);
});

test('pm2 status reads jlist, also after leading noise, and finds the app by name', async () => {
  const out = `noise\n${JSON.stringify([{ name: 'other', pm2_env: { status: 'online' } }, { name: SERVICE_NAME, pm2_env: { status: 'stopped' } }])}`;
  const args = [];
  const pm2 = createPm2({ run: (bin, a, opts, cb) => { args.push([bin, ...a]); cb(null, out, ''); } });
  assert.equal(await pm2.status(SERVICE_NAME), 'stopped');
  assert.equal(await pm2.status('missing'), null);
  assert.deepEqual(args[0], ['pm2', 'jlist']);
  const broken = createPm2({ run: (bin, a, opts, cb) => cb(null, 'not json', '') });
  await assert.rejects(broken.status(SERVICE_NAME), /unreadable/);
  const failing = createPm2({ run: (bin, a, opts, cb) => cb(Object.assign(new Error('x'), { code: 1 }), '', 'boom\n') });
  await assert.rejects(failing.save(), /pm2 save failed: boom/);
});

// A pm2 stand-in on PATH: start runs the real service (src/main.js) detached, jlist reports it, delete stops it.
const FAKE_PM2 = `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const dir = process.env.FAKE_PM2_DIR;
const pidFile = path.join(dir, 'pid');
fs.appendFileSync(path.join(dir, 'calls'), process.argv.slice(2).join(' ') + '\\n');
const alive = () => { try { const p = Number(fs.readFileSync(pidFile, 'utf8')); process.kill(p, 0); return p; } catch { return null; } };
const cmd = process.argv[2];
if (cmd === 'jlist') {
  const apps = fs.existsSync(pidFile) ? [{ name: '${SERVICE_NAME}', pm2_env: { status: alive() ? 'online' : 'stopped' } }] : [];
  process.stdout.write(JSON.stringify(apps));
} else if (cmd === 'start') {
  const c = spawn(process.execPath, [process.env.FAKE_PM2_MAIN], { env: process.env, detached: true, stdio: 'ignore' });
  c.unref();
  fs.writeFileSync(pidFile, String(c.pid));
} else if (cmd === 'delete') {
  const p = alive();
  if (p) process.kill(p, 'SIGTERM');
  fs.rmSync(pidFile, { force: true });
}
`;

function cli(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'src/cli.js'), ...args], { env });
    let stdout = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', () => {});
    child.on('exit', (code) => resolve({ code, stdout }));
  });
}

test('market-client start: starts the service through pm2 and returns once it has pulled from the market', async (t) => {
  const fake = await startFakeMarket({ apiKey: FAKE_KEY, memberId: AGENT });
  t.after(fake.close);
  const pulls = () => fake.requests.filter((r) => r.path.endsWith('/install-intents:query')).length;
  fake.script('POST', `/api/v1/orgs/${ORG}/agents/${AGENT}/install-intents:query`, ...Array(20).fill({
    status: 200, json: { items: [], has_more: false, next_after_seq: 0, policy_sha256: POLICY_SHA256 },
  }));
  const home = tmpHome();
  const dataDir = path.join(home, 'd');
  writeConfig({ ...VALID_ENV, COCO_BFF_URL: fake.url }, dataDir);
  const bin = path.join(home, 'bin');
  const pm2Dir = path.join(home, 'pm2');
  fs.mkdirSync(bin);
  fs.mkdirSync(pm2Dir);
  fs.writeFileSync(path.join(bin, 'pm2'), FAKE_PM2, { mode: 0o755 });
  const env = { ...baseEnv(dataDir), PATH: `${bin}${path.delimiter}${process.env.PATH}`, FAKE_PM2_DIR: pm2Dir, FAKE_PM2_MAIN: path.join(ROOT, 'src/main.js') };
  t.after(() => {
    try { process.kill(Number(fs.readFileSync(path.join(pm2Dir, 'pid'), 'utf8')), 'SIGKILL'); } catch { /* not running */ }
  });
  let r = await cli(['start', '--wait', '60'], env);
  assert.equal(r.code, 0, r.stdout);
  assert.match(r.stdout, /service running \(pid \d+\) and install orders pulled at/);
  const pid = Number(fs.readFileSync(path.join(pm2Dir, 'pid'), 'utf8'));
  assert.match((await cli(['status'], env)).stdout, new RegExp(`service: running \\(pid ${pid}\\)`));
  const calls = () => fs.readFileSync(path.join(pm2Dir, 'calls'), 'utf8').trim().split('\n').map((l) => l.split(' ')[0]);
  assert.deepEqual(calls(), ['jlist', 'start', 'save', 'jlist']);
  const before = pulls();
  r = await cli(['start', '--wait', '60'], env);
  assert.equal(r.code, 0, r.stdout);
  assert.equal(Number(fs.readFileSync(path.join(pm2Dir, 'pid'), 'utf8')), pid);
  assert.deepEqual(calls().slice(4), ['jlist', 'save', 'jlist']);
  assert.ok(pulls() > before);
});
