import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { AGENT, ORG, U, pullHarness } from './fake/pull.js';
import { startFakeStorage } from './fake/storage.js';
import { MANIFEST_SHA, templateBundle } from './fake/bundle.js';
import { fakeZylos } from './fake/zylos.js';
import { createIntentPuller } from '../src/intents.js';
import { EMPTY_REVOKED, createRevocationPuller } from '../src/revocations.js';
import { createTemplates } from '../src/templates.js';
import { ensureDeclarations, readSlots, shardsDir, writeSlots } from '../src/shards.js';
import { emitSlot } from '../src/shard-emitter.js';
import { POLICY_SHA256 } from '../src/policy/pin.js';
import { C02, SKILL, VID, skillHarness } from './fake/skills.js';
import { MAX_PACKAGE_BYTES, MAX_PACKAGE_FILES } from '../src/pkg/zip.js';

const ADOPTION = U(11);
const INTENT = U(12);
const B = `/api/v1/orgs/${ORG}`;
const C01 = `${B}/agents/${AGENT}/install-intents:query`;
const C04 = `${B}/agents/${AGENT}/packages/templates/${ADOPTION}`;
const C15 = `${B}/agents/${AGENT}/adoptions/${ADOPTION}/write-results`;
const applied = { status: 200, json: { adoption_id: ADOPTION, status: 'active', outcome: 'applied' } };
const intent = (over = {}) => ({
  id: INTENT, org_id: ORG, op: 'write_template', skill_id: null, skill_version_id: null, template_id: U(13), source_market_id: null,
  adoption_id: ADOPTION, discard_local_changes: false, expires_at: '2026-10-17T00:00:00Z', seq: 1, ...over,
});
const page = (items) => ({ status: 200, json: { items, has_more: false, next_after_seq: items.at(-1).seq, policy_sha256: POLICY_SHA256 } });

// Fake market and storage serving one template bundle through C-01, C-04 and C-15, and a zylos dir with declarations.
async function harness(t, { bundle = templateBundle(), served, c04, c15 = [applied, applied], items, setup } = {}) {
  const h = await pullHarness(t, { orgs: {} });
  const storage = await startFakeStorage();
  t.after(storage.close);
  const zylosDir = fakeZylos({ hooks: true });
  ensureDeclarations(zylosDir);
  h.fake.script('POST', C01, page(items ?? [intent({ bundle_sha256: bundle.sha })]));
  h.fake.script('GET', C04, ...(c04 ?? [{ status: 200, json: {
    download_url: storage.serve('/t', { status: 200, body: served ?? bundle.zip }), expires_at: '2026-10-16T00:05:00Z', sha256: bundle.sha, size: bundle.size,
  } }]));
  h.fake.script('POST', C15, ...c15);
  await createIntentPuller({ api: h.api, state: h.state, orgs: h.orgs, logger: h.logger, now: h.now }).pull();
  const revocations = createRevocationPuller({ api: h.api, state: h.state, orgs: h.orgs, logger: h.logger, now: h.now });
  const make = () => createTemplates({
    api: h.api, state: h.state, orgs: h.orgs, logger: h.logger, dataDir: h.dataDir, zylosDir, revocations, emulatorOrigin: storage.origin,
    now: h.now, sleep: async () => {},
  });
  const templates = make();
  setup?.(h.dataDir, h.state);
  const sent = () => h.fake.requests.filter((r) => r.path === C15).map((r) => r.json);
  return { ...h, bundle, zylosDir, make, templates, sent, dir: path.join(h.dataDir, 'templates', ADOPTION) };
}

