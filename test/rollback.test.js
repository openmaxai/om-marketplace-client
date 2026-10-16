import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ORG, U, pullHarness } from './fake/pull.js';
import { createSkills } from '../src/skills.js';

const SKILL = U(1);
const VID = (n) => U(100 + n);
const SHA = (n) => String(n).repeat(64);
const marker = (dir, no, skillId = SKILL) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `v${no}`);
  fs.writeFileSync(path.join(dir, '.market-managed'), JSON.stringify({ skill_id: skillId, version_no: no, package_sha256: SHA(no) }));
};
const version = (dir) => { try { return JSON.parse(fs.readFileSync(path.join(dir, '.market-managed'), 'utf8')).version_no; } catch { return null; } };

// Skill demo v2 enabled, v1 kept for rollback.
async function harness(t) {
  const h = await pullHarness(t, { orgs: {} });
  const skillsDir = path.join(path.dirname(h.dataDir), 'skills');
  const make = () => createSkills({ api: h.api, state: h.state, orgs: h.orgs, logger: h.logger, bffUrl: h.fake.url, skillsDir, dataDir: h.dataDir, now: h.now });
  const live = path.join(skillsDir, 'market--demo');
  const rb = (n) => path.join(h.dataDir, 'rollback', 'demo', String(n));
  h.state.write('installs', { [SKILL]: {
    org_id: ORG, install_id: U(5), slug: 'demo', skill_version_id: VID(2), version_no: 2, package_sha256: SHA(2), state: 'enabled',
    rollback: { version_no: 1, skill_version_id: VID(1) },
  } });
  marker(live, 2);
  marker(rb(1), 1);
  const rec = () => h.state.read('installs', {})[SKILL];
  return { ...h, make, live, rb, rec };
}

const rolledBack = (f) => {
  assert.equal(version(f.live), 1);
  assert.equal(version(f.rb(2)), 2);
  assert.ok(!fs.existsSync(f.rb(1)));
  assert.deepEqual([f.rec().version_no, f.rec().skill_version_id, f.rec().package_sha256, f.rec().rollback.version_no], [1, VID(1), SHA(1), 2]);
};
const untouched = (f) => {
  assert.equal(version(f.live), 2);
  assert.equal(version(f.rb(1)), 1);
  assert.equal(f.rec().version_no, 2);
};

test('rollback swaps the kept version in and journals it', async (t) => {
  const f = await harness(t);
  assert.equal(f.make().rollback(SKILL), 'done');
  rolledBack(f);
  const js = f.state.journal.list().map((id) => f.state.journal.get(id));
  assert.deepEqual(js.map((j) => [j.op, j.phase, j.closed]), [['rollback', 'closed', 'done']]);
});

test('rollback is refused for a quarantined skill, while busy, and without a kept copy of that version', async (t) => {
  const q = await harness(t);
  q.state.update('installs', {}, (d) => { d[SKILL].state = 'revoked_disabled'; });
  assert.equal(q.make().rollback(SKILL), 'quarantined');
  assert.equal(version(q.rb(1)), 1);

  const b = await harness(t);
  b.state.write('intents', { after_seq: 1, queue: [{ id: U(9), org_id: ORG, op: 'disable', skill_id: SKILL, status: 'queued', expires_at: '2026-10-17T00:00:00Z', seq: 1 }] });
  assert.equal(b.make().rollback(SKILL), 'busy');
  untouched(b);
  const o = await harness(t);
  o.state.outbox.put(U(10), { kind: 'result', org_id: ORG, skill_id: SKILL, body: {} });
  assert.equal(o.make().rollback(SKILL), 'busy');
  untouched(o);

  for (const [no, id] of [[1, U(2)], [3, SKILL]]) {
    const m = await harness(t);
    fs.rmSync(m.rb(1), { recursive: true });
    marker(m.rb(1), no, id);
    assert.equal(m.make().rollback(SKILL), 'none');
    assert.equal(version(m.live), 2);
    assert.equal(m.rec().version_no, 2);
  }
});

