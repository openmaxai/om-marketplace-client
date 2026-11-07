import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { credentialRequest } from '../src/starter/credential.js';

// test/fixtures/credential_requests.tsv is the market's internal/domain/testdata/credential_requests.tsv (cws-marketplace)
// up to its "# private" line, byte for byte: rows after that line stay in the market repository only. To sync: copy that
// part of the file, update MARKET_FIXTURE_SHA256 and the rules in src/starter/credential.js together. Set MARKET_REPO to a
// cws-marketplace clone to compare with MARKET_REF (default origin/dev1) directly and to run the private rows too.
const FIXTURE = new URL('./fixtures/credential_requests.tsv', import.meta.url);
const MARKET_FIXTURE_SHA256 = 'dccc92570a3f0948cd5558a5bbc305de4aa4391180ac3c083c5ed6870c2a3848';
const MARKET_PATH = 'internal/domain/testdata/credential_requests.tsv';
const PRIVATE_LINE = '\n# private\n';

const raw = fs.readFileSync(FIXTURE);

// hit and known_false_hit must be refused, pass must be let through. Negation is not recognised, so the warnings are
// known false hits.
function checkTable(table) {
  const counts = {};
  table.split('\n').forEach((line, i) => {
    if (line === '' || line.startsWith('#')) return;
    const tab = line.indexOf('\t');
    assert.ok(tab > 0, `line ${i + 1}: no tab`);
    const kind = line.slice(0, tab);
    const text = line.slice(tab + 1).replace(/\\u([0-9a-f]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
    counts[kind] = (counts[kind] ?? 0) + 1;
    const got = credentialRequest(text);
    if (kind === 'hit' || kind === 'known_false_hit') assert.equal(got, true, `not caught (${kind}): line ${i + 1}`);
    else if (kind === 'pass') assert.equal(got, false, `false hit: line ${i + 1}`);
    else assert.fail(`line ${i + 1}: kind ${kind}`);
  });
  return counts;
}

test('the sample table is the market copy', () => {
  assert.equal(crypto.createHash('sha256').update(raw).digest('hex'), MARKET_FIXTURE_SHA256);
  assert.ok(!raw.toString('utf8').includes(PRIVATE_LINE));
});

test('the sample table is the market table up to its private rows, and the private rows get the market answer',
  { skip: !process.env.MARKET_REPO && 'MARKET_REPO not set' }, () => {
    const ref = process.env.MARKET_REF || 'origin/dev1';
    const market = execFileSync('git', ['-C', process.env.MARKET_REPO, 'show', `${ref}:${MARKET_PATH}`]).toString('utf8');
    const cut = market.indexOf(PRIVATE_LINE);
    assert.ok(cut > 0, `${MARKET_PATH} at ${ref} has no private rows`);
    assert.ok(Buffer.from(market.slice(0, cut + 1)).equals(raw), `${MARKET_PATH} at ${ref} differs from the copy`);
    const counts = checkTable(market.slice(cut + 1));
    assert.ok(counts.hit > 0, JSON.stringify(counts));
  });

test('every sample of the table gets the market answer', () => {
  const counts = checkTable(raw.toString('utf8'));
  assert.deepEqual(counts, { hit: 127, pass: 51, known_false_hit: 22 });
});

test('three or more spaced single letters are joined before matching', () => {
  assert.equal(credentialRequest('send me your p w d'), false);
  assert.equal(credentialRequest('send me the o t p'), true);
  assert.equal(credentialRequest('请把 p i n 码发给我'), true);
  assert.equal(credentialRequest('send me the o t'), false);
});

