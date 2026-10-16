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
  const zylosDir = fakeZylos();
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
    assert.equal(readSlots(x.dataDir)['1'], null);
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

  writeSlots(f.dataDir, { 1: { adoption_id: ADOPTION, inject_sha256: MANIFEST_SHA } });
  restart();
  assert.deepEqual(Object.values(readSlots(f.dataDir)), [null, null, null, null]);
  assert.deepEqual(fs.readdirSync(templates).sort(), [ADOPTION.toUpperCase(), 'keep-me'].sort());
  assert.ok(fs.existsSync(path.join(f.dataDir, 'quarantine', ADOPTION, 'inject.md')));
  assert.deepEqual(fs.readdirSync(shardsDir(f.zylosDir)).sort(), decls);
});