test('a rollback interrupted at any step is completed at the next start', async (t) => {
  const journal = (f) => f.state.journal.put(U(50), {
    op: 'rollback', phase: 'rollback', skill_id: SKILL, slug: 'demo', where: 'enabled',
    from: { version_no: 2, skill_version_id: VID(2), package_sha256: SHA(2) }, to: { version_no: 1, skill_version_id: VID(1), package_sha256: SHA(1) },
  });
  const nothingMoved = await harness(t);
  journal(nothingMoved);
  nothingMoved.make();
  rolledBack(nothingMoved);

  const firstMoved = await harness(t);
  journal(firstMoved);
  fs.renameSync(firstMoved.live, firstMoved.rb(2));
  firstMoved.make();
  rolledBack(firstMoved);

  const bothMoved = await harness(t);
  journal(bothMoved);
  fs.renameSync(bothMoved.live, bothMoved.rb(2));
  fs.renameSync(bothMoved.rb(1), bothMoved.live);
  assert.equal(bothMoved.rec().version_no, 2);
  bothMoved.make();
  rolledBack(bothMoved);
  assert.equal(bothMoved.state.journal.get(U(50)).phase, 'closed');
});

test('a rollback that cannot finish keeps the installed version and raises an alert', async (t) => {
  const f = await harness(t);
  fs.mkdirSync(f.rb(2), { recursive: true });
  fs.writeFileSync(path.join(f.rb(2), 'foreign'), 'x');
  assert.equal(f.make().rollback(SKILL), 'none');
  untouched(f);
  assert.equal(fs.readFileSync(path.join(f.rb(2), 'foreign'), 'utf8'), 'x');
  assert.ok(f.state.read('status', null).alerts[`rollback:${SKILL}`]);
});

test('an interrupted rollback whose kept copy vanished puts the moved version back; another version in place is left alone', async (t) => {
  const journal = (f) => f.state.journal.put(U(50), {
    op: 'rollback', phase: 'rollback', skill_id: SKILL, slug: 'demo', where: 'enabled',
    from: { version_no: 2, skill_version_id: VID(2), package_sha256: SHA(2) }, to: { version_no: 1, skill_version_id: VID(1), package_sha256: SHA(1) },
  });
  const gone = await harness(t);
  journal(gone);
  fs.renameSync(gone.live, gone.rb(2));
  fs.rmSync(gone.rb(1), { recursive: true });
  gone.make();
  assert.equal(version(gone.live), 2);
  assert.equal(gone.rec().version_no, 2);
  assert.ok(gone.state.read('status', null).alerts[`rollback:${SKILL}`]);

  const other = await harness(t);
  journal(other);
  fs.rmSync(other.live, { recursive: true });
  marker(other.live, 3);
  other.make();
  assert.equal(version(other.live), 3, 'a version the journal does not name is not replaced');
  assert.equal(version(other.rb(1)), 1);
  assert.equal(other.state.journal.get(U(50)).phase, 'closed');
});

test('a rollback stopped by a persistent fs error never blocks startup; it is retried each round with an alert', { skip: process.getuid?.() === 0 && 'root ignores modes' }, async (t) => {
  const f = await harness(t);
  const slot = path.dirname(f.rb(1));
  fs.chmodSync(slot, 0o500);
  t.after(() => fs.chmodSync(slot, 0o700));
  assert.throws(() => f.make().rollback(SKILL), { code: 'EACCES' });
  const open = () => Object.keys(f.state.read('status', null).alerts).filter((k) => k.startsWith('rollback_open:'));
  assert.equal(open().length, 1);
  const s = f.make();
  assert.equal(open().length, 1);
  assert.equal(s.rollback(SKILL), 'busy');
  assert.deepEqual(s.localScan().busy, new Set([SKILL]));
  await s.runRound();
  untouched(f);
  fs.chmodSync(slot, 0o700);
  await s.runRound();
  rolledBack(f);
  assert.deepEqual(open(), []);
  assert.deepEqual(s.localScan().busy, new Set());
});

