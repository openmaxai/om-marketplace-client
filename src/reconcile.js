import { MAX_RETRY_AFTER_MS, MarketError } from './http.js';
import { isCanonicalUuid, isOrgOrMemberId, isSha256Hex } from './ids.js';
import { EMPTY_INTENTS, enterTooOldMode, tooOld } from './intents.js';

export const MAX_ITEMS = 200;
export const MAX_BODY_BYTES = 64 * 1024;
export const RATE_WINDOW_MS = 60 * 60 * 1000;
// The market accepts 30 reports per identity per hour; the rest is left to the uninstall hook and manual runs.
export const RATE_BUDGET = 20;
// Checked every poll round (5 min +/-20%), so a run starts 45 to 51 minutes after the previous one.
export const RECONCILE_EVERY_MS = 45 * 60 * 1000;
export const EMPTY_RECONCILE = Object.freeze({ last_run_at: null, sent: [], blocked_until: null, last: null });

const SKILL = { required: ['skill_id'], optional: ['skill_version_id', 'installed_sha256'] };
const TEMPLATE = { required: ['adoption_id'], optional: ['rendered_sha256'] };
const SHAPES = {
  local_missing: SKILL,
  local_extra: SKILL,
  local_rollback: SKILL,
  revoked_disabled: { required: ['skill_id', 'skill_version_id'], optional: ['installed_sha256'] },
  template_locally_modified: TEMPLATE,
  template_inject_missing: TEMPLATE,
  org_not_configured: { required: ['intent_id', 'org_id'], optional: [] },
};
const FIELD_CHECK = { installed_sha256: isSha256Hex, rendered_sha256: isSha256Hex, org_id: isOrgOrMemberId };
const ITEM_INDEX_RE = /^items\[(\d+)\]/;

// The market's item rules, so one malformed item never fails a whole report there.
export function validItem(it) {
  const shape = SHAPES[it?.kind];
  if (!shape) return false;
  const keys = Object.keys(it).filter((k) => k !== 'kind');
  return shape.required.every((k) => Object.hasOwn(it, k))
    && keys.every((k) => (shape.required.includes(k) || shape.optional.includes(k)) && (FIELD_CHECK[k] ?? isCanonicalUuid)(it[k]));
}

// Splits entries ({ item }) into requests of at most maxItems items and maxBytes of JSON body.
export function batches(entries, { maxItems = MAX_ITEMS, maxBytes = MAX_BODY_BYTES } = {}) {
  const empty = Buffer.byteLength(JSON.stringify({ items: [] }));
  const out = [];
  let cur = [];
  let size = empty;
  for (const e of entries) {
    const n = Buffer.byteLength(JSON.stringify(e.item));
    if (empty + n > maxBytes) continue;
    if (cur.length && (cur.length >= maxItems || size + 1 + n > maxBytes)) {
      out.push(cur);
      cur = [];
      size = empty;
    }
    size += n + (cur.length ? 1 : 0);
    cur.push(e);
  }
  if (cur.length) out.push(cur);
  return out;
}

const local = (rec) => ({
  ...(isCanonicalUuid(rec.skill_version_id) ? { skill_version_id: rec.skill_version_id } : {}),
  ...(isSha256Hex(rec.package_sha256) ? { installed_sha256: rec.package_sha256 } : {}),
});

// Skill discrepancies between C-12 of orgId and the local scan; returns the items and the skills that match.
export function compareSkills(listed, scan, orgId) {
  const items = [];
  const matching = [];
  const server = new Map(listed.filter((i) => i.install_state !== 'failed').map((i) => [i.skill_id, i]));
  for (const [skillId, s] of server) {
    if (s.install_state !== 'installed' || scan.busy.has(skillId)) continue;
    const rec = Object.hasOwn(scan.recs, skillId) ? scan.recs[skillId] : null;
    if (rec?.state === 'revoked_disabled') items.push({ kind: 'revoked_disabled', skill_id: skillId, ...local(rec) });
    else if (!rec || !scan.present.has(skillId)) {
      items.push({ kind: 'local_missing', skill_id: skillId, ...(rec ? { skill_version_id: rec.skill_version_id } : {}) });
    } else if (rec.skill_version_id !== s.skill_version_id) items.push({ kind: 'local_rollback', skill_id: skillId, ...local(rec) });
    else matching.push([skillId, s.skill_version_id]);
  }
  for (const [skillId, rec] of Object.entries(scan.recs)) {
    if (rec.org_id !== orgId || server.has(skillId) || scan.busy.has(skillId) || rec.state === 'revoked_disabled' || !scan.present.has(skillId)) continue;
    items.push({ kind: 'local_extra', skill_id: skillId, ...local(rec) });
  }
  return { items, matching };
}

