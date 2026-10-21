import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { FAKE_KEY, VALID_ENV, runHook, tmpHome } from './helpers.js';
import { EXIT_CONFIG, writeConfig } from '../src/config.js';
import { runInstall } from '../hooks/lib/install.js';

const OM_KEY = 'cwsk_TEST_OPENMAX_4d2e9a7c1b3f5e60'; // gitleaks:allow (fake test fixture)
const OM_SECRET = 'cf_TEST_SECRET_0a1b2c3d4e5f6a7b'; // gitleaks:allow (fake test fixture)
const ORG_A = '0b6f4f3e-aaaa-4c2a-9d1e-000000000001';
const ORG_B = '0b6f4f3e-bbbb-4c2a-9d1e-000000000002';
const ORG_C = '0b6f4f3e-cccc-4c2a-9d1e-000000000003';
const MEM = (n) => `7d3e2c1b-0000-4b3a-8c2d-00000000000${n}`;

const org = (orgId, member, extra = {}) => ({
  enabled: true, org_id: orgId, org_name: 'Org', self: { member_id: member, name: 'agent' }, owner: { member_id: 'owner-1' }, access: {}, ...extra,
});

function openmaxConfig(overrides = {}) {
  return {
    server: { bff_url: 'https://om-bff.example.test', ws_url: 'wss://om-ws.example.test', frontend_base_path: '/app' },
    cf_access: { client_id: 'cf-id.access', client_secret: OM_SECRET },
    agent: { identity_id: '9a8b7c6d-0000-4d4e-bf5a-000000000009', api_key: OM_KEY, device_id: 'dev-1' },
    orgs: { [ORG_A]: org(ORG_A, MEM(1)) },
    ...overrides,
  };
}

// A fake home with ~/zylos/components/openmax/config.json (raw string or object; null = no file).
function setup(om = openmaxConfig(), { zylosDir } = {}) {
  const home = tmpHome();
  const zylos = zylosDir ?? path.join(home, 'zylos');
  const dataDir = path.join(home, 'data', 'om-marketplace-client');
  if (om !== null) {
    const dir = path.join(zylos, 'components', 'openmax');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'config.json'), typeof om === 'string' ? om : JSON.stringify(om), { mode: 0o600 });
  }
  return { home, zylos, dataDir, omFile: path.join(zylos, 'components', 'openmax', 'config.json') };
}

const envFor = ({ home, dataDir }, extra = {}) => ({ PATH: process.env.PATH, HOME: home, OM_MARKETPLACE_CLIENT_HOME: dataDir, ...extra });
const readCfg = (dataDir) => JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));

function assertNoSecrets(r, dataDir, label) {
  for (const secret of [FAKE_KEY, OM_KEY, OM_SECRET]) {
    assert.ok(!r.stdout.includes(secret), `${label}: secret in stdout`);
    assert.ok(!r.stderr.includes(secret), `${label}: secret in stderr`);
  }
  const logs = path.join(dataDir, 'logs');
  for (const f of fs.existsSync(logs) ? fs.readdirSync(logs) : []) {
    const text = fs.readFileSync(path.join(logs, f), 'utf8');
    assert.ok(!text.includes(OM_KEY) && !text.includes(FAKE_KEY), `${label}: secret in logs/${f}`);
  }
}

function install(ctx, extraEnv) {
  const r = runHook('post-install.js', { env: envFor(ctx, extraEnv) });
  assertNoSecrets(r, ctx.dataDir, JSON.stringify(Object.keys(extraEnv ?? {})));
  return r;
}

test('env only: a complete env set wins and the openmax config is not consulted', () => {
  const ctx = setup(openmaxConfig({ orgs: { [ORG_A]: org(ORG_A, MEM(1)), [ORG_B]: org(ORG_B, MEM(2)) } }));
  const r = install(ctx, VALID_ENV);
  assert.equal(r.status, 0, r.stderr);
  const cfg = readCfg(ctx.dataDir);
  assert.equal(cfg.bff_url, 'https://bff.example.test');
  assert.equal(cfg.api_key, FAKE_KEY);
  assert.equal(cfg.org_id, VALID_ENV.COCO_ORG_ID);
  assert.equal(cfg.orgs, undefined);
  assert.doesNotMatch(r.stdout, /openmax/);
  assert.match(r.stdout, /COCO_API_KEY: from environment/);
});

