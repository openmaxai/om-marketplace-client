import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AGENT, ORG, ORG2, U, pullHarness } from './fake/pull.js';
import { createSkills } from '../src/skills.js';
import { createTemplates } from '../src/templates.js';
import { emptySlots, writeSlots } from '../src/shards.js';
import { MAX_ITEMS, RATE_BUDGET, RECONCILE_EVERY_MS, batches, createReconciler, validItem } from '../src/reconcile.js';

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const SK = (n) => U(500 + n);
const VER = (n, v) => U(600 + n * 10 + v);
const OTHER_ORG = 'org-not-configured';
const path12 = (org) => `/api/v1/orgs/${org}/agents/${AGENT}/skills`;
const path10 = (org) => `/api/v1/orgs/${org}/agents/${AGENT}/reconcile`;
const problem = (status, code, extra = {}) => ({ status, problem: { status, code, ...extra } });
const recordAll = (req) => ({ status: 200, json: { results: req.json.items.map((_, index) => ({ index, outcome: 'recorded' })) } });
const listed = (n, { v = 1, state = 'installed' } = {}) => ({
  install_id: U(700 + n), skill_id: SK(n), slug: `s${n}`, skill_version_id: VER(n, v), version_no: v, source_market_id: U(3),
  install_state: state, enabled: true, readiness: 'ready',
});

function files(root) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(path.relative(root, p));
    }
  };
  if (fs.existsSync(root)) walk(root);
  return out.sort();
}

async function harness(t, { orgs = { [ORG2]: {} } } = {}) {
  const h = await pullHarness(t, { orgs });
  const skillsDir = path.join(path.dirname(h.dataDir), 'skills');
  fs.mkdirSync(skillsDir);
  h.state.write('epoch', { epoch: U(9), created_at: '2026-10-16T00:00:00Z', tombstones: [] });
  const skills = createSkills({ api: h.api, state: h.state, orgs: h.orgs, logger: h.logger, bffUrl: h.fake.url, skillsDir, dataDir: h.dataDir, now: h.now });
  const templates = createTemplates({ api: h.api, state: h.state, orgs: h.orgs, logger: h.logger, dataDir: h.dataDir, zylosDir: h.dataDir, now: h.now });
  const reconciler = createReconciler({ api: h.api, state: h.state, orgs: h.orgs, skills, templates, logger: h.logger, now: h.now });
  const areas = { enabled: skillsDir, disabled: path.join(h.dataDir, 'disabled'), revoked_disabled: path.join(h.dataDir, 'quarantine') };

  function dir(where, n, marker = { skill_id: SK(n), version_no: 1, package_sha256: sha(n) }) {
    const d = path.join(areas[where], `market--s${n}`);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'SKILL.md'), `---\nname: s${n}\ndescription: x\n---\n`);
    fs.writeFileSync(path.join(d, '.market-managed'), JSON.stringify(marker));
  }
  function skill(n, { org = ORG, state = 'enabled', v = 1, rollback = null, onDisk = true } = {}) {
    h.state.update('installs', {}, (d) => {
      d[SK(n)] = {
        org_id: org, install_id: U(700 + n), slug: `s${n}`, skill_version_id: VER(n, v), version_no: v, package_sha256: sha(n),
        source_market_id: U(3), state, installed_at: '2026-10-15T00:00:00Z', request_id: U(800 + n), rollback,
      };
    });
    if (onDisk) dir(state, n);
  }
  function adoption(id, { slot = null, org = ORG } = {}) {
    const d = path.join(h.dataDir, 'templates', id);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'inject.md'), '# T\n');
    h.state.update('adoptions', {}, (a) => {
      a[id] = { adoption_id: id, org_id: org, state: 'active', inject_sha256: sha('# T\n'), files: [{ path: 'inject.md', size: 4, sha256: sha('# T\n') }] };
    });
    if (slot) writeSlots(h.dataDir, { ...(fs.existsSync(path.join(h.dataDir, 'slots.json')) ? JSON.parse(fs.readFileSync(path.join(h.dataDir, 'slots.json'))) : emptySlots()), [slot]: { adoption_id: id, inject_sha256: sha('# T\n') } });
  }
  function queue(...items) {
    h.state.write('intents', { after_seq: 9, queue: items.map((it, i) => ({
      id: U(900 + i), org_id: OTHER_ORG, op: 'install', skill_id: SK(99), skill_version_id: null, template_id: null, source_market_id: null,
      adoption_id: null, discard_local_changes: false, expires_at: '2026-10-17T00:00:00Z', seq: i + 1, status: 'org_not_configured', ...it,
    })) });
  }
  // C-12 and C-10 answer forever; replace the answer functions to script a test.
  const answer = { c12: { [ORG]: () => ({ status: 200, json: { items: [] } }), [ORG2]: () => ({ status: 200, json: { items: [] } }) }, c10: recordAll };
  for (const org of [ORG, ORG2]) {
    const c12 = (req) => { h.fake.script('GET', path12(org), c12); return answer.c12[org](req); };
    const c10 = (req) => { h.fake.script('POST', path10(org), c10); return answer.c10(req, org); };
    h.fake.script('GET', path12(org), c12);
    h.fake.script('POST', path10(org), c10);
  }
  const reports = (org) => h.fake.requests.filter((r) => r.method === 'POST' && (org ? r.path === path10(org) : r.path.endsWith('/reconcile'))).map((r) => r.json.items);
  return { ...h, skillsDir, skills, templates, reconciler, skill, dir, adoption, queue, answer, reports };
}

