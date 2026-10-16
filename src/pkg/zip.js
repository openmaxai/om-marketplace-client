// Strict in-memory zip reader for skill packages. Mirrors the server's archive rules; nothing is written to disk.
import zlib from 'node:zlib';

// Inclusive caps: exactly 20 MiB (zip bytes, and total uncompressed bytes), 200 files, 1000 entries pass.
export const MAX_PACKAGE_BYTES = 20 << 20;
export const MAX_PACKAGE_FILES = 200;
export const MAX_PACKAGE_ENTRIES = 1000;

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = Buffer.from('PK\x05\x06', 'latin1');
const SIG_ZIP64_LOCATOR = 0x07064b50;
const SIG_DESCRIPTOR = 0x08074b50;
const EOCD_LEN = 22;
const CENTRAL_LEN = 46;
const LOCAL_LEN = 30;
const FLAG_ENCRYPTED = 0x1;
const FLAG_DESCRIPTOR = 0x8;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
const U32_MAX = 0xffffffff;

// Metadata-only extra fields (timestamps, ownership). Anything else, notably 0x7075 (Unicode path) and 0x0001 (zip64), is rejected.
const ALLOWED_EXTRA = new Set([0x5455, 0x7875, 0x000a]);

// "Version made by" hosts whose attributes a reader may interpret as MS-DOS (0x10 = directory) or Unix mode bits.
const HOSTS_MSDOS = new Set([0, 11, 14]);
const HOSTS_UNIX = new Set([3, 19]);
const S_IFMT = 0xf000;
const S_IFDIR = 0x4000;
const S_IFREG = 0x8000;

// `reason` is a fixed PACKAGE_UNSAFE reason; `detail` may contain names from the package and is for local logs only.
export class PackageError extends Error {
  constructor(reason, detail) {
    super(`package unsafe: ${reason}`);
    this.name = 'PackageError';
    this.reason = reason;
    this.detail = detail;
  }
}

const invalid = (detail) => new PackageError('archive_invalid', detail);

let crcTable;
export function crc32(buf) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = U32_MAX;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ U32_MAX) >>> 0;
}

// Single end record at EOF (its comment runs exactly to EOF), no zip64, single disk, central directory directly before it.
function checkLayout(buf) {
  if (buf.length < EOCD_LEN) throw invalid('too short for a zip');
  const lo = Math.max(0, buf.length - EOCD_LEN - 0xffff);
  const pos = buf.lastIndexOf(SIG_EOCD);
  if (pos < lo) throw invalid('no end of central directory');
  if (pos + EOCD_LEN > buf.length) throw invalid('truncated end of central directory');
  const disk = buf.readUInt16LE(pos + 4);
  const cdDisk = buf.readUInt16LE(pos + 6);
  const nDisk = buf.readUInt16LE(pos + 8);
  const nTotal = buf.readUInt16LE(pos + 10);
  const cdSize = buf.readUInt32LE(pos + 12);
  const cdOff = buf.readUInt32LE(pos + 16);
  const commentLen = buf.readUInt16LE(pos + 20);
  if (pos + EOCD_LEN + commentLen !== buf.length) throw invalid('data after the end of central directory');
  if (disk !== 0 || cdDisk !== 0 || nDisk !== nTotal) throw invalid('multi-disk zip');
  if (cdOff === U32_MAX || cdSize === U32_MAX || nTotal === 0xffff) throw invalid('zip64 is not accepted');
  if (nTotal > MAX_PACKAGE_ENTRIES) throw new PackageError('too_many_files', `${nTotal} entries`);
  if (cdOff + cdSize !== pos) throw invalid('central directory does not end at the end record');
  if (pos >= 20 && buf.readUInt32LE(pos - 20) === SIG_ZIP64_LOCATOR) throw invalid('zip64 locator present');
  return { cdStart: cdOff, cdEnd: pos, count: nTotal };
}

// Strict TLV walk: exact length, no repeated tag, allowlisted tags only.
function checkExtra(name, where, extra) {
  const seen = new Set();
  let i = 0;
  while (i < extra.length) {
    if (extra.length - i < 4) throw invalid(`${name}: ${where} extra field has trailing bytes`);
    const tag = extra.readUInt16LE(i);
    const size = extra.readUInt16LE(i + 2);
    if (i + 4 + size > extra.length) throw invalid(`${name}: ${where} extra field 0x${tag.toString(16)} overruns`);
    if (!ALLOWED_EXTRA.has(tag)) throw invalid(`${name}: ${where} extra field 0x${tag.toString(16)} is not accepted`);
    if (seen.has(tag)) throw invalid(`${name}: ${where} extra field 0x${tag.toString(16)} appears twice`);
    seen.add(tag);
    i += 4 + size;
  }
}

