import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AGENT, ORG, ORG2, U, pullHarness } from './fake/pull.js';
import fs from 'node:fs';
import path from 'node:path';
import { MAX_QUEUE, MAX_UNREPORTED, createIntentPuller, tooOld } from '../src/intents.js';
import { POLICY_SHA256 } from '../src/policy/pin.js';

const PATH = `/api/v1/orgs/${ORG}/agents/${AGENT}/install-intents:query`;
const intent = (seq, over = {}) => ({
  id: U(100 + seq), org_id: ORG, op: 'install', skill_id: U(2), skill_version_id: U(3), template_id: null,
  source_market_id: U(4), adoption_id: null, discard_local_changes: false, expires_at: '2026-10-17T00:00:00Z', seq, ...over,
});
const page = (items, next, more = false, policy = POLICY_SHA256) => ({
  status: 200, json: { items, has_more: more, next_after_seq: next, policy_sha256: policy },
});

async function setup(t, opts) {
  const h = await pullHarness(t, opts);
  return { ...h, puller: createIntentPuller({ api: h.api, state: h.state, orgs: h.orgs, logger: h.logger, now: h.now }) };
}
const sentSeqs = (fake) => fake.market().map((r) => r.json.after_seq);

test('pages are queued with the cursor until has_more is false; 204 leaves the cursor', async (t) => {
  const { fake, puller, state } = await setup(t);
  const other = intent(2, { org_id: ORG2 });
  const unknown = intent(3, { org_id: 'other:org@x' });
  fake.script('POST', PATH, page([intent(1), other], 2, true), page([unknown], 3, true), page([], 8), { status: 204 });
  assert.deepEqual(await puller.pull(), { outcome: 'ok', added: 3 });
  assert.deepEqual(sentSeqs(fake), [0, 2, 3]);
  const doc = state.read('intents', null);
  assert.equal(doc.after_seq, 8);
  assert.deepEqual(doc.queue.map((it) => [it.seq, it.status]), [[1, 'queued'], [2, 'queued'], [3, 'org_not_configured']]);
  assert.deepEqual(await puller.pull(), { outcome: 'ok', added: 0 });
  assert.deepEqual(sentSeqs(fake), [0, 2, 3, 8]);
  assert.equal(state.read('intents', null).after_seq, 8);
  assert.equal(state.read('status', null).runs.intents.outcome, 'ok');
});

test('the cursor survives a restart and a failed page keeps earlier pages', async (t) => {
  const { fake, puller, state, api, orgs, logger } = await setup(t);
  fake.script('POST', PATH, page([intent(1)], 1, true), { status: 503, problem: { code: 'DEPENDENCY_UNAVAILABLE' } });
  assert.deepEqual(await puller.pull(), { outcome: 'transient', added: 1 });
  assert.equal(state.read('intents', null).after_seq, 1);
  const again = createIntentPuller({ api, state, orgs, logger });
  fake.script('POST', PATH, page([intent(2)], 2));
  await again.pull();
  assert.deepEqual(sentSeqs(fake), [0, 1, 1]);
  assert.deepEqual(state.read('intents', null).queue.map((it) => it.seq), [1, 2]);
});

test('a policy mismatch enters too-old mode without queuing or moving the cursor', async (t) => {
  const { fake, puller, state, lines } = await setup(t);
  fake.script('POST', PATH, page([intent(1)], 1, false, 'cd'.repeat(32)), { status: 204 }, page([intent(1)], 1));
  assert.equal((await puller.pull()).outcome, 'too_old');
  assert.deepEqual(state.read('intents', { after_seq: 0, queue: [] }), { after_seq: 0, queue: [] });
  assert.equal(tooOld(state).reason, 'policy_mismatch');
  assert.ok(lines.some((l) => l.includes('[warn]') && l.includes('differs from the pinned policy')));
  await puller.pull();
  assert.equal(tooOld(state).reason, 'policy_mismatch', '204 carries no policy and does not clear the mismatch');
  assert.equal((await puller.pull()).added, 1);
  assert.equal(tooOld(state), null);
  assert.equal(state.read('status', null).alerts.client_too_old, undefined);
});

