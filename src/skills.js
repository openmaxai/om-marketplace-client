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
import { MAX_PACKAGE_BYTES, MAX_PACKAGE_FILES } from './pkg/zip.js';
import { InstallFailure } from './failure.js';
import { StateError } from './state.js';
import { discard, emptyTrash, fsyncDir } from './trash.js';

export const MAX_INTENTS_PER_ROUND = 20;
const SKILL_OPS = new Set(['install', 'upgrade', 'enable', 'disable', 'uninstall']);
const PACKAGE_OPS = new Set(['install', 'upgrade']);
const DEFER = new Set(['INTENT_OUT_OF_ORDER', 'CLIENT_VERSION_TOO_OLD', 'MEMBER_LEFT_ORG']);
const GONE = new Set(['INTENT_NOT_PENDING', 'INTENT_EXPIRED']);
// Refused for good; shown to the human as is. The market closes the intent.
const SHOWN = new Set(['VERSION_NOT_FOUND', 'VERSION_REVOKED', 'NOT_APPROVED', 'SKILL_ALREADY_INSTALLED', 'INSTALLED_BY_OTHER_ORG']);
const { O_RDONLY, O_NOFOLLOW } = fs.constants;
const CORRUPT = Symbol('corrupt');

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
  // Quarantine keeps one subdirectory per quarantined copy: quarantine/market--<slug>/<version_no>-<skill_version_id>[.n]/.
  const areas = { enabled: skillsDir, disabled: path.join(dataDir, 'disabled'), revoked_disabled: path.join(dataDir, 'quarantine') };
  const dirOf = (slug, where) => path.join(areas[where], `${SKILL_DIR_PREFIX}${slug}`);
  const rollbackDir = (slug, no) => path.join(dataDir, 'rollback', slug, String(no));
  const trashRoot = path.join(dataDir, 'trash');
  const stagingRoot = path.join(dataDir, 'staging');
  const drop = (dir) => discard(dir, trashRoot);
  // Nothing is in flight at startup: what a crash left in the trash or in staging goes first.
  emptyTrash(trashRoot);
  emptyTrash(stagingRoot);
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

  // Moves a skill directory carrying this skill's marker; false when src is absent or not ours. dst must be absent or a
  // real directory carrying this skill's marker (that one is discarded); anything else there is INSTALL_TARGET_CONFLICT
  // and nothing moves.
  function moveDir(src, dst, skillId) {
    if (readMarker(src)?.skill_id !== skillId) return false;
    if (exists(dst)) {
      if (readMarker(dst)?.skill_id !== skillId) throw new InstallFailure('INSTALL_TARGET_CONFLICT', 'target_exists');
      drop(dst);
    }
    fs.mkdirSync(path.dirname(dst), { recursive: true, mode: 0o700 });
    fs.renameSync(src, dst);
    fsyncDir(path.dirname(src));
    fsyncDir(path.dirname(dst));
    return true;
  }

  const isConflict = (err) => err instanceof InstallFailure && err.code === 'INSTALL_TARGET_CONFLICT';

  function removeOurs(dir, skillId) {
    if (readMarker(dir)?.skill_id === skillId) drop(dir);
  }

  // Moves a revoked copy into its own quarantine subdirectory; an earlier copy is never replaced.
  function quarantine(src, rec, skillId) {
    const base = dirOf(rec.slug, 'revoked_disabled');
    const name = `${rec.version_no}-${rec.skill_version_id}`;
    let dst = path.join(base, name);
    for (let n = 2; exists(dst); n++) dst = path.join(base, `${name}.${n}`);
    return moveDir(src, dst, skillId);
  }

  // Reads a journal or outbox entry. An unreadable one is moved aside with an alert so it no longer holds anything back.
  function readEntry(kind, id) {
    try {
      return state[kind].get(id);
    } catch (err) {
      if (!(err instanceof StateError)) throw err;
      state[kind].quarantine(id);
      const msg = `${kind} entry ${id} is unreadable; it was moved aside and its request is dropped`;
      state.setAlert(`corrupt:${kind}:${id}`, msg);
      logger.error(msg);
      return CORRUPT;
    }
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

  const revokedRec = (rec) => ({ ...rec, state: 'revoked_disabled', revoked_at: iso() });

  function revokedAlert(skillId, rec) {
    const msg = `skill ${rec.slug} version ${rec.version_no} was revoked; it is disabled and quarantined`;
    state.setAlert(`revoked:${skillId}`, msg);
    logger.warn(msg);
  }

  // Puts the version a landing replaced back where it was, unless it is still there; one revoked meanwhile goes to
  // quarantine instead. Returns the record to keep. Idempotent.
  function restorePrior(skillId, prior) {
    if (!prior || prior.state === 'revoked_disabled') return prior;
    const src = rollbackDir(prior.slug, prior.version_no);
    const live = dirOf(prior.slug, prior.state);
    const isPrior = (d) => readMarker(d)?.package_sha256 === prior.package_sha256;
    if (isRevoked(prior)) {
      for (const d of [live, src]) if (isPrior(d)) quarantine(d, prior, skillId);
      revokedAlert(skillId, prior);
      return revokedRec(prior);
    }
    if (isPrior(live)) return prior;
    try {
      moveDir(src, live, skillId);
    } catch (err) {
      if (!isConflict(err)) throw err;
      const msg = `skill ${prior.slug} version ${prior.version_no} could not be put back: ${live} is not market-managed; it stays in ${src}`;
      state.setAlert(`conflict:${skillId}`, msg);
      logger.warn(msg);
    }
    return prior;
  }

  // Takes a landing back: the landed copy is discarded (quarantined when revoked) and the replaced version restored.
  function undoLanding(j) {
    const { response: res, prior } = j;
    const revoked = isRevoked(res);
    for (const w of ['enabled', 'disabled']) {
      const d = dirOf(res.slug, w);
      if (readMarker(d)?.package_sha256 !== res.package_sha256) continue;
      if (revoked) quarantine(d, res, res.skill_id);
      else removeOurs(d, res.skill_id);
    }
    putRec(res.skill_id, restorePrior(res.skill_id, prior));
  }

  // Records a landed version; a disabled skill stays disabled. Idempotent.
  function recordLanded(rid, j) {
    const { response: res, prior } = j;
    const where = prior?.state === 'disabled' ? 'disabled' : 'enabled';
    putRec(res.skill_id, {
      org_id: j.org_id, install_id: res.install_id, slug: res.slug, skill_version_id: res.skill_version_id, version_no: res.version_no,
      package_sha256: res.package_sha256, source_market_id: res.source_market_id, state: where, installed_at: iso(), request_id: rid,
      rollback: prior && prior.state !== 'revoked_disabled' ? { version_no: prior.version_no, skill_version_id: prior.skill_version_id } : null,
    });
    return journal(rid, { phase: 'landed' });
  }

  // Keeps only the version replaced by the latest upgrade.
  function pruneRollback(rec) {
    const dir = path.join(dataDir, 'rollback', rec.slug);
    let names = [];
    try { names = fs.readdirSync(dir); } catch { /* none */ }
    for (const n of names) if (n !== String(rec.rollback?.version_no)) drop(path.join(dir, n));
  }

  async function send(o) {
    if (o.kind === 'result') return api.reportInstallResult({ orgId: o.org_id, requestId: o.request_id, body: o.body });
    const agentId = await orgs.agentId(o.org_id);
    return api.manageSkill({ orgId: o.org_id, agentId, skillId: o.skill_id, verb: o.kind, body: o.body });
  }

  async function deliver(id) {
    const o = readEntry('outbox', id);
    if (o === CORRUPT || !o) return 'closed';
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
    const j = readEntry('journal', id);
    if (o.kind === 'result' && res && o.body.status === 'succeeded' && j !== CORRUPT && j?.response) {
      if (res.status === 'succeeded') pruneRollback(installs()[j.response.skill_id] ?? { slug: j.response.slug });
      else if (res.error_code === 'INSTALL_TIMEOUT') logger.warn(`install ${id}: market timed it out; the landed version stays for reconcile`);
      else {
        logger.warn(`install ${id}: market refused the result (${res.error_code}); rolling back`);
        undoLanding(j);
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
  // A version revoked while the process was down is taken back instead of being recorded or reported as installed.
  async function recover(it, rid, j) {
    const st = await statusOf(it, rid);
    if (st === 'deferred' || st === 'closed') return st;
    let landed = false;
    let revoked = false;
    if (j.response && (j.phase === 'landing' || j.phase === 'landed')) {
      landed = Boolean(landedDir(j.response));
      if (!j.result && isRevoked(j.response)) {
        undoLanding(j);
        [landed, revoked] = [false, true];
      } else if (j.phase === 'landing') {
        if (landed) j = recordLanded(rid, j);
        else putRec(j.response.skill_id, restorePrior(j.response.skill_id, j.prior));
      }
    }
    if (st === null) return j.response ? close(it, rid, 'unknown to the market') : null;
    if (st.status !== 'running') return close(it, rid, `market status ${st.status} ${st.error_code ?? ''}`.trim());
    if (j.result) return report(rid, it, j.result);
    if (revoked) return report(rid, it, { status: 'failed', error_code: 'VERSION_REVOKED', error_message: 'version_revoked' });
    if (landed) return report(rid, it, { status: 'succeeded', installed_sha256: j.response.package_sha256 });
    return null;
  }

  // The market may pick the version, so what C-02 selected is checked against the revoked set and the package caps
  // before any download. Returns [code, message] or null.
  function refusedBeforeDownload(res) {
    const revoked = revokedSet(state);
    if (revoked.has('skill_version_id', res.skill_version_id)) return ['VERSION_REVOKED', 'version_revoked'];
    if (revoked.blocksSha(res.package_sha256)) return ['VERSION_REVOKED', 'sha_blocked'];
    if (res.size_bytes > MAX_PACKAGE_BYTES || res.file_manifest.reduce((n, e) => n + e.size, 0) > MAX_PACKAGE_BYTES) {
      return ['PACKAGE_UNSAFE', 'too_large'];
    }
    if (res.file_manifest.length > MAX_PACKAGE_FILES) return ['PACKAGE_UNSAFE', 'too_many_files'];
    return null;
  }

  // Only a higher version replaces a local one; a lower one only from the same source shelf when the local one is revoked.
  function versionRefused(res, prior) {
    if (!prior || res.version_no > prior.version_no) return false;
    const revokedPrior = prior.state === 'revoked_disabled' || isRevoked(prior);
    return !(res.version_no < prior.version_no && revokedPrior && res.source_market_id === prior.source_market_id);
  }

  // The exact version is already in place (kept after INSTALL_TIMEOUT): nothing to land.
  const alreadyLanded = (res, prior) => prior && prior.state !== 'revoked_disabled' && res.version_no === prior.version_no
    && res.package_sha256 === prior.package_sha256 && Boolean(landedDir(res));

  async function runInstall(it, agentId) {
    const rid = it.request_id ?? uuidv7(now());
    let j = readEntry('journal', rid);
    if (j === CORRUPT || j?.phase === 'reported' || j?.phase === 'closed') return setIntent(it.id, null), 'closed';
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
    const refused = refusedBeforeDownload(res);
    if (refused) return fail(...refused);
    if (alreadyLanded(res, prior)) {
      putRec(res.skill_id, { ...prior, install_id: res.install_id, request_id: rid });
      journal(rid, { phase: 'landed', prior });
      return report(rid, it, { status: 'succeeded', installed_sha256: res.package_sha256 });
    }
    if (versionRefused(res, prior)) return fail('INSTALL_TARGET_CONFLICT', 'not_higher');
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
    // A revocation may have arrived during the download.
    const late = refusedBeforeDownload(res);
    if (late) return fail(...late);
    j = journal(rid, { phase: 'landing', prior });
    try {
      // A disabled skill is upgraded in the disabled area, so the new version is never enabled on the way.
      const targetRoot = prior?.state === 'disabled' ? areas.disabled : skillsDir;
      fs.mkdirSync(targetRoot, { recursive: true, mode: 0o700 });
      landSkill({
        skillsDir, targetRoot, stagingRoot, rollbackRoot: path.join(dataDir, 'rollback'), trashRoot, requestId: rid, install: res, inspected,
      });
    } catch (err) {
      putRec(res.skill_id, restorePrior(res.skill_id, prior));
      return failure(err);
    }
    recordLanded(rid, j);
    return report(rid, it, { status: 'succeeded', installed_sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
  }

  // Local change first, then C-08 / C-09. Enabling revoked content, or moving onto a directory that is not ours, is refused
  // and not reported. The skill is looked for in both areas, so a move whose record update was lost is completed.
  function applyLocal(op, skillId) {
    enforceRevocations();
    const rec = installs()[skillId];
    if (!rec) return 'absent';
    if (op === 'uninstall') {
      for (const w of ['enabled', 'disabled']) removeOurs(dirOf(rec.slug, w), skillId);
      const q = dirOf(rec.slug, 'revoked_disabled');
      let names = [];
      try { names = fs.readdirSync(q); } catch { /* none */ }
      for (const n of names) removeOurs(path.join(q, n), skillId);
      try { fs.rmdirSync(q); } catch { /* absent, or holds something that is not ours */ }
      drop(path.join(dataDir, 'rollback', rec.slug));
      putRec(skillId, null);
      return 'done';
    }
    if (rec.state === 'revoked_disabled') return op === 'enable' ? 'revoked' : 'done';
    const want = op === 'enable' ? 'enabled' : 'disabled';
    try {
      moveDir(dirOf(rec.slug, want === 'enabled' ? 'disabled' : 'enabled'), dirOf(rec.slug, want), skillId);
    } catch (err) {
      if (isConflict(err)) return 'conflict';
      throw err;
    }
    if (rec.state !== want) putRec(skillId, { ...rec, state: want });
    return 'done';
  }

  async function manage({ op, skillId, orgId, intentId = null, requestId = null }) {
    const rid = requestId ?? uuidv7(now());
    let j = readEntry('journal', rid);
    if (j === CORRUPT || j?.phase === 'reported' || j?.phase === 'closed') return setIntent(intentId, null), 'closed';
    if (!j) {
      const body = { request_id: rid, ...(op === 'uninstall' ? {} : { enabled: op === 'enable' }), ...(intentId ? { intent_id: intentId } : {}) };
      j = journal(rid, { intent_id: intentId, org_id: orgId, op, skill_id: skillId, body, phase: 'requested' });
      setIntent(intentId, { status: 'running', request_id: rid });
    }
    const local = applyLocal(op, skillId);
    if (local === 'revoked' || local === 'conflict') {
      // C-08 has no way to report a refusal, so the market's intent stays pending until it expires and may hold back
      // later intents of this org until then.
      const why = local === 'revoked' ? 'its version was revoked and it is quarantined'
        : `the ${op === 'enable' ? 'skills' : 'disabled'} directory already holds a market--<slug> entry that is not market-managed`;
      const msg = `${op} of skill ${skillId} was refused: ${why}${intentId ? `; intent ${intentId} stays pending at the market until it expires` : ''}`;
      state.setAlert(`${local === 'revoked' ? 'revoked' : 'conflict'}:${skillId}`, msg);
      logger.warn(msg);
      journal(rid, { phase: 'closed', closed: local });
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
      const o = readEntry('outbox', id);
      if (o === CORRUPT || !o || blocked.has(o.org_id)) continue;
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

  // Head of the queue in seq order, skipping orgs held back this round.
  function nextIntent(blocked) {
    const t = now();
    const revoked = revokedSet(state);
    for (const it of state.read('intents', EMPTY_INTENTS).queue) {
      if (blocked.has(it.org_id) || (it.status !== 'queued' && it.status !== 'running')) continue;
      // Another runner's intent (a template intent) goes first: later intents of its org wait for it.
      if (!SKILL_OPS.has(it.op) || !it.skill_id) {
        blocked.add(it.org_id);
        continue;
      }
      if (!installsAllowed && PACKAGE_OPS.has(it.op)) continue;
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

  // Revoked installed versions move to quarantine as revoked_disabled; never deleted. Both areas are checked, also for a
  // record already quarantined, so a move lost in a crash is completed. Idempotent.
  function enforceRevocations() {
    const revoked = revokedSet(state);
    let n = 0;
    for (const [skillId, rec] of Object.entries(installs())) {
      if (rec.state !== 'revoked_disabled' && !isRevoked(rec, revoked)) continue;
      for (const w of ['enabled', 'disabled']) {
        const d = dirOf(rec.slug, w);
        const m = readMarker(d);
        if (m?.skill_id === skillId && m.package_sha256 === rec.package_sha256) quarantine(d, rec, skillId);
      }
      if (rec.state === 'revoked_disabled') continue;
      putRec(skillId, revokedRec(rec));
      revokedAlert(skillId, rec);
      n += 1;
    }
    return n;
  }

  function busySkills() {
    const busy = new Set(state.read('intents', EMPTY_INTENTS).queue
      .filter((q) => q.skill_id && (q.status === 'queued' || q.status === 'running')).map((q) => q.skill_id));
    const peek = (kind, id) => { try { return state[kind].get(id); } catch (err) { if (err instanceof StateError) return null; throw err; } };
    for (const id of state.outbox.list()) {
      const sid = peek('outbox', id)?.skill_id ?? peek('journal', id)?.response?.skill_id;
      if (sid) busy.add(sid);
    }
    return busy;
  }

  // Swaps the version kept by the last upgrade back in; the replaced one takes its place in the rollback area. The
  // market learns of it through reconcile (local_rollback). Returns 'done', 'none', 'revoked', 'busy' or 'quarantined'.
  function rollback(skillId) {
    const rec = installs()[skillId];
    if (!rec) throw new Error(`skill ${skillId} is not installed`);
    if (rec.state === 'revoked_disabled') return 'quarantined';
    if (busySkills().has(skillId)) return 'busy';
    const prev = rec.rollback;
    const src = prev ? rollbackDir(rec.slug, prev.version_no) : null;
    const m = src ? readMarker(src) : null;
    if (m?.skill_id !== skillId || m.version_no !== prev.version_no) return 'none';
    if (isRevoked({ skill_version_id: prev.skill_version_id, package_sha256: m.package_sha256 })) return 'revoked';
    const cur = dirOf(rec.slug, rec.state);
    if (!moveDir(cur, rollbackDir(rec.slug, rec.version_no), skillId)) return 'none';
    fs.renameSync(src, cur);
    putRec(skillId, {
      ...rec, skill_version_id: prev.skill_version_id, version_no: prev.version_no, package_sha256: m.package_sha256, rolled_back_at: iso(),
      rollback: { version_no: rec.version_no, skill_version_id: rec.skill_version_id },
    });
    logger.info(`skill ${rec.slug} rolled back from version ${rec.version_no} to ${prev.version_no}`);
    return 'done';
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

    // Read-only view for reconcile: the inventory, the recorded skills whose directory is in place, market-managed
    // directories without a record, and skills with an intent or report still in flight.
    localScan() {
      const recs = installs();
      const present = new Set(Object.keys(recs).filter((id) => readMarker(dirOf(recs[id].slug, recs[id].state))?.skill_id === id));
      const orphans = [];
      for (const where of ['enabled', 'disabled']) {
        let names = [];
        try { names = fs.readdirSync(areas[where]); } catch { /* none */ }
        for (const n of names.filter((x) => x.startsWith(SKILL_DIR_PREFIX))) {
          const m = readMarker(path.join(areas[where], n));
          if (m && !Object.hasOwn(recs, m.skill_id)) orphans.push(m);
        }
      }
      return { recs, present, orphans, busy: busySkills() };
    },

    // Drops the kept previous version; reconcile calls it once the market matches the installed version skillVersionId.
    // The record lets go of it first, so a crash never leaves it pointing at a partly removed copy; only that version's
    // directory, and only when it carries this skill's marker, is discarded.
    releaseRollback(skillId, skillVersionId) {
      const rec = installs()[skillId];
      if (!rec?.rollback || rec.skill_version_id !== skillVersionId) return false;
      const dir = rollbackDir(rec.slug, rec.rollback.version_no);
      putRec(skillId, { ...rec, rollback: null });
      if (readMarker(dir)?.skill_id === skillId) drop(dir);
      try { fs.rmdirSync(path.dirname(dir)); } catch { /* absent, or holds something else */ }
      return true;
    },

    rollback,
    setEnabled: (skillId, enabled) => local(enabled ? 'enable' : 'disable', skillId),
    uninstall: (skillId) => local('uninstall', skillId),
    installed: installs,
  };
}
