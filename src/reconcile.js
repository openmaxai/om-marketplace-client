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
const BUDGET_ALERT_KEEP_MS = 24 * 60 * 60 * 1000;
export const EMPTY_RECONCILE = Object.freeze({ last_run_at: null, sent: [], blocked_until: null, last: null });
// Urgent items are sent at once instead of with the next periodic run. Each carries a key; the keys of items already
// settled are kept (the newest MAX_URGENT_DONE), so an item queued again after a restart is not sent twice.
export const MAX_URGENT_DONE = 500;
export const EMPTY_URGENT = Object.freeze({ items: [], done: [] });
// At most this many urgent items are queued (the oldest go first); an item not delivered for URGENT_MAX_AGE_MS (its
// org unreachable all that time) is dropped.
export const MAX_URGENT_ITEMS = 200;
export const URGENT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
// Items sent one by one after a 400 that named none of them, per flush.
export const MAX_SINGLE_RESENDS = 5;
const TEMPLATE_STATUS = new Set(['template_activated', 'template_inject_missing']);

const SKILL = { required: ['skill_id'], optional: ['skill_version_id', 'installed_sha256'] };
const TEMPLATE = { required: ['adoption_id'], optional: ['rendered_sha256'] };
const SHAPES = {
  local_missing: SKILL,
  local_extra: SKILL,
  local_rollback: SKILL,
  revoked_disabled: { required: ['skill_id', 'skill_version_id'], optional: ['installed_sha256'] },
  template_locally_modified: TEMPLATE,
  template_inject_missing: TEMPLATE,
  template_activated: { required: ['adoption_id', 'rendered_sha256'], optional: [] },
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

const urgentDoc = (state) => {
  const d = state.read('reconcile_urgent', EMPTY_URGENT);
  return { items: Array.isArray(d?.items) ? d.items : [], done: Array.isArray(d?.done) ? d.done : [] };
};

// Queues urgent items, entries [{ key, org_id, item }], persisted before they are sent. A key that is queued or already
// settled is ignored. A template_activated or template_inject_missing item replaces a queued one of the same adoption,
// so one report never carries both for an adoption. Returns the number of entries added.
export function enqueueUrgent(state, entries, { now = Date.now, logger = null } = {}) {
  let added = 0;
  const fresh = (d) => entries.filter((e) => !d.items.some((x) => x.key === e.key) && !d.done.includes(e.key));
  if (!fresh(urgentDoc(state)).length) return 0;
  state.update('reconcile_urgent', EMPTY_URGENT, (raw) => {
    const d = { items: Array.isArray(raw?.items) ? raw.items : [], done: Array.isArray(raw?.done) ? raw.done : [] };
    for (const e of fresh(d)) {
      if (TEMPLATE_STATUS.has(e.item.kind)) {
        d.items = d.items.filter((x) => !(TEMPLATE_STATUS.has(x.item?.kind) && x.item.adoption_id === e.item.adoption_id));
      }
      d.items.push({ key: e.key, org_id: e.org_id, item: e.item, queued_at: new Date(now()).toISOString() });
      added += 1;
    }
    if (d.items.length > MAX_URGENT_ITEMS) {
      const over = d.items.splice(0, d.items.length - MAX_URGENT_ITEMS);
      logger?.warn(`reconcile: urgent queue full; dropped the ${over.length} oldest item(s) (${over.map((x) => x.item?.kind).join(', ')})`);
    }
    return d;
  });
  return added;
}

// Drops the queued template_activated items of an adoption (not yet sent); used once template_inject_missing was
// reported for it, so a delayed resend of an older activation never follows it.
export function dropUrgentActivated(state, adoptionId) {
  const hit = (x) => x.item?.kind === 'template_activated' && x.item.adoption_id === adoptionId;
  if (!urgentDoc(state).items.some(hit)) return;
  state.update('reconcile_urgent', EMPTY_URGENT, (raw) => {
    const d = { items: Array.isArray(raw?.items) ? raw.items : [], done: Array.isArray(raw?.done) ? raw.done : [] };
    d.items = d.items.filter((x) => !hit(x));
    return d;
  });
}

// The urgent revoked_disabled entry of a skill record just revoked; null when the record lacks a usable version id.
export function revokedEntry(skillId, rec) {
  if (!isCanonicalUuid(skillId) || !isCanonicalUuid(rec?.skill_version_id)) return null;
  return {
    key: `revoked_disabled:${skillId}:${rec.skill_version_id}`,
    org_id: rec.org_id,
    item: { kind: 'revoked_disabled', skill_id: skillId, ...local(rec) },
  };
}

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
// onInjectMissing(adoptionId) is called once template_inject_missing was reported for an adoption.
export function createReconciler({
  api, state, orgs, skills, templates = null, logger, now = Date.now, every = RECONCILE_EVERY_MS, onInjectMissing = null,
}) {
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

  // 'ok', 'unusable' (the document could not be used) or 'unsaved' (the change could not be stored, with an alert that
  // clears at the next stored change).
  function updateDoc(fn) {
    const d = readDoc();
    if (!d) return 'unusable';
    fn(d);
    try {
      state.write('reconcile', d);
    } catch (err) {
      const msg = `reconcile budget file cannot be written (${err.code ?? err.message}); reports are not sent`;
      if (state.setAlert('reconcile:budget_write', msg)) logger.error(msg);
      return 'unsaved';
    }
    state.clearAlert('reconcile:budget_write');
    return 'ok';
  }

  // Takes one report from the hourly budget, persisted before the request is sent. Stamps ahead of the clock (it was set
  // back) are dropped, and a stored block never lasts longer than the longest Retry-After honoured.
  // Returns 'ok', 'spent' or 'unsaved'.
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
    if (stored === 'unsaved') return 'unsaved';
    return stored === 'ok' && ok ? 'ok' : 'spent';
  }

  // The alert for a reset budget file stays listed for a day after it was last raised, then goes with the next run.
  function clearBudgetAlert() {
    let a = null;
    try { a = state.read('status', null)?.alerts?.['reconcile:budget']; } catch { /* status is repaired by setAlert */ }
    if (a && !(now() - Date.parse(a.updated_at) < BUDGET_ALERT_KEEP_MS)) state.clearAlert('reconcile:budget');
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

  // Set when a report was refused with a 400 that named no item (for the urgent queue).
  let unnamed400 = false;

  // Sends entries in batches; returns 'ok', 'dropped' (sent without items or batches the market refused), 'deferred',
  // 'rate_limited', 'budget_unsaved' or 'rejected'. A batch refused with 400 is resent once without the items it names, or skipped.
  async function send(orgId, agentId, entries, tally) {
    const queue = batches(entries).map((b) => ({ batch: b, retried: false }));
    let dropped = false;
    let accepted = 0;
    while (queue.length) {
      const { batch, retried } = queue.shift();
      const budget = takeBudget();
      if (budget === 'unsaved') return 'budget_unsaved';
      if (budget !== 'ok') return 'rate_limited';
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
        if (!bad.size) unnamed400 = true;
        for (const i of bad) if (batch[i]) batch[i].refused = true;
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
    // Once inject_missing is reported for an adoption, no activation of it that is still waiting may follow.
    const missingReported = (id) => () => {
      dropUrgentActivated(state, id);
      try { onInjectMissing?.(id); } catch (err) { logger.warn(`reconcile: activation of adoption ${id} not dropped: ${err.message}`); }
    };
    for (const it of templateItems) {
      add(adoptions[it.adoption_id]?.org_id, it, it.kind === 'template_inject_missing' ? missingReported(it.adoption_id) : undefined);
    }
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
    let unsaved = false;
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
      if (!entries.length) r.sent = 'ok';
      else r.sent = limited ? 'rate_limited' : await send(orgId, r.agentId, entries, tally);
      if (r.sent === 'budget_unsaved') unsaved = true;
      else if (r.sent === 'rate_limited') limited = true;
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

    const outcome = unsaved ? 'budget_unsaved' : limited ? 'rate_limited' : failed || Object.values(report).some((r) => r.status !== 'ok') ? 'partial' : 'ok';
    const reported = Object.values(report).reduce((n, r) => n + (r.items ?? 0), 0);
    const stored = updateDoc((d) => {
      d.last_run_at = new Date(lastRun).toISOString();
      d.last = { at: iso(), outcome, orgs: report, ...tally };
    });
    if (stored === 'ok') clearBudgetAlert();
    state.recordRun('reconcile', outcome);
    const line = `reconcile: ${outcome}, ${reported} discrepancies (${tally.recorded} recorded, ${tally.skipped} skipped)`;
    if (reported) logger.info(line);
    else logger.debug(line);
    return { outcome, reported, ...tally };
  }

  // Settles urgent entries: dropped from the queue, their keys kept as done.
  function settle(keys) {
    if (!keys.length) return;
    state.update('reconcile_urgent', EMPTY_URGENT, (raw) => {
      const d = { items: Array.isArray(raw?.items) ? raw.items : [], done: Array.isArray(raw?.done) ? raw.done : [] };
      d.items = d.items.filter((x) => !keys.includes(x.key));
      d.done = [...d.done.filter((k) => !keys.includes(k)), ...keys].slice(-MAX_URGENT_DONE);
      return d;
    });
  }

  // Sends the urgent queue, per org, in requests of their own (never mixed into a periodic report). An item is dropped
  // once the market answered it (recorded or skipped alike) or refused it; it stays queued when the report was not
  // delivered (transient error, rate limit, unsaved budget, org not reachable) and is sent again by the next flush.
  async function flushUrgent() {
    // Items queued before queued_at was recorded are stamped now, so they age out like the others.
    if (urgentDoc(state).items.some((x) => !Number.isFinite(Date.parse(x.queued_at)))) {
      state.update('reconcile_urgent', EMPTY_URGENT, (raw) => {
        for (const x of Array.isArray(raw?.items) ? raw.items : []) if (!Number.isFinite(Date.parse(x.queued_at))) x.queued_at = new Date(now()).toISOString();
        return raw;
      });
    }
    const queued = urgentDoc(state).items;
    if (!queued.length) return { sent: 0, left: 0 };
    const tally = { recorded: 0, skipped: 0 };
    const byOrg = new Map();
    const malformed = [];
    for (const e of queued) {
      if (!validItem(e.item)) {
        logger.error(`reconcile: dropped a malformed urgent ${e.item?.kind} item`);
        malformed.push(e.key);
        continue;
      }
      if (!byOrg.has(e.org_id)) byOrg.set(e.org_id, []);
      byOrg.get(e.org_id).push(e);
    }
    settle(malformed);
    let sent = 0;
    for (const [orgId, list] of byOrg) {
      if (!orgs.ids().includes(orgId)) {
        logger.warn(`reconcile: urgent items of org ${orgId} dropped: the org is not configured`);
        settle(list.map((e) => e.key));
        continue;
      }
      if (!orgs.mayContact(orgId)) continue;
      let agentId;
      try {
        agentId = await orgs.agentId(orgId);
      } catch (err) {
        logger.warn(`reconcile: urgent items of org ${orgId} kept: ${err.message}`);
        continue;
      }
      const done = [];
      const entries = list.map((e) => ({
        item: e.item,
        after: () => {
          done.push(e.key);
          settle([e.key]);
          if (e.item.kind === 'template_inject_missing') {
            dropUrgentActivated(state, e.item.adoption_id);
            try { onInjectMissing?.(e.item.adoption_id); } catch { /* the record is pruned on its next check */ }
          }
        },
      }));
      unnamed400 = false;
      let r = await send(orgId, agentId, entries, tally);
      const keyOf = (e) => list[entries.indexOf(e)].key;
      const open = () => entries.filter((e) => !done.includes(keyOf(e)));
      // A 400 that named no item (for example from a market that does not know an item kind): the items it may have
      // refused are sent one by one, at most MAX_SINGLE_RESENDS per flush (they share the hourly budget); the ones not
      // tried yet stay queued for the next flush. Items a 400 named are dropped as before.
      let kept = [];
      if ((r === 'dropped' || r === 'rejected') && unnamed400) {
        const singles = open().filter((e) => !e.refused);
        if (singles.length > 1) {
          kept = singles.slice(MAX_SINGLE_RESENDS);
          for (const e of singles.slice(0, MAX_SINGLE_RESENDS)) {
            const one = await send(orgId, agentId, [e], tally);
            if (one === 'rate_limited' || one === 'deferred' || one === 'budget_unsaved') {
              r = one;
              break;
            }
            if (!done.includes(keyOf(e))) settle([keyOf(e)]);
          }
        }
      }
      sent += done.length;
      if (r === 'ok' || r === 'dropped' || r === 'rejected') {
        const queuedNow = new Set(urgentDoc(state).items.map((x) => x.key));
        settle(open().filter((e) => !kept.includes(e) && queuedNow.has(keyOf(e))).map(keyOf));
      }
      if (r === 'ok') state.clearAlert(`reconcile:${orgId}`);
      else logger.warn(`reconcile: urgent report to org ${orgId}: ${r}`);
    }
    // Items an unreachable org has not taken for URGENT_MAX_AGE_MS are given up.
    const old = urgentDoc(state).items.filter((x) => now() - Date.parse(x.queued_at ?? '') > URGENT_MAX_AGE_MS);
    if (old.length) {
      logger.warn(`reconcile: ${old.length} urgent item(s) not delivered for 7 days; dropped`);
      settle(old.map((x) => x.key));
    }
    const left = urgentDoc(state).items.length;
    if (sent) logger.info(`reconcile: urgent report sent (${tally.recorded} recorded, ${tally.skipped} skipped, ${left} left)`);
    return { sent, left, ...tally };
  }

  // Periodic runs and urgent flushes never overlap.
  let chain = Promise.resolve();
  const serial = (fn) => {
    const p = chain.then(fn);
    chain = p.catch(() => {});
    return p;
  };

  // Sends the urgent queue now; never throws.
  const flushNow = () => serial(flushUrgent).catch((err) => {
    logger.error(`reconcile: urgent report failed: ${err.message}`);
    return null;
  });

  return {
    run: () => serial(run),
    flushUrgent: flushNow,
    // Queues urgent entries ({ key, org_id, item }) and sends them at once.
    urgent(entries) {
      enqueueUrgent(state, entries, { now, logger });
      return flushNow();
    },
    // Sends what is left in the urgent queue, then runs at the first call of the process, and once every `every`.
    async maybeRun() {
      await flushNow();
      if (lastRun !== null && now() - lastRun < every) return null;
      return serial(run);
    },
  };
}
