// Local check of an expert template manifest before upload, against the market's manifest schema (structure: every
// field, type, limit and allowed value). Text rules the schema cannot express (NFC, invisible characters, credential and
// unsafe-instruction scans, inject budget, references to listed skills) are checked by the market; `--dry-run` asks it.
import fs from 'node:fs';
import { SubmitError } from './pack.js';
import { readPinnedSchema } from './schema/pin.js';
import { createChecker } from './schema/check.js';

export const MAX_MANIFEST_BYTES = 256 << 10;
// Preset icons of expert templates, in display order.
export const EXPERT_ICON_PRESETS = ['expert-service', 'expert-growth', 'expert-report', 'expert-creative', 'expert-listing',
  'expert-select', 'expert-global', 'expert-compliance'];

let checker = null;
const check = (m) => {
  checker ??= createChecker(readPinnedSchema());
  return checker(m);
};

// Every problem as {pointer, reason, message} (empty when the manifest passes the schema).
export function manifestProblems(m) {
  if (m === null || typeof m !== 'object' || Array.isArray(m)) {
    return [{ pointer: '', reason: 'malformed', message: 'the manifest must be a JSON object' }];
  }
  return check(m);
}

export const problemLine = (p) => `${p.pointer || '(manifest)'}: ${p.reason}${p.message ? ` (${p.message})` : ''}`;

// The problems as "<JSON pointer>: <reason> (<what is expected>)" lines.
export function checkManifest(m) {
  return manifestProblems(m).map(problemLine);
}

// Reads and checks a manifest file; returns { manifest, raw }. Throws SubmitError('manifest_invalid', ...) carrying
// every problem in err.problems.
export function readManifest(file) {
  let raw;
  try { raw = fs.readFileSync(file); } catch { throw new SubmitError('not_found', `${file} cannot be read`); }
  if (raw.length > MAX_MANIFEST_BYTES) throw new SubmitError('manifest_invalid', `manifest is ${raw.length} bytes (limit ${MAX_MANIFEST_BYTES})`);
  let manifest;
  try { manifest = JSON.parse(raw.toString('utf8')); } catch (err) {
    throw new SubmitError('manifest_invalid', `manifest is not valid JSON: ${err.message}`);
  }
  const problems = manifestProblems(manifest);
  if (problems.length) {
    const err = new SubmitError('manifest_invalid', `manifest invalid (${problems.length} problem${problems.length === 1 ? '' : 's'}):\n  ${problems.map(problemLine).join('\n  ')}`);
    err.problems = problems;
    throw err;
  }
  return { manifest, raw };
}

// The icon field of templates:publish for a preset id. Only the form is checked here; the market decides which ids
// exist (EXPERT_ICON_PRESETS are the ones it had when this client was released).
export function presetIcon(id) {
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) {
    throw new SubmitError('icon_invalid', `--icon-preset takes a preset id such as ${EXPERT_ICON_PRESETS.join(', ')}`);
  }
  return { kind: 'preset', preset_id: id };
}
