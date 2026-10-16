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
