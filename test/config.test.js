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
