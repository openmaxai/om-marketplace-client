import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { BroadcastChannel } from 'node:worker_threads';
import { delay, mode, tmpHome, within } from './helpers.js';
import { skillMd, skillPackage } from './fake/package.js';
import { buildZip } from './fake/zip.js';
import { U } from './fake/pull.js';
import { MARKER, failureFor, landSkill, skillNameReserved } from '../src/land.js';
import { MAX_SKILL_MD_BYTES } from '../src/pkg/frontmatter.js';
import { inspectInWorker } from '../src/inspect.js';
import { inspectPackage } from '../src/pkg/hygiene.js';
import { PackageError } from '../src/pkg/zip.js';
import { SkillPolicyError } from '../src/pkg/policy.js';
import { InstallFailure } from '../src/failure.js';

const SKILL = U(1);
const pkg = skillPackage();

function setup({ stagingRoot } = {}) {
  const home = tmpHome();
  const skillsDir = path.join(home, 'skills');
  fs.mkdirSync(skillsDir);
  const land = (over = {}, inspected = inspectPackage(pkg.zip)) => landSkill({
    skillsDir, stagingRoot: stagingRoot ?? path.join(home, 'data', 'staging'), rollbackRoot: path.join(home, 'data', 'rollback'), requestId: U(9),
    install: { slug: 'demo-skill', skill_id: SKILL, version_no: 1, package_sha256: pkg.sha, file_manifest: pkg.manifest, ...over }, inspected,
  });
  return { home, skillsDir, land, target: path.join(skillsDir, 'market--demo-skill') };
}

const failsWith = (code, reason) => (e) => e instanceof InstallFailure && e.code === code && e.reason === reason;
const STAGE = U(9);

function mkfifo(p) {
  const r = spawnSync('mkfifo', [p]);
  assert.equal(r.status, 0, String(r.stderr));
}

// Inspected files whose iteration runs `after` once every file has been handed out, i.e. once all are staged.
function afterStaging(after, inspected = inspectPackage(pkg.zip)) {
  const files = inspected.files.slice();
  files[Symbol.iterator] = function* iterate() {
    yield* Array.prototype.values.call(this);
    after();
  };
  return { ...inspected, files };
}

test('lands the files and the marker with private modes, leaving no staging behind', () => {
  const { home, land, target } = setup();
  assert.deepEqual(land(), { dir: target, previous: null });
  assert.equal(fs.readFileSync(path.join(target, 'docs/guide.md'), 'utf8'), 'guide\n');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(target, MARKER))), { skill_id: SKILL, version_no: 1, package_sha256: pkg.sha });
  assert.equal(mode(path.join(target, 'SKILL.md')), 0o600);
  assert.equal(mode(path.join(target, 'docs')), 0o700);
  assert.deepEqual(fs.readdirSync(path.join(home, 'data', 'staging')), []);
});

test('an existing directory, link or file at the target that is not this skill is a conflict', () => {
  const variants = {
    'no marker': (t) => fs.mkdirSync(t),
    'other skill': (t) => { fs.mkdirSync(t); fs.writeFileSync(path.join(t, MARKER), JSON.stringify({ skill_id: U(2) })); },
    'marker link': (t, home) => {
      fs.mkdirSync(t);
      fs.writeFileSync(path.join(home, 'm'), JSON.stringify({ skill_id: SKILL }));
      fs.symlinkSync(path.join(home, 'm'), path.join(t, MARKER));
    },
    'dir link': (t, home) => {
      fs.mkdirSync(path.join(home, 'real'));
      fs.writeFileSync(path.join(home, 'real', MARKER), JSON.stringify({ skill_id: SKILL }));
      fs.symlinkSync(path.join(home, 'real'), t);
    },
    file: (t) => fs.writeFileSync(t, 'x'),
  };
  for (const [name, make] of Object.entries(variants)) {
    const { home, land, target } = setup();
    make(target, home);
    assert.throws(() => land(), failsWith('INSTALL_TARGET_CONFLICT', 'target_exists'), name);
    assert.equal(fs.existsSync(path.join(home, 'real', 'SKILL.md')), false);
  }
});