// Compares, per configured org, C-12 with the local skills, and adds template and unconfigured-org discrepancies; reports
// them with C-10. It only reports, except that a previous version kept in the rollback area is dropped once the market
// matches the installed one, and templates.reconcile() frees slots of adoptions that are no longer active.
export function createReconciler({ api, state, orgs, skills, templates = null, logger, now = Date.now, every = RECONCILE_EVERY_MS }) {
  const iso = () => new Date(now()).toISOString();
  let lastRun = null;

  function dropIntent(id) {
    state.update('intents', EMPTY_INTENTS, (d) => { d.queue = d.queue.filter((q) => q.id !== id); });
  }

  const validDoc = (d) => d !== null && typeof d === 'object' && !Array.isArray(d) && Array.isArray(d.sent)
    && d.sent.every((x) => typeof x === 'string' && Number.isFinite(Date.parse(x)))
    && (d.blocked_until === null || d.blocked_until === undefined || (typeof d.blocked_until === 'string' && Number.isFinite(Date.parse(d.blocked_until))));

  // The reconcile document, or null when it cannot be used. An unusable one is taken as this hour's budget spent: it is
  // rewritten that way (reporting pauses for one hour) and an alert is raised, so reconcile neither stops for good nor
  // exceeds the budget.
  function readDoc() {
    let d;
    try { d = state.read('reconcile', EMPTY_RECONCILE); } catch { /* unusable, like a corrupt one */ }
    if (validDoc(d)) return d;
    const msg = 'reconcile budget file was unreadable; it was reset as spent and reporting pauses for one hour';
    state.setAlert('reconcile:budget', msg);
    logger.error(msg);
    try {
      state.write('reconcile', { ...EMPTY_RECONCILE, sent: Array(RATE_BUDGET).fill(iso()) });
    } catch (err) {
      logger.error(`reconcile budget file cannot be rewritten: ${err.message}`);
    }
    return null;
  }

  // False when the document is unusable or the change cannot be stored.
  function updateDoc(fn) {
    const d = readDoc();
    if (!d) return false;
    fn(d);
    try {
      state.write('reconcile', d);
    } catch (err) {
      logger.error(`reconcile budget file cannot be written: ${err.message}`);
      return false;
    }
    return true;
  }

  // Takes one report from the hourly budget, persisted before the request is sent. Stamps ahead of the clock (it was set
  // back) are dropped, and a stored block never lasts longer than the longest Retry-After honoured.
  function takeBudget() {
    const t = now();
    let ok = false;
    const stored = updateDoc((d) => {
      d.sent = d.sent.filter((s) => Date.parse(s) <= t && t - Date.parse(s) < RATE_WINDOW_MS);
      if (Date.parse(d.blocked_until) > t + MAX_RETRY_AFTER_MS) d.blocked_until = new Date(t + MAX_RETRY_AFTER_MS).toISOString();
      if (t < Date.parse(d.blocked_until ?? '') || d.sent.length >= RATE_BUDGET) return;
      d.sent.push(iso());
      ok = true;
    });
    if (!stored) return false;
    if (ok) state.clearAlert('reconcile:budget');
    return ok;
  }

  async function listed(orgId, agentId) {
    if (tooOld(state)) return { list: null, status: 'too_old' };
    try {
      return { list: await api.listInstalls({ orgId, agentId }), status: 'ok' };
    } catch (err) {
      if (!(err instanceof MarketError)) throw err;
      if (err.code === 'MEMBER_LEFT_ORG') {
        orgs.markLeft(orgId, err.reason);
        return { list: null, status: 'org_left' };
      }
      if (err.code === 'CLIENT_VERSION_TOO_OLD') enterTooOldMode(state, logger, err.reason ?? 'unknown', err.min_version, null, iso());
      else if (!err.transient) state.setAlert(`reconcile:${orgId}`, `install list of org ${orgId} rejected (${err.code || err.status})`);
      logger.warn(`reconcile: install list unavailable (${err.code || err.status}); skills of that org are not compared`);
      return { list: null, status: err.code || String(err.status) };
    }
  }

  // Sends entries in batches; returns 'ok', 'dropped' (sent without items or batches the market refused), 'deferred',
  // 'rate_limited' or 'rejected'. A batch refused with 400 is resent once without the items it names, or skipped.
  async function send(orgId, agentId, entries, tally) {
    const queue = batches(entries).map((b) => ({ batch: b, retried: false }));
    let dropped = false;
    let accepted = 0;
    while (queue.length) {
      const { batch, retried } = queue.shift();
      if (!takeBudget()) return 'rate_limited';
      let outcomes;
      try {
        outcomes = await api.reportReconcile({ orgId, agentId, items: batch.map((e) => e.item) });
      } catch (err) {
        if (!(err instanceof MarketError)) throw err;
        const code = err.code || err.status;
        if (err.status === 429) {
          if (err.retryAfterMs) updateDoc((d) => { d.blocked_until = new Date(now() + err.retryAfterMs).toISOString(); });
          logger.warn(`reconcile report rate limited (${code}); reporting resumes next cycle`);
          return 'rate_limited';
        }
        if (err.code === 'MEMBER_LEFT_ORG') orgs.markLeft(orgId, err.reason);
        if (err.transient || err.code === 'MEMBER_LEFT_ORG') {
          logger.warn(`reconcile report not delivered (${code}); retried next cycle`);
          return 'deferred';
        }
        const what = `reconcile report to org ${orgId} rejected (${code})`;
        state.setAlert(`reconcile:${orgId}`, what);
        logger.error(what);
        const bad = new Set((err.errors ?? []).map((e) => ITEM_INDEX_RE.exec(e?.field ?? '')?.[1]).filter(Boolean).map(Number));
        if (err.status !== 400) return 'rejected';
        dropped = true;
        const rest = batch.filter((_, i) => !bad.has(i));
        if (!retried && bad.size && rest.length) queue.unshift({ batch: rest, retried: true });
        continue;
      }
      accepted += 1;
      batch.forEach((e, i) => {
        tally[outcomes[i]] += 1;
        e.after?.(outcomes[i]);
      });
    }
    return !dropped ? 'ok' : accepted ? 'dropped' : 'rejected';
  }

  async function run() {
    lastRun = now();
    const scan = skills.localScan();
    const templateItems = templates?.reconcile() ?? [];
    const adoptions = state.read('adoptions', {});
    const byOrg = new Map(orgs.ids().map((o) => [o, []]));
    const add = (orgId, item, after) => byOrg.get(orgId)?.push({ item, after });
    for (const it of templateItems) add(adoptions[it.adoption_id]?.org_id, it);
    const t = now();
    for (const it of state.read('intents', EMPTY_INTENTS).queue) {
      if (it.status !== 'org_not_configured') continue;
      add(orgs.primary, { kind: 'org_not_configured', intent_id: it.id, org_id: it.org_id }, (o) => {
        if (o === 'recorded' || Date.parse(it.expires_at) <= t) dropIntent(it.id);
      });
    }

    const report = {};
    const listedSkills = new Set();
    const consistent = new Map();
    for (const orgId of byOrg.keys()) {
      if (!orgs.mayContact(orgId)) {
        report[orgId] = { status: `org_${orgs.membership(orgId)}` };
        continue;
      }
      let agentId;
      try {
        agentId = await orgs.agentId(orgId);
      } catch (err) {
        report[orgId] = { status: 'no_agent_id' };
        logger.warn(`reconcile: org ${orgId} skipped: ${err.message}`);
        continue;
      }
      const { list, status } = await listed(orgId, agentId);
      report[orgId] = { status, agentId };
      if (status === 'org_left') continue;
      if (list) {
        orgs.markActive(orgId);
        for (const i of list) listedSkills.add(i.skill_id);
        const { items, matching } = compareSkills(list, scan, orgId);
        for (const item of items) add(orgId, item);
        consistent.set(orgId, matching);
      }
    }
    for (const m of scan.orphans) {
      if (!listedSkills.has(m.skill_id) && !scan.busy.has(m.skill_id)) {
        add(orgs.primary, { kind: 'local_extra', skill_id: m.skill_id, ...(isSha256Hex(m.package_sha256) ? { installed_sha256: m.package_sha256 } : {}) });
      }
    }

    const tally = { recorded: 0, skipped: 0 };
    let limited = false;
    let failed = false;
    for (const [orgId, all] of byOrg) {
      const r = report[orgId];
      if (!r?.agentId || r.status === 'org_left') continue;
      const entries = all.filter((e) => {
        if (validItem(e.item)) return true;
        logger.error(`reconcile: dropped a malformed ${e.item.kind} item`);
        return false;
      });
      r.items = entries.length;
      r.sent = entries.length && !limited ? await send(orgId, r.agentId, entries, tally) : entries.length ? 'rate_limited' : 'ok';
      if (r.sent === 'rate_limited') limited = true;
      else if (r.sent !== 'ok') failed = true;
      if (r.sent === 'ok' && r.status === 'ok') {
        state.clearAlert(`reconcile:${orgId}`);
        for (const [id, v] of consistent.get(orgId) ?? []) {
          try {
            if (skills.releaseRollback(id, v)) logger.info(`reconcile: previous version of skill ${id} released`);
          } catch (err) {
            logger.warn(`reconcile: previous version of skill ${id} not removed: ${err.message}`);
          }
        }
      }
      delete r.agentId;
    }

    const outcome = limited ? 'rate_limited' : failed || Object.values(report).some((r) => r.status !== 'ok') ? 'partial' : 'ok';
    const reported = Object.values(report).reduce((n, r) => n + (r.items ?? 0), 0);
    updateDoc((d) => {
      d.last_run_at = new Date(lastRun).toISOString();
      d.last = { at: iso(), outcome, orgs: report, ...tally };
    });
    state.recordRun('reconcile', outcome);
    const line = `reconcile: ${outcome}, ${reported} discrepancies (${tally.recorded} recorded, ${tally.skipped} skipped)`;
    if (reported) logger.info(line);
    else logger.debug(line);
    return { outcome, reported, ...tally };
  }

  return {
    run,
    // Runs at the first call of the process, then once every `every`.
    async maybeRun() {
      if (lastRun !== null && now() - lastRun < every) return null;
      return run();
    },
  };
}
