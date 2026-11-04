// Local skill scan and report (C-16): the skills in the skills directory that the market did not install, as metadata
// only (directory name, frontmatter name and version, source). The market shows them and trusts nothing in them.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { MarketError } from './http.js';
import { SKILL_DIR_PREFIX } from './land.js';
import { enterTooOldMode, tooOld } from './intents.js';
import { RECONCILE_EVERY_MS } from './reconcile.js';
import { looksLikeSecret } from './secretscan.js';

export const MAX_REPORT_ITEMS = 200;
export const MAX_REPORT_BYTES = 64 * 1024;
export const MAX_SKILL_MD_READ = 64 * 1024;
export const MAX_TEXT_CHARS = 64;
const MAX_COMPONENTS_BYTES = 1024 * 1024;
// A report whose content is unchanged is still sent once this long after the last success. The market marks a report
// stale after 24 hours; this stays well below that even when a send waits for the next cycle.
export const HEARTBEAT_MS = 12 * 60 * 60 * 1000;
// At most this many top-level entries of the skills directory are looked at (in name order); the report is then truncated.
export const MAX_SCAN_ENTRIES = 1000;
// The market refuses a changed report within this long of the previous changed one.
export const MIN_CHANGE_INTERVAL_MS = 5 * 60 * 1000;
export const REPORT_EVERY_MS = RECONCILE_EVERY_MS;
export const SOURCES = Object.freeze(['zylos_component', 'git', 'local']);
const DOC = 'local_skills';
const LOCATION_RE = /^[A-Za-z0-9._-]{1,128}$/;
// Line breaks, controls, format and private-use characters, unassigned code points, default-ignorables, noncharacters,
// lone surrogates and U+FFFD: a superset of what the market drops under its shared character rules.
const BAD_TEXT_RE = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Cs}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}\p{Noncharacter_Code_Point}�⠀￼]/u;
const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = fs.constants;

export const validLocationId = (s) => LOCATION_RE.test(s) && !s.startsWith(SKILL_DIR_PREFIX);

// A name or version as the market keeps it: NFC, at most MAX_TEXT_CHARS characters, none of BAD_TEXT_RE. A longer name is
// cut; a longer version, or any value with a bad character, is left out (null).
export function cleanText(v, { cut = false } = {}) {
  if (typeof v !== 'string' || v === '') return null;
  let s = v.normalize('NFC');
  if (BAD_TEXT_RE.test(s)) return null;
  let chars = [...s];
  if (chars.length > MAX_TEXT_CHARS) {
    if (!cut) return null;
    s = chars.slice(0, MAX_TEXT_CHARS).join('').normalize('NFC');
    chars = [...s];
    if (chars.length > MAX_TEXT_CHARS || BAD_TEXT_RE.test(s)) return null;
  }
  return s.trim() === '' ? null : s;
}