test('one rollback that cannot be resumed does not stop the others', { skip: process.getuid?.() === 0 && 'root ignores modes' }, async (t) => {
  const f = await harness(t);
  const S2 = U(2);
  const live2 = path.join(path.dirname(f.live), 'market--demo2');
  const rb2 = (n) => path.join(f.dataDir, 'rollback', 'demo2', String(n));
  f.state.update('installs', {}, (d) => { d[S2] = { ...d[SKILL], slug: 'demo2' }; });
  marker(live2, 2, S2);
  marker(rb2(1), 1, S2);
  const journal = (id, skillId, slug) => f.state.journal.put(id, {
    op: 'rollback', phase: 'rollback', skill_id: skillId, slug, where: 'enabled',
    from: { version_no: 2, skill_version_id: VID(2), package_sha256: SHA(2) }, to: { version_no: 1, skill_version_id: VID(1), package_sha256: SHA(1) },
  });
  journal(U(49), SKILL, 'demo');
  journal(U(50), S2, 'demo2');
  const slot = path.dirname(f.rb(1));
  fs.chmodSync(slot, 0o500);
  t.after(() => fs.chmodSync(slot, 0o700));
  f.make();
  untouched(f);
  assert.deepEqual([version(live2), version(rb2(2))], [1, 2]);
  assert.equal(f.state.journal.get(U(50)).phase, 'closed');
  assert.equal(f.state.journal.get(U(49)).phase, 'rollback');
  assert.match(f.state.read('status', null).alerts[`rollback_open:${U(49)}`].message, new RegExp(`of skill ${SKILL}`));
});

const openEntry = (f, id, over = {}) => f.state.journal.put(id, {
  op: 'rollback', phase: 'rollback', skill_id: SKILL, slug: 'demo', where: 'enabled',
  from: { version_no: 2, skill_version_id: VID(2), package_sha256: SHA(2) }, to: { version_no: 1, skill_version_id: VID(1), package_sha256: SHA(1) },
  ...over,
});
const alertsOf = (f) => f.state.read('status', null)?.alerts ?? {};

test('an open-rollback alert raised before a restart is cleared once the rollback completes at startup', { skip: process.getuid?.() === 0 && 'root ignores modes' }, async (t) => {
  const f = await harness(t);
  const slot = path.dirname(f.rb(1));
  fs.chmodSync(slot, 0o500);
  t.after(() => fs.chmodSync(slot, 0o700));
  assert.throws(() => f.make().rollback(SKILL), { code: 'EACCES' });
  assert.equal(Object.keys(alertsOf(f)).filter((k) => k.startsWith('rollback_open:')).length, 1);
  fs.chmodSync(slot, 0o700);
  const s = f.make();
  rolledBack(f);
  assert.deepEqual(Object.keys(alertsOf(f)).filter((k) => k.startsWith('rollback_open:')), []);
  assert.deepEqual(s.localScan().busy, new Set());
});

test('a well-formed JSON rollback entry with unusable content is closed as failed with an alert, directories untouched', async (t) => {
  const cases = [
    { from: undefined }, { to: null }, { where: 'elsewhere' }, { where: 'revoked_disabled' }, { slug: '../demo' },
    { from: { version_no: '2', package_sha256: SHA(2) } }, { to: { version_no: 1 } }, { skill_id: 7 },
  ];
  for (const over of cases) {
    const f = await harness(t);
    openEntry(f, U(50), over);
    const s = f.make();
    untouched(f);
    assert.deepEqual([f.state.journal.get(U(50)).phase, f.state.journal.get(U(50)).closed], ['closed', 'failed'], JSON.stringify(over));
    const key = typeof over.skill_id === 'number' ? `rollback:${U(50)}` : `rollback:${SKILL}`;
    assert.match(alertsOf(f)[key].message, /closed as failed/, JSON.stringify(over));
    assert.equal(alertsOf(f)[`rollback_open:${U(50)}`], undefined);
    assert.deepEqual(s.localScan().busy, new Set());
    assert.equal(s.rollback(SKILL), 'done');
  }
});

