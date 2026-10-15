import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { FAKE_KEY, ROOT, VALID_ENV, baseEnv, runHook, tmpHome } from './helpers.js';
import { EXIT_CONFIG, writeConfig } from '../src/config.js';
import fs from 'node:fs';

function assertNoKey(r, label) {
  assert.ok(!r.stdout.includes(FAKE_KEY), `${label}: key in stdout`);
  assert.ok(!r.stderr.includes(FAKE_KEY), `${label}: key in stderr`);
}

const cases = [
  ['success', { ...VALID_ENV }],
  ['missing org/member', { COCO_BFF_URL: VALID_ENV.COCO_BFF_URL, COCO_API_KEY: FAKE_KEY }],
  ['invalid url', { ...VALID_ENV, COCO_BFF_URL: 'http://bff.example.test' }],
  ['url with key-like path', { ...VALID_ENV, COCO_BFF_URL: `https://bff.example.test/${FAKE_KEY}` }],
  ['bad member id', { ...VALID_ENV, COCO_MEMBER_ID: 'has space' }],
];

for (const [label, env] of cases) {
  test(`post-install never prints the API key (${label})`, () => {
    const dataDir = path.join(tmpHome(), 'd');
    const r = runHook('post-install.js', { env: { ...baseEnv(dataDir), ...env } });
    assertNoKey(r, label);
  });
}

test('configure hook never prints the API key, including malformed JSON', () => {
  const dataDir = path.join(tmpHome(), 'd');
  const ok = runHook('configure.js', { env: baseEnv(dataDir), input: JSON.stringify(VALID_ENV) });
  assert.equal(ok.status, 0);
  assertNoKey(ok, 'configure ok');
  const bad = runHook('configure.js', { env: baseEnv(dataDir), input: `{"COCO_API_KEY": "${FAKE_KEY}"` });
  assert.equal(bad.status, EXIT_CONFIG);
  assertNoKey(bad, 'configure malformed');
});

test('runtime never prints the API key on start, shutdown, or config rejection', async () => {
  const dataDir = path.join(tmpHome(), 'd');
  writeConfig({ ...VALID_ENV }, dataDir);
  fs.writeFileSync(path.join(dataDir, 'config.json'),
    JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8')), log_level: 'debug' }), { mode: 0o600 });

  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, [path.join(ROOT, 'src/main.js')], { env: baseEnv(dataDir) });
  let stdout = '', stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  await new Promise((resolve) => {
    const check = setInterval(() => { if (stdout.includes('reconcile')) { clearInterval(check); resolve(); } }, 20);
  });
  child.kill('SIGTERM');
  const code = await new Promise((resolve) => child.on('exit', resolve));
  assert.equal(code, 0);
  assert.match(stdout, /SIGTERM received/);
  assertNoKey({ stdout, stderr }, 'runtime');

  fs.chmodSync(path.join(dataDir, 'config.json'), 0o644);
  const rejected = spawnSync(process.execPath, [path.join(ROOT, 'src/main.js')], { env: baseEnv(dataDir), encoding: 'utf8' });
  assert.equal(rejected.status, EXIT_CONFIG);
  assertNoKey(rejected, 'runtime rejected');
});

test('runtime warns about inherited COCO_* variables by name only and removes them', async () => {
  const dataDir = path.join(tmpHome(), 'd');
  writeConfig({ ...VALID_ENV }, dataDir);
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, [path.join(ROOT, 'src/main.js')], {
    env: { ...baseEnv(dataDir), ...VALID_ENV },
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  await new Promise((resolve) => {
    const check = setInterval(() => { if (stdout.includes('starting')) { clearInterval(check); resolve(); } }, 20);
  });
  child.kill('SIGTERM');
  assert.equal(await new Promise((resolve) => child.on('exit', resolve)), 0);
  assert.match(stderr, /\[warn\].*COCO_API_KEY/);
  for (const name of Object.keys(VALID_ENV)) assert.ok(stderr.includes(name), name);
  for (const value of Object.values(VALID_ENV)) assert.ok(!stderr.includes(value), 'value in warning');
  assertNoKey({ stdout, stderr }, 'runtime env scrub');
});

test('scrubInstallEnv deletes COCO_* names and returns only names', async () => {
  const { scrubInstallEnv } = await import('../src/app.js');
  const warns = [];
  const env = { COCO_API_KEY: FAKE_KEY, COCO_ORG_ID: 'o', PATH: '/bin' };
  const names = scrubInstallEnv(env, { warn: (m) => warns.push(m) });
  assert.deepEqual(names, ['COCO_API_KEY', 'COCO_ORG_ID']);
  assert.deepEqual(env, { PATH: '/bin' });
  assert.ok(!warns.join('').includes(FAKE_KEY));
});

test('runtime exits with EX_CONFIG when config.json is missing', () => {
  const dataDir = path.join(tmpHome(), 'missing');
  const r = spawnSync(process.execPath, [path.join(ROOT, 'src/main.js')], { env: baseEnv(dataDir), encoding: 'utf8' });
  assert.equal(r.status, EXIT_CONFIG);
  assert.match(r.stderr, /config not found/);
});
