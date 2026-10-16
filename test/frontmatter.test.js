import { test } from 'node:test';
import assert from 'node:assert/strict';
import { frontmatterCases } from './fixtures/frontmatter.js';
import { PackageError } from '../src/pkg/zip.js';
import { MAX_SKILL_MD_BYTES, frontmatterKeys, parseSkillMD } from '../src/pkg/frontmatter.js';
import { loadPolicy } from '../src/pkg/policy.js';

const parse = (text) => {
  try {
    return parseSkillMD(Buffer.from(text));
  } catch (err) {
    assert.ok(err instanceof PackageError && err.reason === 'skill_md_invalid', String(err));
    return null;
  }
};

for (const [name, [text, want]] of Object.entries(frontmatterCases)) {
  test(`SKILL.md frontmatter: ${name}`, () => assert.deepEqual(parse(text), want));
}

test('SKILL.md over 256 KiB or not UTF-8 is invalid', () => {
  const head = '---\nname: demo\ndescription: d\n---\n';
  assert.ok(parse(head + 'x'.repeat(MAX_SKILL_MD_BYTES - head.length)));
  assert.equal(parse(head + 'x'.repeat(MAX_SKILL_MD_BYTES - head.length + 1)), null);
  assert.throws(() => parseSkillMD(Buffer.from([...Buffer.from(head), 0xff])), PackageError);
});

test('policy key scan reports keys with line numbers and argument names', () => {
  const { args } = loadPolicy();
  const text = '---\nname: x\narguments:\n  - who\n  - what\nmetadata: |\n  a: *b\nHooks: x\n---\n';
  assert.deepEqual(frontmatterKeys(text, args), {
    keys: [{ key: 'name', line: 2 }, { key: 'arguments', line: 3 }, { key: 'metadata', line: 6 }, { key: 'Hooks', line: 8 }],
    names: ['who', 'what'],
  });
  for (const bad of ['arguments:\n  - who\n   - what\n', 'arguments: [a, ]\n', 'arguments: "a"\n', 'x:\n  - &a b\n', 'x: y\n  z\n']) {
    assert.throws(() => frontmatterKeys(`---\n${bad}---\n`, args), Error, bad);
  }
});
