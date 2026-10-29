import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { InstallFailure } from './failure.js';
import { MarketError } from './http.js';
import { isCanonicalUuid, isSha256Hex, uuidv7 } from './ids.js';
import { EMPTY_INTENTS, tooOld } from './intents.js';
import { revokedSet } from './revocations.js';
import { downloadPackage } from './download.js';
import { failureFor, scan, writeConfined } from './land.js';
import { discard, fsyncDir, leftInTrash } from './trash.js';
import { INJECT, ROLE, inspectBundle } from './pkg/bundle.js';
import { PackageError } from './pkg/zip.js';
import { declarationsReady, emptySlots, readSlots, roleLines, runtimeOf, writeSlots } from './shards.js';
import { composeSection } from './shard-emitter.js';
import { JITTER_RATIO, POLL_INTERVAL_MS } from './scheduler.js';

export const MAX_TOMBSTONES = 1000;
const MAX_ROUND_GAP_MS = Math.ceil(POLL_INTERVAL_MS * (1 + JITTER_RATIO));
// A write waiting for the Codex slot hooks is reported while its intent still has at least 2 min left, even when the
// next poll round comes as late as the jitter allows.
export const HOOKS_REPORT_MARGIN_MS = 2 * 60 * 1000 + MAX_ROUND_GAP_MS;
// Longest a write waits for the Codex slot hooks in total; later intents of its org wait behind it.
export const HOOKS_MAX_DEFERRAL_MS = 15 * 60 * 1000;
const C15_CODES = new Set(['PACKAGE_MISMATCH', 'PACKAGE_UNSAFE', 'INSTALL_TARGET_CONFLICT', 'CLIENT_INTERNAL']);
const RETRY_LATER = new Set(['INTENT_OUT_OF_ORDER', 'CLIENT_VERSION_TOO_OLD', 'MEMBER_LEFT_ORG']);
const LIVE = new Set(['queued', 'running']);

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const internal = (why) => new InstallFailure('CLIENT_INTERNAL', why);
const conflict = (why) => new InstallFailure('INSTALL_TARGET_CONFLICT', why);
const lstatOrNull = (p) => { try { return fs.lstatSync(p); } catch (err) { if (err.code === 'ENOENT') return null; throw err; } };
const rand = () => crypto.randomBytes(6).toString('hex');
export const isTemplateIntent = (it) => it.op === 'write_template' || (it.op === 'uninstall' && Boolean(it.adoption_id) && !it.skill_id);

function realDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!fs.lstatSync(dir).isDirectory()) throw new Error(`${dir} is not a directory`);
  return dir;
}

// Moves templates/<id> to quarantine/<id> by rename on the same filesystem; a link is moved, never followed.
export function quarantine(dataDir, id) {
  const src = path.join(dataDir, 'templates', id);
  if (!lstatOrNull(src)) return false;
  const q = realDir(path.join(dataDir, 'quarantine'));
  const dest = lstatOrNull(path.join(q, id)) ? path.join(q, `${id}.${Date.now()}`) : path.join(q, id);
  fs.renameSync(src, dest);
  return true;
}

const trashOf = (dataDir) => path.join(dataDir, 'trash');
const LEFTOVER_RE = /^(.+)\.(new|old)-[0-9a-f]{12}$/;

// Writes the files into templates/<id>.new-<rand>/, re-reads and compares them, then swaps the directory in. What is
// replaced or left over goes through the trash, so nothing is ever deleted in place.
function land(dataDir, id, bundle) {
  const root = realDir(path.join(dataDir, 'templates'));
  const target = path.join(root, id);
  const stage = path.join(root, `${id}.new-${rand()}`);
  fs.mkdirSync(stage, { mode: 0o700 });
  let old = null;
  try {
    for (const f of bundle.files) writeConfined(stage, f.path, f.data);
    const got = scan(stage);
    const want = new Map(bundle.files.map((f) => [f.path, sha256(f.data)]));
    if (got.length !== want.size || !got.every((g) => want.get(g.path) === g.sha256)) throw internal('staged_files_mismatch');
    if (lstatOrNull(target)) {
      old = path.join(root, `${id}.old-${rand()}`);
      fs.renameSync(target, old);
    }
    try {
      fs.renameSync(stage, target);
    } catch (err) {
      // Not discarded below even when putting it back fails: cleanLeftovers restores it at the next start.
      const o = old;
      old = null;
      if (o) fs.renameSync(o, target);
      throw err;
    }
  } finally {
    // A copy that cannot be discarded now is left to cleanLeftovers at the next start.
    for (const d of [stage, old]) try { if (d) discard(d, trashOf(dataDir)); } catch { /* left over */ }
  }
}

