import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GO_BUNDLE, MANIFEST_SHA, templateBundle } from './fake/bundle.js';
import { buildZip } from './fake/zip.js';
import { inspectBundle } from '../src/pkg/bundle.js';
import { PackageError, readZip } from '../src/pkg/zip.js';
import { InstallFailure } from '../src/failure.js';

const unsafe = (reason) => (err) => err instanceof PackageError && err.reason === reason;

test('a bundle rendered by the server is accepted as is', () => {
  const b = inspectBundle(GO_BUNDLE);
  assert.equal(b.index.template, 'exec-assistant');
  assert.deepEqual(b.manifest.map((m) => m.path), [
    'connectors.json', 'customizations.json', 'inject.md', 'knowledge/faq.md', 'routines/morning_digest.json', 'sop/triage.md',
  ]);
  assert.match(b.inject, /^# Executive Assistant\n/);
  assert.throws(() => readZip(GO_BUNDLE), unsafe('archive_invalid'), 'skill packages still refuse stored entries with descriptors');
});

test('the inject segment is held to 2000 estimated tokens', () => {
  assert.equal(inspectBundle(templateBundle({ inject: 'a'.repeat(8000) }).zip).inject.length, 8000);
  assert.throws(() => inspectBundle(templateBundle({ inject: 'a'.repeat(8001) }).zip), unsafe('inject_too_large'));
  assert.ok(inspectBundle(templateBundle({ inject: '中'.repeat(2600) }).zip));
  assert.throws(() => inspectBundle(templateBundle({ inject: '中'.repeat(2601) }).zip), unsafe('inject_too_large'));
  assert.equal(inspectBundle(templateBundle({ inject: '\u{1F600}'.repeat(2600) }).zip).index.manifest_sha256, MANIFEST_SHA);
});

test('only the fixed bundle paths are accepted', () => {
  for (const p of ['run.sh', 'sop/../x.md', 'sop/Bad.md', 'routines/x.md', 'knowledge/a/b.md', '.claude/x.md', 'sop/a.md/']) {
    assert.throws(() => inspectBundle(templateBundle({ unlisted: { [p]: 'x' } }).zip), unsafe('bundle_path_invalid'), p);
  }
  assert.throws(() => inspectBundle(templateBundle({ files: { 'customizations.json': null } }).zip), unsafe('bundle_file_missing'));
  const deflated = buildZip([{ name: 'bundle.json', data: '{}', deflate: true }]);
  assert.throws(() => inspectBundle(deflated), unsafe('archive_invalid'));
});

test('bundle.json must list exactly the files with their sizes and sha256', () => {
  const mismatch = (err) => err instanceof InstallFailure && err.code === 'PACKAGE_MISMATCH';
  assert.throws(() => inspectBundle(templateBundle({ unlisted: { 'sop/extra.md': 'x' } }).zip), mismatch);
  const listing = [{ path: 'inject.md', size: 1, sha256: MANIFEST_SHA }];
  assert.throws(() => inspectBundle(templateBundle({ index: { files: listing } }).zip), mismatch);
  assert.throws(() => inspectBundle(templateBundle({ index: { render_version: 2 } }).zip), unsafe('bundle_index_invalid'));
  assert.throws(() => inspectBundle(templateBundle({ inject: Buffer.from([0xff]) }).zip), unsafe('inject_invalid'));
});