test('a write intent lands the bundle, takes a slot, is emitted and reported with C-15', async (t) => {
  const f = await harness(t);
  assert.equal(await f.templates.runNext(), 'succeeded');
  const [body] = f.sent();
  assert.deepEqual(body, { request_id: body.request_id, intent_id: INTENT, kind: 'write', status: 'succeeded', rendered_sha256: f.bundle.sha });
  assert.equal(fs.readFileSync(path.join(f.dir, 'sop/triage.md'), 'utf8'), '# Triage\n');
  assert.equal(fs.statSync(path.join(f.dir, 'inject.md')).mode & 0o777, 0o600);
  assert.equal(readSlots(f.dataDir)['1'].adoption_id, ADOPTION);
  assert.match(emitSlot(1, { dataDir: f.dataDir }), /# Demo\n\nHelp with demos\.\n$/);
  assert.deepEqual(f.state.read('intents', null).queue, []);
  assert.equal(await f.templates.runNext(), null);
  assert.deepEqual(f.templates.reconcile(), []);
  fs.rmSync(path.join(f.dataDir, 'slots.json'));
  assert.deepEqual(f.templates.reconcile(), [{ kind: 'template_inject_missing', adoption_id: ADOPTION }]);
});

test('a sha mismatch or an over-budget inject segment writes nothing', async (t) => {
  const bundle = templateBundle();
  const served = Buffer.from(bundle.zip);
  served[40] ^= 1;
  const f = await harness(t, { bundle, served });
  assert.equal(await f.templates.runNext(), 'failed');
  assert.deepEqual([f.sent()[0].error_code, f.sent()[0].error_message], ['PACKAGE_MISMATCH', 'sha256_mismatch']);
  const g = await harness(t, { bundle: templateBundle({ inject: 'a'.repeat(8001) }) });
  assert.equal(await g.templates.runNext(), 'failed');
  assert.deepEqual([g.sent()[0].error_code, g.sent()[0].error_message], ['PACKAGE_UNSAFE', 'inject_too_large']);
  for (const x of [f, g]) {
    assert.equal(fs.existsSync(x.dir), false);
    assert.equal(readSlots(x.dataDir), null);
  }
});

test('no free slot, a revoked manifest or a local write failure is CLIENT_INTERNAL', async (t) => {
  const other = { adoption_id: U(20), inject_sha256: MANIFEST_SHA };
  const full = await harness(t, { setup: (d) => writeSlots(d, { 1: other, 2: other, 3: other, 4: other }) });
  assert.equal(await full.templates.runNext(), 'failed');
  assert.equal(full.sent()[0].error_message, 'slots_full');
  assert.equal(full.fake.requests.filter((r) => r.path === C04).length, 0);

  const revoked = await harness(t, { setup: (d, s) => s.write('revoked', { ...EMPTY_REVOKED, manifest_sha256: [MANIFEST_SHA] }) });
  assert.equal(await revoked.templates.runNext(), 'failed');
  assert.deepEqual([revoked.sent()[0].error_code, revoked.sent()[0].error_message], ['CLIENT_INTERNAL', 'role_write_failed']);
  assert.equal(fs.existsSync(revoked.dir), false);

  const broken = await harness(t, { setup: (d) => fs.writeFileSync(path.join(d, 'templates'), '') });
  assert.equal(await broken.templates.runNext(), 'failed');
  assert.equal(broken.sent()[0].error_message, 'role_write_failed');
});

test('C-04 404: C-11 is pulled, then C-01 decides between a failed report and dropping the intent', async (t) => {
  const notFound = { status: 404, problem: { code: 'NOT_FOUND' } };
  const f = await harness(t, { c04: [notFound], setup: () => {} });
  f.fake.script('POST', C01, (req) => page([intent({ bundle_sha256: f.bundle.sha })]));
  assert.equal(await f.templates.runNext(), 'failed');
  assert.equal(f.sent()[0].error_message, 'bundle_unavailable');
  const order = f.fake.market().map((r) => r.path.split('/').at(-1));
  assert.deepEqual(order.slice(-4), [ADOPTION, 'revocations:query', 'install-intents:query', 'write-results']);
  assert.deepEqual(f.fake.requests.filter((r) => r.path === C01).at(-1).json, { status: 'pending', after_seq: 0, limit: 1 });

  const g = await harness(t, { c04: [notFound] });
  g.fake.script('POST', C01, { status: 204 });
  assert.equal(await g.templates.runNext(), 'closed');
  assert.deepEqual(g.sent(), []);
  assert.deepEqual(g.state.read('intents', null).queue, []);
});

test('a revoked template is unmapped and quarantined, never deleted; its slot is free again', async (t) => {
  const f = await harness(t);
  await f.templates.runNext();
  f.state.write('revoked', { ...EMPTY_REVOKED, manifest_sha256: [MANIFEST_SHA] });
  f.templates.sweepRevoked();
  assert.equal(readSlots(f.dataDir)['1'], null);
  assert.equal(emitSlot(1, { dataDir: f.dataDir }), '');
  assert.equal(fs.existsSync(f.dir), false);
  assert.equal(fs.readFileSync(path.join(f.dataDir, 'quarantine', ADOPTION, 'sop/triage.md'), 'utf8'), '# Triage\n');
  assert.equal(f.state.read('adoptions', {})[ADOPTION].state, 'quarantined');
  assert.deepEqual(f.templates.reconcile(), []);
});

test('uninstall removes the content and slot; an unknown adoption only leaves a tombstone', async (t) => {
  const f = await harness(t);
  await f.templates.runNext();
  const removal = intent({ id: U(14), op: 'uninstall', seq: 2 });
  f.state.update('intents', null, (d) => { d.queue.push({ ...removal, status: 'queued' }); });
  assert.equal(await f.templates.runNext(), 'succeeded');
  const body = f.sent()[1];
  assert.deepEqual(body, { request_id: body.request_id, intent_id: U(14), kind: 'uninstall', status: 'succeeded' });
  assert.equal(fs.existsSync(f.dir), false);
  assert.equal(readSlots(f.dataDir)['1'], null);

  const g = await harness(t, { items: [removal], c15: [applied] });
  fs.mkdirSync(g.dir, { recursive: true });
  assert.equal(await g.templates.runNext(), 'succeeded');
  assert.equal(fs.existsSync(g.dir), true);
  assert.deepEqual(g.state.read('epoch', null).tombstones.map((x) => x.adoption_id), [ADOPTION]);
});

test('an undelivered C-15 result is kept and resent unchanged', async (t) => {
  const f = await harness(t, { c15: [{ status: 503, problem: { code: 'DEPENDENCY_UNAVAILABLE' } }, applied] });
  assert.equal(await f.templates.runNext(), 'deferred');
  assert.equal(await f.templates.runNext(), null);
  const raw = f.fake.requests.filter((r) => r.path === C15).map((r) => r.body);
  assert.equal(raw.length, 2);
  assert.equal(raw[0], raw[1]);
  assert.deepEqual(f.state.read('template_reports', {}), {});
});

test('locally modified content is not overwritten without discard_local_changes and is reported by reconcile', async (t) => {
  const f = await harness(t);
  await f.templates.runNext();
  fs.appendFileSync(path.join(f.dir, 'sop/triage.md'), 'edited\n');
  assert.deepEqual(f.templates.reconcile().map((i) => i.kind), ['template_locally_modified']);
  const upgrade = templateBundle({ inject: '# Demo v2\n' });
  f.state.update('intents', null, (d) => { d.queue.push({ ...intent({ id: U(15), seq: 2, bundle_sha256: upgrade.sha }), status: 'queued' }); });
  assert.equal(await f.templates.runNext(), 'failed');
  assert.deepEqual([f.sent()[1].error_code, f.sent()[1].error_message], ['INSTALL_TARGET_CONFLICT', 'locally_modified']);

  const g = await harness(t, { setup: (d) => fs.mkdirSync(path.join(d, 'templates', ADOPTION), { recursive: true }) });
  assert.equal(await g.templates.runNext(), 'failed');
  assert.equal(g.sent()[0].error_message, 'target_exists');
});

test('a new epoch clears the slot map and quarantines adoption dirs only when slots.json is readable', async (t) => {
  const f = await harness(t);
  await f.templates.runNext();
  const templates = path.join(f.dataDir, 'templates');
  fs.mkdirSync(path.join(templates, 'keep-me'));
  fs.mkdirSync(path.join(templates, ADOPTION.toUpperCase()));
  const decls = fs.readdirSync(shardsDir(f.zylosDir)).sort();
  const restart = () => { f.state.write('epoch', null); f.make(); };

  fs.writeFileSync(path.join(f.dataDir, 'slots.json'), 'not json');
  restart();
  assert.equal(fs.existsSync(f.dir), true);
  assert.ok(f.state.read('status', null).alerts.template_epoch);

  writeSlots(f.dataDir, { 1: { adoption_id: ADOPTION, inject_sha256: MANIFEST_SHA } });
  fs.rmSync(path.join(f.dataDir, 'slots.json'));
  f.state.write('epoch', null);
  f.make();
  assert.equal(fs.existsSync(f.dir), true);
  assert.equal(fs.existsSync(path.join(f.dataDir, 'slots.json')), false);

  writeSlots(f.dataDir, { 1: { adoption_id: ADOPTION, inject_sha256: MANIFEST_SHA } });
  restart();
  assert.deepEqual(Object.values(readSlots(f.dataDir)), [null, null, null, null]);
  assert.deepEqual(fs.readdirSync(templates).sort(), [ADOPTION.toUpperCase(), 'keep-me'].sort());
  assert.ok(fs.existsSync(path.join(f.dataDir, 'quarantine', ADOPTION, 'inject.md')));
  assert.deepEqual(fs.readdirSync(shardsDir(f.zylosDir)).sort(), decls);
});

test('skill and template intents of one org run in seq order across both runners', async (t) => {
  const h = await skillHarness(t);
  const zylosDir = fakeZylos({ hooks: true });
  ensureDeclarations(zylosDir);
  const bundle = templateBundle();
  h.fake.script('GET', C04, { status: 200, json: {
    download_url: h.storage.serve('/t', { status: 200, body: bundle.zip }), expires_at: '2026-10-16T00:05:00Z', sha256: bundle.sha, size: bundle.size,
  } });
  h.fake.script('POST', C15, applied);
  const skillIntent = (id, seq, op, n = null) => intent({ id: U(id), seq, op, skill_id: SKILL, skill_version_id: n ? VID(n) : null, template_id: null, adoption_id: null });
  h.fake.script('POST', C01, page([skillIntent(30, 1, 'install', 1), intent({ seq: 2, bundle_sha256: bundle.sha }), skillIntent(31, 3, 'disable')]));
  await createIntentPuller({ api: h.api, state: h.state, orgs: h.orgs, logger: h.logger, now: h.now }).pull();
  const skills = h.make();
  const templates = createTemplates({
    api: h.api, state: h.state, orgs: h.orgs, logger: h.logger, dataDir: h.dataDir, zylosDir, emulatorOrigin: h.storage.origin, now: h.now, sleep: async () => {},
  });
  const order = () => h.fake.requests.map((r) => r.path).filter((p) => p.endsWith('/install-requests') || p === C15 || p.endsWith(':set-enabled'));
  assert.equal(await templates.runNext(), null);
  assert.deepEqual(await skills.runRound(), ['succeeded']);
  assert.equal(h.state.read('intents', null).queue.find((q) => q.id === U(31)).status, 'queued');
  assert.equal(await templates.runNext(), 'succeeded');
  assert.deepEqual(await skills.runRound(), ['done']);
  assert.deepEqual(order(), [C02, C15, `${B}/agents/${AGENT}/skills/${SKILL}:set-enabled`]);
  assert.deepEqual(h.state.read('intents', null).queue, []);
});

test('a bundle over the size or file caps is PACKAGE_UNSAFE too_large / too_many_files', async (t) => {
  const big = templateBundle();
  const f = await harness(t, { bundle: big, c04: [{ status: 200, json: {
    download_url: 'https://storage.googleapis.com/x', expires_at: '2026-10-16T00:05:00Z', sha256: big.sha, size: MAX_PACKAGE_BYTES + 1,
  } }] });
  assert.equal(await f.templates.runNext(), 'failed');
  assert.deepEqual([f.sent()[0].error_code, f.sent()[0].error_message], ['PACKAGE_UNSAFE', 'too_large']);
  const files = Object.fromEntries(Array.from({ length: MAX_PACKAGE_FILES }, (_, i) => [`sop/s${i}.md`, 'x']));
  const g = await harness(t, { bundle: templateBundle({ files }) });
  assert.equal(await g.templates.runNext(), 'failed');
  assert.deepEqual([g.sent()[0].error_code, g.sent()[0].error_message], ['PACKAGE_UNSAFE', 'too_many_files']);
  for (const x of [f, g]) assert.equal(fs.existsSync(x.dir), false);
});

test('copies a crash left inside land() are cleaned up at start: a replaced copy comes back when the swap did not happen', async (t) => {
  const f = await harness(t);
  await f.templates.runNext();
  const root = path.join(f.dataDir, 'templates');
  const OTHER = U(30);
  const put = (name, content) => { fs.mkdirSync(path.join(root, name), { recursive: true }); fs.writeFileSync(path.join(root, name, 'inject.md'), content); };
  put(`${ADOPTION}.new-aaaaaaaaaaaa`, 'staged');
  put(`${ADOPTION}.old-bbbbbbbbbbbb`, 'replaced');
  put(`${OTHER}.old-cccccccccccc`, 'only copy');
  put(`${OTHER}.new-dddddddddddd`, 'staged');
  put('keep.new-eeeeeeeeeeee', 'not ours');
  put(`${ADOPTION}.new-short`, 'not ours');
  f.make();
  assert.deepEqual(fs.readdirSync(root).sort(), [ADOPTION, `${ADOPTION}.new-short`, OTHER, 'keep.new-eeeeeeeeeeee'].sort());
  assert.equal(fs.readFileSync(path.join(f.dir, 'inject.md'), 'utf8'), '# Demo\n\nHelp with demos.\n');
  assert.equal(fs.readFileSync(path.join(root, OTHER, 'inject.md'), 'utf8'), 'only copy');
  assert.deepEqual(fs.readdirSync(path.join(f.dataDir, 'trash')), []);
});

test('a template uninstall also removes the copies of that adoption a crash left behind', async (t) => {
  const f = await harness(t);
  await f.templates.runNext();
  const root = path.join(f.dataDir, 'templates');
  for (const n of [`${ADOPTION}.new-aaaaaaaaaaaa`, `${ADOPTION}.old-bbbbbbbbbbbb`, `${U(30)}.new-cccccccccccc`]) fs.mkdirSync(path.join(root, n));
  f.state.update('intents', null, (d) => { d.queue.push({ ...intent({ id: U(14), op: 'uninstall', seq: 2 }), status: 'queued' }); });
  assert.equal(await f.templates.runNext(), 'succeeded');
  assert.deepEqual(fs.readdirSync(root), [`${U(30)}.new-cccccccccccc`]);
});

test('without the slot hooks, or with a revoked bundle sha, nothing is written', async (t) => {
  const f = await harness(t, { setup: () => {} });
  fs.rmSync(path.join(f.zylosDir, '.claude', 'settings.json'));
  assert.equal(await f.templates.runNext(), 'failed');
  assert.deepEqual([f.sent()[0].error_code, f.sent()[0].error_message], ['CLIENT_INTERNAL', 'inject_unavailable']);
  assert.equal(f.fake.requests.filter((r) => r.path === C04).length, 0);
  assert.equal(fs.existsSync(f.dir), false);

  for (const key of ['sha_block', 'package_sha256']) {
    const g = await harness(t);
    g.state.write('revoked', { ...EMPTY_REVOKED, [key]: [g.bundle.sha] });
    assert.equal(await g.templates.runNext(), 'failed', key);
    assert.deepEqual([g.sent()[0].error_code, g.sent()[0].error_message], ['CLIENT_INTERNAL', 'role_write_failed']);
    assert.equal(fs.existsSync(g.dir), false);
  }
});

test('reconcile frees slots of adoptions no longer active and reports a slot whose sha is not the landed one', async (t) => {
  const f = await harness(t);
  await f.templates.runNext();
  const ghost = { adoption_id: U(31), inject_sha256: MANIFEST_SHA };
  writeSlots(f.dataDir, { ...readSlots(f.dataDir), 2: ghost });
  f.state.update('adoptions', {}, (d) => { d[U(31)] = { adoption_id: U(31), state: 'removed' }; });
  assert.deepEqual(f.templates.reconcile(), []);
  assert.equal(readSlots(f.dataDir)['2'], null);
  writeSlots(f.dataDir, { 1: { adoption_id: ADOPTION, inject_sha256: MANIFEST_SHA } });
  assert.deepEqual(f.templates.reconcile(), [{ kind: 'template_inject_missing', adoption_id: ADOPTION }]);
  fs.appendFileSync(path.join(f.dir, 'sop/triage.md'), 'edited\n');
  writeSlots(f.dataDir, { 1: { adoption_id: ADOPTION, inject_sha256: f.state.read('adoptions', {})[ADOPTION].inject_sha256 } });
  assert.deepEqual(f.templates.reconcile(), [{ kind: 'template_locally_modified', adoption_id: ADOPTION, rendered_sha256: f.bundle.sha }]);
});

test('a revocation whose quarantine fails has already stopped the injection', async (t) => {
  const f = await harness(t);
  await f.templates.runNext();
  fs.writeFileSync(path.join(f.dataDir, 'quarantine'), '');
  f.state.write('revoked', { ...EMPTY_REVOKED, manifest_sha256: [MANIFEST_SHA] });
  assert.throws(() => f.templates.sweepRevoked());
  assert.equal(readSlots(f.dataDir)['1'], null);
  assert.equal(emitSlot(1, { dataDir: f.dataDir }), '');
});
