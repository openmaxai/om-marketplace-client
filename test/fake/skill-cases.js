import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { skillPackage } from './package.js';
import { problem, skillHarness } from './skills.js';

// Shared by the skills*.test.js files.

export const v2 = () => skillPackage('demo-skill', { 'docs/guide.md': 'guide v2\n' });
export const v3 = () => skillPackage('demo-skill', { 'docs/guide.md': 'guide v3\n' });
export const f503 = problem(503, 'DEPENDENCY_UNAVAILABLE');
export const c02s = (h) => h.sent('/install-requests');
export const queueOf = (h) => h.state.read('intents', null).queue;
export const qdir = (h) => path.join(h.dataDir, 'quarantine', 'market--demo-skill');
// version_no of each quarantined copy, by subdirectory name.
export const quarantined = (h) => {
  let names = [];
  try { names = fs.readdirSync(qdir(h)).sort(); } catch { /* none */ }
  return Object.fromEntries(names.map((n) => [n, h.marker(path.join(qdir(h), n))?.version_no]));
};
export const alerts = (h) => Object.values(h.state.read('status', { alerts: {} }).alerts).map((a) => a.message).join('\n');

export const downloads = (h) => h.fake.requests.filter((r) => r.path.includes('/packages/')).length + h.storage.requests.length;
export const failure = (code, message) => ({ status: 'failed', error_code: code, error_message: message });

export async function installed(t, opts) {
  const h = await skillHarness(t, opts);
  const s = h.make();
  await h.queue(['install', 1]);
  assert.deepEqual(await s.runRound(), ['succeeded']);
  return { h, s };
}
