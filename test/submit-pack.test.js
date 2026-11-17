import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpHome } from './helpers.js';
import { SubmitError, buildZip, isSecretFile, isServiceAccountKey, packSkill } from '../src/agent/pack.js';
import { inspectPackage } from '../src/pkg/hygiene.js';
import { checkManifest, readManifest } from '../src/agent/template.js';

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

test('files that may hold credentials refuse the package and are all named', () => {
  const dir = skillDir({
    'SKILL.md': SKILL_MD, '.env': 'A=1', 'conf/.env.local': 'B=2', 'certs/server.pem': 'x', 'tls.KEY': 'x', 'ssh/id_rsa.pub': 'x',
    'id_ed25519': 'x', '.npmrc': 'x', '.netrc': 'x', 'credentials': 'x', 'aws/credentials.json': 'x', 'notes.md': '# n\n', 'keys.md': '# k\n',
  });
  let err;
  try { packSkill(dir); } catch (e) { err = e; }
  assert.equal(err?.code, 'secret_file');
  for (const f of ['.env', 'conf/.env.local', 'certs/server.pem', 'tls.KEY', 'ssh/id_rsa.pub', 'id_ed25519', '.npmrc', '.netrc', 'credentials', 'aws/credentials.json']) {
    assert.ok(err.message.includes(f), f);
  }
  assert.ok(!err.message.includes('notes.md') && !err.message.includes('keys.md'));
  assert.equal(isSecretFile('environment.md'), false);
  assert.equal(isSecretFile('.envrc'), true);
});

test('certificate bundles, package-index and git credentials, and service-account keys by content are refused', () => {
  const sa = JSON.stringify({ type: 'service_account', project_id: 'p', private_key: 'fake-key-for-test' });
  const dir = skillDir({
    'SKILL.md': SKILL_MD, 'a.p12': 'x', 'b.PFX': 'x', '.pypirc': 'x', '.git-credentials': 'x', 'gcp/deploy.json': sa,
    'data/config.json': JSON.stringify({ type: 'service_account' }), 'data/list.json': '[1]', 'data/bad.json': '{',
  });
  let err;
  try { packSkill(dir); } catch (e) { err = e; }
  assert.equal(err?.code, 'secret_file');
  for (const f of ['a.p12', 'b.PFX', '.pypirc', '.git-credentials', 'gcp/deploy.json']) assert.ok(err.message.includes(f), f);
  for (const f of ['config.json', 'list.json', 'bad.json']) assert.ok(!err.message.includes(f), f);
  assert.equal(isServiceAccountKey(Buffer.from(sa)), true);
  assert.equal(isServiceAccountKey(Buffer.from('{"type":"service_account"}')), false);
});
