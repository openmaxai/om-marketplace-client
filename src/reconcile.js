import { MarketError } from './http.js';
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
    if (cur.length && (cur.length >= maxItems || size + 1 + n > maxBytes)) {
      out.push(cur);
      cur = [];
      size = empty;
    }
    if (empty + n > maxBytes) continue;
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
    else matching.push(skillId);
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

  // Takes one report from the hourly budget, persisted before the request is sent.
  function takeBudget() {
    const t = now();
    let ok = false;
    state.update('reconcile', EMPTY_RECONCILE, (d) => {
      d.sent = (d.sent ?? []).filter((s) => t - Date.parse(s) < RATE_WINDOW_MS);
      if (t < Date.parse(d.blocked_until ?? '') || d.sent.length >= RATE_BUDGET) return;
      d.sent.push(iso());
      ok = true;
    });
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

  // Sends entries in batches; returns 'ok', 'dropped' (sent without items the market refused), 'deferred',
  // 'rate_limited' or 'rejected'.
  async function send(orgId, agentId, entries, tally) {
    const queue = batches(entries);
    let retried = false;
    while (queue.length) {
      const batch = queue.shift();
      if (!takeBudget()) return 'rate_limited';
      let outcomes;
      try {
        outcomes = await api.reportReconcile({ orgId, agentId, items: batch.map((e) => e.item) });
      } catch (err) {
        if (!(err instanceof MarketError)) throw err;
        const code = err.code || err.status;
        if (err.status === 429) {
          if (err.retryAfterMs) state.update('reconcile', EMPTY_RECONCILE, (d) => { d.blocked_until = new Date(now() + err.retryAfterMs).toISOString(); });
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
        const rest = batch.filter((_, i) => !bad.has(i));
        if (err.status !== 400 || retried || !bad.size || !rest.length) return 'rejected';
        retried = true;
        queue.unshift(rest);
        continue;
      }
      batch.forEach((e, i) => {
        tally[outcomes[i]] += 1;
        e.after?.(outcomes[i]);
      });
    }
    return retried ? 'dropped' : 'ok';
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
        for (const id of consistent.get(orgId) ?? []) if (skills.releaseRollback(id)) logger.info(`reconcile: previous version of skill ${id} released`);
      }
      delete r.agentId;
    }

    const outcome = limited ? 'rate_limited' : failed || Object.values(report).some((r) => r.status !== 'ok') ? 'partial' : 'ok';
    const reported = Object.values(report).reduce((n, r) => n + (r.items ?? 0), 0);
    state.update('reconcile', EMPTY_RECONCILE, (d) => {
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
