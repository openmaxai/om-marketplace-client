import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { AGENT, ORG, U, pullHarness } from './fake/pull.js';
import { startFakeStorage } from './fake/storage.js';
import { templateBundle } from './fake/bundle.js';
import { fakeZylos } from './fake/zylos.js';
import { tmpHome } from './helpers.js';
import { fakeControl } from './fake/control.js';
import { createIntentPuller } from '../src/intents.js';
import { createTemplates } from '../src/templates.js';
import { createReconciler } from '../src/reconcile.js';
import {
  ACTIVATION_CHECK_MS, DAILY_WELCOME_REQUESTS, NEW_SESSION_TEXT, WELCOME_MAX_HOLD_MS, WELCOME_REQUEST_INTERVAL_MS, createActivation,
} from '../src/activation.js';
import { ensureDeclarations, readSlots } from '../src/shards.js';
import { MARKER_FILE, emitSlot } from '../src/shard-emitter.js';
import { POLICY_SHA256 } from '../src/policy/pin.js';

const ADOPTION = U(11);
const ADOPTER = U(30);
const B = `/api/v1/orgs/${ORG}/agents/${AGENT}`;
const C01 = `${B}/install-intents:query`;
const C04 = `${B}/packages/templates/${ADOPTION}`;
const C15 = `${B}/adoptions/${ADOPTION}/write-results`;
const C10 = `${B}/reconcile`;
const applied = { status: 200, json: { adoption_id: ADOPTION, status: 'active', outcome: 'applied' } };
const recordAll = (req) => ({ status: 200, json: { results: req.json.items.map((_, index) => ({ index, outcome: 'recorded' })) } });

// Template write, uninstall and activation end to end: fake market and storage, a zylos dir with the slot hooks, a
// fake control queue, a fake runtime status file and the real shard emitter writing the marker.
async function flow(t, { starterMessage = false } = {}) {
  const h = await pullHarness(t, { orgs: {} });
  const storage = await startFakeStorage();
  t.after(storage.close);
  const zylosDir = fakeZylos({ hooks: true });
  ensureDeclarations(zylosDir);
  const queue = fakeControl(zylosDir, path.join(tmpHome(), 'controls.jsonl'));
  const controls = queue.enqueued;
  const statusFile = path.join(zylosDir, 'activity-monitor', 'agent-status.json');
  fs.mkdirSync(path.dirname(statusFile), { recursive: true });
  const status = (over = {}) => {
    fs.writeFileSync(statusFile, JSON.stringify({ state: 'idle', active_tools: 0, idle_seconds: 600, ...over }));
    fs.utimesSync(statusFile, h.clock.t / 1000, h.clock.t / 1000);
  };
  const bundle = templateBundle();
  let seq = 0;
  const order = async (op) => {
    seq += 1;
    const it = {
      id: U(1000 + seq), org_id: ORG, op, skill_id: null, skill_version_id: null, template_id: U(13), source_market_id: null, adoption_id: ADOPTION,
      discard_local_changes: false, expires_at: '2026-10-17T00:00:00Z', seq,
      ...(op === 'write_template' ? { bundle_sha256: bundle.sha } : {}),
      ...(starterMessage ? { starter_message: true, adopted_by_member_id: ADOPTER } : {}),
    };
    intents.push(it);
    h.fake.script('POST', C01, { status: 200, json: { items: [it], has_more: false, next_after_seq: seq, policy_sha256: POLICY_SHA256 } });
    await createIntentPuller({ api: h.api, state: h.state, orgs: h.orgs, logger: h.logger, now: h.now }).pull();
  };
  h.fake.script('GET', C04, { status: 200, json: {
    download_url: storage.serve('/t', { status: 200, body: bundle.zip }), expires_at: '2026-10-16T00:05:00Z', sha256: bundle.sha, size: bundle.size,
  } });
  h.fake.script('POST', C15, applied, applied);
  const starts = [];
  const starter = { enqueue: (x) => starts.push(x) };
  let reconcile = null;
  const activation = createActivation({
    state: h.state, dataDir: h.dataDir, zylosDir, logger: h.logger, im: { available: () => false }, flush: () => reconcile.flushUrgent(), now: h.now,
  });
  const templates = createTemplates({
    api: h.api, state: h.state, orgs: h.orgs, logger: h.logger, dataDir: h.dataDir, zylosDir, emulatorOrigin: storage.origin, now: h.now,
    sleep: async () => {}, starter, activation,
  });
  reconcile = createReconciler({ api: h.api, state: h.state, orgs: h.orgs, skills: null, templates, logger: h.logger, now: h.now });
  // A session starts: zylos runs the four shards, the first writes the marker.
  const session = () => [1, 2, 3, 4].map((n) => emitSlot(n, { dataDir: h.dataDir, now: h.now }));
  const reports = () => h.fake.requests.filter((r) => r.path === C10).map((r) => r.json.items);
  const writeResults = () => h.fake.requests.filter((r) => r.path === C15).map((r) => r.json);
  const intents = [];
  return { ...h, queue, intents, writeResults, bundle, zylosDir, controls, status, order, templates, activation, reconcile, starts, session, reports };
}

