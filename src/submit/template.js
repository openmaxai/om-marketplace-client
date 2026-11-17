// Local shape check of an expert template manifest before upload. The market runs the full validation (text limits,
// credential and unsafe-instruction scans, inject budget); this catches the mistakes an author makes most often.
import fs from 'node:fs';
import { validSemver, validSlug } from '../pkg/frontmatter.js';
import { SubmitError } from './pack.js';

export const MAX_MANIFEST_BYTES = 256 << 10;
const TOP_REQUIRED = ['schema_version', 'kind', 'id', 'role', 'skills'];
const TOP_OPTIONAL = ['version', 'connectors', 'triggers', 'sop', 'knowledge', 'customizable_fields', 'starter_tasks', 'card', 'first_guide'];
const ROLE_REQUIRED = ['name', 'instructions', 'duty'];
const ROLE_OPTIONAL = ['persona', 'boundary'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const nonEmpty = (v) => typeof v === 'string' && v.trim() !== '';

function keys(o, ptr, required, optional, problems) {
  const allowed = new Set([...required, ...optional]);
  for (const k of required) if (!(k in o)) problems.push(`${ptr}/${k}: missing_field`);
  for (const k of Object.keys(o)) if (!allowed.has(k)) problems.push(`${ptr}/${k}: unknown_field`);
}

// Returns the problems as "<JSON pointer>: <reason>" lines (empty when the shape is fine).
export function checkManifest(m) {
  const problems = [];
  if (!isObject(m)) return [': malformed (the manifest must be a JSON object)'];
  keys(m, '', TOP_REQUIRED, TOP_OPTIONAL, problems);
  if ('schema_version' in m && m.schema_version !== 1) problems.push('/schema_version: bad_value (must be 1)');
  if ('kind' in m && m.kind !== 'expert_template') problems.push('/kind: bad_value (must be "expert_template")');
  if ('id' in m && !(typeof m.id === 'string' && validSlug(m.id))) problems.push('/id: bad_value (lowercase letters, digits and hyphens)');
  if ('version' in m && !(typeof m.version === 'string' && validSemver(m.version))) problems.push('/version: bad_value (semver such as 1.0.0)');
  if ('role' in m) {
    if (!isObject(m.role)) problems.push('/role: bad_value (must be an object)');
    else {
      keys(m.role, '/role', ROLE_REQUIRED, ROLE_OPTIONAL, problems);
      for (const k of ROLE_REQUIRED) if (k in m.role && !nonEmpty(m.role[k])) problems.push(`/role/${k}: bad_value (non-empty text)`);
      for (const k of ['duty', 'boundary']) {
        if (typeof m.role[k] === 'string' && /[\r\n]/.test(m.role[k])) problems.push(`/role/${k}: bad_value (one line)`);
      }
    }
  }
  if ('skills' in m) {
    if (!Array.isArray(m.skills) || m.skills.length > 20) problems.push('/skills: bad_value (array of at most 20)');
    else {
      m.skills.forEach((s, i) => {
        if (!isObject(s) || !UUID.test(s.skill_id) || !UUID.test(s.skill_version_id) || !SHA.test(s.package_sha256)) {
          problems.push(`/skills/${i}: bad_value ({skill_id, skill_version_id, package_sha256} of a listed skill version)`);
        }
      });
    }
  }
  return problems;
}

// Reads and checks a manifest file; returns { manifest, raw }. Throws SubmitError('manifest_invalid', ...).
export function readManifest(file) {
  let raw;
  try { raw = fs.readFileSync(file); } catch { throw new SubmitError('not_found', `${file} cannot be read`); }
  if (raw.length > MAX_MANIFEST_BYTES) throw new SubmitError('manifest_invalid', `manifest is ${raw.length} bytes (limit ${MAX_MANIFEST_BYTES})`);
  let manifest;
  try { manifest = JSON.parse(raw.toString('utf8')); } catch (err) {
    throw new SubmitError('manifest_invalid', `manifest is not valid JSON: ${err.message}`);
  }
  const problems = checkManifest(manifest);
  if (problems.length) throw new SubmitError('manifest_invalid', `manifest invalid:\n  ${problems.join('\n  ')}`);
  return { manifest, raw };
}
