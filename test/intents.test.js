import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AGENT, ORG, ORG2, U, pullHarness } from './fake/pull.js';
import { createIntentPuller, tooOld } from '../src/intents.js';
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

test('MEMBER_LEFT_ORG marks the org invalid and stops pulling without another org', async (t) => {
  const { fake, puller, state, orgs, lines } = await setup(t);
  fake.script('POST', PATH, { status: 403, problem: { code: 'MEMBER_LEFT_ORG' } });
  assert.equal((await puller.pull()).outcome, 'org_invalid');
  assert.equal(orgs.isInvalid(ORG), true);
  assert.ok(state.read('status', null).alerts[`org_invalid:${ORG}`]);
  assert.ok(lines.some((l) => l.includes('[warn]') && l.includes('rejected this agent')));
  assert.equal((await puller.pull()).outcome, 'org_invalid');
  assert.equal(fake.market().length, 1, 'no further pulls through any org');
});

test('intents of an org marked invalid are kept but not runnable', async (t) => {
  const { fake, puller, state, orgs } = await setup(t);
  orgs.markInvalid(ORG2, 'MEMBER_LEFT_ORG');
  fake.script('POST', PATH, page([intent(1, { org_id: ORG2 })], 1));
  await puller.pull();
  assert.equal(state.read('intents', null).queue[0].status, 'org_invalid');
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
