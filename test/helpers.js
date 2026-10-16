import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const FAKE_KEY = 'cwsk_TEST_SECRET_6f1c2a9e0b7d4e33'; // gitleaks:allow (fake test fixture)

export const VALID_ENV = Object.freeze({
  COCO_BFF_URL: 'https://bff.example.test/',
  COCO_API_KEY: FAKE_KEY,
  COCO_ORG_ID: '0b6f4f3e-1111-4c2a-9d1e-aaaaaaaaaaaa',
  COCO_MEMBER_ID: '7d3e2c1b-2222-4b3a-8c2d-bbbbbbbbbbbb',
  COCO_IDENTITY_ID: '9a8b7c6d-3333-4d4e-bf5a-cccccccccccc',
});

const tmpDirs = [];
process.on('exit', () => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

export function tmpHome() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'om-mc-test-'));
  tmpDirs.push(d);
  return d;
}

// Minimal env so the developer's own COCO_* vars never leak into tests.
export function baseEnv(dataDir) {
  return { PATH: process.env.PATH, HOME: path.dirname(dataDir), OM_MARKETPLACE_CLIENT_HOME: dataDir };
}

export function runHook(hook, { env, input } = {}) {
  return spawnSync(process.execPath, [path.join(ROOT, 'hooks', hook)], {
    env,
    input: input ?? '',
    encoding: 'utf8',
  });
}

export function mode(p) {
  return fs.statSync(p).mode & 0o777;
}