test('CLIENT_VERSION_TOO_OLD enters too-old mode with min_version; a later 204 leaves it', async (t) => {
  const { fake, puller, state } = await setup(t);
  fake.script('POST', PATH, { status: 409, problem: { code: 'CLIENT_VERSION_TOO_OLD', reason: 'below_minimum', min_version: '2.0.0' } }, { status: 204 });
  assert.equal((await puller.pull()).outcome, 'too_old');
  assert.deepEqual(tooOld(state), { reason: 'below_minimum', min_version: '2.0.0', since: '2026-10-16T00:00:00.000Z' });
  assert.match(state.read('status', null).alerts.client_too_old.message, /minimum 2\.0\.0/);
  assert.equal((await puller.pull()).outcome, 'ok');
  assert.equal(tooOld(state), null);
});

test('MEMBER_LEFT_ORG (departed) marks the primary org invalid and stops pulling without another org', async (t) => {
  const { fake, puller, state, orgs, lines } = await setup(t);
  fake.script('POST', PATH, { status: 403, problem: { code: 'MEMBER_LEFT_ORG', reason: 'member_departed' } });
  assert.equal((await puller.pull()).outcome, 'org_left');
  assert.equal(orgs.membership(ORG), 'invalid');
  assert.match(state.read('status', null).alerts[`org_membership:${ORG}`].message, /pulling has stopped for ALL orgs/);
  assert.ok(lines.some((l) => l.includes('[warn]') && l.includes('pulling has stopped for ALL orgs')));
  assert.equal((await puller.pull()).outcome, 'org_left');
  assert.equal(fake.market().length, 1, 'no further pulls through any org');
});

test('intents of a suspended or departed org are kept but not runnable', async (t) => {
  const { fake, puller, state, orgs } = await setup(t, { orgs: { [ORG2]: {}, [U(9)]: {} } });
  orgs.markLeft(ORG2, 'member_departed');
  orgs.markLeft(U(9), 'member_suspended');
  fake.script('POST', PATH, page([intent(1, { org_id: ORG2 }), intent(2, { org_id: U(9) })], 2));
  await puller.pull();
  assert.deepEqual(state.read('intents', null).queue.map((it) => it.status), ['org_invalid', 'org_suspended']);
});

test('a re-delivered intent id is queued once', async (t) => {
  const { fake, puller, state } = await setup(t);
  fake.script('POST', PATH, page([intent(1)], 1), page([intent(2, { id: intent(1).id })], 2));
  await puller.pull();
  await puller.pull();
  const doc = state.read('intents', null);
  assert.deepEqual(doc.queue.map((it) => it.seq), [1]);
  assert.equal(doc.after_seq, 2);
});

test('every intents write holds each item the cursor has passed', async (t) => {
  const { fake, puller, state } = await setup(t);
  const writes = [];
  const write = state.write;
  state.write = (name, value) => {
    if (name === 'intents') writes.push(structuredClone(value));
    return write(name, value);
  };
  fake.script('POST', PATH, page([intent(1), intent(2)], 2, true), page([intent(3)], 5));
  await puller.pull();
  assert.equal(writes.length, 2);
  for (const w of writes) {
    for (const seq of [1, 2, 3].filter((n) => n <= w.after_seq)) assert.ok(w.queue.some((it) => it.seq === seq), `seq ${seq}`);
  }
});