test('a rollback entry failing for a non-filesystem reason is closed, not kept stuck', async (t) => {
  const f = await harness(t);
  openEntry(f, U(50));
  const get = f.state.journal.get;
  let thrown = false;
  f.state.journal.get = (id) => {
    const j = get(id);
    if (id !== U(50) || thrown || j?.phase !== 'rollback') return j;
    thrown = true;
    return { ...j, get from() { throw new TypeError('bad entry'); } };
  };
  const s = f.make();
  untouched(f);
  assert.deepEqual([f.state.journal.get(U(50)).phase, f.state.journal.get(U(50)).closed], ['closed', 'failed']);
  assert.match(alertsOf(f)[`rollback:${SKILL}`].message, /bad entry/);
  assert.equal(alertsOf(f)[`rollback_open:${U(50)}`], undefined);
  assert.deepEqual(s.localScan().busy, new Set());
});

test('startup survives a journal that cannot be listed; the rollback resumes and the alert clears once it can', { skip: process.getuid?.() === 0 && 'root ignores modes' }, async (t) => {
  const f = await harness(t);
  openEntry(f, U(50));
  const dir = path.join(f.state.dir, 'requests');
  fs.chmodSync(dir, 0o000);
  t.after(() => fs.chmodSync(dir, 0o700));
  const s = f.make();
  untouched(f);
  assert.match(alertsOf(f).journal_unreadable.message, /cannot be listed/);
  await s.runRound();
  untouched(f);
  assert.ok(alertsOf(f).journal_unreadable);
  fs.chmodSync(dir, 0o700);
  await s.runRound();
  rolledBack(f);
  assert.equal(alertsOf(f).journal_unreadable, undefined);
});

test('an unreadable (EACCES) rollback entry is kept, not moved aside, and retried', { skip: process.getuid?.() === 0 && 'root ignores modes' }, async (t) => {
  const f = await harness(t);
  openEntry(f, U(50));
  const file = path.join(f.state.dir, 'requests', `${U(50)}.json`);
  fs.chmodSync(file, 0o000);
  t.after(() => { try { fs.chmodSync(file, 0o600); } catch { /* moved */ } });
  const s = f.make();
  untouched(f);
  assert.ok(fs.existsSync(file));
  assert.equal(fs.existsSync(path.join(f.state.dir, 'corrupt')), false);
  assert.ok(alertsOf(f)[`rollback_open:${U(50)}`]);
  fs.chmodSync(file, 0o600);
  await s.runRound();
  rolledBack(f);
  assert.equal(alertsOf(f)[`rollback_open:${U(50)}`], undefined);
});

test('a rollback whose directories moved but whose state file is corrupt stays open and is retried with an alert', async (t) => {
  const f = await harness(t);
  openEntry(f, U(50));
  fs.renameSync(f.live, f.rb(2));
  fs.renameSync(f.rb(1), f.live);
  const file = path.join(f.state.dir, 'installs.json');
  const good = fs.readFileSync(file);
  fs.writeFileSync(file, '{');
  const s = f.make();
  assert.equal(f.state.journal.get(U(50)).phase, 'rollback');
  assert.match(alertsOf(f)[`rollback_open:${U(50)}`].message, /retried every round/);
  assert.equal(alertsOf(f)[`rollback:${SKILL}`], undefined);
  fs.writeFileSync(file, good);
  await s.runRound();
  rolledBack(f);
  assert.deepEqual([f.state.journal.get(U(50)).phase, f.state.journal.get(U(50)).closed], ['closed', 'done']);
  assert.equal(alertsOf(f)[`rollback_open:${U(50)}`], undefined);
});
