import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
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

// A worker swaps the file between the pinned bytes and a parsable variant; a load must parse the bytes it hashed.
test('loadPolicy parses the same read it checked against the pin', async (t) => {
  const dir = tmpHome();
  const file = path.join(dir, 'v1.json');
  const good = fs.readFileSync(POLICY_FILE);
  const doc = JSON.parse(good);
  doc.max_violations += 1;
  fs.writeFileSync(path.join(dir, 'a'), good);
  fs.writeFileSync(path.join(dir, 'b'), JSON.stringify(doc));
  fs.copyFileSync(path.join(dir, 'a'), file);
  const stop = new Int32Array(new SharedArrayBuffer(4));
  const w = new Worker(`
    const fs = require('node:fs');
    const { workerData: { dir, stop } } = require('node:worker_threads');
    for (let i = 0; !Atomics.load(stop, 0); i++) {
      fs.copyFileSync(dir + '/' + (i % 2 ? 'a' : 'b'), dir + '/n');
      fs.renameSync(dir + '/n', dir + '/v1.json');
    }`, { eval: true, workerData: { dir, stop } });
  t.after(() => w.terminate());
  const want = loadPolicy().maxViolations;
  let loaded = 0;
  for (let i = 0; i < 3000; i++) {
    try {
      assert.equal(loadPolicy(file).maxViolations, want);
      loaded++;
    } catch (err) {
      if (!/does not match its pin/.test(err.message)) throw err;
    }
  }
  Atomics.store(stop, 0, 1);
  assert.ok(loaded > 0);
});
