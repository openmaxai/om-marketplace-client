import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { InstallFailure } from './failure.js';
import { MarketError } from './http.js';
import { isCanonicalUuid, uuidv7 } from './ids.js';
import { EMPTY_INTENTS, tooOld } from './intents.js';
import { revokedSet } from './revocations.js';
import { downloadPackage } from './download.js';
import { failureFor, scan, writeConfined } from './land.js';
import { INJECT, inspectBundle } from './pkg/bundle.js';
import { declarationsReady, emptySlots, readSlots, writeSlots } from './shards.js';

export const MAX_TOMBSTONES = 1000;
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

// Writes the files into templates/<id>.new-<rand>/, re-reads and compares them, then swaps the directory in.
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
      if (old) fs.renameSync(old, target);
      old = null;
      throw err;
    }
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
    if (old) fs.rmSync(old, { recursive: true, force: true });
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
  function assignSlot(id, injectSha) {
    setSlots((s) => {
      const n = slotOf(s, id) ?? Object.keys(s).find((k) => s[k] === null);
      if (!n) throw internal('slots_full');
      s[n] = { adoption_id: id, inject_sha256: injectSha };
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

  // A new install epoch (no epoch record in this state dir) clears the slot map and quarantines every template dir
  // named by a canonical adoption id; declarations are never touched. Missing or unreadable slots.json: nothing is
  // touched and nothing is written.
  function startEpoch() {
    if (state.read('epoch', null)) return;
    let slots;
    try { slots = readSlots(dataDir); } catch { slots = undefined; }
    if (slots === undefined) {
      state.setAlert('template_epoch', 'slots.json is unreadable; template content was left untouched');
      logger.warn('slots.json is unreadable; template content was left untouched');
    } else if (slots === null) {
      logger.warn('new install epoch without slots.json; template content was left untouched');
    } else {
      writeSlots(dataDir, emptySlots());
      let names = [];
      try { names = fs.readdirSync(path.join(dataDir, 'templates')); } catch { /* no templates dir */ }
      for (const name of names.filter(isCanonicalUuid)) quarantine(dataDir, name);
    }
    state.write('epoch', { epoch: uuidv7(now()), created_at: iso(), tombstones: [] });
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
      return assignSlot(id, rec.inject_sha256);
    }
    if (st && (!st.isDirectory() || !(rec?.state === 'active' || rec?.state === 'writing'))) throw conflict('target_exists');
    if (st && rec.state === 'active' && !it.discard_local_changes && !unchanged(rec)) throw conflict('locally_modified');
    const slots = readSlots(dataDir) ?? emptySlots();
    if (!slotOf(slots, id) && !Object.values(slots).includes(null)) throw internal('slots_full');
    const agentId = await orgs.agentId(it.org_id);
    const bytes = await downloadPackage({
      api, orgId: it.org_id, subPath: `/agents/${encodeURIComponent(agentId)}/packages/templates/${id}`, sha: it.bundle_sha256, size: null,
      emulatorOrigin, fetchImpl, now, sleep, signal,
    });
    const bundle = inspectBundle(bytes);
    const revoked = revokedSet(state);
    const manifestSha = bundle.index.manifest_sha256;
    if (revoked.has('manifest_sha256', manifestSha) || revoked.blocksSha(manifestSha) || revoked.blocksSha(it.bundle_sha256)) {
      throw internal('role_write_failed');
    }
    const injectSha = sha256(bundle.files.find((f) => f.path === INJECT).data);
    putAdoption(id, {
      adoption_id: id, org_id: it.org_id, template_id: it.template_id, bundle_sha256: it.bundle_sha256, manifest_sha256: manifestSha,
      template: bundle.index.template, version: bundle.index.version, inject_sha256: injectSha, state: 'writing',
      files: bundle.files.map((f) => ({ path: f.path, size: f.data.length, sha256: sha256(f.data) })),
    });
    land(dataDir, id, bundle);
    putAdoption(id, { state: 'active' });
    assignSlot(id, injectSha);
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

  async function write(it, body) {
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
      fs.rmSync(dir(id), { recursive: true, force: true });
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
    if (res && r.body.kind === 'write' && r.body.status === 'succeeded' && res.status === 'failed' && res.error_code !== 'INSTALL_TIMEOUT') {
      revoke(r.adoption_id, 'market closed the write as failed');
    }
    state.update('template_reports', {}, (d) => { delete d[requestId]; });
    setIntent(r.intent_id, null);
    return r.body.status;
  }

  function sweepRevoked() {
    const revoked = revokedSet(state);
    for (const [id, rec] of Object.entries(adoptions())) {
      if (rec.state !== 'active' && rec.state !== 'writing') continue;
      if (revoked.has('manifest_sha256', rec.manifest_sha256) || revoked.blocksSha(rec.manifest_sha256) || revoked.blocksSha(rec.bundle_sha256)) {
        revoke(id, 'template version revoked');
      }
    }
  }

  try {
    startEpoch();
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
          logger.info(`template intent ${it.id} expired; dropped`);
          setIntent(it.id, null);
          continue;
        }
        if (!orgs.mayContact(it.org_id) || queue.some((o) => o.org_id === it.org_id && o.seq < it.seq && LIVE.has(o.status))) continue;
        const requestId = it.request_id ?? uuidv7(now());
        setIntent(it.id, { status: 'running', request_id: requestId });
        const base = { request_id: requestId, intent_id: it.id, kind: it.op === 'write_template' ? 'write' : 'uninstall' };
        const body = it.op === 'write_template' ? await write(it, base) : remove(it, base);
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
        if (!slotOf(slots, id) || !lstatOrNull(dir(id))?.isDirectory()) items.push({ kind: 'template_inject_missing', adoption_id: id });
        else if (!unchanged(rec)) {
          let inject = null;
          try { inject = sha256(fs.readFileSync(path.join(dir(id), INJECT), { flag: fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW })); } catch { /* missing */ }
          items.push({ kind: 'template_locally_modified', adoption_id: id, ...(inject ? { rendered_sha256: inject } : {}) });
        }
      }
      return items;
    },
  };
}
