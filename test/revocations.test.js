import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ORG, U, pullHarness } from './fake/pull.js';
import { fakeCursor as C } from './fake/market.js';
import { STALE_AFTER_MS, createRevocationPuller, revokedSet } from '../src/revocations.js';

const PATH = `/api/v1/orgs/${ORG}/revocations:query`;
const E7 = U(7007);
const E8 = U(8008);
const SHA = (c) => c.repeat(64);
const rev = (n, over = {}) => ({
  kind: 'version_revoke', source_market_id: U(4), skill_id: U(2), skill_version_id: U(n), template_version_id: null,
  package_sha256: SHA('a'), manifest_sha256: null, revoked_at: '2026-10-16T00:00:00Z', ...over,
});
const page = (items, next, more = false) => ({ status: 200, json: { items, next_cursor: next, has_more: more } });

async function setup(t) {
  const h = await pullHarness(t);
  const enforced = [];
  const puller = createRevocationPuller({
    api: h.api, state: h.state, orgs: h.orgs, logger: h.logger, now: h.now, enforce: async (items) => { enforced.push(...items); },
  });
  return { ...h, puller, enforced };
}
const sent = (fake) => fake.market().map((r) => r.json);

test('pages extend the revoked set and persist the cursor; the set never shrinks', async (t) => {
  const { fake, puller, state, enforced } = await setup(t);
  const tpl = rev(0, { kind: 'template_revoke', skill_id: null, skill_version_id: null, template_version_id: U(9), package_sha256: null, manifest_sha256: SHA('b') });
  const block = rev(0, { kind: 'sha_block', skill_id: null, skill_version_id: null, package_sha256: SHA('c') });
  fake.script('POST', PATH, page([rev(5), tpl], C(2), true), page([block], C(3)), page([], C(3)));
  assert.deepEqual(await puller.pull(), { outcome: 'ok' });
  assert.deepEqual(sent(fake), [{}, { cursor: C(2) }]);
  assert.equal(enforced.length, 3);
  const doc = state.read('revocations', null);
  assert.equal(doc.cursor, C(3));
  assert.equal(doc.last_success_at, '2026-10-16T00:00:00.000Z');
  await puller.pull();
  assert.deepEqual(sent(fake).at(-1), { cursor: C(3) });
  const set = revokedSet(state);
  assert.equal(set.has('skill_version_id', U(5)), true);
  assert.equal(set.has('template_version_id', U(9)), true);
  assert.equal(set.has('skill_version_id', U(6)), false);
  assert.equal(set.blocksSha(SHA('a')), true);
  assert.equal(set.blocksSha(SHA('b')), true);
  assert.equal(set.blocksSha(SHA('c')), true);
  assert.equal(set.blocksSha(SHA('d')), false);
  assert.equal(set.has('skill_version_id', U(9)), false);
});

test('CURSOR_INVALID drops the cursor and pulls from the start once per round', async (t) => {
  const { fake, puller, state, lines } = await setup(t);
  state.write('revocations', { cursor: C(40, E7), last_success_at: null, first_attempt_at: null });
  fake.script('POST', PATH, { status: 400, problem: { code: 'CURSOR_INVALID' } }, page([rev(5)], C(1, E8)));
  assert.deepEqual(await puller.pull(), { outcome: 'ok' });
  assert.deepEqual(sent(fake), [{ cursor: C(40, E7) }, {}]);
  assert.equal(state.read('revocations', null).cursor, C(1, E8));
  assert.ok(lines.some((l) => l.includes('[warn]') && l.includes('pulling from the start')));
  fake.script('POST', PATH, { status: 400, problem: { code: 'CURSOR_INVALID' } }, { status: 400, problem: { code: 'CURSOR_INVALID' } });
  assert.deepEqual(await puller.pull(), { outcome: 'rejected' });
  assert.equal(fake.market().length, 4);
  state.write('revocations', { cursor: '1:2', last_success_at: null, first_attempt_at: null });
  assert.deepEqual(await puller.pull(), { outcome: 'ok' });
  assert.deepEqual(sent(fake).at(-1), {}, 'a stored cursor of the wrong shape is dropped');
});

test('a failed later page keeps earlier pages and does not count as success', async (t) => {
  const { fake, puller, state } = await setup(t);
  fake.script('POST', PATH, page([rev(5)], C(1), true), { status: 503, problem: { code: 'DEPENDENCY_UNAVAILABLE' } });
  assert.deepEqual(await puller.pull(), { outcome: 'transient' });
  const doc = state.read('revocations', null);
  assert.equal(doc.cursor, C(1));
  assert.equal(doc.last_success_at, null);
  assert.equal(revokedSet(state).has('skill_version_id', U(5)), true);
});