test('every discrepancy kind is detected and reported through its org; only the released rollback is removed', async (t) => {
  const f = await harness(t);
  f.skill(2, { onDisk: false });
  f.skill(3, { v: 1 });
  f.skill(4, { state: 'revoked_disabled' });
  f.skill(5);
  f.dir('enabled', 6);
  f.skill(7, { v: 2, rollback: { version_no: 1, skill_version_id: VER(7, 1) } });
  fs.mkdirSync(path.join(f.dataDir, 'rollback', 's7', '1'), { recursive: true });
  fs.writeFileSync(path.join(f.dataDir, 'rollback', 's7', '1', 'SKILL.md'), 'old');
  fs.writeFileSync(path.join(f.dataDir, 'rollback', 's7', '1', '.market-managed'), JSON.stringify({ skill_id: SK(7), version_no: 1 }));
  fs.mkdirSync(path.join(f.dataDir, 'rollback', 's7', 'not-ours'));
  fs.writeFileSync(path.join(f.dataDir, 'rollback', 's7', 'not-ours', 'keep'), 'x');
  f.skill(8);
  f.skill(9, { state: 'disabled' });
  f.skill(11, { org: ORG2 });
  f.adoption(U(21), { slot: 1 });
  fs.writeFileSync(path.join(f.dataDir, 'templates', U(21), 'inject.md'), 'edited');
  f.adoption(U(22));
  f.queue({}, { status: 'queued', org_id: ORG, skill_id: SK(10) });
  f.answer.c12[ORG] = () => ({ status: 200, json: { items: [
    listed(1), listed(2), listed(3, { v: 2 }), listed(4), listed(7, { v: 2 }), listed(8, { state: 'installing' }), listed(9, { state: 'failed' }), listed(10),
  ] } });
  const before = [...files(f.dataDir).filter((p) => !p.startsWith('state')), ...files(f.skillsDir)];

  assert.deepEqual(await f.reconciler.run(), { outcome: 'ok', reported: 11, recorded: 11, skipped: 0 });

  const byKind = (items) => items.map((i) => `${i.kind}:${i.skill_id ?? i.adoption_id ?? i.intent_id}`).sort();
  assert.deepEqual(byKind(f.reports(ORG).flat()), [
    `local_extra:${SK(5)}`, `local_extra:${SK(6)}`, `local_extra:${SK(9)}`, `local_missing:${SK(1)}`, `local_missing:${SK(2)}`,
    `local_rollback:${SK(3)}`, `org_not_configured:${U(900)}`, `revoked_disabled:${SK(4)}`,
    `template_inject_missing:${U(22)}`, `template_locally_modified:${U(21)}`,
  ].sort());
  assert.deepEqual(f.reports(ORG2), [[{ kind: 'local_extra', skill_id: SK(11), skill_version_id: VER(11, 1), installed_sha256: sha(11) }]]);
  const items = Object.fromEntries(f.reports(ORG).flat().map((i) => [`${i.kind}:${i.skill_id ?? i.adoption_id ?? i.intent_id}`, i]));
  assert.deepEqual(items[`local_missing:${SK(1)}`], { kind: 'local_missing', skill_id: SK(1) });
  assert.deepEqual(items[`local_missing:${SK(2)}`], { kind: 'local_missing', skill_id: SK(2), skill_version_id: VER(2, 1) });
  assert.deepEqual(items[`local_rollback:${SK(3)}`], { kind: 'local_rollback', skill_id: SK(3), skill_version_id: VER(3, 1), installed_sha256: sha(3) });
  assert.deepEqual(items[`revoked_disabled:${SK(4)}`], { kind: 'revoked_disabled', skill_id: SK(4), skill_version_id: VER(4, 1), installed_sha256: sha(4) });
  assert.deepEqual(items[`local_extra:${SK(6)}`], { kind: 'local_extra', skill_id: SK(6), installed_sha256: sha(6) });
  assert.deepEqual(items[`org_not_configured:${U(900)}`], { kind: 'org_not_configured', intent_id: U(900), org_id: OTHER_ORG });
  assert.deepEqual(items[`template_locally_modified:${U(21)}`], { kind: 'template_locally_modified', adoption_id: U(21), rendered_sha256: sha('edited') });

  const after = [...files(f.dataDir).filter((p) => !p.startsWith('state')), ...files(f.skillsDir)];
  assert.deepEqual(before.filter((p) => !after.includes(p)), ['rollback/s7/1/.market-managed', 'rollback/s7/1/SKILL.md']);
  assert.equal(fs.readFileSync(path.join(f.dataDir, 'templates', U(21), 'inject.md'), 'utf8'), 'edited');
  assert.equal(f.state.read('installs', {})[SK(7)].rollback, null);
  assert.deepEqual(f.state.read('intents', null).queue.map((q) => q.id), [U(901)], 'recorded org_not_configured intent is done');
  assert.equal(f.state.read('status', null).runs.reconcile.outcome, 'ok');
});

