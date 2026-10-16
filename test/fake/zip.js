// Zip writer for test fixtures, including deliberately malformed layouts.
import zlib from 'node:zlib';
import { crc32 } from '../../src/pkg/zip.js';

const u16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b; };
const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); return b; };

export function extraField(tag, data) {
  return Buffer.concat([u16(tag), u16(data.length), Buffer.from(data)]);
}

// Entry options:
//   name, data, deflate, payload (raw compressed bytes), deflateTail (appended to the deflate stream),
//   declSize, crc, flags, method, localName, localFlags (OR-ed into flags), localMethod, localSize, localCRC,
//   descriptor (write a data descriptor, zero local crc/sizes), descSig (default true), descUSize,
//   unixMode, externalAttrs, madeBy, localExtra, centralExtra, centralComment, centralOffset (override)
// Archive options:
//   prefix, suffix, comment, commentLen, alias [[name, target]], gap (bytes before the central directory),
//   centralTail (bytes after the last central record), eocd {disk, cdDisk, nDisk, nTotal, cdSize, cdOff}
export function buildZip(entries, opts = {}) {
  const parts = [];
  let off = 0;
  const push = (b) => { parts.push(b); off += b.length; };
  if (opts.prefix) push(Buffer.from(opts.prefix));
  const cents = [];
  for (const e of entries) {
    const name = Buffer.from(e.name);
    const data = Buffer.from(e.data ?? []);
    let payload = e.deflate ? zlib.deflateRawSync(data, { level: 9 }) : data;
    if (e.deflateTail) payload = Buffer.concat([payload, Buffer.from(e.deflateTail)]);
    if (e.payload) payload = Buffer.from(e.payload);
    const method = e.method ?? (e.deflate ? 8 : 0);
    const flags = e.flags ?? 0;
    const crc = e.crc ?? crc32(data);
    const usize = e.declSize ?? data.length;
    const mode = e.unixMode ?? (e.name.endsWith('/') ? 0o040755 : 0o100644);
    const c = {
      e, name, method, flags, crc, csize: payload.length, usize, off,
      attrs: e.externalAttrs ?? ((mode << 16) >>> 0),
    };
    cents.push(c);
    const lname = e.localName !== undefined ? Buffer.from(e.localName) : name;
    const lextra = Buffer.from(e.localExtra ?? []);
    let [lcrc, lcsize, lusize] = [e.localCRC ?? crc, e.localSize ?? payload.length, e.localSize ?? usize];
    if (e.descriptor) [lcrc, lcsize, lusize] = [0, 0, 0];
    push(Buffer.concat([
      u32(0x04034b50), u16(20), u16(flags | (e.localFlags ?? 0)), u16(e.localMethod ?? method), u16(0), u16(0),
      u32(lcrc), u32(lcsize), u32(lusize), u16(lname.length), u16(lextra.length), lname, lextra, payload,
    ]));
    if (e.descriptor) {
      push(Buffer.concat([e.descSig === false ? Buffer.alloc(0) : u32(0x08074b50), u32(crc), u32(payload.length),
        u32(e.descUSize ?? usize)]));
    }
  }
  if (opts.gap) push(Buffer.from(opts.gap));
  const cdOff = off;
  const record = (c, name) => {
    const extra = Buffer.from(c.e.centralExtra ?? []);
    const comment = Buffer.from(c.e.centralComment ?? []);
    return Buffer.concat([
      u32(0x02014b50), u16(c.e.madeBy ?? ((3 << 8) | 20)), u16(20), u16(c.flags), u16(c.method), u16(0), u16(0),
      u32(c.crc), u32(c.csize), u32(c.usize), u16(name.length), u16(extra.length), u16(comment.length), u16(0), u16(0),
      u32(c.attrs), u32(c.e.centralOffset ?? c.off), name, extra, comment,
    ]);
  };
  let n = 0;
  for (const c of cents) { push(record(c, c.name)); n++; }
  for (const [name, target] of opts.alias ?? []) {
    push(record(cents.find((c) => c.e.name === target), Buffer.from(name)));
    n++;
  }
  if (opts.centralTail) push(Buffer.from(opts.centralTail));
  const cdSize = off - cdOff;
  const comment = Buffer.from(opts.comment ?? []);
  const q = opts.eocd ?? {};
  push(Buffer.concat([
    u32(0x06054b50), u16(q.disk ?? 0), u16(q.cdDisk ?? 0), u16(q.nDisk ?? q.nTotal ?? n), u16(q.nTotal ?? n),
    u32(q.cdSize ?? cdSize), u32(q.cdOff ?? cdOff), u16(opts.commentLen ?? comment.length), comment,
  ]));
  if (opts.suffix) push(Buffer.from(opts.suffix));
  return Buffer.concat(parts);
}