test('the slug may not be another local skill directory or SKILL.md name, also of a linked skill', () => {
  const taken = {
    dir: (s) => fs.mkdirSync(path.join(s, 'Demo-Skill')),
    link: (s, home) => fs.symlinkSync(home, path.join(s, 'demo-skill')),
    'skill name': (s) => { fs.mkdirSync(path.join(s, 'other')); fs.writeFileSync(path.join(s, 'other', 'SKILL.md'), skillMd('"demo-skill"')); },
    'linked skill name': (s, home) => {
      fs.mkdirSync(path.join(home, 'elsewhere'));
      fs.writeFileSync(path.join(home, 'elsewhere', 'SKILL.md'), skillMd('demo-skill'));
      fs.symlinkSync(path.join(home, 'elsewhere'), path.join(s, 'linked'));
    },
  };
  for (const [name, make] of Object.entries(taken)) {
    const { home, skillsDir, land } = setup();
    make(skillsDir, home);
    assert.throws(() => land(), failsWith('INSTALL_TARGET_CONFLICT', 'name_taken'), name);
  }
});

test('a linked SKILL.md is read without following its own link and leaves the linked skill untouched', () => {
  const { home, skillsDir, land } = setup();
  fs.mkdirSync(path.join(home, 'elsewhere'));
  fs.writeFileSync(path.join(home, 'named.md'), skillMd('demo-skill'));
  fs.symlinkSync(path.join(home, 'named.md'), path.join(home, 'elsewhere', 'SKILL.md'));
  fs.symlinkSync(path.join(home, 'elsewhere'), path.join(skillsDir, 'linked'));
  assert.equal(land().previous, null);
  assert.deepEqual(fs.readdirSync(path.join(home, 'elsewhere')), ['SKILL.md']);
  assert.equal(fs.readlinkSync(path.join(skillsDir, 'linked')), path.join(home, 'elsewhere'));
});

test('links without a readable skill name are compared by entry name only and do not block the install', () => {
  const links = {
    'dir without SKILL.md': (home) => { fs.mkdirSync(path.join(home, 'empty')); return path.join(home, 'empty'); },
    dangling: (home) => path.join(home, 'missing'),
    fifo: (home) => { mkfifo(path.join(home, 'pipe')); return path.join(home, 'pipe'); },
  };
  for (const [name, make] of Object.entries(links)) {
    const { home, skillsDir, land, target } = setup();
    fs.symlinkSync(make(home), path.join(skillsDir, 'linked'));
    assert.equal(land().previous, null, name);
    assert.ok(fs.lstatSync(target).isDirectory(), name);
    assert.ok(fs.lstatSync(path.join(skillsDir, 'linked')).isSymbolicLink(), name);
  }
});

test('a local SKILL.md that fstat does not report as a regular file is not read', (t) => {
  const { skillsDir, land } = setup();
  fs.mkdirSync(path.join(skillsDir, 'other'));
  const md = path.join(skillsDir, 'other', 'SKILL.md');
  fs.writeFileSync(md, skillMd('demo-skill'));
  const opened = new Map();
  const { openSync, fstatSync } = fs;
  t.mock.method(fs, 'openSync', (...a) => { const fd = openSync(...a); opened.set(fd, String(a[0])); return fd; });
  t.mock.method(fs, 'fstatSync', (fd, ...a) => {
    const st = fstatSync(fd, ...a);
    return opened.get(fd) === md ? Object.assign(Object.create(st), { isFile: () => false }) : st;
  });
  assert.equal(land().previous, null);
  t.mock.restoreAll();
  const again = setup();
  fs.mkdirSync(path.join(again.skillsDir, 'other'));
  fs.writeFileSync(path.join(again.skillsDir, 'other', 'SKILL.md'), skillMd('demo-skill'));
  assert.throws(() => again.land(), failsWith('INSTALL_TARGET_CONFLICT', 'name_taken'));
});