test('a consistent agent sends no report, and runs are spaced by the cadence', async (t) => {
  const f = await harness(t);
  f.skill(1);
  f.answer.c12[ORG] = () => ({ status: 200, json: { items: [listed(1)] } });
  const c12 = () => f.fake.requests.filter((r) => r.method === 'GET' && r.path.endsWith('/skills')).length;
  assert.equal((await f.reconciler.maybeRun()).reported, 0);
  assert.equal(c12(), 2);
  f.clock.t += RECONCILE_EVERY_MS - 1;
  assert.equal(await f.reconciler.maybeRun(), null);
  f.clock.t += 1;
  await f.reconciler.maybeRun();
  assert.equal(c12(), 4);
  assert.equal(f.reports().length, 0);
});

test('batches split at 200 items and at the body size limit', () => {
  const e = (n) => Array.from({ length: n }, (_, i) => ({ item: { kind: 'local_extra', skill_id: U(i) } }));
  assert.deepEqual(batches(e(200)).map((b) => b.length), [200]);
  assert.deepEqual(batches(e(201)).map((b) => b.length), [200, 1]);
  assert.deepEqual(batches(e(401)).map((b) => b.length), [200, 200, 1]);
  const one = Buffer.byteLength(JSON.stringify(e(1)[0].item));
  const exact = Buffer.byteLength(JSON.stringify({ items: e(3).map((x) => x.item) }));
  assert.deepEqual(batches(e(3), { maxBytes: exact }).map((b) => b.length), [3]);
  assert.deepEqual(batches(e(3), { maxBytes: exact - 1 }).map((b) => b.length), [2, 1]);
  assert.deepEqual(batches(e(2), { maxBytes: one }).map((b) => b.length), [], 'an item that cannot fit is dropped');
  const worst = { kind: 'revoked_disabled', skill_id: U(1), skill_version_id: U(2), installed_sha256: sha(1) };
  assert.ok(Buffer.byteLength(JSON.stringify({ items: Array(MAX_ITEMS).fill(worst) })) <= 64 * 1024, 'item cap binds first');
});

test('201 items go out as two reports of 200 and 1', async (t) => {
  const f = await harness(t, { orgs: {} });
  f.queue(...Array.from({ length: 201 }, () => ({})));
  const r = await f.reconciler.run();
  assert.deepEqual(f.reports(ORG).map((b) => b.length), [200, 1]);
  assert.equal(r.recorded, 201);
  assert.deepEqual(f.state.read('intents', null).queue, []);
});