test('openmax only, single org: every field is derived and its source logged by name', () => {
  const ctx = setup();
  const r = install(ctx);
  assert.equal(r.status, 0, r.stderr);
  const cfg = readCfg(ctx.dataDir);
  assert.equal(cfg.bff_url, 'https://om-bff.example.test');
  assert.equal(cfg.api_key, OM_KEY);
  assert.equal(cfg.org_id, ORG_A);
  assert.equal(cfg.member_id, MEM(1));
  assert.equal(cfg.identity_id, '9a8b7c6d-0000-4d4e-bf5a-000000000009');
  assert.equal(cfg.orgs, undefined);
  assert.equal(Object.keys(cfg).some((k) => /cf_access/.test(k)), false);
  assert.equal(fs.statSync(path.join(ctx.dataDir, 'config.json')).mode & 0o777, 0o600);
  assert.match(r.stdout, /COCO_API_KEY: from openmax component config \(agent\.api_key\)/);
  assert.match(r.stdout, new RegExp(`COCO_MEMBER_ID: from openmax component config \\(orgs\\.${ORG_A}\\.self\\.member_id\\)`));
});

test('openmax with several orgs: first enabled org by id is primary, the others go into orgs; disabled ones are skipped', () => {
  const ctx = setup(openmaxConfig({
    orgs: {
      [ORG_C]: org(ORG_C, MEM(3)),
      [ORG_B]: org(ORG_B, MEM(2), { enabled: false }),
      [ORG_A]: (({ enabled, ...rest }) => rest)(org(ORG_A, MEM(1))),
    },
  }));
  const r = install(ctx);
  assert.equal(r.status, 0, r.stderr);
  const cfg = readCfg(ctx.dataDir);
  assert.equal(cfg.org_id, ORG_A);
  assert.equal(cfg.member_id, MEM(1));
  assert.deepEqual(cfg.orgs, { [ORG_C]: { member_id: MEM(3) } });
});

test('openmax with several orgs: the org matching COCO_ORG_ID is primary', () => {
  const ctx = setup(openmaxConfig({ orgs: { [ORG_A]: org(ORG_A, MEM(1)), [ORG_B]: org(ORG_B, MEM(2)), [ORG_C]: org(ORG_C, MEM(3)) } }));
  const r = install(ctx, { COCO_ORG_ID: ORG_B });
  assert.equal(r.status, 0, r.stderr);
  const cfg = readCfg(ctx.dataDir);
  assert.equal(cfg.org_id, ORG_B);
  assert.equal(cfg.member_id, MEM(2));
  assert.deepEqual(cfg.orgs, { [ORG_A]: { member_id: MEM(1) }, [ORG_C]: { member_id: MEM(3) } });
  assert.match(r.stdout, /COCO_ORG_ID: from environment/);
});

test('mixed precedence: env fields win per field, openmax fills the rest', () => {
  const ctx = setup();
  const r = install(ctx, { COCO_BFF_URL: VALID_ENV.COCO_BFF_URL, COCO_API_KEY: FAKE_KEY });
  assert.equal(r.status, 0, r.stderr);
  const cfg = readCfg(ctx.dataDir);
  assert.equal(cfg.bff_url, 'https://bff.example.test');
  assert.equal(cfg.api_key, FAKE_KEY);
  assert.equal(cfg.org_id, ORG_A);
  assert.equal(cfg.member_id, MEM(1));
  assert.match(r.stdout, /COCO_BFF_URL: from environment/);
  assert.match(r.stdout, /COCO_ORG_ID: from openmax component config/);
});

test('re-run keeps existing orgs entries, which win over derived ones', () => {
  const ctx = setup(openmaxConfig({ orgs: { [ORG_A]: org(ORG_A, MEM(1)), [ORG_B]: org(ORG_B, MEM(2)) } }));
  writeConfig({ ...VALID_ENV, COCO_ORG_ID: ORG_A, COCO_MEMBER_ID: MEM(1) }, ctx.dataDir);
  const file = path.join(ctx.dataDir, 'config.json');
  const hand = { ...readCfg(ctx.dataDir), orgs: { [ORG_B]: { member_id: null }, 'extra-org': { member_id: 'm-9' } } };
  fs.writeFileSync(file, JSON.stringify(hand), { mode: 0o600 });
  const r = install(ctx, { COCO_ORG_ID: ORG_A });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(readCfg(ctx.dataDir).orgs, { [ORG_B]: { member_id: null }, 'extra-org': { member_id: 'm-9' } });
});

test('only disabled orgs: exit 78 naming the missing settings and the openmax config', () => {
  const ctx = setup(openmaxConfig({ orgs: { [ORG_A]: org(ORG_A, MEM(1), { enabled: false }) } }));
  const r = install(ctx);
  assert.equal(r.status, EXIT_CONFIG);
  assert.match(r.stderr, /missing required settings: COCO_ORG_ID, COCO_MEMBER_ID/);
  assert.ok(r.stderr.includes(ctx.omFile));
  assert.match(r.stderr, /no enabled org/);
  assert.equal(fs.existsSync(path.join(ctx.dataDir, 'config.json')), false);
});

