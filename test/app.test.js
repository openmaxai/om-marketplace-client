import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { FAKE_KEY, tmpHome } from './helpers.js';
import { fakeCursor, marketHarness } from './fake/market.js';
import { AGENT, ORG } from './fake/pull.js';
import { buildTasks, createRuntime } from '../src/app.js';
import { StateLockedError } from '../src/state.js';
import { POLICY_SHA256 } from '../src/policy/pin.js';

test('one poll round pulls revocations, then intents; a second runtime is locked out', async (t) => {
  const { fake, lines } = await marketHarness(t);
  const logger = { debug() {}, info() {}, warn: (l) => lines.push(l), error: (l) => lines.push(l) };
  const config = { bff_url: fake.url, api_key: FAKE_KEY, org_id: ORG, member_id: AGENT, orgs: { [ORG]: { member_id: AGENT } } };
  const dataDir = path.join(tmpHome(), 'd');
  const rt = createRuntime({ config, dataDir, logger });
  t.after(() => rt.state.close());
  assert.throws(() => createRuntime({ config, dataDir, logger }), StateLockedError);
  fake.script('POST', `/api/v1/orgs/${ORG}/revocations:query`, { status: 200, json: { items: [], next_cursor: fakeCursor(0), has_more: false } });
  fake.script('POST', `/api/v1/orgs/${ORG}/agents/${AGENT}/install-intents:query`,
    { status: 200, json: { items: [], has_more: false, next_after_seq: 3, policy_sha256: POLICY_SHA256 } });
  await buildTasks(logger, rt).find((x) => x.name === 'poll').run();
  assert.deepEqual(fake.market().map((r) => r.path.split('/').at(-1)), ['revocations:query', 'install-intents:query']);
  assert.equal(rt.state.read('intents', null).after_seq, 3);
  assert.deepEqual(Object.keys(rt.state.read('status', null).alerts), []);
});
