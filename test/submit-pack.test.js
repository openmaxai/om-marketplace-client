import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpHome } from './helpers.js';
import { SubmitError, buildZip, packSkill } from '../src/submit/pack.js';
import { inspectPackage } from '../src/pkg/hygiene.js';
import { checkManifest, readManifest } from '../src/submit/template.js';

const SKILL_MD = '---\nname: weekday-helper\ndescription: Tells the weekday of a date.\nversion: 1.0.0\n---\n\n# Weekday helper\n';

function skillDir(files) {
  const dir = path.join(tmpHome(), 'skill');
  for (const [rel, data] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), data);
  }
  return dir;
}

const code = (fn) => { try { fn(); } catch (err) { assert.ok(err instanceof SubmitError, err.message); return err.code; } return null; };

test('packs a skill directory into a zip the install path accepts, skipping .git', () => {
  const dir = skillDir({ 'SKILL.md': SKILL_MD, 'scripts/run.sh': 'echo hi\n', '.git/HEAD': 'ref', 'notes.md': '# Notes\n' });
  const r = packSkill(dir);
  assert.deepEqual(r.meta, { name: 'weekday-helper', description: 'Tells the weekday of a date.', version: '1.0.0' });
  assert.deepEqual(r.files, ['SKILL.md', 'notes.md', 'scripts/run.sh']);
  assert.deepEqual(inspectPackage(r.zip).manifest.map((m) => m.path), r.files);
  assert.deepEqual(packSkill(dir).zip, r.zip, 'same input gives the same bytes');
});

test('a stored entry is used when deflate does not help', () => {
  const zip = buildZip([{ name: 'SKILL.md', data: Buffer.from(SKILL_MD) }, { name: 'x.bin', data: Buffer.from([1]) }]);
  assert.equal(inspectPackage(zip).files.length, 2);
});

test('refuses what the market would refuse, with its reason', () => {
  assert.equal(code(() => packSkill(path.join(tmpHome(), 'none'))), 'not_found');
  assert.equal(code(() => packSkill(skillDir({ 'README.md': '# x\n' }))), 'skill_md_missing');
  assert.equal(code(() => packSkill(skillDir({ 'SKILL.md': 'no frontmatter\n' }))), 'skill_md_invalid');
  assert.equal(code(() => packSkill(skillDir({ 'SKILL.md': SKILL_MD.replace('weekday-helper', 'Weekday Helper') }))), 'skill_md_invalid');
  assert.equal(code(() => packSkill(skillDir({ 'SKILL.md': SKILL_MD, 'package.json': '{"scripts":{"postinstall":"x"}}' }))), 'install_hook');
  assert.equal(code(() => packSkill(skillDir({ 'SKILL.md': SKILL_MD, '.claude/settings.json': '{}' }))), 'forbidden_path');
  const linked = skillDir({ 'SKILL.md': SKILL_MD });
  fs.symlinkSync('/etc/hostname', path.join(linked, 'host'));
  assert.equal(code(() => packSkill(linked)), 'link');
  const policy = skillDir({ 'SKILL.md': SKILL_MD.replace('version: 1.0.0\n', 'version: 1.0.0\nallowed-tools: Bash\n') });
  const c = code(() => packSkill(policy));
  assert.ok(c === 'skill_policy' || c === 'skill_md_invalid', c);
});

const MANIFEST = {
  schema_version: 1, kind: 'expert_template', id: 'weekly-reporter',
  role: { name: 'Weekly reporter', instructions: 'Write the weekly report.', duty: 'Writes weekly reports.' },
  skills: [],
};

test('template manifest shape check names each problem by JSON pointer', () => {
  assert.deepEqual(checkManifest(MANIFEST), []);
  const p = checkManifest({ ...MANIFEST, kind: 'x', extra: 1, role: { name: '', instructions: 'i', duty: 'a\nb' }, skills: [{}] });
  assert.deepEqual(p.sort(), [
    '/extra: unknown_field', '/kind: bad_value (must be "expert_template")', '/role/duty: bad_value (one line)',
    '/role/name: bad_value (non-empty text)', '/skills/0: bad_value ({skill_id, skill_version_id, package_sha256} of a listed skill version)',
  ]);
  assert.deepEqual(checkManifest([]), [': malformed (the manifest must be a JSON object)']);
});

test('readManifest reports unreadable, non-JSON and invalid files', () => {
  const dir = tmpHome();
  const f = path.join(dir, 'm.json');
  assert.equal(code(() => readManifest(f)), 'not_found');
  fs.writeFileSync(f, '{');
  assert.equal(code(() => readManifest(f)), 'manifest_invalid');
  fs.writeFileSync(f, JSON.stringify({ ...MANIFEST, id: 'Bad Id' }));
  assert.throws(() => readManifest(f), /\/id: bad_value/);
  fs.writeFileSync(f, JSON.stringify(MANIFEST));
  assert.equal(readManifest(f).manifest.id, 'weekly-reporter');
});
