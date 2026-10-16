import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpHome } from './helpers.js';
import { POLICY_FILE, POLICY_SHA256, vendoredPolicyMatchesPin, vendoredPolicySha256 } from '../src/policy/pin.js';
import { loadPolicy } from '../src/pkg/policy.js';

test('vendored policy matches the pin', () => {
  assert.equal(vendoredPolicySha256(), POLICY_SHA256);
  assert.equal(vendoredPolicyMatchesPin(), true);
  assert.equal(JSON.parse(fs.readFileSync(POLICY_FILE, 'utf8')).policy, 'skill-policy/v1');
});

test('an altered or missing policy file does not match the pin', () => {
  const dir = tmpHome();
  const altered = path.join(dir, 'v1.json');
  fs.writeFileSync(altered, Buffer.concat([fs.readFileSync(POLICY_FILE), Buffer.from(' ')]));
  assert.equal(vendoredPolicyMatchesPin(altered), false);
  assert.equal(vendoredPolicyMatchesPin(path.join(dir, 'missing.json')), false);
});

test('loadPolicy refuses a file that does not match the pin', () => {
  const dir = tmpHome();
  const altered = path.join(dir, 'v1.json');
  fs.writeFileSync(altered, Buffer.concat([fs.readFileSync(POLICY_FILE), Buffer.from(' ')]));
  assert.throws(() => loadPolicy(altered), /does not match its pin/);
  assert.equal(loadPolicy(altered, vendoredPolicySha256(altered)).maxViolations, loadPolicy().maxViolations);
});
