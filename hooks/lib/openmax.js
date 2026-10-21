// Reads the local openmax component config and derives the COCO_* values it can supply. Never returns or logs more
// than the derived values themselves; callers print only field names and sources.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isOrgOrMemberId } from '../../src/ids.js';

const MAX_BYTES = 1024 * 1024;

export function openmaxConfigPath(zylosDir) {
  return path.join(zylosDir, 'components', 'openmax', 'config.json');
}

const inside = (child, parent) => child === parent || child.startsWith(parent + path.sep);
const realOrNull = (p) => { try { return fs.realpathSync(p); } catch { return null; } };

/**
 * Returns { ok: true, data } or { ok: false, reason } where reason is a short phrase without config values.
 * The file must resolve inside the home or zylos directory, be a regular file owned by the current user, and parse
 * as a JSON object.
 */
export function readOpenmaxConfig(zylosDir, { home = os.homedir(), uid = process.getuid?.() } = {}) {
  const file = openmaxConfigPath(zylosDir);
  let real;
  try {
    real = fs.realpathSync(file);
  } catch (err) {
    return { ok: false, reason: err.code === 'ENOENT' ? 'not found' : `not readable (${err.code || 'error'})` };
  }
  const roots = [realOrNull(home), realOrNull(zylosDir)].filter(Boolean);
  if (!roots.some((r) => inside(real, r))) return { ok: false, reason: 'resolves outside the home directory' };
  let raw;
  let fd;
  try {
    fd = fs.openSync(real, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return { ok: false, reason: 'not a regular file' };
    if (uid !== undefined && st.uid !== uid) return { ok: false, reason: 'not owned by the current user' };
    if (st.size > MAX_BYTES) return { ok: false, reason: 'too large' };
    raw = fs.readFileSync(fd, 'utf8');
  } catch (err) {
    return { ok: false, reason: `not readable (${err.code || 'error'})` };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'not valid JSON' };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false, reason: 'not a JSON object' };
  return { ok: true, data };
}

const str = (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);

// Enabled orgs (enabled !== false) with a usable org id, sorted by org id so the primary does not depend on key order.
function enabledOrgs(orgs, notes) {
  const out = [];
  for (const [key, entry] of Object.entries(obj(orgs) ?? {})) {
    const e = obj(entry);
    if (!e) { notes.push('an orgs entry is not an object; skipped'); continue; }
    if (e.enabled === false) continue;
    const orgId = str(e.org_id) ?? str(key);
    if (!isOrgOrMemberId(orgId) || orgId === '__proto__' || (str(e.org_id) && str(e.org_id) !== key)) {
      notes.push('an orgs entry has an invalid org_id; skipped');
      continue;
    }
    const member = str(obj(e.self)?.member_id);
    if (member !== null && !isOrgOrMemberId(member)) {
      notes.push('an orgs entry has an invalid self.member_id; skipped');
      continue;
    }
    out.push({ orgId, memberId: member });
  }
  return out.sort((a, b) => (a.orgId < b.orgId ? -1 : a.orgId > b.orgId ? 1 : 0));
}

/**
 * Fills only the COCO_* names missing from `values` (env wins per field).
 * Returns { values, sources, extraOrgs, notes }: sources maps each filled name to its openmax field; extraOrgs is
 * {<org_id>: {member_id}} for the enabled orgs other than the primary, set only when the primary is an openmax org.
 */
export function deriveFromOpenmax(data, values) {
  const out = { ...values };
  const sources = {};
  const notes = [];
  const fill = (name, value, from) => {
    if (out[name] || value === null) return;
    out[name] = value;
    sources[name] = from;
  };

  fill('COCO_BFF_URL', str(obj(data.server)?.bff_url), 'server.bff_url');
  fill('COCO_API_KEY', str(obj(data.agent)?.api_key), 'agent.api_key');
  fill('COCO_IDENTITY_ID', str(obj(data.agent)?.identity_id), 'agent.identity_id');

  const orgs = enabledOrgs(data.orgs, notes);
  let primary = null;
  if (out.COCO_ORG_ID) {
    primary = orgs.find((o) => o.orgId === out.COCO_ORG_ID) ?? null;
  } else if (out.COCO_MEMBER_ID) {
    primary = orgs.find((o) => o.memberId === out.COCO_MEMBER_ID) ?? orgs[0] ?? null;
  } else {
    primary = orgs[0] ?? null;
  }
  let extraOrgs;
  if (primary) {
    fill('COCO_ORG_ID', primary.orgId, `orgs.${primary.orgId}.org_id`);
    fill('COCO_MEMBER_ID', primary.memberId, `orgs.${primary.orgId}.self.member_id`);
    const rest = orgs.filter((o) => o.orgId !== primary.orgId);
    if (rest.length) extraOrgs = Object.fromEntries(rest.map((o) => [o.orgId, { member_id: o.memberId }]));
  }
  if (!out.COCO_BFF_URL) notes.push('server.bff_url is missing');
  if (!out.COCO_API_KEY) notes.push('agent.api_key is missing');
  if (!out.COCO_ORG_ID || !out.COCO_MEMBER_ID) {
    if (!orgs.length) notes.push('no enabled org');
    else if (values.COCO_ORG_ID && !primary) notes.push('COCO_ORG_ID is not one of its enabled orgs');
    else if (primary && !primary.memberId) notes.push(`orgs.${primary.orgId}.self.member_id is missing`);
  }
  return { values: out, sources, extraOrgs, notes };
}
