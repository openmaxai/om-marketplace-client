// One crash-sweep round in a child process: runs one skills round and SIGKILLs itself just before its KILL_AT-th
// write-like fs call (0 = never). Recursive rmSync is replaced by a per-entry walk so a kill can land inside it.
import fs from 'node:fs';
import pathm from 'node:path';
const KILL_AT = Number(process.env.KILL_AT ?? 0);
let calls = 0; let armed = false;
const tick = (name, arg) => { if (!armed) return; calls++; if (KILL_AT && calls === KILL_AT) { process.stdout.write(`KILL ${name} ${String(arg).split('/').slice(-3).join('/')}\n`); process.kill(process.pid, 'SIGKILL'); } };
for (const n of ['renameSync','writeSync','writeFileSync','fsyncSync','unlinkSync','mkdirSync','openSync','linkSync','rmdirSync']) { const o = fs[n]; fs[n] = function (...a) { tick(n, a[0]); return o.apply(this, a); }; }
const origRm = fs.rmSync;
fs.rmSync = function (p, opts) {
  let st; try { st = fs.lstatSync(p); } catch { return; }
  if (st.isDirectory() && opts?.recursive) { for (const e of fs.readdirSync(p)) fs.rmSync(pathm.join(p, e), opts); fs.rmdirSync(p); return; }
  if (st.isDirectory()) return origRm(p, opts);
  fs.unlinkSync(p);
};
import { createAuth } from '../src/auth.js';
import { createMarketHttp } from '../src/http.js';
import { createMarketApi } from '../src/market-api.js';
import { createLogger } from '../src/logger.js';
import { openState } from '../src/state.js';
import { createOrgs } from '../src/orgs.js';
import { createSkills } from '../src/skills.js';
import { FAKE_KEY, VALID_ENV } from '../test/helpers.js';
const a = JSON.parse(process.argv[2]);
const ORG = VALID_ENV.COCO_ORG_ID, AGENT = VALID_ENV.COCO_MEMBER_ID;
const logger = createLogger('debug', { log: () => {}, error: () => {} });
const now = () => Date.parse('2026-10-16T00:00:00Z');
const auth = createAuth({ bffUrl: a.url, apiKey: FAKE_KEY, logger });
const api = createMarketApi({ http: createMarketHttp({ bffUrl: a.url, auth, logger }) });
const state = openState(a.dataDir, { bffUrl: a.url, orgId: ORG, memberId: AGENT, now });
const config = { org_id: ORG, member_id: AGENT, orgs: { [ORG]: { member_id: AGENT } } };
const orgs = createOrgs({ config, state, auth, logger, now });
const s = createSkills({ api, state, orgs, logger, bffUrl: a.url, skillsDir: a.skillsDir, dataDir: a.dataDir, emulatorOrigin: a.origin, now, sleep: async () => {} });
await auth.getAccessToken(ORG);
process.stdout.write('GO\n'); armed = true;
const out = a.action === 'rollback' ? s.rollback(a.skillId) : await s.runRound();
armed=false; process.stdout.write(`DONE ${calls} ${JSON.stringify(out)}\n`);
state.close();
