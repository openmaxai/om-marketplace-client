import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AGENT, ORG, ORG2, pullHarness } from './fake/pull.js';
import { fakeCursor as C } from './fake/market.js';
import { createIntentPuller } from '../src/intents.js';
import { createRevocationPuller } from '../src/revocations.js';
import { SUSPENDED_PROBE_MS, createOrgs, membershipMessage } from '../src/orgs.js';

const REV = `/api/v1/orgs/${ORG}/revocations:query`;
const INT = `/api/v1/orgs/${ORG}/agents/${AGENT}/install-intents:query`;
const left = (reason) => ({ status: 403, problem: { code: 'MEMBER_LEFT_ORG', ...(reason === undefined ? {} : { reason }) } });
const revPage = { status: 200, json: { items: [], next_cursor: C(1), has_more: false } };

const PRIMARY_SUSPENDED = `This agent's membership in primary org ${ORG} is suspended; pulling has stopped for ALL orgs. `
  + 'Retrying hourly and resuming automatically once restored. To restore sooner, contact the org admin.';
const PRIMARY_DEPARTED = `This agent has left primary org ${ORG}; pulling has stopped for ALL orgs. `
  + "Ask the org admin to re-add it, or change the primary org in config (this drops the original org's revocation set and queue).";
const OTHER_SUSPENDED = `This agent's membership in org ${ORG2} is suspended; its orders are no longer pulled or executed. `
  + 'Retrying hourly and resuming automatically once restored. To restore sooner, contact the org admin.';
const OTHER_DEPARTED = `This agent has left org ${ORG2}; its orders are no longer pulled or executed. `
  + "Ask the org admin to re-add it, or change the primary org in config (this drops the original org's revocation set and queue).";

async function setup(t) {
  const h = await pullHarness(t);
  const pullers = (orgs = h.orgs) => {
    const deps = { api: h.api, state: h.state, orgs, logger: h.logger, now: h.now };
    return { revocations: createRevocationPuller(deps), intents: createIntentPuller(deps) };
  };
  const round = async (p) => [(await p.revocations.pull()).outcome, (await p.intents.pull()).outcome];
  const alert = () => h.state.read('status', null).alerts[`org_membership:${ORG}`];
  const warns = (text) => h.lines.filter((l) => l.includes('[warn]') && l.includes(text)).length;
  const onlyPrimary = () => assert.ok(h.fake.market().every((r) => r.path.startsWith(`/api/v1/orgs/${ORG}/`)), 'no other org used');
  return { ...h, pullers, round, alert, warns, onlyPrimary };
}

test('membership messages', () => {
  assert.equal(membershipMessage(ORG, 'suspended', true), PRIMARY_SUSPENDED);
  assert.equal(membershipMessage(ORG, 'invalid', true), PRIMARY_DEPARTED);
  assert.equal(membershipMessage(ORG2, 'suspended', false), OTHER_SUSPENDED);
  assert.equal(membershipMessage(ORG2, 'invalid', false), OTHER_DEPARTED);
});

test('member_suspended: hourly re-probe of the same org, automatic recovery', async (t) => {
  const { fake, clock, orgs, pullers, round, alert, warns, onlyPrimary, state } = await setup(t);
  const p = pullers();
  fake.script('POST', REV, left('member_suspended'));
  assert.deepEqual(await round(p), ['org_left', 'org_left']);
  assert.equal(orgs.membership(ORG), 'suspended');
  assert.equal(alert().message, PRIMARY_SUSPENDED);
  assert.equal(warns(PRIMARY_SUSPENDED), 1);
  assert.equal(fake.market().length, 1, 'intents not pulled in the same round');

  clock.t += SUSPENDED_PROBE_MS - 1;
  assert.deepEqual(await round(p), ['org_left', 'org_left']);
  assert.equal(fake.market().length, 1, 'no request before the probe is due');

  clock.t += 1;
  fake.script('POST', REV, left('member_suspended'));
  assert.deepEqual(await round(p), ['org_left', 'org_left']);
  assert.equal(fake.market().length, 2, 'one probe per hour');
  assert.equal(warns(PRIMARY_SUSPENDED), 1, 'no repeated warn while still suspended');

  clock.t += SUSPENDED_PROBE_MS;
  fake.script('POST', REV, revPage);
  fake.script('POST', INT, { status: 204 });
  assert.deepEqual(await round(p), ['ok', 'ok']);
  assert.equal(orgs.membership(ORG), null);
  assert.equal(alert(), undefined);
  assert.deepEqual(state.read('orgs', null), {});
  onlyPrimary();
});