test('when this round\'s pull fails, the set from earlier rounds still blocks installs', async (t) => {
  const { fake, puller, state } = await setup(t);
  const block = rev(0, { kind: 'sha_block', skill_id: null, skill_version_id: null, package_sha256: SHA('c') });
  fake.script('POST', PATH, page([rev(5), block], C(2)), { status: 503, problem: { code: 'DEPENDENCY_UNAVAILABLE' } });
  assert.deepEqual(await puller.pull(), { outcome: 'ok' });
  assert.deepEqual(await puller.pull(), { outcome: 'transient' });
  const set = revokedSet(state);
  assert.equal(set.has('skill_version_id', U(5)), true);
  assert.equal(set.blocksSha(SHA('a')), true);
  assert.equal(set.blocksSha(SHA('c')), true);
  assert.equal(set.blocksSha(SHA('d')), false);
});

test('no successful pull for 24 h writes a status alert and one warn log, and clears on success', async (t) => {
  const { fake, puller, state, clock, lines } = await setup(t);
  const stale = () => state.read('status', null).alerts.revocations_stale;
  const warns = () => lines.filter((l) => l.includes('[warn]') && l.includes('no successful revocation pull')).length;
  fake.script('POST', PATH, ...Array(3).fill({ status: 503, problem: { code: 'DEPENDENCY_UNAVAILABLE' } }));
  await puller.pull();
  clock.t += STALE_AFTER_MS;
  await puller.pull();
  assert.equal(stale(), undefined);
  clock.t += 1;
  await puller.pull();
  assert.match(stale().message, /since start-up/);
  assert.equal(puller.checkStale(), true);
  assert.equal(warns(), 1);
  fake.script('POST', PATH, page([], C(0)));
  await puller.pull();
  assert.equal(stale(), undefined);
  clock.t += STALE_AFTER_MS + 1;
  assert.equal(puller.checkStale(), true);
  assert.match(stale().message, /since 2026-10-17/);
});

test('MEMBER_LEFT_ORG marks the primary org invalid; no other org is tried', async (t) => {
  const { fake, puller, orgs } = await setup(t);
  fake.script('POST', PATH, { status: 403, problem: { code: 'MEMBER_LEFT_ORG', reason: 'member_departed' } });
  assert.deepEqual(await puller.pull(), { outcome: 'org_left' });
  assert.equal(orgs.membership(ORG), 'invalid');
  assert.deepEqual(await puller.pull(), { outcome: 'org_left' });
  assert.equal(fake.market().length, 1);
});

test('enforcement runs before the cursor moves; a failed enforce re-delivers the page', async (t) => {
  const h = await pullHarness(t);
  let fail = true;
  const enforced = [];
  const puller = createRevocationPuller({
    api: h.api, state: h.state, orgs: h.orgs, logger: h.logger, now: h.now,
    enforce: async (items) => {
      if (fail) throw new Error('enforce failed');
      enforced.push(...items);
    },
  });
  h.fake.script('POST', PATH, page([rev(5)], C(1)), page([rev(5)], C(1)));
  assert.deepEqual(await puller.pull(), { outcome: 'error' });
  assert.equal(h.state.read('revocations', null).cursor, null);
  assert.equal(revokedSet(h.state).has('skill_version_id', U(5)), true);
  assert.equal(h.state.read('status', null).runs.revocations.outcome, 'error');
  fail = false;
  assert.deepEqual(await puller.pull(), { outcome: 'ok' });
  assert.deepEqual(sent(h.fake), [{}, {}]);
  assert.equal(enforced.length, 1);
  assert.equal(h.state.read('revocations', null).cursor, C(1));
});

test('a corrupt revocation document still raises the 24 h alert', async (t) => {
  const { fake, puller, state, clock } = await setup(t);
  fs.writeFileSync(path.join(state.dir, 'revocations.json'), '{nope');
  assert.deepEqual(await puller.pull(), { outcome: 'error' });
  assert.match(state.read('status', null).alerts.revocations_pull.message, /not valid JSON/);
  assert.equal(state.read('status', null).alerts.revocations_stale, undefined);
  clock.t += STALE_AFTER_MS + 1;
  await puller.pull();
  assert.match(state.read('status', null).alerts.revocations_stale.message, /since start-up/);
  assert.equal(fake.market().length, 0);
});

test('only the client cursor check resets the cursor; other TypeErrors do not', async (t) => {
  const h = await pullHarness(t);
  const api = { pullRevocations: async () => { throw new TypeError('boom'); } };
  const puller = createRevocationPuller({ api, state: h.state, orgs: h.orgs, logger: h.logger, now: h.now });
  h.state.write('revocations', { cursor: C(4), last_success_at: null, first_attempt_at: null });
  assert.deepEqual(await puller.pull(), { outcome: 'error' });
  assert.equal(h.state.read('revocations', null).cursor, C(4));
});

test('Retry-After on revocations defers the next pull', async (t) => {
  const { fake, puller, clock } = await setup(t);
  fake.script('POST', PATH, { status: 503, headers: { 'retry-after': '900' }, problem: { code: 'DEPENDENCY_UNAVAILABLE' } });
  assert.deepEqual(await puller.pull(), { outcome: 'transient' });
  assert.equal(puller.notBefore(), clock.t + 900_000);
  clock.t += 300_000;
  assert.deepEqual(await puller.pull(), { outcome: 'backoff' });
  assert.equal(fake.market().length, 1);
});
