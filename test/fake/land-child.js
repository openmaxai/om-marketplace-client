import path from 'node:path';
import { landSkill } from '../../src/land.js';
import { inspectPackage } from '../../src/pkg/hygiene.js';
import { skillPackage } from './package.js';
import { U } from './pull.js';

// Lands demo-skill under the home directory named by OM_MC_LAND_CHILD and prints the outcome as JSON, so a test can
// bound a synchronous open that blocks. Inert when node --test loads it as a test file.
const home = process.env.OM_MC_LAND_CHILD;
if (home) {
  const pkg = skillPackage();
  let out;
  try {
    landSkill({
      skillsDir: path.join(home, 'skills'), stagingRoot: path.join(home, 'data', 'staging'), rollbackRoot: path.join(home, 'data', 'rollback'),
      requestId: U(9), inspected: inspectPackage(pkg.zip),
      install: { slug: 'demo-skill', skill_id: U(1), version_no: 1, package_sha256: pkg.sha, file_manifest: pkg.manifest },
    });
    out = { landed: true };
  } catch (err) {
    out = { code: err.code, reason: err.reason };
  }
  process.stdout.write(JSON.stringify(out));
}