function readCentral(buf, { cdStart, cdEnd, count }) {
  const entries = [];
  let p = cdStart;
  for (let i = 0; i < count; i++) {
    if (p + CENTRAL_LEN > cdEnd || buf.readUInt32LE(p) !== SIG_CENTRAL) throw invalid('bad central directory record');
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const end = p + CENTRAL_LEN + nameLen + extraLen + commentLen;
    if (end > cdEnd) throw invalid('truncated central directory record');
    const nameBytes = buf.subarray(p + CENTRAL_LEN, p + CENTRAL_LEN + nameLen);
    const e = {
      name: nameBytes.toString('utf8'),
      nameBytes,
      madeBy: buf.readUInt16LE(p + 4),
      flags: buf.readUInt16LE(p + 8),
      method: buf.readUInt16LE(p + 10),
      crc32: buf.readUInt32LE(p + 16),
      compressedSize: buf.readUInt32LE(p + 20),
      size: buf.readUInt32LE(p + 24),
      externalAttrs: buf.readUInt32LE(p + 38),
      localOffset: buf.readUInt32LE(p + 42),
      extra: buf.subarray(p + CENTRAL_LEN + nameLen, p + CENTRAL_LEN + nameLen + extraLen),
      dataOffset: -1,
    };
    e.isDir = e.name.endsWith('/');
    if (e.compressedSize === U32_MAX || e.localOffset === U32_MAX) throw invalid(`${e.name}: zip64 sizes`);
    entries.push(e);
    p = end;
  }
  if (p !== cdEnd) throw invalid('unaccounted bytes in the central directory');
  return entries;
}

// Per-entry central directory checks: encryption, extra fields, method, descriptors, file type, directory data.
export function checkEntry(e) {
  if (e.flags & FLAG_ENCRYPTED) throw invalid(`encrypted entry ${e.name}`);
  checkExtra(e.name, 'central', e.extra);
  if (e.method !== METHOD_STORE && e.method !== METHOD_DEFLATE) throw invalid(`unsupported compression method ${e.method}`);
  if (e.method === METHOD_STORE && e.flags & FLAG_DESCRIPTOR) throw invalid(`stored entry ${e.name} uses a data descriptor`);
  // Unix file type in the upper 16 bits is honoured by common extractors regardless of the "made by" host.
  const unixType = (e.externalAttrs >>> 16) & S_IFMT;
  if (unixType !== 0 && unixType !== S_IFREG && unixType !== S_IFDIR) {
    throw new PackageError('link', `${e.name} has unix file type 0o${unixType.toString(8)}`);
  }
  if (unixType === S_IFDIR && !e.isDir) throw invalid(`${e.name}: unix file type and name disagree`);
  if (unixType === S_IFREG && e.isDir) throw invalid(`${e.name}: unix file type and name disagree`);
  if (!e.isDir && HOSTS_MSDOS.has(e.madeBy >>> 8) && e.externalAttrs & 0x10) {
    throw invalid(`${e.name}: directory flag and name disagree`);
  }
  if (e.isDir && (e.method !== METHOD_STORE || e.compressedSize !== 0 || e.size !== 0 || e.crc32 !== 0)) {
    throw invalid(`directory entry ${e.name} has data`);
  }
}

