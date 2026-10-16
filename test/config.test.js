import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { VALID_ENV, tmpHome } from './helpers.js';
import { ConfigError, loadConfig, normalizeBffUrl, resolveDataDir, writeConfig } from '../src/config.js';

test('valid BFF URLs are normalized', () => {
  assert.equal(normalizeBffUrl('https://bff.example.test'), 'https://bff.example.test');
  assert.equal(normalizeBffUrl('https://bff.example.test/'), 'https://bff.example.test');
  assert.equal(normalizeBffUrl('https://BFF.Example.test:8443/'), 'https://bff.example.test:8443');
  assert.equal(normalizeBffUrl('http://localhost:8080/'), 'http://localhost:8080');
  assert.equal(normalizeBffUrl('http://127.0.0.1:8080'), 'http://127.0.0.1:8080');
});

test('invalid BFF URLs are rejected', () => {
  for (const bad of [
    'not a url',
    '',
    'http://bff.example.test',
    'http://10.0.0.5:8080',
    'http://localhost.evil.test',
    'ftp://bff.example.test',
    'ws://localhost:8080',
    'https://bff.example.test/api',
    'https://bff.example.test/api/',
    'https://bff.example.test//',
    'https://bff.example.test/?x=1',
    'https://bff.example.test/#frag',
    'https://user:pass@bff.example.test',
  ]) {
    assert.throws(() => normalizeBffUrl(bad), ConfigError, bad);
  }
});

test('writeConfig rejects an invalid URL without creating config.json', () => {
  const dataDir = path.join(tmpHome(), 'd');
  assert.throws(() => writeConfig({ ...VALID_ENV, COCO_BFF_URL: 'http://bff.example.test' }, dataDir), ConfigError);
  assert.equal(fs.existsSync(path.join(dataDir, 'config.json')), false);
});

test('data dir override and default', () => {
  assert.equal(resolveDataDir({ OM_MARKETPLACE_CLIENT_HOME: '/tmp/x' }), '/tmp/x');
  assert.equal(resolveDataDir({ HOME: '/home/u' }), '/home/u/zylos/components/om-marketplace-client');
});

test('loadConfig accepts a 0600 file written by writeConfig', () => {
  const dataDir = path.join(tmpHome(), 'd');
  writeConfig({ ...VALID_ENV }, dataDir);
  const cfg = loadConfig(dataDir);
  assert.equal(cfg.org_id, VALID_ENV.COCO_ORG_ID);
  assert.equal(cfg.bff_url, 'https://bff.example.test');
});

test('loadConfig rejects group/other-readable files', () => {
  const dataDir = path.join(tmpHome(), 'd');
  writeConfig({ ...VALID_ENV }, dataDir);
  for (const m of [0o644, 0o640, 0o604, 0o660]) {
    fs.chmodSync(path.join(dataDir, 'config.json'), m);
    assert.throws(() => loadConfig(dataDir), /group\/other/, m.toString(8));
  }
});

test('loadConfig rejects missing file, bad JSON, missing fields, bad URL', () => {
  const dataDir = path.join(tmpHome(), 'd');
  assert.throws(() => loadConfig(dataDir), /not found/);
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'config.json');
  const put = (s) => { fs.writeFileSync(file, s, { mode: 0o600 }); fs.chmodSync(file, 0o600); };
  put('{nope');
  assert.throws(() => loadConfig(dataDir), /not valid JSON/);
  put(JSON.stringify({ schema_version: 1, bff_url: 'https://bff.example.test', org_id: 'o' }));
  assert.throws(() => loadConfig(dataDir), /api_key/);
  put(JSON.stringify({ schema_version: 1, bff_url: 'http://bff.example.test', org_id: 'o', member_id: 'm', api_key: 'k' }));
  assert.throws(() => loadConfig(dataDir), /https/);
  put(JSON.stringify({ schema_version: 2, bff_url: 'https://bff.example.test', org_id: 'o', member_id: 'm', api_key: 'k' }));
  assert.throws(() => loadConfig(dataDir), /schema_version/);
});

test('loadConfig rejects a symlinked config.json', () => {
  const dataDir = path.join(tmpHome(), 'd');
  const other = path.join(tmpHome(), 'o');
  writeConfig({ ...VALID_ENV }, other);
  fs.mkdirSync(dataDir, { mode: 0o700 });
  fs.symlinkSync(path.join(other, 'config.json'), path.join(dataDir, 'config.json'));
  assert.throws(() => loadConfig(dataDir), /symlink/);
});

test('loadConfig rejects a file owned by another uid', { skip: typeof process.getuid !== 'function' }, () => {
  const dataDir = path.join(tmpHome(), 'd');
  writeConfig({ ...VALID_ENV }, dataDir);
  assert.throws(() => loadConfig(dataDir, { uid: process.getuid() + 1 }), /not owned/);
  assert.ok(loadConfig(dataDir));
});

test('orgs map: the primary org is always present; other orgs keep their own member id', () => {
  const dataDir = path.join(tmpHome(), 'd');
  writeConfig({ ...VALID_ENV }, dataDir);
  const file = path.join(dataDir, 'config.json');
  const put = (orgs) => fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), orgs }));
  assert.deepEqual(loadConfig(dataDir).orgs, { [VALID_ENV.COCO_ORG_ID]: { member_id: VALID_ENV.COCO_MEMBER_ID } });
  put({ 'org-2': { member_id: 'm:2' }, 'org-3': {} });
  assert.deepEqual(loadConfig(dataDir).orgs, {
    [VALID_ENV.COCO_ORG_ID]: { member_id: VALID_ENV.COCO_MEMBER_ID }, 'org-2': { member_id: 'm:2' }, 'org-3': { member_id: null },
  });
  for (const bad of [[], { 'a/b': {} }, { __proto__: null, ['__proto__']: {} }, { o: { member_id: 'x y' } }, { o: { api_key: 'k' } },
    { o: 'm' }, { [VALID_ENV.COCO_ORG_ID]: { member_id: 'other' } }]) {
    put(bad);
    assert.throws(() => loadConfig(dataDir), ConfigError, JSON.stringify(bad));
  }
});

test('rewriting the config keeps the extra orgs and drops a stale primary entry', () => {
  const dataDir = path.join(tmpHome(), 'd');
  writeConfig({ ...VALID_ENV }, dataDir);
  const file = path.join(dataDir, 'config.json');
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...cfg, orgs: { 'org-2': {}, [VALID_ENV.COCO_ORG_ID]: { member_id: 'old' } } }));
  writeConfig({ ...VALID_ENV, COCO_API_KEY: 'rotated' }, dataDir);
  assert.deepEqual(Object.keys(loadConfig(dataDir).orgs), [VALID_ENV.COCO_ORG_ID, 'org-2']);
});