test('skipped items are reported again next cycle; skipped expired org_not_configured intents are dropped', async (t) => {
  const f = await harness(t, { orgs: {} });
  f.queue({}, { expires_at: '2026-10-15T00:00:00Z' });
  f.answer.c10 = (req) => ({ status: 200, json: { results: req.json.items.map((_, index) => ({ index, outcome: 'skipped' })) } });
  assert.deepEqual(await f.reconciler.run(), { outcome: 'ok', reported: 2, recorded: 0, skipped: 2 });
  assert.deepEqual(f.state.read('intents', null).queue.map((q) => q.id), [U(900)]);
  await f.reconciler.run();
  assert.deepEqual(f.reports(ORG).map((b) => b.length), [2, 1]);
});

test('an answer that does not match the items changes nothing and raises an alert', async (t) => {
  const f = await harness(t, { orgs: {} });
  f.queue({}, {});
  f.answer.c10 = () => ({ status: 200, json: { results: [{ index: 0, outcome: 'recorded' }] } });
  assert.equal((await f.reconciler.run()).outcome, 'partial');
  assert.equal(f.state.read('intents', null).queue.length, 2);
  assert.match(f.state.read('status', null).alerts[`reconcile:${ORG}`].message, /RESPONSE_INVALID/);
});

test('VALIDATION_FAILED drops the named items and resends the rest once', async (t) => {
  const f = await harness(t, { orgs: {} });
  f.queue({}, {}, {});
  const answers = [problem(400, 'VALIDATION_FAILED', { errors: [{ field: 'items[1].intent_id' }] }), null];
  f.answer.c10 = (req) => answers.shift() ?? recordAll(req);
  await f.reconciler.run();
  assert.deepEqual(f.reports(ORG).map((b) => b.map((i) => i.intent_id)), [[U(900), U(901), U(902)], [U(900), U(902)]]);
  assert.deepEqual(f.state.read('intents', null).queue.map((q) => q.id), [U(901)]);
  assert.ok(f.state.read('status', null).alerts[`reconcile:${ORG}`]);

  f.answer.c10 = () => problem(400, 'VALIDATION_FAILED');
  await f.reconciler.run();
  assert.equal(f.reports(ORG).length, 3, 'no index: nothing is resent');
});

test('429 stops all reporting until next cycle and honours Retry-After; the local hourly budget is never exceeded', async (t) => {
  const f = await harness(t);
  f.skill(11, { org: ORG2 });
  f.queue(...Array.from({ length: 201 }, () => ({})));
  f.answer.c10 = () => ({ ...problem(429, 'RATE_LIMITED'), headers: { 'retry-after': '3600' } });
  assert.equal((await f.reconciler.run()).outcome, 'rate_limited');
  assert.equal(f.reports().length, 1, 'neither the second batch nor the other org is sent');
  f.answer.c10 = recordAll;
  f.clock.t += RECONCILE_EVERY_MS;
  assert.equal((await f.reconciler.run()).outcome, 'rate_limited');
  assert.equal(f.reports().length, 1);
  f.clock.t += 15 * 60 * 1000;
  assert.equal((await f.reconciler.run()).outcome, 'ok');
  assert.equal(f.reports().length, 4);

  const recent = new Date(f.clock.t).toISOString();
  f.state.update('reconcile', {}, (d) => { d.sent = Array(RATE_BUDGET - 1).fill(recent); });
  f.queue(...Array.from({ length: 201 }, () => ({})));
  assert.equal((await f.reconciler.run()).outcome, 'rate_limited');
  assert.deepEqual(f.reports().slice(4).map((b) => b.length), [200]);
  assert.equal(f.state.read('reconcile', null).sent.length, RATE_BUDGET);
  f.clock.t += 60 * 60 * 1000;
  await f.reconciler.run();
  assert.deepEqual(f.reports().slice(5).map((b) => b.length), [1, 1]);
});

test('503 and MEMBER_LEFT_ORG defer one org without blocking the other', async (t) => {
  const f = await harness(t);
  f.skill(5);
  f.skill(11, { org: ORG2 });
  f.answer.c10 = (req, org) => (org === ORG ? problem(503, 'DEPENDENCY_UNAVAILABLE') : recordAll(req));
  assert.equal((await f.reconciler.run()).outcome, 'partial');
  assert.equal(f.reports(ORG2).length, 1);
  assert.equal(f.state.read('installs', {})[SK(5)].state, 'enabled');

  f.answer.c10 = (req, org) => (org === ORG2 ? problem(403, 'MEMBER_LEFT_ORG', { reason: 'member_departed' }) : recordAll(req));
  await f.reconciler.run();
  assert.equal(f.orgs.membership(ORG2), 'invalid');
  assert.equal(f.reports(ORG).length, 2);
  await f.reconciler.run();
  assert.equal(f.reports(ORG2).length, 2, 'a departed org is not contacted again');
});

