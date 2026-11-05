import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { credentialRequest } from '../src/starter/credential.js';

// test/fixtures/credential_requests.tsv is a byte-for-byte copy of the market's
// internal/domain/testdata/credential_requests.tsv (cws-marketplace). To sync: copy the file, update MARKET_FIXTURE_SHA256
// and the rules in src/starter/credential.js together. Set MARKET_REPO to a cws-marketplace clone to compare with
// MARKET_REF (default origin/dev1) directly.
const FIXTURE = new URL('./fixtures/credential_requests.tsv', import.meta.url);
const MARKET_FIXTURE_SHA256 = '08d9beea44068b7b9aa2a3e70c950e1922e9604988f432daaef3dd52761dae1c';
const MARKET_PATH = 'internal/domain/testdata/credential_requests.tsv';

const raw = fs.readFileSync(FIXTURE);

test('the sample table is the market copy', () => {
  assert.equal(crypto.createHash('sha256').update(raw).digest('hex'), MARKET_FIXTURE_SHA256);
});

test('the sample table matches the market repository byte for byte', { skip: !process.env.MARKET_REPO && 'MARKET_REPO not set' }, () => {
  const ref = process.env.MARKET_REF || 'origin/dev1';
  const market = execFileSync('git', ['-C', process.env.MARKET_REPO, 'show', `${ref}:${MARKET_PATH}`]);
  assert.ok(market.equals(raw), `${MARKET_PATH} at ${ref} differs from the copy`);
});

// hit and known_false_hit must be refused, pass must be let through. Negation is not recognised, so the warnings are
// known false hits.
test('every sample of the table gets the market answer', () => {
  const counts = {};
  raw.toString('utf8').split('\n').forEach((line, i) => {
    if (line === '' || line.startsWith('#')) return;
    const tab = line.indexOf('\t');
    assert.ok(tab > 0, `line ${i + 1}: no tab`);
    const kind = line.slice(0, tab);
    const text = line.slice(tab + 1).replace(/\\u([0-9a-f]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
    counts[kind] = (counts[kind] ?? 0) + 1;
    const got = credentialRequest(text);
    if (kind === 'hit' || kind === 'known_false_hit') assert.equal(got, true, `not caught (${kind}): ${JSON.stringify(text)}`);
    else if (kind === 'pass') assert.equal(got, false, `false hit: ${JSON.stringify(text)}`);
    else assert.fail(`line ${i + 1}: kind ${kind}`);
  });
  assert.ok(counts.hit > 0 && counts.pass > 0 && counts.known_false_hit > 0, JSON.stringify(counts));
});
