import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { MarketError } from './http.js';
import { uuidv7 } from './ids.js';
import { EMPTY_INTENTS, enterTooOldMode, tooOld } from './intents.js';
import { revokedSet } from './revocations.js';
import { checkPackageUrl, downloadPackage } from './download.js';
import { inspectInWorker } from './inspect.js';
import { MARKER, SKILL_DIR_PREFIX, failureFor, landSkill } from './land.js';

export const MAX_INTENTS_PER_ROUND = 20;
const SKILL_OPS = new Set(['install', 'upgrade', 'enable', 'disable', 'uninstall']);
const PACKAGE_OPS = new Set(['install', 'upgrade']);
const DEFER = new Set(['INTENT_OUT_OF_ORDER', 'CLIENT_VERSION_TOO_OLD', 'MEMBER_LEFT_ORG']);
const GONE = new Set(['INTENT_NOT_PENDING', 'INTENT_EXPIRED']);
// Refused for good; shown to the human as is. The market closes the intent.
const SHOWN = new Set(['VERSION_NOT_FOUND', 'VERSION_REVOKED', 'NOT_APPROVED', 'SKILL_ALREADY_INSTALLED', 'INSTALLED_BY_OTHER_ORG']);
const { O_RDONLY, O_NOFOLLOW } = fs.constants;

function readMarker(dir) {
  let fd;
  try {
    if (!fs.lstatSync(dir).isDirectory()) return null;
    fd = fs.openSync(path.join(dir, MARKER), O_RDONLY | O_NOFOLLOW);
    return JSON.parse(fs.readFileSync(fd, 'utf8'));
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

const exists = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } };

