import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { buildZip } from './fake/zip.js';
import { GOOD_SKILL_MD, hygieneFixtures } from './fixtures/hygiene.js';
import { PackageError } from '../src/pkg/zip.js';
import { canonSegment, checkEntryPath, hasForbiddenSegment } from '../src/pkg/paths.js';
import { checkPackageJSON, foldKey, inspectPackage, isMarkdownPath, isSkillMDPath } from '../src/pkg/hygiene.js';

const reasonOf = (fn) => {
  try {
    fn();
    return null;
  } catch (err) {
    assert.ok(err instanceof PackageError, String(err));
    return err.reason;
  }
};

for (const [name, zip, want] of hygieneFixtures()) {
  test(`hygiene: ${name} -> ${want ?? 'accepted'}`, () => {
    assert.equal(reasonOf(() => inspectPackage(zip)), want);
  });
}

test('an accepted package yields a byte-ordered manifest, the root SKILL.md and every .md file', () => {
  const run = 'echo hi\n';
  const z = buildZip([
    { name: 'scripts/' }, { name: 'scripts/run.sh', data: run, deflate: true }, { name: 'SKILL.md', data: GOOD_SKILL_MD },
    { name: '\u00e9.txt', data: 'e' }, { name: 'z.txt', data: 'z' }, { name: 'docs/Guide.MD', data: '# g' },
    { name: 'sub/skill.md', data: GOOD_SKILL_MD },
  ]);
  const { manifest, skillMD, markdown } = inspectPackage(z);
  assert.deepEqual(manifest.map((m) => m.path),
    ['SKILL.md', 'docs/Guide.MD', 'scripts/run.sh', 'sub/skill.md', 'z.txt', '\u00e9.txt']);
  const sh = manifest.find((m) => m.path === 'scripts/run.sh');
  assert.equal(sh.size, run.length);
  assert.equal(sh.sha256, crypto.createHash('sha256').update(run).digest('hex'));
  assert.equal(skillMD.toString(), GOOD_SKILL_MD);
  assert.deepEqual(markdown.map((m) => m.path), ['SKILL.md', 'docs/Guide.MD', 'sub/skill.md']);
});

test('path syntax checks run on raw name bytes', () => {
  assert.equal(checkEntryPath(Buffer.from('a/b.txt')), 'a/b.txt');
  assert.equal(reasonOf(() => checkEntryPath(Buffer.alloc(0))), 'invalid_path');
  assert.equal(reasonOf(() => checkEntryPath(Buffer.from([0xc0, 0xaf]))), 'invalid_path');
  assert.equal(reasonOf(() => checkEntryPath(Buffer.from('a/'))), null);
  assert.equal(reasonOf(() => checkEntryPath(Buffer.from('a//'))), 'invalid_path');
  assert.equal(reasonOf(() => checkEntryPath(Buffer.from('\u00e9:/x'))), 'invalid_path');
  // Rejected by the strict decoder, not later as U+FFFD.
  for (const bytes of [[0x61, 0xff], [0xc0, 0xaf], [0xe0, 0x80, 0xae], [0xed, 0xa0, 0x80], [0xf4, 0x90, 0x80, 0x80], [0x61, 0xe2, 0x82]]) {
    assert.throws(() => checkEntryPath(Buffer.from(bytes)), (err) => err.reason === 'invalid_path' && /non-UTF-8/.test(err.detail), String(bytes));
  }
  assert.equal(checkEntryPath(Buffer.from('\ufeffa')), '\ufeffa');
  const at = (n) => Buffer.from(`${'\u00e9/'.repeat(341)}${'a'.repeat(n)}`);
  assert.equal(at(1).length, 1024);
  assert.equal(reasonOf(() => checkEntryPath(at(1))), null);
  assert.throws(() => checkEntryPath(at(2)), (err) => /longer than 1024 bytes/.test(err.detail));
});

test('case folding follows the server', () => {
  assert.equal(canonSegment('STRASSE'), canonSegment('stra\u00dfe'));
  assert.equal(canonSegment('\u1e9e'), canonSegment('ss'));
  assert.equal(canonSegment('cafe\u0301'), canonSegment('CAF\u00c9'));
  assert.notEqual(canonSegment('\u0131'), canonSegment('i'));
  assert.notEqual(canonSegment('\u13a0'), canonSegment('\uab70'));
  assert.equal(foldKey('\u017fcripts'), 'scripts');
  assert.equal(foldKey('\u0130nstall'), 'install');
  assert.equal(foldKey('\u00df'), '\u00df');
  assert.ok(hasForbiddenSegment('a/.CLAUDE/') && !hasForbiddenSegment('a/.claude.d'));
  assert.ok(isSkillMDPath('x/\u017fKILL.md') && isMarkdownPath('a.Md') && !isMarkdownPath('a.md/b'));
});

test('package.json checks report the reason for the first failing rule', () => {
  const check = (body) => reasonOf(() => checkPackageJSON('package.json', Buffer.from(body)));
  assert.equal(check('{"Dependencies":{},"scripts":{"install":"x"}}'), 'npm_dependencies');
  assert.equal(check('{"scripts":{"install":"x"},"dependencies":{"a":"1"}}'), 'install_hook');
  assert.equal(check('{"dependencies":[1]}'), 'npm_dependencies');
  assert.equal(check('{"dependencies":[]}  '), null);
  assert.equal(check('{"a":{"b":[1,{"c":"d"}]},"e":-1.5E-2}'), null);
  for (const bad of ['', '{', '{"a"}', '{"a":}', '{"a":1 "b":2}', '{"a":tru}', '{"a":[1,]}', '{"a":"\\u12"}', '{} x']) {
    assert.equal(check(bad), 'install_hook', bad);
  }
});
