import crypto from 'node:crypto';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

// Lowercase canonical form only; the market rejects uppercase or braced UUIDs.
export function isCanonicalUuid(v) {
  return typeof v === 'string' && UUID_RE.test(v);
}

export function isSha256Hex(v) {
  return typeof v === 'string' && SHA256_HEX_RE.test(v);
}

let lastMs = -1;
let counter = 0;

// RFC 9562 UUIDv7. The 12-bit rand_a field is a counter seeded randomly each millisecond, so ids from one process
// sort in creation order.
export function uuidv7(nowMs = Date.now()) {
  let ms = nowMs;
  if (ms <= lastMs) {
    ms = lastMs;
    counter += 1;
    if (counter > 0xfff) {
      ms += 1;
      counter = 0;
    }
  } else {
    counter = crypto.randomInt(0, 0x800);
  }
  lastMs = ms;
  const b = crypto.randomBytes(16);
  b.writeUIntBE(ms, 0, 6);
  b[6] = 0x70 | (counter >> 8);
  b[7] = counter & 0xff;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