test('without C-12 skills are not compared, other kinds are still reported and no rollback is released', async (t) => {
  const f = await harness(t, { orgs: {} });
  f.skill(7, { v: 2, rollback: { version_no: 1, skill_version_id: VER(7, 1) } });
  f.skill(5);
  f.queue({});
  f.answer.c12[ORG] = () => problem(503, 'DEPENDENCY_UNAVAILABLE');
  assert.equal((await f.reconciler.run()).outcome, 'partial');
  assert.deepEqual(f.reports(ORG), [[{ kind: 'org_not_configured', intent_id: U(900), org_id: OTHER_ORG }]]);
  assert.ok(f.state.read('installs', {})[SK(7)].rollback);

  f.answer.c12[ORG] = () => problem(409, 'CLIENT_VERSION_TOO_OLD', { reason: 'below_minimum', min_version: '9.0.0' });
  f.queue({});
  await f.reconciler.run();
  assert.ok(f.state.read('gate', null).too_old);
  f.queue({});
  await f.reconciler.run();
  assert.equal(f.fake.requests.filter((r) => r.method === 'GET' && r.path.endsWith('/skills')).length, 2, 'C-12 is not called in too-old mode');
  assert.equal(f.reports(ORG).length, 3, 'C-10 still reports in too-old mode');

  const g = await harness(t, { orgs: {} });
  g.skill(5);
  g.answer.c12[ORG] = () => problem(403, 'MEMBER_LEFT_ORG', { reason: 'member_suspended' });
  await g.reconciler.run();
  assert.equal(g.orgs.membership(ORG), 'suspended');
  assert.equal(g.reports().length, 0);
});

test('items follow the market rules; malformed ones are never sent', async (t) => {
  assert.ok(validItem({ kind: 'local_missing', skill_id: U(1) }));
  assert.ok(validItem({ kind: 'org_not_configured', intent_id: U(1), org_id: ORG }));
  for (const bad of [
    { kind: 'install_succeeded', skill_id: U(1) }, { kind: 'client_uninstalled' }, { kind: 'local_missing' },
    { kind: 'local_missing', skill_id: U(1).toUpperCase() }, { kind: 'local_missing', skill_id: U(1), skill_version_id: '' },
    { kind: 'revoked_disabled', skill_id: U(1) }, { kind: 'local_extra', skill_id: U(1), adoption_id: U(2) },
    { kind: 'template_locally_modified', adoption_id: U(1), rendered_sha256: 'ABC' },
  ]) assert.equal(validItem(bad), false, JSON.stringify(bad));
  const f = await harness(t, { orgs: {} });
  f.dir('enabled', 6, { skill_id: 'not-a-uuid', package_sha256: sha(6) });
  f.queue({});
  await f.reconciler.run();
  assert.deepEqual(f.reports(ORG).flat().map((i) => i.kind), ['org_not_configured']);
});

test('an unusable budget file pauses reporting for one hour with an alert and never stops reconcile', async (t) => {
  for (const bad of ['{not json', 'null', '{"sent":"x"}', '{"sent":[1]}', '[]', '{"sent":[],"blocked_until":5}']) {
    const f = await harness(t, { orgs: {} });
    fs.writeFileSync(path.join(f.state.dir, 'reconcile.json'), bad);
    f.queue({});
    assert.equal((await f.reconciler.run()).outcome, 'rate_limited', bad);
    assert.equal(f.reports().length, 0);
    const st = f.state.read('status', null);
    assert.ok(st.alerts['reconcile:budget'], bad);
    assert.equal(st.runs.reconcile.outcome, 'rate_limited');
    assert.equal(f.state.read('reconcile', null).sent.length, RATE_BUDGET);
    f.clock.t += 60 * 60 * 1000 - 1;
    assert.equal((await f.reconciler.run()).outcome, 'rate_limited');
    f.clock.t += 1;
    assert.equal((await f.reconciler.run()).outcome, 'ok', bad);
    assert.equal(f.reports().length, 1);
    assert.ok(f.state.read('status', null).alerts['reconcile:budget'], 'still listed after reporting resumed');
    f.clock.t += 23 * 60 * 60 * 1000 - 1;
    await f.reconciler.run();
    assert.ok(f.state.read('status', null).alerts['reconcile:budget']);
    f.clock.t += 1;
    await f.reconciler.run();
    assert.equal(f.state.read('status', null).alerts['reconcile:budget'], undefined, bad);
  }
});

