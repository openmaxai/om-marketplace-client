// expert-template-manifest.schema.json next to this file is a byte-identical copy of the market's
// docs/schemas/expert-template-manifest.schema.json (cws-marketplace) at commit SCHEMA_SOURCE_COMMIT.
// To update: copy the file unchanged from a newer market commit, then set both constants below.
import crypto from 'node:crypto';
import fs from 'node:fs';

export const SCHEMA_SOURCE = 'cws-marketplace:docs/schemas/expert-template-manifest.schema.json';
export const SCHEMA_SOURCE_COMMIT = '6f45f51217e2fa8198474cb1c8be30132c53bb85';
export const SCHEMA_SHA256 = 'b0096846dbab1b3bdc6280a983847bb96ac23032d436a81c8f99c490e2bf45dd';
export const SCHEMA_FILE = new URL('./expert-template-manifest.schema.json', import.meta.url);

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// The parsed schema; throws unless the file's bytes hash to pin.
export function readPinnedSchema(file = SCHEMA_FILE, pin = SCHEMA_SHA256) {
  const buf = fs.readFileSync(file);
  if (sha256(buf) !== pin) throw new Error('manifest schema: file does not match its pin');
  return JSON.parse(buf.toString('utf8'));
}