test('COCO_ORG_ID not among the enabled openmax orgs: member id cannot be derived', () => {
  const ctx = setup();
  const r = install(ctx, { COCO_ORG_ID: ORG_C });
  assert.equal(r.status, EXIT_CONFIG);
  assert.match(r.stderr, /missing required settings: COCO_MEMBER_ID/);
  assert.match(r.stderr, /COCO_ORG_ID is not one of its enabled orgs/);
});

for (const [label, om, reason] of [
  ['missing', null, /not found/],
  ['malformed', `{"agent": {"api_key": "${OM_KEY}"`, /not valid JSON/],
  ['not an object', '[1,2]', /not a JSON object/],
]) {
  test(`openmax config ${label}: exit 78 with every missing name and the reason`, () => {
    const ctx = setup(om);
    const r = install(ctx);
    assert.equal(r.status, EXIT_CONFIG);
    assert.match(r.stderr, /missing required settings: COCO_BFF_URL, COCO_API_KEY, COCO_ORG_ID, COCO_MEMBER_ID/);
    assert.match(r.stderr, /openmax component config/);
    assert.ok(r.stderr.includes(ctx.omFile));
    assert.match(r.stderr, reason);
  });
}

test('openmax config unreadable: exit 78 with the reason', { skip: process.getuid?.() === 0 && 'root reads any file' }, () => {
  const ctx = setup();
  fs.chmodSync(ctx.omFile, 0o000);
  const r = install(ctx);
  assert.equal(r.status, EXIT_CONFIG);
  assert.match(r.stderr, /not readable \(EACCES\)/);
});

test('openmax config symlinked outside the home directory is refused', () => {
  const ctx = setup(null);
  const outside = tmpHome();
  fs.writeFileSync(path.join(outside, 'config.json'), JSON.stringify(openmaxConfig()), { mode: 0o600 });
  fs.mkdirSync(path.dirname(ctx.omFile), { recursive: true });
  fs.symlinkSync(path.join(outside, 'config.json'), ctx.omFile);
  const r = install(ctx);
  assert.equal(r.status, EXIT_CONFIG);
  assert.match(r.stderr, /resolves outside the home directory/);
});

for (const [label, url, why] of [
  ['with a path', 'https://om-bff.example.test/bff', /must not contain a path/],
  ['over http', 'http://om-bff.example.test', /must use https/],
  ['not a URL', 'not a url', /not a valid URL/],
]) {
  test(`openmax bff_url ${label}: exit 78 naming the openmax field`, () => {
    const ctx = setup(openmaxConfig({ server: { bff_url: url } }));
    const r = install(ctx);
    assert.equal(r.status, EXIT_CONFIG);
    assert.match(r.stderr, why);
    assert.match(r.stderr, /openmax component config field server\.bff_url/);
    assert.equal(fs.existsSync(path.join(ctx.dataDir, 'config.json')), false);
  });
}

test('ZYLOS_DIR relocates the openmax config lookup', () => {
  const ctx = setup(openmaxConfig(), { zylosDir: path.join(tmpHome(), 'zy') });
  const r = install(ctx, { ZYLOS_DIR: ctx.zylos });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readCfg(ctx.dataDir).org_id, ORG_A);
});

test('interactive: openmax values are used and only what is still missing is prompted', async () => {
  const ctx = setup(openmaxConfig({ orgs: {} }));
  const asked = [];
  const out = [];
  const code = await runInstall({
    env: { HOME: ctx.home },
    isTTY: true,
    dataDir: ctx.dataDir,
    zylosDir: ctx.zylos,
    ask: async (q) => {
      const name = q.match(/\[(COCO_[A-Z_]+)\]/)[1];
      asked.push(name);
      return { COCO_ORG_ID: ORG_B, COCO_MEMBER_ID: MEM(2) }[name];
    },
    log: (m) => out.push(m),
    error: (m) => out.push(m),
  });
  assert.equal(code, 0);
  assert.deepEqual(asked, ['COCO_ORG_ID', 'COCO_MEMBER_ID']);
  const cfg = readCfg(ctx.dataDir);
  assert.equal(cfg.api_key, OM_KEY);
  assert.equal(cfg.org_id, ORG_B);
  assert.ok(out.some((m) => m.includes('COCO_ORG_ID: from prompt')));
  assert.ok(!out.join('\n').includes(OM_KEY));
});