test('a budget file that cannot be rewritten still does not throw', async (t) => {
  const f = await harness(t, { orgs: {} });
  fs.mkdirSync(path.join(f.state.dir, 'reconcile.json'));
  f.queue({});
  assert.equal((await f.reconciler.run()).outcome, 'rate_limited');
  assert.equal(f.reports().length, 0);
  assert.ok(f.state.read('status', null).alerts['reconcile:budget']);
});

test('stamps ahead of a clock set back and an overlong stored block do not silence reporting', async (t) => {
  const f = await harness(t, { orgs: {} });
  const ahead = new Date(f.clock.t + 24 * 60 * 60 * 1000).toISOString();
  f.state.write('reconcile', { last_run_at: null, last: null, sent: Array(RATE_BUDGET).fill(ahead), blocked_until: null });
  f.queue({});
  assert.equal((await f.reconciler.run()).outcome, 'ok');
  assert.equal(f.reports().length, 1);

  f.state.write('reconcile', { last_run_at: null, last: null, sent: [], blocked_until: new Date(f.clock.t + 30 * 24 * 60 * 60 * 1000).toISOString() });
  f.queue({});
  assert.equal((await f.reconciler.run()).outcome, 'rate_limited');
  f.clock.t += 60 * 60 * 1000 - 1;
  assert.equal((await f.reconciler.run()).outcome, 'rate_limited');
  f.clock.t += 1;
  assert.equal((await f.reconciler.run()).outcome, 'ok');
  assert.equal(f.reports().length, 2);
});

test('a batch refused with a 400 naming no item is skipped and the next batches are still sent', async (t) => {
  const f = await harness(t, { orgs: {} });
  f.queue(...Array.from({ length: 401 }, () => ({})));
  const answers = [problem(400, 'BODY_TOO_LARGE')];
  f.answer.c10 = (req) => answers.shift() ?? recordAll(req);
  const r = await f.reconciler.run();
  assert.deepEqual(f.reports(ORG).map((b) => b.length), [200, 200, 1]);
  assert.equal(r.outcome, 'partial');
  assert.equal(r.recorded, 201);
  assert.ok(f.state.read('status', null).alerts[`reconcile:${ORG}`]);

  f.queue({}, {});
  f.answer.c10 = () => problem(400, 'BODY_TOO_LARGE');
  await f.reconciler.run();
  assert.equal(f.state.read('reconcile', null).last.orgs[ORG].sent, 'rejected');
});

test('an indexed 400 is resent without the named items once, never twice', async (t) => {
  const f = await harness(t, { orgs: {} });
  f.queue({}, {}, {});
  f.answer.c10 = () => problem(400, 'VALIDATION_FAILED', { errors: [{ field: 'items[0].intent_id' }] });
  await f.reconciler.run();
  assert.deepEqual(f.reports(ORG).map((b) => b.length), [3, 2]);
});

test('an item too large for any report does not cut the current batch', () => {
  const small = (i) => ({ item: { kind: 'local_extra', skill_id: U(i) } });
  const big = { item: { kind: 'local_extra', skill_id: U(1), pad: 'x'.repeat(200) } };
  assert.deepEqual(batches([small(1), big, small(2)], { maxBytes: 160 }).map((b) => b.length), [2]);
});

test('C-10 results out of index order are refused and nothing is marked done', async (t) => {
  const f = await harness(t, { orgs: {} });
  f.queue({}, {});
  f.answer.c10 = () => ({ status: 200, json: { results: [{ index: 1, outcome: 'recorded' }, { index: 0, outcome: 'recorded' }] } });
  assert.equal((await f.reconciler.run()).outcome, 'partial');
  assert.equal(f.state.read('intents', null).queue.length, 2);
  assert.match(f.state.read('status', null).alerts[`reconcile:${ORG}`].message, /RESPONSE_INVALID/);
});