test('a full queue stops the cursor at the last queued item and raises an alert until it drains', async (t) => {
  const { fake, puller, state, clock, lines } = await setup(t);
  const filler = Array.from({ length: MAX_QUEUE - 1 }, (_, i) => ({ ...intent(0, { id: U(5000 + i) }), status: 'queued' }));
  const expired = { ...intent(0, { id: U(9000), expires_at: '2026-10-15T00:00:00Z' }), status: 'queued' };
  state.write('intents', { after_seq: 0, queue: [...filler, expired] });
  fake.script('POST', PATH, page([intent(1), intent(2), intent(3)], 9));
  assert.deepEqual(await puller.pull(), { outcome: 'queue_full', added: 1 });
  let doc = state.read('intents', null);
  assert.equal(doc.queue.length, MAX_QUEUE);
  assert.ok(!doc.queue.some((it) => it.id === U(9000)), 'expired intent dropped');
  assert.equal(doc.after_seq, 1);
  assert.match(state.read('status', null).alerts.intents_queue_full.message, /queue is full/);
  assert.equal(lines.filter((l) => l.includes('[warn]') && l.includes('queue is full')).length, 1);
  assert.equal((await puller.pull()).outcome, 'queue_full');
  assert.equal(fake.market().length, 1, 'no pull while full');
  doc.queue = doc.queue.slice(10);
  state.write('intents', doc);
  clock.t += 1;
  fake.script('POST', PATH, page([intent(2), intent(3)], 9));
  assert.deepEqual(await puller.pull(), { outcome: 'ok', added: 2 });
  assert.deepEqual(sentSeqs(fake), [0, 1]);
  doc = state.read('intents', null);
  assert.equal(doc.after_seq, 9);
  assert.equal(state.read('status', null).alerts.intents_queue_full, undefined);
});

test('intents for unconfigured orgs do not fill the queue and are capped separately, oldest dropped', async (t) => {
  const { fake, puller, state, lines } = await setup(t);
  const unknown = Array.from({ length: MAX_UNREPORTED }, (_, i) => ({ ...intent(0, { id: U(5000 + i), org_id: 'other:org@x' }), status: 'org_not_configured' }));
  state.write('intents', { after_seq: 0, queue: unknown });
  fake.script('POST', PATH, page([intent(1), intent(2, { org_id: 'other:org@x' })], 9));
  assert.deepEqual(await puller.pull(), { outcome: 'ok', added: 2 });
  const doc = state.read('intents', null);
  assert.equal(doc.after_seq, 9);
  assert.equal(doc.queue.filter((it) => it.status === 'org_not_configured').length, MAX_UNREPORTED);
  assert.ok(!doc.queue.some((it) => it.id === U(5000)), 'oldest unreported dropped');
  assert.ok(doc.queue.some((it) => it.id === U(102)) && doc.queue.some((it) => it.id === U(101)));
  assert.equal(lines.filter((l) => l.includes('[warn]') && l.includes('dropped 1 unreported')).length, 1);
  assert.equal(state.read('status', null).alerts.intents_queue_full, undefined);
});

test('Retry-After defers the next pull at least as long as the server asked', async (t) => {
  const { fake, puller, clock } = await setup(t);
  fake.script('POST', PATH, { status: 429, headers: { 'retry-after': '1800' }, problem: { code: 'RATE_LIMITED' } }, { status: 204 });
  assert.equal((await puller.pull()).outcome, 'transient');
  assert.equal(puller.notBefore(), clock.t + 1_800_000);
  clock.t += 1_799_999;
  assert.equal((await puller.pull()).outcome, 'backoff');
  assert.equal(fake.market().length, 1);
  clock.t += 1;
  assert.equal((await puller.pull()).outcome, 'ok');
});

test('a corrupt intents document is reported and the run is recorded', async (t) => {
  const { puller, state, fake } = await setup(t);
  fs.writeFileSync(path.join(state.dir, 'intents.json'), '{nope');
  assert.equal((await puller.pull()).outcome, 'error');
  assert.match(state.read('status', null).alerts.intents_pull.message, /not valid JSON/);
  assert.equal(state.read('status', null).runs.intents.outcome, 'error');
  assert.equal(fake.market().length, 0);
});

test('404 and malformed responses raise an alert and keep the cursor', async (t) => {
  const { fake, puller, state } = await setup(t);
  fake.script('POST', PATH, { status: 404, problem: { code: 'NOT_FOUND' } }, page([intent(0)], 0), page([], 4));
  assert.equal((await puller.pull()).outcome, 'rejected');
  assert.match(state.read('status', null).alerts.intents_pull.message, /not this agent/);
  assert.equal((await puller.pull()).outcome, 'rejected');
  assert.equal(state.read('intents', { after_seq: 0 }).after_seq, 0);
  assert.equal((await puller.pull()).outcome, 'ok');
  assert.equal(state.read('status', null).alerts.intents_pull, undefined);
});
