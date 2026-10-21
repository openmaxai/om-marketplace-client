import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');

test('package.json, SKILL.md and CHANGELOG.md carry the same version', () => {
  const version = JSON.parse(read('package.json')).version;
  assert.equal(read('SKILL.md').match(/^version:\s*(\S+)\s*$/m)?.[1], version);
  assert.match(read('CHANGELOG.md'), new RegExp(`^## \\[${version.replaceAll('.', '\\.')}\\] - \\d{4}-\\d{2}-\\d{2}$`, 'm'));
});
