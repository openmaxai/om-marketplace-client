// Template write bundle (server internal/domain/templatebundle.go): fixed file names, stored entries, bundle.json lists
// every other file with its size and sha256. Nothing in it is executed.
import crypto from 'node:crypto';
import { InstallFailure } from '../failure.js';
import { isSha256Hex } from '../ids.js';
import { INJECT_MAX_TOKENS, estimateTokens, parseRole, roleLines } from '../shards.js';
import { decodeUTF8 } from './frontmatter.js';
import { PackageError, readFiles, readZip } from './zip.js';

export const INDEX = 'bundle.json';
export const INJECT = 'inject.md';
export const ROLE = 'role.json';
const REQUIRED = [INDEX, INJECT, 'connectors.json', 'customizations.json'];
const KEY = '[a-z][a-z0-9_]{0,31}';
const PATH_RE = new RegExp(`^(?:bundle\\.json|inject\\.md|role\\.json|connectors\\.json|customizations\\.json|sop/${KEY}\\.md|knowledge/${KEY}\\.md|routines/${KEY}\\.json)$`);
// Render version 2 adds role.json (duty, boundary); version 1 bundles have none.
const RENDER_VERSIONS = new Set([1, 2]);

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const mismatch = () => new InstallFailure('PACKAGE_MISMATCH', 'bundle_index_mismatch');

function parseIndex(raw) {
  let ix;
  try { ix = JSON.parse(decodeUTF8(raw)); } catch { ix = null; }
  const entry = (f) => f && typeof f.path === 'string' && Number.isSafeInteger(f.size) && isSha256Hex(f.sha256);
  if (!ix || typeof ix !== 'object' || !RENDER_VERSIONS.has(ix.render_version) || !isSha256Hex(ix.manifest_sha256)
    || typeof ix.template !== 'string' || !ix.template || typeof ix.version !== 'string' || !ix.version
    || !Array.isArray(ix.files) || !ix.files.every(entry)) {
    throw new PackageError('bundle_index_invalid', 'bundle.json is not a valid index');
  }
  return ix;
}

// Returns { files: [{ path, data }], manifest: [{ path, size, sha256 }], index, inject, role } (role is null before render
// version 2). Unsafe content throws PackageError (PACKAGE_UNSAFE); an index that disagrees with the files throws PACKAGE_MISMATCH.
export function inspectBundle(buf) {
  const seen = new Set();
  const { files: entries } = readZip(buf, {
    storedDescriptor: true,
    onEntry: (e) => {
      if (e.isDir || !PATH_RE.test(e.name) || seen.has(e.name)) throw new PackageError('bundle_path_invalid', e.name);
      if (e.method !== 0) throw new PackageError('archive_invalid', `${e.name} is compressed`);
      seen.add(e.name);
    },
  });
  if (!REQUIRED.every((p) => seen.has(p))) throw new PackageError('bundle_file_missing', 'required bundle file missing');
  const files = [...readFiles(buf, entries)].map(([e, data]) => ({ path: e.name, data: Buffer.from(data) }));
  const index = parseIndex(files.find((f) => f.path === INDEX).data);
  const manifest = files.filter((f) => f.path !== INDEX).map((f) => ({ path: f.path, size: f.data.length, sha256: sha256(f.data) }));
  if (index.files.length !== manifest.length) throw mismatch();
  const listed = new Map(index.files.map((f) => [f.path, f]));
  if (!manifest.every((m) => listed.get(m.path)?.size === m.size && listed.get(m.path).sha256 === m.sha256)) throw mismatch();
  const inject = decodeUTF8(files.find((f) => f.path === INJECT).data);
  if (inject === null) throw new PackageError('inject_invalid', 'inject.md is not UTF-8');
  const roleFile = files.find((f) => f.path === ROLE);
  if (Boolean(roleFile) !== (index.render_version >= 2)) throw new PackageError('bundle_file_missing', 'role.json does not match the render version');
  let role = null;
  if (roleFile) {
    const text = decodeUTF8(roleFile.data);
    role = text === null ? null : parseRole(text);
    if (!role) throw new PackageError('role_invalid', 'role.json is not a valid role');
  }
  const tokens = estimateTokens((role ? roleLines(role) : '') + inject);
  if (tokens > INJECT_MAX_TOKENS) throw new PackageError('inject_too_large', `inject segment is ${tokens} tokens`);
  return {
    files, manifest, inject, role,
    index: { manifest_sha256: index.manifest_sha256, template: index.template, version: index.version },
  };
}