test('installing skills, skills with a report in flight and foreign markers are judged correctly', async (t) => {
  const f = await harness(t, { orgs: {} });
  f.skill(2, { onDisk: false });
  f.state.outbox.put(U(950), { kind: 'result', org_id: ORG, skill_id: SK(2), body: {} });
  f.skill(3, { onDisk: false });
  f.dir('enabled', 3, { skill_id: SK(4), version_no: 1, package_sha256: sha(3) });
  f.answer.c12[ORG] = () => ({ status: 200, json: { items: [listed(1, { state: 'installing' }), listed(2), listed(3)] } });
  await f.reconciler.run();
  assert.deepEqual(f.reports(ORG).flat(), [
    { kind: 'local_missing', skill_id: SK(3), skill_version_id: VER(3, 1) },
    { kind: 'local_extra', skill_id: SK(4), installed_sha256: sha(3) },
  ]);
});

test('a rollback is released only for the compared version and only its own marked directory', async (t) => {
  const f = await harness(t, { orgs: {} });
  f.skill(7, { v: 2, rollback: { version_no: 1, skill_version_id: VER(7, 1) } });
  const rb = path.join(f.dataDir, 'rollback', 's7', '1');
  fs.mkdirSync(rb, { recursive: true });
  fs.writeFileSync(path.join(rb, 'SKILL.md'), 'unmarked');
  assert.equal(f.skills.releaseRollback(SK(7), VER(7, 1)), false, 'record moved on');
  assert.ok(f.state.read('installs', {})[SK(7)].rollback);
  assert.equal(f.skills.releaseRollback(SK(7), VER(7, 2)), true);
  assert.equal(f.state.read('installs', {})[SK(7)].rollback, null);
  assert.ok(fs.existsSync(path.join(rb, 'SKILL.md')), 'an unmarked directory is left alone');
  assert.ok(!fs.existsSync(path.join(f.dataDir, 'trash')) || fs.readdirSync(path.join(f.dataDir, 'trash')).length === 0);
});

test('a release whose delete fails has already let go of the rollback and leaves the copy whole', async (t) => {
  const f = await harness(t, { orgs: {} });
  f.skill(7, { v: 2, rollback: { version_no: 1, skill_version_id: VER(7, 1) } });
  const rb = path.join(f.dataDir, 'rollback', 's7', '1');
  fs.mkdirSync(rb, { recursive: true });
  fs.writeFileSync(path.join(rb, 'SKILL.md'), 'old');
  fs.writeFileSync(path.join(rb, '.market-managed'), JSON.stringify({ skill_id: SK(7), version_no: 1 }));
  fs.writeFileSync(path.join(f.dataDir, 'trash'), 'not a directory');
  f.answer.c12[ORG] = () => ({ status: 200, json: { items: [listed(7, { v: 2 })] } });
  assert.equal((await f.reconciler.run()).outcome, 'ok');
  assert.equal(f.state.read('installs', {})[SK(7)].rollback, null);
  assert.deepEqual(fs.readdirSync(rb).sort(), ['.market-managed', 'SKILL.md']);
});

test('a budget read failing with any error, or a broken status.json, still does not abort reconcile', async (t) => {
  const f = await harness(t, { orgs: {} });
  const eacces = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
  const state = { ...f.state, read: (n, fb) => { if (n === 'reconcile') throw eacces; return f.state.read(n, fb); } };
  const r = createReconciler({ api: f.api, state, orgs: f.orgs, skills: f.skills, templates: f.templates, logger: f.logger, now: f.now });
  f.queue({});
  fs.writeFileSync(path.join(f.state.dir, 'status.json'), '{broken');
  assert.equal((await r.run()).outcome, 'rate_limited');
  assert.equal(f.reports().length, 0);
  const st = f.state.read('status', null);
  assert.ok(st.alerts['reconcile:budget']);
  assert.ok(st.alerts['corrupt:status']);
});

test('a budget that cannot be stored is not spent: nothing is sent', async (t) => {
  const f = await harness(t, { orgs: {} });
  const state = { ...f.state, write: (n, v) => { if (n === 'reconcile') throw new Error('ENOSPC'); return f.state.write(n, v); } };
  const r = createReconciler({ api: f.api, state, orgs: f.orgs, skills: f.skills, templates: f.templates, logger: f.logger, now: f.now });
  f.queue({});
  assert.equal((await r.run()).outcome, 'rate_limited');
  assert.equal(f.reports().length, 0);
});
