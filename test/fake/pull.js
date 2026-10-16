import path from 'node:path';
import { VALID_ENV, tmpHome } from '../helpers.js';
import { marketHarness } from './market.js';
import { createMarketApi } from '../../src/market-api.js';
import { createLogger } from '../../src/logger.js';
import { openState } from '../../src/state.js';
import { createOrgs } from '../../src/orgs.js';

export const ORG = VALID_ENV.COCO_ORG_ID;
export const AGENT = VALID_ENV.COCO_MEMBER_ID;
export const ORG2 = '0b6f4f3e-1111-4c2a-9d1e-dddddddddddd';
export const U = (n) => `0190f000-0000-7000-8000-${String(n).padStart(12, '0')}`;

// Fake market, a temp state store and the org registry; `clock.t` drives now().
export async function pullHarness(t, { orgs = { [ORG2]: {} } } = {}) {
  const h = await marketHarness(t);
  const dataDir = path.join(tmpHome(), 'd');
  const clock = { t: Date.parse('2026-10-16T00:00:00Z') };
  const now = () => clock.t;
  const state = openState(dataDir, { bffUrl: h.fake.url, orgId: ORG, memberId: AGENT, now });
  t.after(() => state.close());
  const logger = createLogger('debug', { log: (l) => h.lines.push(l), error: (l) => h.lines.push(l) });
  const config = { org_id: ORG, member_id: AGENT, orgs: { [ORG]: { member_id: AGENT }, ...orgs } };
  const reg = createOrgs({ config, state, auth: h.auth, logger, now });
  return { ...h, dataDir, clock, now, state, logger, orgs: reg, api: createMarketApi({ http: h.http }) };
}
