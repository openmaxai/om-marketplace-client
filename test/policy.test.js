import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildZip } from './fake/zip.js';
import { PackageError } from '../src/pkg/zip.js';
import { inspectPackage } from '../src/pkg/hygiene.js';
import {
  BUILTIN_PLACEHOLDERS, GENERIC_PLACEHOLDER, MAX_SKILL_LINE_BYTES, SkillPolicyError, checkSkillPolicy, deleteBuiltin, deleteGeneric, loadPolicy,
} from '../src/pkg/policy.js';

const rules = loadPolicy();
const fileBytes = (f) => (f.content_base64 !== undefined ? Buffer.from(f.content_base64, 'base64') : Buffer.from(f.content));
const vectorFiles = (v) => v.files.map((f) => ({ path: f.path, content: fileBytes(f) }));

// Vector notation of a result, as the market's conformance test builds it.
export function outcome(fn) {
  try {
    fn();
    return { result: 'ok' };
  } catch (err) {
    if (err instanceof SkillPolicyError) {
      return { result: 'violations', violations: err.violations, ...(err.truncated ? { truncated: true } : {}) };
    }
    if (err instanceof PackageError && (err.reason === 'skill_md_invalid' || err.reason === 'forbidden_path')) {
      return { result: err.reason, file: err.file };
    }
    throw err;
  }
}

test('the policy file carries all 139 vectors', () => {
  assert.equal(rules.vectors.length, 139);
});

for (const v of rules.vectors) {
  test(`policy vector: ${v.name}`, () => {
    assert.deepEqual(outcome(() => checkSkillPolicy(vectorFiles(v), rules)), v.expect);
  });
  test(`policy vector through the package check: ${v.name}`, () => {
    const zip = buildZip(vectorFiles(v).map((f) => ({ name: f.path, data: f.content, deflate: true })));
    let meta;
    assert.deepEqual(outcome(() => ({ meta } = inspectPackage(zip))), v.expect);
    if (v.expect.result === 'ok') assert.equal(meta.name, 'demo-skill');
  });
}

const skill = (fm, body = '') => ({ path: 'SKILL.md', content: Buffer.from(`---\nname: demo\ndescription: d\n${fm}---\n${body}`) });
const reasonOf = (files) => outcome(() => checkSkillPolicy(files, rules));

test('line length cap counts bytes, CR included', () => {
  const at = (n, tail = '') => [skill(''), { path: 'a.md', content: Buffer.from(`x\n${'é'.repeat(n / 2)}${tail}\ny`) }];
  assert.deepEqual(reasonOf(at(MAX_SKILL_LINE_BYTES)), { result: 'ok' });
  assert.deepEqual(reasonOf(at(MAX_SKILL_LINE_BYTES - 2, 'xy\r')), { result: 'skill_md_invalid', file: 'a.md' });
});

test('argument names are capped across all SKILL.md files', () => {
  const names = (from, n) => `arguments: [${Array.from({ length: n }, (_, i) => `a${from + i}`).join(', ')}]\n`;
  const pkg = (n) => [skill(names(0, 40)), { ...skill(names(40, n - 40)), path: 'x/SKILL.md' }];
  assert.deepEqual(reasonOf(pkg(64)), { result: 'ok' });
  assert.deepEqual(reasonOf(pkg(65)), { result: 'skill_md_invalid', file: 'x/SKILL.md' });
});

test('a nested SKILL.md over 256 KiB is invalid', () => {
  assert.deepEqual(reasonOf([skill(''), { ...skill('', 'x'.repeat(256 << 10)), path: 'x/SKILL.md' }]),
    { result: 'skill_md_invalid', file: 'x/SKILL.md' });
});

test('violations are ordered by file path bytes, not UTF-16 code units', () => {
  const hit = (path, body) => ({ path, content: Buffer.from(body) });
  assert.deepEqual(reasonOf([skill(''), hit('\u{1F600}.md', 'y\n!`x`\n'), hit('\uff5e.md', '!`x`\n')]), {
    result: 'violations',
    violations: [
      { code: 'SKILL_COMMAND_INJECTION', file: '\uff5e.md', line: 1 },
      { code: 'SKILL_COMMAND_INJECTION', file: '\u{1F600}.md', line: 2 },
    ],
  });
});

// Reference: the pattern applied until the line stops changing.
function deleteGenericReference(line) {
  for (;;) {
    const next = line.replace(GENERIC_PLACEHOLDER, '');
    if (next === line) return line;
    line = next;
  }
}

test('generic placeholder deletion matches the repeated regex', () => {
  const alphabet = ['$', '$', '{', '}', '[', ']', '1', '0', 'A', 'ARGUMENTS', 'a', '_', '-', '!', '`', ' ', 'é'];
  let seed = 7;
  const rand = (n) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };
  for (let k = 0; k < 20000; k++) {
    let s = '';
    for (let i = rand(24); i > 0; i--) s += alphabet[rand(alphabet.length)];
    assert.equal(deleteGeneric(s), deleteGenericReference(s), JSON.stringify(s));
  }
});

test('builtin placeholder deletion matches the regexes in order', () => {
  const alphabet = ['$', '$', '[', ']', '1', '0', 'A', 'ARGUMENTS', '$ARGUMENTS[', 'a', '!', '`', 'é'];
  let seed = 11;
  const rand = (n) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };
  for (let k = 0; k < 20000; k++) {
    let s = '';
    for (let i = rand(16); i > 0; i--) s += alphabet[rand(alphabet.length)];
    assert.equal(deleteBuiltin(s), BUILTIN_PLACEHOLDERS.reduce((t, re) => t.replace(re, ''), s), JSON.stringify(s));
  }
});

test('argument names are deleted per line across batches, with line numbers kept', () => {
  // ``$$bca`! hits only after deleting $bc and then $a; the generic deletion leaves ``$`!.
  const fm = 'arguments: [a, bc]\n';
  const filler = 'x\n```x$a\n!$\n'.repeat(40000);
  const tail = '``$$bca`!\n``$$bc`!\n``$$bca`!';
  const lines = filler.split('\n').length - 1;
  assert.deepEqual(reasonOf([skill(fm), { path: 'a.md', content: Buffer.from(`${filler}${tail}`) }]), {
    result: 'violations',
    violations: Array.from({ length: 50 }, (_, i) => ({ code: 'SKILL_COMMAND_INJECTION', file: 'a.md', line: 3 + 3 * i })),
    truncated: true,
  });
  assert.deepEqual(reasonOf([skill(fm), { path: 'a.md', content: Buffer.from(`${filler.replaceAll('!$\n', 'y\n')}${tail}`) }]), {
    result: 'violations',
    violations: [lines + 1, lines + 3].map((line) => ({ code: 'SKILL_COMMAND_INJECTION', file: 'a.md', line })),
  });
});

test('generic placeholder deletion is linear on nested layers', () => {
  const k = 200000;
  const line = `${'$'.repeat(k)}1${'{}'.repeat(k)}!\``;
  const t = process.hrtime.bigint();
  assert.ok(deleteGeneric(line) === '{}!`');
  assert.ok(process.hrtime.bigint() - t < 2_000_000_000n);
});