// templates/<id>.new-* and .old-* of one adoption (all of them when id is null), as [name, id, kind].
function leftovers(dataDir, id = null) {
  let names = [];
  try { names = fs.readdirSync(path.join(dataDir, 'templates')); } catch { /* none */ }
  return names.map((n) => [n, ...(LEFTOVER_RE.exec(n)?.slice(1) ?? [])])
    .filter(([, a]) => isCanonicalUuid(a) && (id === null || a === id)).sort();
}

// Cleans up after a crash inside land(): a staged copy is discarded; a replaced copy (a real directory) is put back when
// the swap did not happen (templates/<id> is missing), else discarded.
export function cleanLeftovers(dataDir) {
  const root = path.join(dataDir, 'templates');
  for (const [name, id, kind] of leftovers(dataDir)) {
    const p = path.join(root, name);
    if (kind === 'old' && !lstatOrNull(path.join(root, id)) && lstatOrNull(p)?.isDirectory()) {
      fs.renameSync(p, path.join(root, id));
      fsyncDir(root);
    } else {
      discard(p, trashOf(dataDir));
    }
  }
}

// Executes write_template and template uninstall intents and reports them with C-15. Results not yet accepted are kept in
// template_reports and resent unchanged first.
export function createTemplates({
  api, state, orgs, logger, dataDir, zylosDir, revocations = null, emulatorOrigin = null, fetchImpl, now = Date.now, sleep, signal = null,
}) {
  const iso = () => new Date(now()).toISOString();
  const adoptions = () => state.read('adoptions', {});
  const putAdoption = (id, rec) => state.update('adoptions', {}, (d) => { d[id] = { ...d[id], ...rec, updated_at: iso() }; });
  const setIntent = (id, patch) => state.update('intents', EMPTY_INTENTS, (d) => {
    d.queue = patch ? d.queue.map((q) => (q.id === id ? { ...q, ...patch } : q)) : d.queue.filter((q) => q.id !== id);
  });
  const dir = (id) => path.join(dataDir, 'templates', id);
  const unchanged = (rec) => {
    try {
      const got = scan(dir(rec.adoption_id));
      return got.length === rec.files.length && got.every((g) => rec.files.some((f) => f.path === g.path && f.sha256 === g.sha256));
    } catch { return false; }
  };

  function setSlots(fn) {
    const slots = readSlots(dataDir) ?? emptySlots();
    if (fn(slots)) writeSlots(dataDir, slots);
    return slots;
  }
  const slotOf = (slots, id) => Object.keys(slots).find((n) => slots[n]?.adoption_id === id);
  const clearSlot = (id) => setSlots((s) => { const n = slotOf(s, id); if (n) s[n] = null; return Boolean(n); });
  function assignSlot(id, injectSha, roleSha) {
    setSlots((s) => {
      const n = slotOf(s, id) ?? Object.keys(s).find((k) => s[k] === null);
      if (!n) throw internal('slots_full');
      s[n] = { adoption_id: id, inject_sha256: injectSha, ...(roleSha ? { role_sha256: roleSha } : {}) };
      return true;
    });
  }

  // Stops injection first, then quarantines the content. Never deletes.
  function revoke(id, why) {
    clearSlot(id);
    quarantine(dataDir, id);
    putAdoption(id, { state: 'quarantined' });
    const msg = `template adoption ${id} quarantined: ${why}`;
    if (state.setAlert(`template:${id}`, msg)) logger.warn(msg);
  }

  function adoptionDirs() {
    try { return fs.readdirSync(path.join(dataDir, 'templates')).filter(isCanonicalUuid); } catch { return []; }
  }

  // A new install epoch (no epoch record in this state dir) clears the slot map and quarantines every template dir
  // named by a canonical adoption id; declarations are never touched. Missing or unreadable slots.json: nothing is
  // touched and nothing is written; that is an alert unless templates/ holds no adoption dir (a fresh install).
  function startEpoch() {
    if (state.read('epoch', null)) return;
    let slots;
    try { slots = readSlots(dataDir); } catch { slots = undefined; }
    if (slots === undefined) {
      state.setAlert('template_epoch', 'slots.json is unreadable; template content was left untouched');
      logger.warn('slots.json is unreadable; template content was left untouched');
    } else if (slots === null) {
      if (adoptionDirs().length) {
        const msg = 'new install epoch without slots.json while templates/ holds adoption content; it was left untouched';
        state.setAlert('template_epoch', msg);
        logger.warn(msg);
      }
    } else {
      writeSlots(dataDir, emptySlots());
      for (const name of adoptionDirs()) quarantine(dataDir, name);
    }
    state.write('epoch', { epoch: uuidv7(now()), created_at: iso(), tombstones: [] });
  }

  // The template_epoch alert holds while slots.json is unreadable, or missing with adoption dirs in templates/.
  function epochResolved() {
    let slots;
    try { slots = readSlots(dataDir); } catch { return; }
    if (slots === null && adoptionDirs().length) return;
    state.clearAlert('template_epoch');
  }

  function failureOf(err) {
    const f = failureFor(err);
    if (f.reason === 'client internal error') {
      logger.error(`template write failed: ${err.message}`);
      return internal('role_write_failed');
    }
    return C15_CODES.has(f.code) ? f : internal(f.reason);
  }

  async function writeBundle(it) {
    const id = it.adoption_id;
    if (!declarationsReady(zylosDir)) throw internal('inject_unavailable');
    const rec = adoptions()[id];
    const st = lstatOrNull(dir(id));
    if (rec?.state === 'active' && rec.bundle_sha256 === it.bundle_sha256 && st?.isDirectory() && unchanged(rec)) {
      return assignSlot(id, rec.inject_sha256, rec.role_sha256);
    }
    if (st && (!st.isDirectory() || !['active', 'writing', 'failed'].includes(rec?.state))) throw conflict('target_exists');
    if (st && rec.state === 'active' && !it.discard_local_changes && !unchanged(rec)) throw conflict('locally_modified');
    const slots = readSlots(dataDir) ?? emptySlots();
    if (!slotOf(slots, id) && !Object.values(slots).includes(null)) throw internal('slots_full');
    const agentId = await orgs.agentId(it.org_id);
    const bytes = await downloadPackage({
      api, orgId: it.org_id, subPath: `/agents/${encodeURIComponent(agentId)}/packages/templates/${id}`, sha: it.bundle_sha256, size: null,
      emulatorOrigin, fetchImpl, now, sleep, signal,
    });
    const bundle = inspectBundle(bytes);
    // The whole section the emitter will print (priority and path lines included) must fit, or the slot would print nothing.
    if (composeSection(dir(id), (bundle.role ? roleLines(bundle.role) : '') + bundle.inject) === null) {
      throw new PackageError('inject_too_large', 'template section does not fit the shard budget');
    }
    const revoked = revokedSet(state);
    const manifestSha = bundle.index.manifest_sha256;
    if (revoked.has('manifest_sha256', manifestSha) || revoked.blocksSha(manifestSha) || revoked.blocksSha(it.bundle_sha256)) {
      throw internal('role_write_failed');
    }
    const injectSha = sha256(bundle.files.find((f) => f.path === INJECT).data);
    const roleFile = bundle.files.find((f) => f.path === ROLE);
    const roleSha = roleFile ? sha256(roleFile.data) : undefined;
    putAdoption(id, {
      adoption_id: id, org_id: it.org_id, template_id: it.template_id, bundle_sha256: it.bundle_sha256, manifest_sha256: manifestSha,
      template: bundle.index.template, version: bundle.index.version, inject_sha256: injectSha, role_sha256: roleSha, state: 'writing',
      files: bundle.files.map((f) => ({ path: f.path, size: f.data.length, sha256: sha256(f.data) })),
    });
    try {
      land(dataDir, id, bundle);
    } catch (err) {
      // The previous active version is what the market still has: it is kept (reconcile reports it when its content is
      // not in place); any other attempt ends as failed.
      state.update('adoptions', {}, (d) => {
        d[id] = rec?.state === 'active' ? { ...rec, updated_at: iso() } : { ...d[id], state: 'failed', updated_at: iso() };
      });
      throw err;
    }
    putAdoption(id, { state: 'active' });
    assignSlot(id, injectSha, roleSha);
  }

  // C-04 answers one 404 for every reason: pull C-11 first, then ask C-01 whether the intent is still pending.
  async function bundleGone(it) {
    await revocations?.pull();
    const page = await api.pullInstallIntents({ orgId: orgs.primary, agentId: await orgs.agentId(orgs.primary), afterSeq: it.seq - 1, limit: 1 });
    if (page?.items[0]?.id === it.id) return null;
    logger.info(`template intent ${it.id} is no longer pending; dropped`);
    setIntent(it.id, null);
    return 'closed';
  }

  function marketFailure(err, it) {
    if (err.code === 'MEMBER_LEFT_ORG') orgs.markLeft(it.org_id, err.reason);
    if (err.transient || RETRY_LATER.has(err.code)) return 'deferred';
    state.setAlert(`template_intent:${it.id}`, `template intent ${it.id} rejected (${err.code || err.status})`);
    setIntent(it.id, null);
    return 'closed';
  }

  function hooksAlert() {
    const msg = 'template slot hooks are missing from the Codex hook file; restart the Codex session, then adopt the template again';
    if (state.setAlert('template_hooks_pending', msg)) logger.warn(msg);
  }

  // Codex adds the slot hooks only when its session next starts, so a write waits for them while its intent has more
  // than HOOKS_REPORT_MARGIN_MS left (with no known expiry: for one round), for at most HOOKS_MAX_DEFERRAL_MS in total,
  // and only while no later template intent of any org is queued (a deferral ends the round); later intents of its org
  // wait too. Then it is reported as inject_unavailable, before the market times it out.
  function hooksPending(it, body, queue) {
    const rec = state.read('template_hooks', null) ?? {};
    const since = Number.isFinite(Date.parse(rec.pending_since)) ? rec.pending_since : iso();
    const live = new Set(queue.map((q) => q.id));
    // Legacy records list the deferred ids only; their deferral is counted from pending_since.
    const prev = Array.isArray(rec.deferred) ? Object.fromEntries(rec.deferred.map((id) => [id, since]))
      : rec.deferred && typeof rec.deferred === 'object' ? rec.deferred : {};
    const waited = Object.fromEntries(Object.entries(prev).filter(([id]) => live.has(id)));
    hooksAlert();
    const exp = Date.parse(it.expires_at);
    const first = Date.parse(waited[it.id]);
    const elapsed = Number.isFinite(first) ? now() - first : 0;
    const behind = queue.some((q) => isTemplateIntent(q) && q.seq > it.seq && LIVE.has(q.status));
    const wait = !behind && elapsed + MAX_ROUND_GAP_MS <= HOOKS_MAX_DEFERRAL_MS
      && (Number.isFinite(exp) ? exp - now() > HOOKS_REPORT_MARGIN_MS : !(it.id in waited));
    const deferred = { ...waited };
    if (!wait) delete deferred[it.id];
    else if (!Number.isFinite(first)) deferred[it.id] = iso();
    const next = { pending_since: since, deferred };
    if (JSON.stringify(next) !== JSON.stringify(rec)) state.write('template_hooks', next);
    if (wait) {
      if (!(it.id in waited)) logger.info(`template intent ${it.id} waits for the slot hooks; they are added when the Codex session next starts`);
      return 'deferred';
    }
    logger.warn(`template intent ${it.id} reported as inject_unavailable: the slot hooks are still missing`);
    return { ...body, status: 'failed', error_code: 'CLIENT_INTERNAL', error_message: 'inject_unavailable', rendered_sha256: it.bundle_sha256 };
  }
  function hooksReady() {
    if (state.read('template_hooks', null) !== null) state.write('template_hooks', null);
    state.clearAlert('template_hooks_pending');
  }

  async function write(it, body, queue) {
    if (!declarationsReady(zylosDir)) {
      if (runtimeOf(zylosDir) === 'codex') return hooksPending(it, body, queue);
    } else {
      hooksReady();
    }
    try {
      await writeBundle(it);
      return { ...body, status: 'succeeded', rendered_sha256: it.bundle_sha256 };
    } catch (err) {
      if (signal?.aborted) return 'deferred';
      if (err instanceof MarketError) {
        if (err.code !== 'NOT_FOUND') return marketFailure(err, it);
        try {
          const gone = await bundleGone(it);
          if (gone) return gone;
        } catch (e) {
          if (e instanceof MarketError) return 'deferred';
          throw e;
        }
        err = internal('bundle_unavailable');
      }
      const f = failureOf(err);
      return { ...body, status: 'failed', error_code: f.code, error_message: f.reason, rendered_sha256: it.bundle_sha256 };
    }
  }

  // Remove: clear the slot, then delete templates/<id>. An adoption with no local record is not touched on disk; it is
  // recorded as a tombstone of this epoch instead.
  function remove(it, body) {
    const id = it.adoption_id;
    try {
      if (!adoptions()[id]) {
        const epoch = state.read('epoch', { tombstones: [] });
        if (epoch.tombstones.length >= MAX_TOMBSTONES) return { ...body, status: 'failed', error_code: 'CLIENT_INTERNAL', error_message: 'tombstones_full' };
        epoch.tombstones.push({ adoption_id: id, intent_id: it.id, at: iso() });
        state.write('epoch', epoch);
        logger.warn(`uninstall of unknown template adoption ${id}: nothing removed`);
        return { ...body, status: 'succeeded' };
      }
      clearSlot(id);
      const left = leftInTrash(state, logger);
      discard(dir(id), trashOf(dataDir), left);
      for (const [name] of leftovers(dataDir, id)) discard(path.join(dataDir, 'templates', name), trashOf(dataDir), left);
      putAdoption(id, { state: 'removed' });
      return { ...body, status: 'succeeded' };
    } catch (err) {
      logger.error(`template uninstall failed: ${err.message}`);
      return { ...body, status: 'failed', error_code: 'CLIENT_INTERNAL', error_message: 'role_write_failed' };
    }
  }

  async function send(requestId) {
    const r = state.read('template_reports', {})[requestId];
    let res = null;
    try {
      res = await api.reportTemplateResult({ orgId: r.org_id, agentId: await orgs.agentId(r.org_id), adoptionId: r.adoption_id, body: r.body });
    } catch (err) {
      if (!(err instanceof MarketError)) throw err;
      if (err.code === 'MEMBER_LEFT_ORG') orgs.markLeft(r.org_id, err.reason);
      if (err.transient || RETRY_LATER.has(err.code)) {
        logger.warn(`template result ${requestId} not delivered (${err.code || err.status}); kept for resend`);
        return 'deferred';
      }
      const lapsed = err.code === 'INTENT_NOT_PENDING' || err.code === 'INTENT_EXPIRED';
      if (lapsed && r.body.kind === 'write' && r.body.status === 'succeeded') revoke(r.adoption_id, 'write order no longer pending');
      else if (!lapsed) state.setAlert(`template_result:${requestId}`, `template result ${requestId} rejected (${err.code || err.status})`);
    }
    const wrote = res && r.body.kind === 'write' && r.body.status === 'succeeded';
    // A stale answer means the market did not take this write (revoked, blocked or timed out meanwhile), also when the
    // adoption stays active on its previous version: what landed is never kept.
    const stale = wrote && res.outcome === 'stale';
    if (stale) revoke(r.adoption_id, 'market did not accept the write (stale)');
    else if (wrote && res.status === 'failed' && res.error_code !== 'INSTALL_TIMEOUT') revoke(r.adoption_id, 'market closed the write as failed');
    state.update('template_reports', {}, (d) => { delete d[requestId]; });
    setIntent(r.intent_id, null);
    if (stale) await revocations?.pull();
    return r.body.status;
  }

  function sweepRevoked() {
    const revoked = revokedSet(state);
    for (const [id, rec] of Object.entries(adoptions())) {
      if (!['active', 'writing', 'failed'].includes(rec.state)) continue;
      if (revoked.has('manifest_sha256', rec.manifest_sha256) || revoked.blocksSha(rec.manifest_sha256) || revoked.blocksSha(rec.bundle_sha256)) {
        revoke(id, 'template version revoked');
      }
    }
  }

  try {
    cleanLeftovers(dataDir);
  } catch (err) {
    logger.error(`template leftovers not cleaned up: ${err.message}`);
  }
  try {
    startEpoch();
    if (state.read('epoch', null)) epochResolved();
  } catch (err) {
    logger.error(`template epoch check failed: ${err.message}`);
  }

  return {
    // Resolves to the outcome of the one template intent run, or null when there was none to run.
    async runNext() {
      for (const id of Object.keys(state.read('template_reports', {}))) if ((await send(id)) === 'deferred') return null;
      if (tooOld(state)) return null;
      const { queue } = state.read('intents', EMPTY_INTENTS);
      const t = now();
      for (const it of queue) {
        if (!isTemplateIntent(it) || !LIVE.has(it.status)) continue;
        if (Date.parse(it.expires_at) <= t) {
          if (it.op === 'write_template' && !declarationsReady(zylosDir) && runtimeOf(zylosDir) === 'codex') hooksAlert();
          logger.warn(`template intent ${it.id} expired before it was run; dropped`);
          setIntent(it.id, null);
          continue;
        }
        if (!orgs.mayContact(it.org_id) || queue.some((o) => o.org_id === it.org_id && o.seq < it.seq && LIVE.has(o.status))) continue;
        const requestId = it.request_id ?? uuidv7(now());
        setIntent(it.id, { status: 'running', request_id: requestId });
        const base = { request_id: requestId, intent_id: it.id, kind: it.op === 'write_template' ? 'write' : 'uninstall' };
        const body = it.op === 'write_template' ? await write(it, base, queue) : remove(it, base);
        if (typeof body === 'string') return body;
        state.update('template_reports', {}, (d) => { d[requestId] = { org_id: it.org_id, adoption_id: it.adoption_id, intent_id: it.id, body }; });
        return send(requestId);
      }
      return null;
    },

    // Quarantines every active adoption whose manifest or bundle is in the revoked set; idempotent.
    sweepRevoked,

    // Frees slots held by adoptions that are no longer active and returns the C-10 items for active adoptions whose
    // content or slot is gone or was changed locally.
    reconcile() {
      epochResolved();
      if (declarationsReady(zylosDir)) hooksReady();
      sweepRevoked();
      const recs = adoptions();
      const slots = setSlots((s) => {
        const dead = Object.keys(s).filter((n) => s[n] && recs[s[n].adoption_id]?.state !== 'active');
        for (const n of dead) s[n] = null;
        return dead.length > 0;
      });
      const items = [];
      for (const [id, rec] of Object.entries(recs)) {
        if (rec.state !== 'active') continue;
        // The emitter prints nothing while the slot's shas differ from the landed inject.md and role.json.
        const n = slotOf(slots, id);
        if (!n || slots[n].inject_sha256 !== rec.inject_sha256 || slots[n].role_sha256 !== rec.role_sha256 || !lstatOrNull(dir(id))?.isDirectory()) {
          items.push({ kind: 'template_inject_missing', adoption_id: id });
        } else if (!unchanged(rec)) {
          // Same basis as C-15: the bundle the content was rendered from.
          items.push({ kind: 'template_locally_modified', adoption_id: id, ...(isSha256Hex(rec.bundle_sha256) ? { rendered_sha256: rec.bundle_sha256 } : {}) });
        }
      }
      return items;
    },
  };
}