test('reserved names, a name or manifest that differs from C-02, and a packaged marker are refused before writing', () => {
  assert.ok(skillNameReserved('comm-bridge') && skillNameReserved('Zylos-x') && skillNameReserved('market-foo'));
  assert.equal(skillNameReserved('demo-skill'), false);
  const reserved = skillPackage('scheduler');
  const { land, target } = setup();
  assert.throws(() => land({ slug: 'scheduler', file_manifest: reserved.manifest }, inspectPackage(reserved.zip)),
    failsWith('PACKAGE_UNSAFE', 'SKILL_NAME_RESERVED'));
  assert.throws(() => land({ slug: 'other-skill' }), failsWith('PACKAGE_MISMATCH', 'skill_name_mismatch'));
  const wrong = pkg.manifest.map((e) => ({ ...e }));
  wrong[0].size += 1;
  assert.throws(() => land({ file_manifest: wrong }), failsWith('PACKAGE_MISMATCH', 'file_manifest_mismatch'));
  assert.throws(() => land({ file_manifest: pkg.manifest.slice(1) }), failsWith('PACKAGE_MISMATCH', 'file_manifest_mismatch'));
  const marked = skillPackage('demo-skill', { [MARKER]: '{}' });
  assert.throws(() => land({ file_manifest: marked.manifest }, inspectPackage(marked.zip)), failsWith('PACKAGE_UNSAFE', 'reserved_path'));
  assert.equal(fs.existsSync(target), false);
});

test('a previous version of the same skill moves to the rollback area', () => {
  const { home, land, target } = setup();
  land();
  fs.writeFileSync(path.join(target, 'local.txt'), 'old');
  const v2 = skillPackage('demo-skill', { 'docs/guide.md': 'v2\n' });
  const r = land({ version_no: 2, package_sha256: v2.sha, file_manifest: v2.manifest }, inspectPackage(v2.zip));
  assert.equal(r.previous, path.join(home, 'data', 'rollback', 'demo-skill', '1'));
  assert.equal(fs.readFileSync(path.join(r.previous, 'local.txt'), 'utf8'), 'old');
  assert.equal(fs.readFileSync(path.join(target, 'docs/guide.md'), 'utf8'), 'v2\n');
  assert.equal(fs.existsSync(path.join(target, 'local.txt')), false);
});

test('a skills dir that is a link is refused', () => {
  const { home, skillsDir, land } = setup();
  fs.renameSync(skillsDir, path.join(home, 'real-skills'));
  fs.symlinkSync(path.join(home, 'real-skills'), skillsDir);
  assert.throws(() => land(), failsWith('CLIENT_INTERNAL', 'skills_dir_invalid'));
});

test('package and policy errors map to PACKAGE_UNSAFE, anything else to CLIENT_INTERNAL', () => {
  assert.deepEqual([failureFor(new PackageError('link', 'x/y')).code, failureFor(new PackageError('link', 'x/y')).reason], ['PACKAGE_UNSAFE', 'link']);
  const p = failureFor(new SkillPolicyError([{ code: 'SKILL_COMMAND_INJECTION', file: 'a/b.md', line: 3 }], false));
  assert.deepEqual([p.code, p.reason], ['PACKAGE_UNSAFE', 'SKILL_COMMAND_INJECTION at line 3']);
  const i = failureFor(new Error('/home/x: EACCES'));
  assert.deepEqual([i.code, i.reason], ['CLIENT_INTERNAL', 'client internal error']);
});

test('the worker returns what inspectPackage returns, with every file read', async () => {
  const direct = inspectPackage(pkg.zip);
  const r = await inspectInWorker(pkg.zip);
  assert.deepEqual(r.manifest, direct.manifest);
  assert.deepEqual(r.meta, direct.meta);
  assert.deepEqual(r.files.map((f) => [f.path, f.data.toString()]), direct.files.map((f) => [f.path, f.data.toString()]));
});

test('worker failures come back as package and policy errors', async () => {
  await assert.rejects(inspectInWorker(Buffer.from('not a zip')), (e) => e instanceof PackageError && e.reason === 'archive_invalid');
  const bad = buildZip([{ name: 'SKILL.md', data: skillMd('demo-skill', 'hooks: x\n') }]);
  await assert.rejects(inspectInWorker(bad), (e) => e instanceof SkillPolicyError && e.violations[0].code === 'SKILL_FRONTMATTER_KEY_NOT_ALLOWED');
});

