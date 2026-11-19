import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_BODY_BYTES, MAX_FALLBACK_BYTES, RESERVED_METADATA_KEYS, TRUNCATION_SUFFIX, utf8Bytes, withinLimits,
} from '../src/starter/limits.js';
import {
  ADDRESSEE_RESERVE, LINE_SEPARATOR, LINK_REMOVED, SAFETY_NOTICE, cleanContent, cutToBytes, fitContent, fitFallback, removeLinks, renderStarter,
} from '../src/starter/render.js';
import { ImError, assertNoReservedMetadata, sendParams } from '../src/starter/im.js';

const ZH = '中'; // 3 bytes
const EXT = '\u{20000}'; // 4 bytes

test('limits are the IM service limits', () => {
  assert.equal(MAX_BODY_BYTES, 16384);
  assert.equal(MAX_FALLBACK_BYTES, 8192);
  assert.deepEqual([...RESERVED_METADATA_KEYS].sort(), ['agent_run', 'cap_notice', 'context']);
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

test('metadata.context is refused by the client before any call, also in the structured send', () => {
  assert.ok(RESERVED_METADATA_KEYS.includes('context'));
  const p = sendParams({ orgId: 'o', conversationId: 'c', text: 't', clientMsgId: 'k', structured: { adoptionId: 'a', fallbackText: 't' } });
  assert.doesNotThrow(() => assertNoReservedMetadata(p.body));
  const err = (() => { try { assertNoReservedMetadata({ ...p.body, metadata: { ...p.body.metadata, context: {} } }); } catch (e) { return e; } return null; })();
  assert.ok(err instanceof ImError);
  assert.equal(err.definite, true);
  assert.equal(err.kind, 'refused');
  assert.match(err.message, /context/);
});

const AT_8192 = ZH.repeat(2730) + 'ab';

test('a structured send with a fallback text of exactly 8192 bytes is kept; one byte more is refused', () => {
  assert.equal(utf8Bytes(AT_8192), 8192);
  const p = sendParams({ orgId: 'o', conversationId: 'c', text: 'x', clientMsgId: 'k', structured: { adoptionId: 'a', fallbackText: AT_8192 } });
  assert.equal(p.body.fallback_text, AT_8192);
  for (const over of [`${AT_8192}c`, ZH.repeat(2731)]) {
    assert.throws(
      () => sendParams({ orgId: 'o', conversationId: 'c', text: 'x', clientMsgId: 'k', structured: { adoptionId: 'a', fallbackText: over } }),
      (e) => e instanceof ImError && e.definite && e.kind === 'refused',
    );
  }
});

// True when s is valid UTF-8 once encoded: no lone surrogate, and it survives a round trip.
const validUtf8 = (s) => s.isWellFormed() && Buffer.from(s, 'utf8').toString('utf8') === s;

test('the fallback text is the whole message up to exactly 8192 bytes', () => {
  // A first guide sized so the message is exactly 8192 bytes with addressee 'A'.
  const withGuide = (firstGuide) => ({ ...content(''), firstGuide });
  const head = utf8Bytes(renderStarter({ ...withGuide('x'), addressee: 'A' })) - 1;
  const guide = 'x'.repeat(MAX_FALLBACK_BYTES - head);
  const text = renderStarter({ ...withGuide(guide), addressee: 'A' });
  assert.equal(utf8Bytes(text), MAX_FALLBACK_BYTES);
  assert.equal(fitFallback(withGuide(guide), 'A'), text);
  const cut = fitFallback(withGuide(`${guide}y`), 'A');
  assert.ok(utf8Bytes(cut) <= MAX_FALLBACK_BYTES);
  assert.ok(cut.includes(`${TRUNCATION_SUFFIX}${'\n\n'}｜ 可以先试试`));
});

test('a fallback text over 8192 bytes cuts the first guide by bytes with the suffix, never inside a character', () => {
  for (const unit of [ZH, EXT, '😀', '👨‍👩‍👧', 'é']) {
    for (let pad = 0; pad < 4; pad++) {
      const c = { ...content(''), firstGuide: 'a'.repeat(pad) + unit.repeat(Math.ceil(9000 / utf8Bytes(unit))) };
      const full = renderStarter({ ...c, addressee: '张三' });
      assert.ok(utf8Bytes(full) > MAX_FALLBACK_BYTES, unit);
      const fb = fitFallback(c, '张三');
      assert.ok(utf8Bytes(fb) <= MAX_FALLBACK_BYTES, `${unit} ${pad}: ${utf8Bytes(fb)}`);
      assert.ok(validUtf8(fb), unit);
      const guideEnd = fb.indexOf(TRUNCATION_SUFFIX);
      assert.ok(guideEnd > 0, unit);
      // What is kept of the guide is a prefix of it made of whole characters.
      const kept = fb.slice(0, guideEnd).split('｜ ').at(-1);
      assert.ok(c.firstGuide.startsWith(kept), unit);
      assert.equal((kept.length - pad) % unit.length, 0, `${JSON.stringify(unit)} ${pad}`);
      // The tasks and the end line are kept.
      assert.ok(fb.endsWith(full.slice(full.indexOf('｜ 可以先试试'))), unit);
    }
  }
});

test('cutToBytes cuts by UTF-8 bytes at a character boundary and ends with the suffix', () => {
  for (const unit of [ZH, EXT, '😀', '👨‍👩‍👧', 'é', 'a']) {
    for (let pad = 0; pad < 4; pad++) {
      const text = 'b'.repeat(pad) + unit.repeat(Math.ceil(9000 / utf8Bytes(unit)));
      const cut = cutToBytes(text, MAX_FALLBACK_BYTES);
      assert.ok(utf8Bytes(cut) <= MAX_FALLBACK_BYTES, `${unit} ${pad}`);
      assert.ok(utf8Bytes(cut) > MAX_FALLBACK_BYTES - utf8Bytes(unit), `as much as fits is kept: ${unit} ${pad}`);
      assert.ok(validUtf8(cut), unit);
      assert.ok(cut.endsWith(TRUNCATION_SUFFIX));
      const kept = cut.slice(0, -TRUNCATION_SUFFIX.length);
      assert.ok(text.startsWith(kept));
      assert.equal((kept.length - pad) % unit.length, 0, `${JSON.stringify(unit)} ${pad}`);
    }
  }
  assert.equal(cutToBytes(AT_8192, MAX_FALLBACK_BYTES), AT_8192);
  assert.ok(cutToBytes(`${AT_8192}c`, MAX_FALLBACK_BYTES).endsWith(TRUNCATION_SUFFIX));
});

test('cutToBytes never leaves a link the cut created', () => {
  // "example.commxyz" is no link, but cut after "example.com" it would be a bare domain.
  const room = MAX_FALLBACK_BYTES - utf8Bytes(TRUNCATION_SUFFIX);
  const text = `${'a'.repeat(room - ' example.com'.length)} example.commxyz ${'b'.repeat(100)}`;
  const cut = cutToBytes(text, MAX_FALLBACK_BYTES);
  assert.equal(removeLinks(cut), cut, cut.slice(-60));
  assert.ok(cut.endsWith(TRUNCATION_SUFFIX));
  assert.ok(utf8Bytes(cut) <= MAX_FALLBACK_BYTES);
  // The placeholder is longer than the link it replaces, so the cut is measured after it is put in.
  assert.ok(utf8Bytes(LINK_REMOVED) > 'example.com'.length);
  const at = cutToBytes(`${'a'.repeat(room - ' example.com'.length - 4)} example.commxyz ${'b'.repeat(100)}`, MAX_FALLBACK_BYTES);
  assert.equal(removeLinks(at), at, at.slice(-60));
  assert.ok(utf8Bytes(at) <= MAX_FALLBACK_BYTES, String(utf8Bytes(at)));
});

test('a message that does not fit 8192 bytes even with the first guide cut is cut to the size, keeping the safety notice', () => {
  const tasks = Array.from({ length: 3 }, (_, i) => ({ title: `t${i}`, prompt: `${ZH}\n`.repeat(400).trim() }));
  const c = { addressee: '', templateName: '周报', firstGuide: ZH.repeat(100), starterTasks: tasks };
  assert.equal(fitContent(c, { maxBodyBytes: MAX_FALLBACK_BYTES }), null);
  const fb = fitFallback(c, '张三');
  assert.ok(utf8Bytes(fb) <= MAX_FALLBACK_BYTES);
  assert.ok(validUtf8(fb));
  const tail = LINE_SEPARATOR + SAFETY_NOTICE;
  assert.ok(fb.endsWith(TRUNCATION_SUFFIX + tail));
  assert.equal(fb.split(SAFETY_NOTICE).length - 1, 1);
  assert.ok(renderStarter({ ...c, addressee: '张三' }).startsWith(fb.slice(0, -(TRUNCATION_SUFFIX + tail).length)));
});