// Local headers must mirror the central directory and tile the bytes from offset 0 up to the central directory exactly.
export function checkLocalHeaders(buf, entries, cdStart) {
  const byData = new Map();
  for (const e of entries) {
    const p = e.localOffset;
    if (p + LOCAL_LEN > buf.length || buf.readUInt32LE(p) !== SIG_LOCAL) throw invalid(`${e.name}: no local header`);
    e.dataOffset = p + LOCAL_LEN + buf.readUInt16LE(p + 26) + buf.readUInt16LE(p + 28);
    const other = byData.get(e.dataOffset);
    if (other) throw new PackageError('link', `entries ${other.name} and ${e.name} share data`);
    byData.set(e.dataOffset, e);
  }
  const sorted = [...entries].sort((a, b) => a.dataOffset - b.dataOffset);
  let cur = 0;
  for (const e of sorted) {
    if (cur + LOCAL_LEN > buf.length || buf.readUInt32LE(cur) !== SIG_LOCAL) throw invalid(`no local header at ${cur}`);
    const flags = buf.readUInt16LE(cur + 6);
    const method = buf.readUInt16LE(cur + 8);
    const nameLen = buf.readUInt16LE(cur + 26);
    const extraLen = buf.readUInt16LE(cur + 28);
    const nameEnd = cur + LOCAL_LEN + nameLen;
    if (nameEnd > buf.length) throw invalid('truncated local header');
    if (!buf.subarray(cur + LOCAL_LEN, nameEnd).equals(e.nameBytes) || method !== e.method || flags !== e.flags
      || flags & FLAG_ENCRYPTED) {
      throw invalid(`local header for ${e.name} differs from the central directory`);
    }
    if (nameEnd + extraLen !== e.dataOffset) throw invalid(`${e.name}: data is not where its local header says`);
    checkExtra(e.name, 'local', buf.subarray(nameEnd, e.dataOffset));
    let crc = buf.readUInt32LE(cur + 14);
    let csize = buf.readUInt32LE(cur + 18);
    let usize = buf.readUInt32LE(cur + 22);
    cur = e.dataOffset + e.compressedSize;
    if (flags & FLAG_DESCRIPTOR) {
      if (crc !== 0 || csize !== 0 || usize !== 0) throw invalid(`${e.name}: local header has sizes and a data descriptor`);
      if (cur + 4 <= buf.length && buf.readUInt32LE(cur) === SIG_DESCRIPTOR) cur += 4;
      if (cur + 12 > cdStart) throw invalid(`${e.name}: truncated data descriptor`);
      crc = buf.readUInt32LE(cur);
      csize = buf.readUInt32LE(cur + 4);
      usize = buf.readUInt32LE(cur + 8);
      cur += 12;
    }
    if (crc !== e.crc32 || csize !== e.compressedSize || usize !== e.size) {
      throw invalid(`${e.name}: local crc32 or sizes differ from the central directory`);
    }
    if (cur > cdStart) throw invalid(`${e.name} overlaps the central directory`);
  }
  if (cur !== cdStart) throw invalid('unaccounted bytes before the central directory');
}

// Validates the whole archive structure without inflating anything. `onEntry` runs first for every entry in central
// directory order (path checks); `onCentral` runs after all entries passed, before the file count and size caps.
export function readZip(buf, { onEntry, onCentral } = {}) {
  if (buf.length > MAX_PACKAGE_BYTES) throw new PackageError('too_large', `zip is ${buf.length} bytes`);
  if (buf.length === 0) throw invalid('empty body');
  const layout = checkLayout(buf);
  const entries = readCentral(buf, layout);
  const files = [];
  let declared = 0;
  for (const e of entries) {
    if (onEntry) onEntry(e);
    checkEntry(e);
    if (!e.isDir) {
      files.push(e);
      declared += e.size;
    }
  }
  if (onCentral) onCentral(entries, files);
  if (files.length > MAX_PACKAGE_FILES) throw new PackageError('too_many_files', `${files.length} files`);
  if (declared > MAX_PACKAGE_BYTES) throw new PackageError('too_large', `declared uncompressed size ${declared}`);
  checkLocalHeaders(buf, entries, layout.cdStart);
  return { entries, files };
}

// Returns the entry's content. Output is capped while inflating; the deflate stream must consume exactly the
// compressed size and produce exactly the declared size, and the crc32 must match.
export function readEntry(buf, e, budget = MAX_PACKAGE_BYTES) {
  if (e.dataOffset < 0) throw new Error('readEntry before checkLocalHeaders');
  const raw = buf.subarray(e.dataOffset, e.dataOffset + e.compressedSize);
  let out;
  if (e.method === METHOD_STORE) {
    out = raw;
  } else {
    const cap = Math.min(e.size, budget) + 1;
    let res;
    try {
      res = zlib.inflateRawSync(raw, { info: true, maxOutputLength: cap });
    } catch (err) {
      if (err instanceof RangeError) {
        if (e.size > budget) throw new PackageError('too_large', `uncompressed size exceeds ${MAX_PACKAGE_BYTES} bytes`);
        throw invalid(`${e.name}: size differs from the header`);
      }
      throw invalid(`inflate ${e.name}: ${err.code || 'error'}`);
    }
    out = res.buffer;
    if (res.engine.bytesWritten !== raw.length) throw invalid(`${e.name}: deflate stream ends before its compressed size`);
  }
  if (out.length > budget) throw new PackageError('too_large', `uncompressed size exceeds ${MAX_PACKAGE_BYTES} bytes`);
  if (out.length !== e.size) throw invalid(`${e.name}: size differs from the header`);
  if (crc32(out) !== e.crc32) throw invalid(`${e.name}: crc32 mismatch`);
  return out;
}

// Yields [entry, content] for every file in central directory order, counting actual output against the total cap.
export function* readFiles(buf, files) {
  let total = 0;
  for (const e of files) {
    const data = readEntry(buf, e, MAX_PACKAGE_BYTES - total);
    total += data.length;
    yield [e, data];
  }
}
