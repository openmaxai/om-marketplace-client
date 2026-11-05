import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_BODY_BYTES, MAX_FALLBACK_BYTES, RESERVED_METADATA_KEYS, TRUNCATION_SUFFIX, utf8Bytes, withinLimits,
} from '../src/starter/limits.js';
import { ADDRESSEE_RESERVE, cleanContent, fitContent, renderStarter } from '../src/starter/render.js';
import { ImError, assertNoReservedMetadata, sendParams } from '../src/starter/im.js';

const ZH = '中'; // 3 bytes
const EXT = '\u{20000}'; // 4 bytes

test('limits are the IM service limits', () => {
  assert.equal(MAX_BODY_BYTES, 16384);
  assert.equal(MAX_FALLBACK_BYTES, 8192);
  assert.deepEqual([...RESERVED_METADATA_KEYS].sort(), ['agent_run', 'cap_notice']);
});

test('body text is checked in UTF-8 bytes at the 16384 boundary', () => {
  const at = ZH.repeat(5461) + 'a';
  assert.equal(utf8Bytes(at), 16384);
  assert.equal(withinLimits({ text: at }), true);
  assert.equal(withinLimits({ text: `${at}a` }), false);
  assert.equal(withinLimits({ text: ZH.repeat(5462) }), false);
  assert.equal(withinLimits({ text: EXT.repeat(4096) }), true);
  assert.equal(withinLimits({ text: EXT.repeat(4096) + 'a' }), false);
  assert.equal(ZH.repeat(5462).length <= MAX_BODY_BYTES, true, 'counting UTF-16 units would let it through');
});

test('fallback text is checked in UTF-8 bytes at the 8192 boundary', () => {
  const at = ZH.repeat(2730) + 'ab';
  assert.equal(utf8Bytes(at), 8192);
  assert.equal(withinLimits({ text: 'x', fallbackText: at }), true);
  assert.equal(withinLimits({ text: 'x', fallbackText: `${at}c` }), false);
  assert.equal(withinLimits({ text: 'x', fallbackText: ZH.repeat(2731) }), false);
});

const content = (firstGuide) => cleanContent({ templateName: '周报', firstGuide, starterTasks: [{ title: '汇总', prompt: '写' }] });
const size = (c) => utf8Bytes(renderStarter({ ...c, addressee: ADDRESSEE_RESERVE }));

test('content that fits is unchanged; one byte less and the first guide is cut with the suffix', () => {
  const c = content(ZH.repeat(1500));
  const exact = size(c);
  assert.equal(fitContent(c, { maxBodyBytes: exact }), c);
  const cut = fitContent(c, { maxBodyBytes: exact - 1 });
  assert.ok(cut.firstGuide.endsWith(TRUNCATION_SUFFIX));
  assert.ok(size(cut) <= exact - 1);
  const kept = cut.firstGuide.slice(0, -TRUNCATION_SUFFIX.length);
  assert.ok(c.firstGuide.startsWith(kept));
  // As much as fits is kept: one more character would not fit.
  assert.ok(size({ ...c, firstGuide: c.firstGuide.slice(0, kept.length + 1) + TRUNCATION_SUFFIX }) > exact - 1);
});

test('the cut is at a character boundary: no split surrogate pair or combining sequence', () => {
  for (const unit of [EXT, 'é', '中']) {
    const c = content(unit.repeat(600));
    for (let cap = size(c) - 1; cap > size(c) - 40; cap--) {
      const cut = fitContent(c, { maxBodyBytes: cap });
      const kept = cut.firstGuide.slice(0, -TRUNCATION_SUFFIX.length);
      assert.equal(kept.length % unit.length, 0, `${JSON.stringify(unit)} at ${cap}`);
      assert.ok(!/[\uD800-\uDFFF]/u.test(kept.replace(/[\u{10000}-\u{10FFFF}]/gu, '')));
      assert.ok(size(cut) <= cap);
    }
  }
});

test('content that does not fit even with the first guide reduced to the suffix gives null', () => {
  const c = content('长'.repeat(100));
  const floor = size({ ...c, firstGuide: TRUNCATION_SUFFIX });
  assert.equal(fitContent(c, { maxBodyBytes: floor - 1 }), null);
  assert.equal(fitContent(c, { maxBodyBytes: floor }).firstGuide, TRUNCATION_SUFFIX);
});

test('the send body carries no reserved metadata key, and one that does is refused', () => {
  const p = sendParams({ orgId: 'o', conversationId: 'c', text: 't', clientMsgId: 'k' });
  for (const k of RESERVED_METADATA_KEYS) {
    assert.ok(!Object.hasOwn(p.body, k) && !Object.hasOwn(p.body.metadata ?? {}, k));
    assert.throws(() => assertNoReservedMetadata({ ...p.body, metadata: { [k]: 1 } }), ImError);
    assert.throws(() => assertNoReservedMetadata({ ...p.body, [k]: 1 }), ImError);
  }
  assert.doesNotThrow(() => assertNoReservedMetadata({ ...p.body, metadata: { other: 1 } }));
});