test('inspection does not block the event loop and times out as inspect_timeout', async () => {
  const run = inspectInWorker(pkg.zip);
  assert.equal(await Promise.race([run, new Promise((r) => setTimeout(() => r('tick'), 0))]), 'tick');
  await run;
  await assert.rejects(inspectInWorker(pkg.zip, { timeoutMs: 1 }), failsWith('CLIENT_INTERNAL', 'inspect_timeout'));
});

// Opening a FIFO blocks synchronously, which no timer in this process can interrupt; the child is killed instead.
function landInChild(home) {
  const t0 = performance.now();
  const r = spawnSync(process.execPath, [CHILD], { env: { PATH: process.env.PATH, OM_MC_LAND_CHILD: home }, encoding: 'utf8', timeout: 10_000 });
  assert.equal(r.error?.code, undefined, `landing did not finish in 10 s (${Math.round(performance.now() - t0)} ms)`);
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}
const CHILD = new URL('./fake/land-child.js', import.meta.url).pathname;

test('a FIFO in another skill, at the target marker or in staging neither blocks nor lands', () => {
  {
    const { home, skillsDir, target } = setup();
    fs.mkdirSync(path.join(skillsDir, 'other'));
    mkfifo(path.join(skillsDir, 'other', 'SKILL.md'));
    assert.deepEqual(landInChild(home), { landed: true });
    assert.ok(fs.existsSync(path.join(target, MARKER)));
  }
  {
    const { home, target } = setup();
    fs.mkdirSync(target);
    mkfifo(path.join(target, MARKER));
    assert.deepEqual(landInChild(home), { code: 'INSTALL_TARGET_CONFLICT', reason: 'target_exists' });
  }
  {
    const { home, land, target } = setup();
    const stage = path.join(home, 'data', 'staging', STAGE);
    assert.throws(() => land({}, afterStaging(() => mkfifo(path.join(stage, 'docs', 'pipe')))), failsWith('CLIENT_INTERNAL', 'staged_files_mismatch'));
    assert.equal(fs.existsSync(target), false);
  }
});

test('staged files that read back differently from the manifest are CLIENT_INTERNAL', () => {
  const { land, target } = setup();
  const inspected = inspectPackage(pkg.zip);
  inspected.files = inspected.files.map((f) => (f.path === 'docs/guide.md' ? { ...f, data: Buffer.from('other\n') } : f));
  assert.throws(() => land({}, inspected), failsWith('CLIENT_INTERNAL', 'staged_files_mismatch'));
  assert.equal(fs.existsSync(target), false);
});

test('staged files are created exclusively', () => {
  const { land, target } = setup();
  const inspected = inspectPackage(pkg.zip);
  inspected.files = [...inspected.files, inspected.files[1]];
  assert.throws(() => land({}, inspected), (e) => e.code === 'EEXIST');
  assert.equal(fs.existsSync(target), false);
});

test('a target that appears while staging is a conflict and is left alone', () => {
  const { land, target } = setup();
  const make = () => { fs.mkdirSync(target); fs.writeFileSync(path.join(target, 'mine'), 'x'); };
  assert.throws(() => land({}, afterStaging(make)), failsWith('INSTALL_TARGET_CONFLICT', 'target_exists'));
  assert.deepEqual(fs.readdirSync(target), ['mine']);
});

test('a failed final rename puts the previous version back', (t) => {
  const { land, target } = setup();
  land();
  const v2 = skillPackage('demo-skill', { 'docs/guide.md': 'v2\n' });
  const real = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (from.endsWith(STAGE)) throw Object.assign(new Error('EIO'), { code: 'EIO' });
    return real(from, to);
  });
  assert.throws(() => land({ version_no: 2, package_sha256: v2.sha, file_manifest: v2.manifest }, inspectPackage(v2.zip)), /EIO/);
  t.mock.restoreAll();
  assert.equal(fs.readFileSync(path.join(target, 'docs/guide.md'), 'utf8'), 'guide\n');
  assert.equal(JSON.parse(fs.readFileSync(path.join(target, MARKER))).version_no, 1);
});

test('staging on another filesystem than the skills dir is refused', (t) => {
  const shm = '/dev/shm';
  if (!fs.existsSync(shm) || fs.statSync(shm).dev === fs.statSync(os.tmpdir()).dev) return t.skip('no second filesystem');
  const stagingRoot = fs.mkdtempSync(path.join(shm, 'om-mc-test-'));
  t.after(() => fs.rmSync(stagingRoot, { recursive: true, force: true }));
  const { land, target } = setup({ stagingRoot });
  assert.throws(() => land(), failsWith('CLIENT_INTERNAL', 'staging_other_filesystem'));
  assert.equal(fs.existsSync(target), false);
});