// Skill intents: install / upgrade (C-02, C-03, download, inspect, land, C-06) and enable / disable / uninstall (local
// change first, then C-08 / C-09). Every request is journaled by phase before its effects, so a restart resumes it:
// requested -> accepted -> landing -> landed -> reporting -> reported (or closed). Reports wait in the
// outbox until the market answers and are resent unchanged.
export function createSkills({
  api, state, orgs, logger, bffUrl, skillsDir, dataDir, emulatorOrigin = null, fetchImpl, inspect = inspectInWorker,
  installsAllowed = true, now = Date.now, sleep, signal = null,
}) {
  const iso = () => new Date(now()).toISOString();
  const areas = { enabled: skillsDir, disabled: path.join(dataDir, 'disabled'), revoked_disabled: path.join(dataDir, 'quarantine') };
  const dirOf = (slug, where) => path.join(areas[where], `${SKILL_DIR_PREFIX}${slug}`);
  const rollbackDir = (slug, no) => path.join(dataDir, 'rollback', slug, String(no));
  const journal = (id, patch) => {
    const j = { ...state.journal.get(id), ...patch, updated_at: iso() };
    state.journal.put(id, j);
    return j;
  };
  const setIntent = (id, patch) => id && state.update('intents', EMPTY_INTENTS, (d) => {
    d.queue = patch ? d.queue.map((q) => (q.id === id ? { ...q, ...patch } : q)) : d.queue.filter((q) => q.id !== id);
  });
  const installs = () => state.read('installs', {});
  const putRec = (skillId, rec) => state.update('installs', {}, (d) => { if (rec) d[skillId] = rec; else delete d[skillId]; });
  const isRevoked = (rec, revoked = revokedSet(state)) => revoked.has('skill_version_id', rec.skill_version_id) || revoked.blocksSha(rec.package_sha256);

  // Moves a skill directory carrying this skill's marker; false when src is absent or not ours.
  function moveDir(src, dst, skillId) {
    if (readMarker(src)?.skill_id !== skillId) return false;
    fs.mkdirSync(path.dirname(dst), { recursive: true, mode: 0o700 });
    fs.rmSync(dst, { recursive: true, force: true });
    fs.renameSync(src, dst);
    return true;
  }

  function removeOurs(dir, skillId) {
    if (readMarker(dir)?.skill_id === skillId) fs.rmSync(dir, { recursive: true, force: true });
  }

  // Market error -> 'defer' (retry later with the same id and body), 'gone', 'shown' or 'alert'.
  function classify(err, orgId) {
    if (!(err instanceof MarketError)) throw err;
    if (err.code === 'MEMBER_LEFT_ORG') orgs.markLeft(orgId, err.reason);
    if (err.code === 'CLIENT_VERSION_TOO_OLD') enterTooOldMode(state, logger, err.reason ?? 'unknown', err.min_version, null, iso());
    if (err.transient || DEFER.has(err.code)) return 'defer';
    if (GONE.has(err.code) || (err.code === 'VALIDATION_FAILED' && ['not_installed', 'not_higher'].includes(err.reason))) return 'gone';
    return SHOWN.has(err.code) ? 'shown' : 'alert';
  }

  function rejected(err, it, what) {
    const c = classify(err, it.org_id);
    if (c === 'defer') {
      logger.warn(`intent ${it.id}: ${what} deferred (${err.code || err.status})`);
      return 'deferred';
    }
    const by = err.installed_by_org_id ? `; already installed by org ${err.installed_by_org_id}` : '';
    const msg = `intent ${it.id}: ${what} refused (${err.code || err.status}${err.reason ? ` ${err.reason}` : ''})${by}`;
    if (c === 'gone') logger.info(msg);
    else {
      state.setAlert(`intent:${it.id}`, msg);
      logger.warn(msg);
    }
    setIntent(it.id, null);
    return 'closed';
  }

  const landedDir = (res) => ['enabled', 'disabled'].map((w) => dirOf(res.slug, w)).find((d) => {
    const m = readMarker(d);
    return m?.skill_id === res.skill_id && m.package_sha256 === res.package_sha256;
  });

  // Puts the replaced version back where it was, when it is still in the rollback area.
  function restorePrior(prior) {
    if (!prior || prior.state === 'revoked_disabled' || exists(dirOf(prior.slug, prior.state))) return;
    const src = rollbackDir(prior.slug, prior.version_no);
    if (readMarker(src)) fs.renameSync(src, dirOf(prior.slug, prior.state));
  }

  // Records a landed version; a disabled skill stays disabled. Idempotent.
  function recordLanded(rid, j) {
    const { response: res, prior } = j;
    const where = prior?.state === 'disabled' ? 'disabled' : 'enabled';
    if (where === 'disabled') moveDir(dirOf(res.slug, 'enabled'), dirOf(res.slug, 'disabled'), res.skill_id);
    putRec(res.skill_id, {
      org_id: j.org_id, install_id: res.install_id, slug: res.slug, skill_version_id: res.skill_version_id, version_no: res.version_no,
      package_sha256: res.package_sha256, source_market_id: res.source_market_id, state: where, installed_at: iso(), request_id: rid,
      rollback: prior && prior.state !== 'revoked_disabled' ? { version_no: prior.version_no, skill_version_id: prior.skill_version_id } : null,
    });
    return journal(rid, { phase: 'landed' });
  }

  // The market refused a reported success: the landed version goes, the previous one comes back.
  function rollBack(j) {
    const { response: res, prior } = j;
    for (const w of ['enabled', 'disabled']) {
      if (readMarker(dirOf(res.slug, w))?.package_sha256 === res.package_sha256) fs.rmSync(dirOf(res.slug, w), { recursive: true, force: true });
    }
    restorePrior(prior);
    putRec(res.skill_id, prior);
  }

  // Keeps only the version replaced by the latest upgrade.
  function pruneRollback(rec) {
    const dir = path.join(dataDir, 'rollback', rec.slug);
    let names = [];
    try { names = fs.readdirSync(dir); } catch { /* none */ }
    for (const n of names) if (n !== String(rec.rollback?.version_no)) fs.rmSync(path.join(dir, n), { recursive: true, force: true });
  }

  async function send(o) {
    if (o.kind === 'result') return api.reportInstallResult({ orgId: o.org_id, requestId: o.request_id, body: o.body });
    const agentId = await orgs.agentId(o.org_id);
    return api.manageSkill({ orgId: o.org_id, agentId, skillId: o.skill_id, verb: o.kind, body: o.body });
  }

  async function deliver(id) {
    const o = state.outbox.get(id);
    let res = null;
    try {
      res = await send(o);
    } catch (err) {
      const c = classify(err, o.org_id);
      if (c === 'defer') {
        logger.warn(`${o.kind} report ${id} not delivered (${err.code || err.status}); kept for resend`);
        return 'deferred';
      }
      const msg = `${o.kind} report ${id} refused (${err.code || err.status})`;
      if (c !== 'gone' && (o.kind === 'result' || err.status !== 404)) state.setAlert(`report:${id}`, msg);
      logger.warn(msg);
    }
    // Idempotent, so it runs again when a crash comes before the outbox entry is gone.
    const j = state.journal.get(id);
    if (o.kind === 'result' && res && o.body.status === 'succeeded') {
      if (res.status === 'succeeded') pruneRollback(installs()[j.response.skill_id] ?? { slug: j.response.slug });
      else if (res.error_code === 'INSTALL_TIMEOUT') logger.warn(`install ${id}: market timed it out; the landed version stays for reconcile`);
      else {
        logger.warn(`install ${id}: market refused the result (${res.error_code}); rolling back`);
        rollBack(j);
      }
    }
    state.outbox.remove(id);
    journal(id, { phase: 'reported', response_report: res });
    setIntent(o.intent_id, null);
    return o.kind === 'result' ? o.body.status : 'done';
  }

  function report(rid, it, result) {
    state.outbox.put(rid, { kind: 'result', org_id: it.org_id, intent_id: it.id, request_id: rid, body: result });
    journal(rid, { phase: 'reporting', result });
    return deliver(rid);
  }

  // C-07: the request's market status, null when unknown, or 'deferred'.
  async function statusOf(it, rid) {
    try {
      return await api.requestStatus({ orgId: it.org_id, requestId: rid });
    } catch (err) {
      if (err instanceof MarketError && err.status === 404) return null;
      return rejected(err, it, 'status query') === 'deferred' ? 'deferred' : 'closed';
    }
  }

  function close(it, rid, why) {
    journal(rid, { phase: 'closed', closed: why });
    setIntent(it.id, null);
    logger.info(`install ${rid} closed: ${why}`);
    return 'closed';
  }

  // A request seen before this run: resolves what landed locally against C-07. Returns an outcome, or null to (re)send C-02.
  async function recover(it, rid, j) {
    const st = await statusOf(it, rid);
    if (st === 'deferred' || st === 'closed') return st;
    const landed = j.response && j.phase !== 'accepted' && landedDir(j.response);
    if (landed && j.phase === 'landing') j = recordLanded(rid, j);
    if (!landed && j.phase === 'landing') restorePrior(j.prior);
    if (st === null) return j.response ? close(it, rid, 'unknown to the market') : null;
    if (st.status !== 'running') return close(it, rid, `market status ${st.status} ${st.error_code ?? ''}`.trim());
    if (j.result) return report(rid, it, j.result);
    if (landed) return report(rid, it, { status: 'succeeded', installed_sha256: j.response.package_sha256 });
    return null;
  }

  function upgradeRefused(op, res, prior) {
    if (op !== 'upgrade' || !prior) return false;
    return !(res.version_no > prior.version_no || (res.version_no < prior.version_no && (prior.state === 'revoked_disabled' || isRevoked(prior))));
  }

  async function runInstall(it, agentId) {
    const rid = it.request_id ?? uuidv7(now());
    let j = state.journal.get(rid);
    if (j?.phase === 'reported' || j?.phase === 'closed') return setIntent(it.id, null), 'closed';
    if (j) {
      const r = await recover(it, rid, j);
      if (r) return r;
    } else {
      const body = {
        request_id: rid, skill_id: it.skill_id, ...(it.skill_version_id ? { skill_version_id: it.skill_version_id } : {}),
        op: it.op, intent_id: it.id, ...(it.source_market_id ? { market: it.source_market_id } : {}),
      };
      j = journal(rid, { intent_id: it.id, org_id: it.org_id, op: it.op, body, phase: 'requested' });
      setIntent(it.id, { status: 'running', request_id: rid });
    }
    let res;
    try {
      res = await api.requestInstall({ orgId: it.org_id, agentId, body: j.body });
    } catch (err) {
      if (err instanceof MarketError && err.code === 'RESPONSE_INVALID') {
        return report(rid, it, { status: 'failed', error_code: 'CLIENT_INTERNAL', error_message: 'install_response_invalid' });
      }
      return rejected(err, it, `${it.op} request`);
    }
    if (res.already_installed) {
      if (!installs()[it.skill_id]) logger.warn(`skill ${it.skill_id} is installed per the market but missing locally`);
      return close(it, rid, 'already installed');
    }
    j = journal(rid, { phase: 'accepted', response: res });
    const prior = installs()[res.skill_id] ?? null;
    const fail = (code, msg) => report(rid, it, { status: 'failed', error_code: code, error_message: msg });
    if (isRevoked(res)) return fail('VERSION_REVOKED', 'version_revoked');
    if (upgradeRefused(it.op, res, prior)) return fail('INSTALL_TARGET_CONFLICT', 'not_higher');
    const failure = (err) => {
      const f = failureFor(err);
      if (f.reason === 'client internal error') logger.error(`install ${rid}: ${err.message}`);
      return fail(f.code, f.reason);
    };
    let bytes;
    let inspected;
    try {
      const subPath = checkPackageUrl(res.package_url, { bffUrl, orgId: it.org_id, agentId, requestId: rid });
      bytes = await downloadPackage({
        api, orgId: it.org_id, subPath, sha: res.package_sha256, size: res.size_bytes, emulatorOrigin, fetchImpl, now, sleep, signal,
      });
      inspected = await inspect(bytes, { signal });
    } catch (err) {
      if (signal?.aborted) return 'deferred';
      if (err instanceof MarketError) {
        if (err.code !== 'AGENT_NOT_SELF' && err.code !== 'NOT_FOUND') return rejected(err, it, 'package download');
        const st = await statusOf(it, rid);
        if (st === 'deferred' || st === 'closed') return st;
        if (st?.status !== 'running') return close(it, rid, `package gone (${st ? st.status : 'unknown'})`);
        return fail('CLIENT_INTERNAL', 'download_unavailable');
      }
      return failure(err);
    }
    j = journal(rid, { phase: 'landing', prior });
    try {
      if (prior?.state === 'disabled') moveDir(dirOf(prior.slug, 'disabled'), rollbackDir(prior.slug, prior.version_no), res.skill_id);
      landSkill({
        skillsDir, stagingRoot: path.join(dataDir, 'staging'), rollbackRoot: path.join(dataDir, 'rollback'), requestId: rid, install: res, inspected,
      });
    } catch (err) {
      restorePrior(prior);
      return failure(err);
    }
    recordLanded(rid, j);
    return report(rid, it, { status: 'succeeded', installed_sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
  }

  // Local change first, then C-08 / C-09. Enabling revoked content is refused and not reported.
  function applyLocal(op, skillId) {
    const rec = installs()[skillId];
    if (!rec) return 'absent';
    if (op === 'uninstall') {
      for (const w of Object.keys(areas)) removeOurs(dirOf(rec.slug, w), skillId);
      fs.rmSync(path.join(dataDir, 'rollback', rec.slug), { recursive: true, force: true });
      putRec(skillId, null);
      return 'done';
    }
    if (rec.state === 'revoked_disabled') return op === 'enable' ? 'refused' : 'done';
    const want = op === 'enable' ? 'enabled' : 'disabled';
    if (rec.state !== want) {
      moveDir(dirOf(rec.slug, rec.state), dirOf(rec.slug, want), skillId);
      putRec(skillId, { ...rec, state: want });
    }
    return 'done';
  }

  async function manage({ op, skillId, orgId, intentId = null, requestId = null }) {
    const rid = requestId ?? uuidv7(now());
    let j = state.journal.get(rid);
    if (j?.phase === 'reported' || j?.phase === 'closed') return setIntent(intentId, null), 'closed';
    if (!j) {
      const body = { request_id: rid, ...(op === 'uninstall' ? {} : { enabled: op === 'enable' }), ...(intentId ? { intent_id: intentId } : {}) };
      j = journal(rid, { intent_id: intentId, org_id: orgId, op, skill_id: skillId, body, phase: 'requested' });
      setIntent(intentId, { status: 'running', request_id: rid });
    }
    const local = applyLocal(op, skillId);
    if (local === 'refused') {
      const msg = `skill ${skillId} is disabled because its version was revoked; enabling it was refused`;
      state.setAlert(`revoked:${skillId}`, msg);
      logger.warn(msg);
      journal(rid, { phase: 'closed', closed: 'revoked' });
      setIntent(intentId, null);
      return 'refused';
    }
    if (local === 'absent') logger.warn(`${op} of skill ${skillId}: not installed locally; reporting anyway`);
    state.outbox.put(rid, { kind: op === 'uninstall' ? 'uninstall' : 'set-enabled', org_id: orgId, intent_id: intentId, skill_id: skillId, body: j.body });
    journal(rid, { phase: 'reporting' });
    return deliver(rid);
  }

  async function flushOutbox(blocked) {
    for (const id of state.outbox.list()) {
      const o = state.outbox.get(id);
      if (!o || blocked.has(o.org_id)) continue;
      let r;
      try {
        r = await deliver(id);
      } catch (err) {
        logger.error(`report ${id} failed: ${err.message}`);
        r = 'deferred';
      }
      if (r === 'deferred') blocked.add(o.org_id);
    }
  }

  // Head of the queue in seq order, skipping orgs held back this round and intents that are not skill intents.
  function nextIntent(blocked) {
    const t = now();
    const revoked = revokedSet(state);
    for (const it of state.read('intents', EMPTY_INTENTS).queue) {
      if (blocked.has(it.org_id) || (it.status !== 'queued' && it.status !== 'running')) continue;
      if (!SKILL_OPS.has(it.op) || !it.skill_id || (!installsAllowed && PACKAGE_OPS.has(it.op))) continue;
      const stale = Date.parse(it.expires_at) <= t ? 'expired' : PACKAGE_OPS.has(it.op) && revoked.has('skill_version_id', it.skill_version_id) ? 'version revoked' : null;
      if (it.status === 'queued' && stale) {
        logger.info(`intent ${it.id} dropped: ${stale}`);
        setIntent(it.id, null);
        continue;
      }
      if (!orgs.mayContact(it.org_id)) {
        blocked.add(it.org_id);
        continue;
      }
      return it;
    }
    return null;
  }

  async function runIntent(it) {
    const agentId = await orgs.agentId(it.org_id);
    if (PACKAGE_OPS.has(it.op)) return runInstall(it, agentId);
    return manage({ op: it.op, skillId: it.skill_id, orgId: it.org_id, intentId: it.id, requestId: it.request_id });
  }

  const local = async (op, skillId) => {
    const rec = installs()[skillId];
    if (!rec) throw new Error(`skill ${skillId} is not installed`);
    return manage({ op, skillId, orgId: rec.org_id });
  };

  // Revoked installed versions move to quarantine as revoked_disabled; never deleted. Idempotent.
  function enforceRevocations() {
    const revoked = revokedSet(state);
    let n = 0;
    for (const [skillId, rec] of Object.entries(installs())) {
      if (rec.state === 'revoked_disabled' || !isRevoked(rec, revoked)) continue;
      moveDir(dirOf(rec.slug, rec.state), dirOf(rec.slug, 'revoked_disabled'), skillId);
      putRec(skillId, { ...rec, state: 'revoked_disabled', revoked_at: iso() });
      const msg = `skill ${rec.slug} version ${rec.version_no} was revoked; it is disabled and quarantined`;
      state.setAlert(`revoked:${skillId}`, msg);
      logger.warn(msg);
      n += 1;
    }
    return n;
  }

  return {
    enforceRevocations,

    // Resends the outbox, then runs queued skill intents in order. An org whose report or intent was deferred is held
    // back for the rest of the round.
    async runRound({ limit = MAX_INTENTS_PER_ROUND } = {}) {
      const blocked = new Set();
      const outcomes = [];
      enforceRevocations();
      await flushOutbox(blocked);
      for (let n = 0; n < limit && !signal?.aborted && !tooOld(state); n++) {
        const it = nextIntent(blocked);
        if (!it) break;
        let r;
        try {
          r = await runIntent(it);
        } catch (err) {
          logger.error(`intent ${it.id} failed: ${err.message}`);
          r = 'deferred';
        }
        outcomes.push(r);
        if (r === 'deferred') blocked.add(it.org_id);
      }
      return outcomes;
    },

    setEnabled: (skillId, enabled) => local(enabled ? 'enable' : 'disable', skillId),
    uninstall: (skillId) => local('uninstall', skillId),
    installed: installs,
  };
}
