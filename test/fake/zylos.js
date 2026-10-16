import fs from 'node:fs';
import path from 'node:path';
import { ROOT, tmpHome } from '../helpers.js';

// A zylos dir with the shard registry and the client installed (as a link) under .claude/skills.
export function fakeZylos({ installed = true, registry = true } = {}) {
  const z = path.join(tmpHome(), 'zylos');
  const skills = path.join(z, '.claude', 'skills');
  fs.mkdirSync(path.join(skills, 'activity-monitor', 'scripts'), { recursive: true });
  if (registry) fs.writeFileSync(path.join(skills, 'activity-monitor', 'scripts', 'shard-registry.js'), '');
  if (installed) fs.symlinkSync(ROOT, path.join(skills, 'om-marketplace-client'));
  return z;
}