test('a template write is activated: idle Agent asked through the control queue, marker written, template_activated reported', async (t) => {
  const f = await flow(t);
  await f.order('write_template');
  f.status({ state: 'busy' });
  assert.equal(await f.templates.runNext(), 'succeeded');
  assert.equal(readSlots(f.dataDir)['1'].bundle_sha256, f.bundle.sha);
  assert.deepEqual(f.controls(), []);
  assert.equal(await f.activation.tick(), 'busy');
  f.clock.t += ACTIVATION_CHECK_MS;
  f.status();
  assert.equal(await f.activation.tick(), 'sampled');
  f.clock.t += ACTIVATION_CHECK_MS;
  f.status();
  assert.equal(await f.activation.tick(), 'requested');
  assert.deepEqual(f.controls(), [[
    'enqueue', '--content', NEW_SESSION_TEXT, '--block-queue-until-idle', '--no-ack-suffix', '--ack-deadline', '21600',
  ]]);
  f.clock.t += 20_000;
  const out = f.session();
  assert.match(out[0], /# Demo/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.dataDir, MARKER_FILE), 'utf8')), {
    at: new Date(f.clock.t).toISOString(), items: [{ adoption_id: ADOPTION, rendered_sha256: f.bundle.sha }],
  });
  f.fake.script('POST', C10, recordAll);
  f.clock.t += ACTIVATION_CHECK_MS;
  assert.equal(await f.activation.tick(), 'confirmed');
  assert.deepEqual(f.reports(), [[{ kind: 'template_activated', adoption_id: ADOPTION, rendered_sha256: f.bundle.sha }]]);
  // The bundle sha of the write intent, as on the C-15 write result; never a per-file sha.
  const intentSha = f.intents[0].bundle_sha256;
  assert.equal(f.reports()[0][0].rendered_sha256, intentSha);
  assert.equal(f.reports()[0][0].rendered_sha256, f.writeResults()[0].rendered_sha256);
  const rec = f.state.read('adoptions', {})[ADOPTION];
  assert.equal(rec.bundle_sha256, intentSha);
  assert.ok(![rec.inject_sha256, rec.role_sha256, rec.manifest_sha256].includes(intentSha));
  assert.equal(f.state.read('activation', null).pending, null);
  assert.equal(f.controls().length, 1);
  // The request was still queued (the fake never delivers it): confirmed by the session, it is withdrawn.
  assert.deepEqual(f.queue.statuses(), ['done']);

  // Uninstall: the slot is freed; the next session must not show it; nothing is reported for a removal.
  await f.order('uninstall');
  assert.equal(await f.templates.runNext(), 'succeeded');
  assert.deepEqual(f.state.read('activation', null).pending.removed, [ADOPTION]);
  f.clock.t += 1000;
  assert.deepEqual(f.session(), ['', '', '', '']);
  assert.equal(await f.activation.tick(), 'confirmed');
  assert.equal(f.state.read('activation', null).pending, null);
  assert.equal(f.reports().length, 1);
});

test('starter message: an Agent idle 30 s is asked for a new session at once and the message is held until the session', async (t) => {
  const f = await flow(t, { starterMessage: true });
  await f.order('write_template');
  f.status({ idle_seconds: 45 });
  assert.equal(await f.templates.runNext(), 'succeeded');
  assert.equal(f.controls().length, 1);
  assert.deepEqual(f.starts, [{ orgId: ORG, adoptionId: ADOPTION, adoptedBy: ADOPTER, content: null, holdUntil: f.clock.t + WELCOME_MAX_HOLD_MS }]);
  assert.equal(f.activation.isPending(ADOPTION), true);
  f.clock.t += 1000;
  f.session();
  f.fake.script('POST', C10, recordAll);
  assert.equal(await f.activation.tick(), 'confirmed');
  assert.equal(f.activation.isPending(ADOPTION), false);
});

test('starter message: 10 minutes after an automatic request, the Agent is still asked at once and the message held', async (t) => {
  const f = await flow(t, { starterMessage: true });
  f.state.update('activation', {}, (d) => ({ ...d, requests: [new Date(f.clock.t - 10 * 60 * 1000).toISOString()] }));
  await f.order('write_template');
  f.status({ idle_seconds: 45 });
  assert.equal(await f.templates.runNext(), 'succeeded');
  assert.equal(f.controls().length, 1);
  assert.equal(f.starts[0].holdUntil, f.clock.t + WELCOME_MAX_HOLD_MS);
});

