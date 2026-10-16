import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { FAKE_KEY, ROOT, VALID_ENV, baseEnv, tmpHome } from './helpers.js';
import { fakeCursor, marketHarness, startFakeMarket } from './fake/market.js';
import { AGENT, ORG } from './fake/pull.js';
import { buildTasks, createRuntime } from '../src/app.js';
import { StateLockedError } from '../src/state.js';
import { writeConfig } from '../src/config.js';
import { POLICY_SHA256 } from '../src/policy/pin.js';

test('one poll round pulls revocations, then intents; a second runtime is locked out', async (t) => {
  const { fake, lines } = await marketHarness(t);
  const logger = { debug() {}, info() {}, warn: (l) => lines.push(l), error: (l) => lines.push(l) };
  const config = { bff_url: fake.url, api_key: FAKE_KEY, org_id: ORG, member_id: AGENT, orgs: { [ORG]: { member_id: AGENT } } };
  const dataDir = path.join(tmpHome(), 'd');
  const rt = createRuntime({ config, dataDir, logger });
  t.after(() => rt.state.close());
  assert.throws(() => createRuntime({ config, dataDir, logger }), StateLockedError);
  fake.script('POST', `/api/v1/orgs/${ORG}/revocations:query`, { status: 200, json: { items: [], next_cursor: fakeCursor(0), has_more: false } });
  fake.script('POST', `/api/v1/orgs/${ORG}/agents/${AGENT}/install-intents:query`,
    { status: 200, json: { items: [], has_more: false, next_after_seq: 3, policy_sha256: POLICY_SHA256 } });
  await buildTasks(logger, rt).find((x) => x.name === 'poll').run();
  assert.deepEqual(fake.market().map((r) => r.path.split('/').at(-1)), ['revocations:query', 'install-intents:query']);
  assert.equal(rt.state.read('intents', null).after_seq, 3);
  assert.deepEqual(Object.keys(rt.state.read('status', null).alerts), []);
});

test('the poll round is skipped while the token belongs to another member', async (t) => {
  const { fake, lines } = await marketHarness(t);
  const logger = { debug() {}, info() {}, warn: (l) => lines.push(l), error: (l) => lines.push(l) };
  const other = '7d3e2c1b-2222-4b3a-8c2d-eeeeeeeeeeee';
  const config = { bff_url: fake.url, api_key: FAKE_KEY, org_id: ORG, member_id: other, orgs: { [ORG]: { member_id: other } } };
  const rt = createRuntime({ config, dataDir: path.join(tmpHome(), 'd'), logger });
  t.after(() => rt.state.close());
  const poll = buildTasks(logger, rt).find((x) => x.name === 'poll');
  await poll.run();
  await poll.run();
  assert.equal(fake.market().length, 0);
  assert.match(rt.state.read('status', null).alerts.identity_mismatch.message, new RegExp(`belongs to member ${AGENT}`));
  assert.equal(lines.filter((l) => l.includes('belongs to member')).length, 1);
});

test('aborting the runtime signal ends an in-flight pull promptly', async (t) => {
  const { fake, lines } = await marketHarness(t);
  const logger = { debug() {}, info() {}, warn: (l) => lines.push(l), error: (l) => lines.push(l) };
  const config = { bff_url: fake.url, api_key: FAKE_KEY, org_id: ORG, member_id: AGENT, orgs: { [ORG]: { member_id: AGENT } } };
  const abort = new AbortController();
  const rt = createRuntime({ config, dataDir: path.join(tmpHome(), 'd'), logger, signal: abort.signal });
  t.after(() => rt.state.close());
  fake.script('POST', `/api/v1/orgs/${ORG}/revocations:query`, { status: 200, delayMs: 5000, json: { items: [], next_cursor: fakeCursor(0), has_more: false } });
  const started = Date.now();
  const run = rt.revocations.pull();
  setTimeout(() => abort.abort(), 100);
  assert.deepEqual(await run, { outcome: 'transient' });
  assert.ok(Date.now() - started < 2000);
});

test('SIGTERM right after start-up always exits cleanly and releases the lock', async () => {
  for (let i = 0; i < 5; i++) {
    const dataDir = path.join(tmpHome(), 'd');
    writeConfig({ ...VALID_ENV, COCO_BFF_URL: 'https://127.0.0.1:9/' }, dataDir);
    const child = spawn(process.execPath, [path.join(ROOT, 'src/main.js')], { env: baseEnv(dataDir) });
    let stdout = '';
    const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
    await new Promise((resolve) => {
      child.stdout.on('data', (d) => {
        stdout += d;
        if (stdout.includes('starting')) resolve();
      });
    });
    child.kill('SIGTERM');
    assert.deepEqual(await exited, { code: 0, signal: null });
    assert.equal(fs.existsSync(path.join(dataDir, 'state', 'lock')), false);
  }
});

test('SIGTERM during an in-flight pull aborts it and exits promptly', async (t) => {
  const fake = await startFakeMarket({ apiKey: FAKE_KEY, memberId: VALID_ENV.COCO_MEMBER_ID });
  t.after(fake.close);
  fake.script('POST', `/api/v1/orgs/${VALID_ENV.COCO_ORG_ID}/revocations:query`,
    { status: 200, delayMs: 8000, json: { items: [], next_cursor: fakeCursor(0), has_more: false } });
  const dataDir = path.join(tmpHome(), 'd');
  writeConfig({ ...VALID_ENV, COCO_BFF_URL: fake.url }, dataDir);
  const child = spawn(process.execPath, [path.join(ROOT, 'src/main.js')], { env: baseEnv(dataDir), stdio: 'ignore' });
  t.after(() => child.kill('SIGKILL'));
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  const deadline = Date.now() + 5000;
  while (!fake.market().some((r) => r.path.endsWith('/revocations:query'))) {
    assert.ok(Date.now() < deadline, 'pull started');
    await new Promise((r) => setTimeout(r, 20));
  }
  const sent = Date.now();
  child.kill('SIGTERM');
  assert.deepEqual(await exited, { code: 0, signal: null });
  assert.ok(Date.now() - sent < 2000, 'in-flight pull aborted, not awaited');
  assert.equal(fs.existsSync(path.join(dataDir, 'state', 'lock')), false);
});
