import crypto from 'node:crypto';
import fs from 'node:fs';

// sha256 of the market's skill-policy/v1.json; v1.json next to this file must be a byte-identical copy.
export const POLICY_SHA256 = '1b8eb823a981abe7b2c0ea847a59ad77e8b704cdaf047792d365dee24bd39df4';
export const POLICY_FILE = new URL('./v1.json', import.meta.url);

export function vendoredPolicySha256(file = POLICY_FILE) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

// False when the vendored file is missing or altered; installs must then be refused.
export function vendoredPolicyMatchesPin(file = POLICY_FILE) {
  try {
    return vendoredPolicySha256(file) === POLICY_SHA256;
  } catch {
    return false;
  }
}
