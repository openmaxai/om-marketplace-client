import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isCanonicalUuid, isOrgOrMemberId, isSha256Hex, uuidv7 } from '../src/ids.js';

test('uuidv7 is canonical, version 7, RFC variant, timestamp-prefixed and ordered', () => {
  const ms = Date.parse('2026-10-16T12:00:00Z');
  const ids = Array.from({ length: 5000 }, () => uuidv7(ms));
  for (const id of ids) {
    assert.ok(isCanonicalUuid(id), id);
    assert.equal(id[14], '7');
    assert.match(id[19], /[89ab]/);
  }
  assert.equal(parseInt(ids[0].replace(/-/g, '').slice(0, 12), 16), ms);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual([...ids].sort(), ids);
  const later = uuidv7(ms - 1000);
  assert.ok(later > ids.at(-1), 'clock going backwards keeps order');
  assert.ok(isCanonicalUuid(uuidv7()));
});

test('canonical UUID and sha256 validators', () => {
  assert.ok(isCanonicalUuid('0b6f4f3e-1111-4c2a-9d1e-aaaaaaaaaaaa'));
  for (const bad of ['0B6F4F3E-1111-4C2A-9D1E-AAAAAAAAAAAA', '{0b6f4f3e-1111-4c2a-9d1e-aaaaaaaaaaaa}',
    '0b6f4f3e11114c2a9d1eaaaaaaaaaaaa', '0b6f4f3e-1111-4c2a-9d1e-aaaaaaaaaaa', '', null, 7]) {
    assert.equal(isCanonicalUuid(bad), false, String(bad));
  }
  assert.ok(isSha256Hex('0f'.repeat(32)));
  for (const bad of ['0F'.repeat(32), '0f'.repeat(31), `${'0f'.repeat(32)}0`, 'g'.repeat(64), undefined]) {
    assert.equal(isSha256Hex(bad), false, String(bad));
  }
});

test('org and member ids accept the server character set except "." and ".."', () => {
  for (const ok of ['org-1', 'm-owner', 'a:b@c', 'A.b_c-9', '...', 'x'.repeat(128), '0b6f4f3e-1111-4c2a-9d1e-aaaaaaaaaaaa']) {
    assert.ok(isOrgOrMemberId(ok), ok);
  }
  for (const bad of ['.', '..', '', 'x'.repeat(129), 'a/b', 'a b', 'a%2e', 'a?b', 'a#b', 'é', null, 7]) {
    assert.equal(isOrgOrMemberId(bad), false, String(bad));
  }
});
