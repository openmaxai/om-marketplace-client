import fs from 'node:fs';
import path from 'node:path';
import { ROOT, tmpHome } from '../helpers.js';

// What the zylos hook sync writes for the four slot shards into the hook file of `runtime`.
export function writeSlotHooks(z, { runtime = 'claude', slots = [1, 2, 3, 4] } = {}) {
  const file = runtime === 'codex' ? path.join(z, '.codex', 'hooks.json') : path.join(z, '.claude', 'settings.json');
  const orchestrator = `node ${path.join(z, '.claude', 'skills', 'activity-monitor', 'scripts', 'session-start-orchestrator.js')}`;
  const hooks = ['identity', ...slots.map((n) => `market-template-${n}`)].map((name) => ({ type: 'command', command: `${orchestrator} --shard ${name}`, timeout: 20000 }));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ hooks: { SessionStart: [{ matcher: 'startup', hooks }] } }));
}

// A zylos dir with the shard registry and the client installed (as a link) under .claude/skills; with `hooks`, the
// slot hooks are in settings.json as after a hook sync.
export function fakeZylos({ installed = true, registry = true, hooks = false } = {}) {
  const z = path.join(tmpHome(), 'zylos');
  const skills = path.join(z, '.claude', 'skills');
  fs.mkdirSync(path.join(skills, 'activity-monitor', 'scripts'), { recursive: true });
  if (registry) fs.writeFileSync(path.join(skills, 'activity-monitor', 'scripts', 'shard-registry.js'), '');
  if (installed) fs.symlinkSync(ROOT, path.join(skills, 'om-marketplace-client'));
  if (hooks) writeSlotHooks(z);
  return z;
}
