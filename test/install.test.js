import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { FAKE_KEY, VALID_ENV, baseEnv, mode, runHook, tmpHome } from './helpers.js';
import { writeConfig, REQUIRED_ENV } from '../src/config.js';
import { runInstall } from '../hooks/lib/install.js';

function dataDirIn(home) {
  return path.join(home, 'components', 'om-marketplace-client');
}

test('post-install writes config.json from env with 0700 dir and 0600 file', () => {
  const dataDir = dataDirIn(tmpHome());
  const r = runHook('post-install.js', { env: { ...baseEnv(dataDir), ...VALID_ENV } });
  assert.equal(r.status, 0, r.stderr);
  const file = path.join(dataDir, 'config.json');
  assert.equal(mode(dataDir), 0o700);
  assert.equal(mode(file), 0o600);
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(cfg.bff_url, 'https://bff.example.test');
  assert.equal(cfg.api_key, FAKE_KEY);
  assert.equal(cfg.identity_id, VALID_ENV.COCO_IDENTITY_ID);
  assert.deepEqual(fs.readdirSync(dataDir).filter((f) => f.endsWith('.tmp')), []);
});

test('post-install tightens a pre-existing permissive data dir', () => {
  const dataDir = dataDirIn(tmpHome());
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o755 });
  fs.chmodSync(dataDir, 0o755);
  const r = runHook('post-install.js', { env: { ...baseEnv(dataDir), ...VALID_ENV } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(mode(dataDir), 0o700);
});

test('missing required vars: non-zero exit, lists every missing name, writes nothing', () => {
  const dataDir = dataDirIn(tmpHome());
  const env = { ...baseEnv(dataDir), COCO_BFF_URL: VALID_ENV.COCO_BFF_URL, COCO_API_KEY: FAKE_KEY };
  const r = runHook('post-install.js', { env });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /COCO_ORG_ID/);
  assert.match(r.stderr, /COCO_MEMBER_ID/);
  assert.doesNotMatch(r.stderr, /COCO_BFF_URL|COCO_API_KEY/);
  assert.equal(fs.existsSync(path.join(dataDir, 'config.json')), false);
});

test('no env at all lists all required names', () => {
  const dataDir = dataDirIn(tmpHome());
  const r = runHook('post-install.js', { env: baseEnv(dataDir) });
  assert.equal(r.status, 1);
  for (const name of REQUIRED_ENV) assert.match(r.stderr, new RegExp(name));
  assert.doesNotMatch(r.stderr, /COCO_IDENTITY_ID/);
});

test('identity id is optional', () => {
  const dataDir = dataDirIn(tmpHome());
  const { COCO_IDENTITY_ID, ...env } = VALID_ENV;
  const r = runHook('post-install.js', { env: { ...baseEnv(dataDir), ...env } });
  assert.equal(r.status, 0, r.stderr);
  const cfg = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
  assert.equal(cfg.identity_id, null);
});

test('env path and interactive path produce byte-identical config.json', async () => {
  const envDir = dataDirIn(tmpHome());
  const r = runHook('post-install.js', { env: { ...baseEnv(envDir), ...VALID_ENV } });
  assert.equal(r.status, 0, r.stderr);

  const directDir = dataDirIn(tmpHome());
  writeConfig({ ...VALID_ENV }, directDir);

  const qaDir = dataDirIn(tmpHome());
  const answers = { ...VALID_ENV };
  const asked = [];
  const code = await runInstall({
    env: { COCO_BFF_URL: VALID_ENV.COCO_BFF_URL },
    isTTY: true,
    dataDir: qaDir,
    ask: async (q, opts) => {
      const name = q.match(/\[(COCO_[A-Z_]+)\]/)[1];
      asked.push([name, opts.hidden]);
      return answers[name];
    },
    log: () => {},
    error: () => {},
  });
  assert.equal(code, 0);
  assert.deepEqual(asked.find(([n]) => n === 'COCO_API_KEY'), ['COCO_API_KEY', true]);

  const read = (d) => fs.readFileSync(path.join(d, 'config.json'));
  assert.ok(read(envDir).equals(read(directDir)));
  assert.ok(read(envDir).equals(read(qaDir)));
});

test('no TTY never prompts', async () => {
  const dataDir = dataDirIn(tmpHome());
  let prompted = false;
  const code = await runInstall({
    env: {}, isTTY: false, dataDir,
    ask: async () => { prompted = true; return 'x'; },
    log: () => {}, error: () => {},
  });
  assert.equal(code, 1);
  assert.equal(prompted, false);
});

test('rerun without any COCO_* vars keeps a valid existing config', () => {
  const dataDir = dataDirIn(tmpHome());
  writeConfig({ ...VALID_ENV }, dataDir);
  const before = fs.readFileSync(path.join(dataDir, 'config.json'));
  const r = runHook('post-install.js', { env: baseEnv(dataDir) });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.readFileSync(path.join(dataDir, 'config.json')).equals(before));
});

test('configure hook (stdin JSON) writes the same file as the env path', () => {
  const envDir = dataDirIn(tmpHome());
  assert.equal(runHook('post-install.js', { env: { ...baseEnv(envDir), ...VALID_ENV } }).status, 0);
  const cfgDir = dataDirIn(tmpHome());
  const r = runHook('configure.js', { env: baseEnv(cfgDir), input: JSON.stringify(VALID_ENV) });
  assert.equal(r.status, 0, r.stderr);
  const read = (d) => fs.readFileSync(path.join(d, 'config.json'));
  assert.ok(read(envDir).equals(read(cfgDir)));
});

test('pre-uninstall stub exits 0', () => {
  const dataDir = dataDirIn(tmpHome());
  assert.equal(runHook('pre-uninstall.js', { env: baseEnv(dataDir) }).status, 0);
});