function scalarValue(raw) {
  const v = raw.trim();
  if (v[0] === '"' || v[0] === "'") {
    const end = v.indexOf(v[0], 1);
    return end > 0 ? v.slice(1, end) : null;
  }
  if (v === '' || '|>[{&*!%@`'.includes(v[0])) return null;
  const hash = v.search(/[ \t]#/);
  return (hash >= 0 ? v.slice(0, hash) : v).trim();
}

// Top-level `name` and `version` of a SKILL.md frontmatter, the first occurrence of each. Nothing after the closing
// `---` is looked at; an unclosed frontmatter yields nothing.
export function parseFrontmatter(text) {
  const out = { name: null, version: null };
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  if (lines[0] !== '---') return out;
  const end = lines.indexOf('---', 1);
  if (end < 0) return out;
  for (let i = 1; i < end; i++) {
    const m = /^(name|version):(?:[ \t](.*))?$/.exec(lines[i]);
    if (m && out[m[1]] === null) out[m[1]] = scalarValue(m[2] ?? '');
  }
  return out;
}

// The opened file is the expected one: where /proc is available, the path of the descriptor itself; otherwise the
// directory is still the same directory, not a link put in its place.
function openedAt(fd, expected, dir, dirStat) {
  try {
    return fs.readlinkSync(`/proc/self/fd/${fd}`) === expected;
  } catch {
    try {
      const st = fs.lstatSync(dir);
      return st.isDirectory() && st.dev === dirStat.dev && st.ino === dirStat.ino;
    } catch {
      return false;
    }
  }
}

// The first MAX_SKILL_MD_READ bytes of a regular SKILL.md, never through a link (also not a directory swapped for a
// link after it was checked); null when there is none.
function readHead(file, { expected, dir, dirStat }) {
  let fd;
  try {
    fd = fs.openSync(file, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    if (!fs.fstatSync(fd).isFile() || !openedAt(fd, expected, dir, dirStat)) return null;
    const buf = Buffer.alloc(MAX_SKILL_MD_READ);
    let n = 0;
    while (n < buf.length) {
      const r = fs.readSync(fd, buf, n, buf.length - n, n);
      if (r === 0) break;
      n += r;
    }
    return buf.subarray(0, n).toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

const lexists = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } };

// Directory names in skillsDir of the skills zylos installed as components: components.json maps each component name
// to an entry whose skillDir is the absolute path of its skill. Unreadable or malformed → none.
export function componentSkillNames(zylosDir, skillsDir) {
  const names = new Set();
  const file = path.join(zylosDir, '.zylos', 'components.json');
  let doc;
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.size > MAX_COMPONENTS_BYTES) return names;
    doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return names;
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return names;
  const base = path.resolve(skillsDir);
  for (const [key, entry] of Object.entries(doc)) {
    const dir = entry && typeof entry === 'object' ? entry.skillDir : undefined;
    if (typeof dir === 'string' && path.dirname(path.resolve(dir)) === base) {
      names.add(path.basename(dir));
    }
  }
  return names;
}

// First-level directories of skillsDir with a SKILL.md, sorted by name. Skipped: market-managed (market--*), dot
// entries, links (never followed), non-directories, directories without SKILL.md and names the market would drop.
// Only the first MAX_SCAN_ENTRIES entries the directory lists are read. Returns { items, skipped, capped }; a missing
// skillsDir is an empty scan, any other read error is thrown.
export function scanLocalSkills({ skillsDir, zylosDir }) {
  const names = [];
  let capped = false;
  let handle;
  try {
    handle = fs.opendirSync(skillsDir);
    for (let e = handle.readSync(); e !== null; e = handle.readSync()) {
      if (names.length === MAX_SCAN_ENTRIES) {
        capped = true;
        break;
      }
      names.push(e.name);
    }
  } catch (err) {
    if (err.code === 'ENOENT') return { items: [], skipped: 0, capped: false };
    throw err;
  } finally {
    if (handle) handle.closeSync();
  }
  const realBase = fs.realpathSync(skillsDir);
  const components = componentSkillNames(zylosDir, skillsDir);
  const items = [];
  let skipped = 0;
  names.sort();
  for (const name of names) {
    if (name.startsWith(SKILL_DIR_PREFIX) || name.startsWith('.')) continue;
    const dir = path.join(skillsDir, name);
    let st;
    try { st = fs.lstatSync(dir); } catch { continue; }
    if (!st.isDirectory()) continue;
    const md = path.join(dir, 'SKILL.md');
    if (!lexists(md)) continue;
    if (!validLocationId(name)) {
      skipped += 1;
      continue;
    }
    const head = readHead(md, { expected: path.join(realBase, name, 'SKILL.md'), dir, dirStat: st });
    const fm = head === null ? { name: null, version: null } : parseFrontmatter(head);
    const item = { location_id: name };
    const n = cleanText(fm.name, { cut: true });
    const v = cleanText(fm.version);
    if (n !== null) item.name = n;
    if (v !== null) item.version = v;
    if ([item.location_id, item.name, item.version].some(looksLikeSecret)) {
      skipped += 1;
      continue;
    }
    item.source = components.has(name) ? 'zylos_component' : lexists(path.join(dir, '.git')) ? 'git' : 'local';
    items.push(item);
  }
  return { items, skipped, capped };
}

// The C-16 body: at most MAX_REPORT_ITEMS items and MAX_REPORT_BYTES of JSON; anything beyond is left out and marked
// truncated, as is a capped scan.
export function buildReport(items, scannedAt, { capped = false } = {}) {
  const limit = MAX_REPORT_BYTES - Buffer.byteLength(JSON.stringify({ scanned_at: scannedAt, truncated: true, items: [] }));
  const kept = [];
  let size = 0;
  for (const it of items) {
    const n = Buffer.byteLength(JSON.stringify(it)) + (kept.length ? 1 : 0);
    if (kept.length >= MAX_REPORT_ITEMS || size + n > limit) break;
    kept.push(it);
    size += n;
  }
  return { scanned_at: scannedAt, truncated: capped || kept.length < items.length, items: kept };
}

// sha256 of the reported content (items and truncated), without the scan time.
export const reportHash = (body) => crypto.createHash('sha256').update(JSON.stringify({ items: body.items, truncated: body.truncated })).digest('hex');

// Per configured org: scans once per run and reports with that org's token and member id. A report equal to the last
// success of that org is skipped unless HEARTBEAT_MS has passed; a 429 waits for its Retry-After, content refused with a 400
// is resent only after HEARTBEAT_MS, a changed report waits MIN_CHANGE_INTERVAL_MS after the last changed one. The last success of
// each org is kept in the `local_skills` state document. Nothing here throws: failures are logged per org.
export function createLocalSkillReporter({
  api, state, orgs, logger, skillsDir, zylosDir, now = Date.now, every = REPORT_EVERY_MS,
}) {
  const iso = (t = now()) => new Date(t).toISOString();
  let nextAt = null;

  // An unreadable document counts as empty and is replaced by the next write: at worst one report is sent again.
  function readDoc() {
    try {
      const d = state.read(DOC, {});
      return d && typeof d === 'object' && !Array.isArray(d) ? d : {};
    } catch {
      return {};
    }
  }

  function saveOrg(orgId, rec) {
    try {
      state.write(DOC, { ...readDoc(), [orgId]: rec });
    } catch (err) {
      logger.warn(`local skill report state of org ${orgId} not saved (${err.code ?? err.message})`);
    }
  }

  const time = (s) => (typeof s === 'string' ? Date.parse(s) : Number.NaN);

  // { outcome, retryAt? }.
  async function reportOrg(orgId, body, hash) {
    const rec = readDoc()[orgId] ?? {};
    const t = now();
    if (orgs.isBlocked(orgId)) return { outcome: `org_${orgs.membership(orgId)}` };
    if (t < time(rec.blocked_until)) return { outcome: 'backoff', retryAt: time(rec.blocked_until) };
    if (rec.hash === hash && t - time(rec.at) < HEARTBEAT_MS) return { outcome: 'unchanged' };
    if (rec.rejected_hash === hash && t - time(rec.rejected_at) < HEARTBEAT_MS) return { outcome: 'rejected' };
    const changedAt = time(rec.changed_at);
    if (rec.hash !== hash && t - changedAt < MIN_CHANGE_INTERVAL_MS) return { outcome: 'deferred', retryAt: changedAt + MIN_CHANGE_INTERVAL_MS };
    let res;
    try {
      const agentId = await orgs.agentId(orgId);
      res = await api.reportLocalSkills({ orgId, agentId, body });
    } catch (err) {
      if (!(err instanceof MarketError)) {
        logger.warn(`local skill report to org ${orgId} not sent: ${err.message}`);
        return { outcome: 'error' };
      }
      const code = err.code || err.status;
      if (err.status === 429) {
        const until = now() + (err.retryAfterMs || MIN_CHANGE_INTERVAL_MS);
        saveOrg(orgId, { ...rec, blocked_until: iso(until) });
        logger.warn(`local skill report to org ${orgId} rate limited (${code}); retried after ${iso(until)}`);
        return { outcome: 'rate_limited', retryAt: until };
      }
      if (err.code === 'CLIENT_VERSION_TOO_OLD') {
        enterTooOldMode(state, logger, err.reason ?? 'unknown', err.min_version, null, iso());
        return { outcome: 'too_old' };
      }
      if (err.code === 'MEMBER_LEFT_ORG') {
        orgs.markLeft(orgId, err.reason);
        return { outcome: 'org_left' };
      }
      if (err.status === 400) {
        saveOrg(orgId, { ...rec, rejected_hash: hash, rejected_at: iso() });
        logger.error(`local skill report to org ${orgId} rejected (${code}); this content is resent after ${HEARTBEAT_MS / 3600000} hours`);
        return { outcome: 'rejected' };
      }
      if (err.transient) {
        logger.warn(`local skill report not delivered (${code}); retried next cycle`);
        return { outcome: 'deferred' };
      }
      logger.warn(`local skill report to org ${orgId} refused (${code}); retried next cycle`);
      return { outcome: 'refused' };
    }
    const at = iso();
    saveOrg(orgId, { hash, at, changed_at: res.unchanged ? (rec.changed_at ?? null) : at, accepted: res.accepted, dropped: res.dropped });
    const line = `local skill report to org ${orgId}: ${res.unchanged ? 'unchanged' : `${res.accepted} accepted, ${res.dropped} dropped`}${body.truncated ? ', truncated' : ''}`;
    if (res.dropped) logger.info(line);
    else logger.debug(line);
    return { outcome: 'ok' };
  }

  async function run() {
    const started = now();
    nextAt = started + every;
    let outcome = 'ok';
    try {
      if (tooOld(state)) {
        outcome = 'too_old';
        return { outcome, orgs: {} };
      }
      let scan;
      try {
        scan = scanLocalSkills({ skillsDir, zylosDir });
      } catch (err) {
        outcome = 'scan_failed';
        logger.warn(`local skill scan failed (${err.code ?? err.message}); nothing is reported`);
        return { outcome, orgs: {} };
      }
      if (scan.skipped) logger.debug(`local skill scan: ${scan.skipped} directory name(s) the market would drop were left out`);
      const body = buildReport(scan.items, iso(started), { capped: scan.capped });
      const hash = reportHash(body);
      const results = {};
      for (const orgId of orgs.ids()) {
        let r;
        try {
          r = await reportOrg(orgId, body, hash);
        } catch (err) {
          logger.warn(`local skill report to org ${orgId} failed: ${err.message}`);
          r = { outcome: 'error' };
        }
        results[orgId] = r.outcome;
        if (r.retryAt) nextAt = Math.min(nextAt, Math.max(r.retryAt, now()));
        if (!['ok', 'unchanged'].includes(r.outcome)) outcome = 'partial';
      }
      return { outcome, orgs: results };
    } finally {
      try { state.recordRun('local_skills', outcome); } catch { /* status unwritable */ }
    }
  }

  return {
    run,
    // Runs at the first call of the process, then once every `every`, sooner when an org waits for a retry time.
    async maybeRun() {
      if (nextAt !== null && now() < nextAt) return null;
      try {
        return await run();
      } catch (err) {
        logger.warn(`local skill report failed: ${err.message}`);
        return null;
      }
    },
  };
}