test('starter message: with the starter requests of the day used up, the message is held until the session', async (t) => {
  const f = await flow(t, { starterMessage: true });
  // Earlier today (the fake clock starts at midnight UTC), the last one 2 minutes ago, so only the daily cap blocks.
  f.clock.t += 4 * 60 * 1000;
  const used = Array.from({ length: DAILY_WELCOME_REQUESTS }, (_, i) => new Date(f.clock.t - WELCOME_REQUEST_INTERVAL_MS - i * 5000).toISOString());
  f.state.update('activation', {}, (d) => ({ ...d, welcome_requests: used }));
  await f.order('write_template');
  f.status({ idle_seconds: 45 });
  assert.equal(await f.templates.runNext(), 'succeeded');
  assert.deepEqual(f.controls(), []);
  assert.equal(f.starts[0].holdUntil, f.clock.t + WELCOME_MAX_HOLD_MS);
  assert.deepEqual(f.state.read('activation', null).pending.welcome, [ADOPTION]);
});

test('starter message: a busy Agent is not asked at once; the message is held until the template is in a session', async (t) => {
  const f = await flow(t, { starterMessage: true });
  await f.order('write_template');
  f.status({ state: 'busy', idle_seconds: 0 });
  assert.equal(await f.templates.runNext(), 'succeeded');
  assert.deepEqual(f.controls(), []);
  assert.equal(f.starts[0].holdUntil, f.clock.t + WELCOME_MAX_HOLD_MS);
  assert.deepEqual(f.state.read('activation', null).pending.welcome, [ADOPTION]);
});

test('the marker is written by the first shard only, also when nothing is printed, and never breaks the shard', async (t) => {
  const f = await flow(t);
  const marker = path.join(f.dataDir, MARKER_FILE);
  assert.equal(emitSlot(2, { dataDir: f.dataDir }), '');
  assert.equal(fs.existsSync(marker), false);
  assert.equal(emitSlot(1, { dataDir: f.dataDir, now: f.now }), '');
  assert.deepEqual(JSON.parse(fs.readFileSync(marker, 'utf8')), { at: new Date(f.clock.t).toISOString(), items: [] });
  fs.writeFileSync(path.join(f.dataDir, 'slots.json'), '{');
  assert.equal(emitSlot(1, { dataDir: f.dataDir, now: f.now }), '');
  assert.equal(emitSlot(1, { dataDir: path.join(f.dataDir, 'missing', 'dir') }), '');
});

// An Agent upgraded from 0.5.4: its adoption was written without an activation record and its slot has no bundle
// sha256. 0.6.0 seeds it once, fills the slot, never asks for a session for it, and reports it when a session shows it.
test('upgrade from 0.5.4: an earlier adoption is confirmed by the next natural session, without a request', async (t) => {
  const f = await flow(t);
  await f.order('write_template');
  f.status({ state: 'busy' });
  assert.equal(await f.templates.runNext(), 'succeeded');
  // The state 0.5.4 left: no activation document, no bundle_sha256 in the slot, no marker.
  const slotsFile = path.join(f.dataDir, 'slots.json');
  const slots = JSON.parse(fs.readFileSync(slotsFile, 'utf8'));
  delete slots['1'].bundle_sha256;
  fs.writeFileSync(slotsFile, JSON.stringify(slots));
  f.state.write('activation', {});
  const start = () => createActivation({
    state: f.state, dataDir: f.dataDir, zylosDir: f.zylosDir, logger: f.logger, im: { available: () => false }, flush: () => f.reconcile.flushUrgent(), now: f.now,
  });
  const a = start();
  assert.equal(readSlots(f.dataDir)['1'].bundle_sha256, f.bundle.sha);
  const doc = f.state.read('activation', null);
  assert.equal(doc.backfilled, true);
  assert.equal(doc.pending, null);
  assert.deepEqual(doc.passive.targets, [{ adoption_id: ADOPTION, rendered_sha256: f.bundle.sha }]);
  // An idle Agent is not asked for a session for it.
  for (let i = 0; i < 4; i++) {
    f.status();
    assert.equal(await a.tick(), 'none');
    f.clock.t += ACTIVATION_CHECK_MS;
  }
  assert.deepEqual(f.controls(), []);
  // Seeded once only.
  start();
  assert.deepEqual(f.state.read('activation', null).passive.targets.length, 1);
  f.fake.script('POST', C10, recordAll);
  f.session();
  f.clock.t += 1000;
  assert.equal(await a.tick(), 'none');
  assert.deepEqual(f.reports(), [[{ kind: 'template_activated', adoption_id: ADOPTION, rendered_sha256: f.bundle.sha }]]);
  assert.equal(f.state.read('activation', null).passive, null);
  assert.deepEqual(f.controls(), []);
  start();
  assert.equal(f.state.read('activation', null).passive, null);
});