test('member_departed: invalid until restart, then probed once', async (t) => {
  const h = await setup(t);
  const p = h.pullers();
  h.fake.script('POST', INT, left('member_departed'));
  assert.deepEqual(await h.round(p), ['ok', 'org_left']);
  assert.equal(h.orgs.membership(ORG), 'invalid');
  assert.equal(h.alert().message, PRIMARY_DEPARTED);
  assert.equal(h.warns(PRIMARY_DEPARTED), 1);
  const before = h.fake.market().length;
  h.clock.t += 5 * SUSPENDED_PROBE_MS;
  assert.deepEqual(await h.round(p), ['org_left', 'org_left']);
  assert.equal(h.fake.market().length, before, 'never probed again in this process');

  const config = { org_id: ORG, member_id: AGENT, orgs: { [ORG]: { member_id: AGENT }, [ORG2]: {} } };
  const restarted = createOrgs({ config, state: h.state, auth: h.auth, logger: h.logger, now: h.now });
  const p2 = h.pullers(restarted);
  h.fake.script('POST', REV, revPage);
  h.fake.script('POST', INT, { status: 204 });
  assert.deepEqual(await h.round(p2), ['ok', 'ok']);
  assert.equal(restarted.membership(ORG), null);
  assert.equal(h.alert(), undefined);
  h.onlyPrimary();
});

test('a missing or unknown reason counts as departed', async (t) => {
  for (const reason of [undefined, 'something_else']) {
    const { fake, pullers, round, orgs, alert } = await setup(t);
    fake.script('POST', REV, left(reason));
    assert.deepEqual(await round(pullers()), ['org_left', 'org_left']);
    assert.equal(orgs.membership(ORG), 'invalid');
    assert.equal(alert().message, PRIMARY_DEPARTED);
  }
});

test('suspended then departed updates the alert; non-primary orgs get their own texts', async (t) => {
  const { fake, clock, orgs, pullers, round, alert, state, warns } = await setup(t);
  const p = pullers();
  fake.script('POST', REV, left('member_suspended'));
  await round(p);
  clock.t += SUSPENDED_PROBE_MS;
  fake.script('POST', REV, left('member_departed'));
  await round(p);
  assert.equal(orgs.membership(ORG), 'invalid');
  assert.equal(alert().message, PRIMARY_DEPARTED);
  assert.equal(warns(PRIMARY_DEPARTED), 1);

  orgs.markLeft(ORG2, 'member_suspended');
  assert.equal(state.read('status', null).alerts[`org_membership:${ORG2}`].message, OTHER_SUSPENDED);
  assert.equal(warns(OTHER_SUSPENDED), 1);
  orgs.markLeft(ORG2, 'member_departed');
  assert.equal(state.read('status', null).alerts[`org_membership:${ORG2}`].message, OTHER_DEPARTED);
  assert.equal(warns(OTHER_DEPARTED), 1);
});

test('marks written before suspension was tracked count as invalid', async (t) => {
  const { state, orgs } = await setup(t);
  state.write('orgs', { [ORG]: { reason: 'MEMBER_LEFT_ORG', since: '2026-10-01T00:00:00.000Z' } });
  assert.equal(orgs.membership(ORG), 'invalid');
  assert.equal(orgs.isBlocked(ORG), true);
});
