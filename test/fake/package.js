import crypto from 'node:crypto';
import { buildZip } from './zip.js';
import { inspectPackage } from '../../src/pkg/hygiene.js';

export const skillMd = (name, extra = '') => `---\nname: ${name}\ndescription: A test skill\n${extra}---\nUse it.\n`;

// A valid skill zip with its sha256, size and manifest as C-02 would describe it.
export function skillPackage(name = 'demo-skill', files = { 'docs/guide.md': 'guide\n' }) {
  const zip = buildZip([{ name: 'SKILL.md', data: skillMd(name), deflate: true },
    ...Object.entries(files).map(([n, data]) => ({ name: n, data, deflate: true }))]);
  return {
    zip,
    sha: crypto.createHash('sha256').update(zip).digest('hex'),
    size: zip.length,
    manifest: inspectPackage(zip).manifest,
  };
}