// The inspection timeout runs on mocked time and fires only once the worker has beaten, however slow it is to start.
test('a timed-out worker is terminated', async (t) => {
  const beats = new BroadcastChannel('spin-worker');
  let n = 0;
  let last = 0;
  const started = new Promise((r) => { beats.onmessage = () => { n++; last = performance.now(); r(); }; });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const workerUrl = new URL('./fake/spin-worker.js', import.meta.url);
    const run = inspectInWorker(pkg.zip, { workerUrl, timeoutMs: 1000 });
    run.catch(() => {});
    await within(started, 20_000, 'first worker beat');
    t.mock.timers.tick(1000);
    t.mock.timers.reset();
    await within(assert.rejects(run, failsWith('CLIENT_INTERNAL', 'inspect_timeout')), 1000, 'timeout rejection');
    const t0 = performance.now();
    while (performance.now() - last < 300) {
      assert.ok(performance.now() - t0 < 5000, `worker still beating after 5 s (${n} beats)`);
      await delay(50);
    }
  } finally {
    t.mock.timers.reset();
    beats.close();
  }
});

test('a link aliasing our own target does not block an upgrade or a reinstall and is left as it is', () => {
  const { home, skillsDir, land, target } = setup();
  land();
  const alias = path.join(skillsDir, 'alias');
  fs.symlinkSync('market--demo-skill', alias);
  const v2 = skillPackage('demo-skill', { 'docs/guide.md': 'v2\n' });
  const r = land({ version_no: 2, package_sha256: v2.sha, file_manifest: v2.manifest }, inspectPackage(v2.zip));
  assert.equal(r.previous, path.join(home, 'data', 'rollback', 'demo-skill', '1'));
  assert.equal(fs.readFileSync(path.join(target, 'docs/guide.md'), 'utf8'), 'v2\n');
  assert.equal(land({ version_no: 2, package_sha256: v2.sha, file_manifest: v2.manifest }, inspectPackage(v2.zip)).previous,
    path.join(home, 'data', 'rollback', 'demo-skill', '2'));
  assert.equal(fs.readlinkSync(alias), 'market--demo-skill');
  assert.equal(fs.readFileSync(path.join(alias, 'docs/guide.md'), 'utf8'), 'v2\n');
});

test('a local SKILL.md over the size cap is not read; one at the cap is', () => {
  const sized = (n) => {
    const md = skillMd('demo-skill');
    return md + 'x'.repeat(n - Buffer.byteLength(md));
  };
  for (const [size, conflict] of [[MAX_SKILL_MD_BYTES + 1, false], [MAX_SKILL_MD_BYTES, true]]) {
    const { skillsDir, land } = setup();
    fs.mkdirSync(path.join(skillsDir, 'other'));
    fs.writeFileSync(path.join(skillsDir, 'other', 'SKILL.md'), sized(size));
    if (conflict) assert.throws(() => land(), failsWith('INSTALL_TARGET_CONFLICT', 'name_taken'), String(size));
    else assert.equal(land().previous, null, String(size));
  }
});

test('a local SKILL.md is read only up to the cap, whatever fstat reported', (t) => {
  const { skillsDir, land } = setup();
  fs.mkdirSync(path.join(skillsDir, 'other'));
  const md = path.join(skillsDir, 'other', 'SKILL.md');
  fs.writeFileSync(md, skillMd('demo-skill') + 'x'.repeat(MAX_SKILL_MD_BYTES));
  const opened = new Map();
  const { openSync, fstatSync } = fs;
  t.mock.method(fs, 'openSync', (...a) => { const fd = openSync(...a); opened.set(fd, String(a[0])); return fd; });
  t.mock.method(fs, 'fstatSync', (fd, ...a) => {
    const st = fstatSync(fd, ...a);
    return opened.get(fd) === md ? Object.assign(Object.create(st), { size: 10 }) : st;
  });
  assert.equal(land().previous, null);
});
