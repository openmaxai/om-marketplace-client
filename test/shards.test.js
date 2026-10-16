import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, tmpHome } from './helpers.js';
import {
  declaration, declarationsReady, ensureDeclarations, estimateTokens, findHookSyncScript, hooksPresent, readSlots, shardsDir, syncHooks, writeSlots,
} from '../src/shards.js';
import { emitSlot } from '../src/shard-emitter.js';
import { installShards } from '../hooks/lib/shards.js';
import { fakeZylos, writeSlotHooks } from './fake/zylos.js';

const ID = '0190f000-0000-7000-8000-000000000001';
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

const zylos = fakeZylos;

test('token estimate follows zylos: ceil(ascii/4 + other/1.3) over code points', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens('abcd'), 1);
  assert.equal(estimateTokens('abcde'), 2);
  assert.equal(estimateTokens('中'), 1);
  assert.equal(estimateTokens('中文'), 2);
  assert.equal(estimateTokens('\u{1F600}'), 1);
  assert.equal(estimateTokens('a'.repeat(8000)), 2000);
  assert.equal(estimateTokens('a'.repeat(8001)), 2001);
});

test('the four declarations are written once, match zylos rules and leave other files alone', () => {
  const z = zylos();
  fs.mkdirSync(shardsDir(z), { recursive: true });
  fs.writeFileSync(path.join(shardsDir(z), 'other.json'), '{"keep":true}');
  assert.equal(declarationsReady(z), false);
  assert.deepEqual(ensureDeclarations(z), ['market-template-1', 'market-template-2', 'market-template-3', 'market-template-4']);
  for (let n = 1; n <= 4; n++) {
    const d = JSON.parse(fs.readFileSync(path.join(shardsDir(z), `market-template-${n}.json`), 'utf8'));
    assert.deepEqual(d, declaration(n));
    assert.equal(d.name, `market-template-${n}`);
    assert.match(d.name, /^[a-z0-9][a-z0-9_-]{0,31}$/);
    assert.equal(d.order, 60 + n);
    assert.ok(fs.realpathSync(path.join(z, '.claude', d.emitter)).startsWith(ROOT));
    assert.deepEqual(d.budget, { maxChars: 10000, maxTokens: 2200 });
  }
  assert.deepEqual(ensureDeclarations(z), []);
  assert.equal(declarationsReady(z), false, 'declared but no hooks yet');
  writeSlotHooks(z, { slots: [1, 2, 3] });
  assert.equal(declarationsReady(z), false, 'one hook missing');
  writeSlotHooks(z);
  assert.equal(declarationsReady(z), true);
  assert.equal(fs.readFileSync(path.join(shardsDir(z), 'other.json'), 'utf8'), '{"keep":true}');
});

test('declarations are refused without a shard registry or outside the zylos .claude dir', () => {
  assert.throws(() => ensureDeclarations(zylos({ registry: false })), /no session-start shard registry/);
  const z = zylos({ installed: false });
  assert.throws(() => ensureDeclarations(z), /not installed under/);
  assert.equal(fs.existsSync(shardsDir(z)), false);
});

test('install hook declares the shards and runs the hook sync only while a slot hook is missing; failures do not throw', () => {
  const z = zylos();
  const calls = [];
  const lines = [];
  const quiet = { log: (l) => lines.push(l), error: (l) => lines.push(l) };
  const sync = (dir) => { calls.push(dir); writeSlotHooks(dir); };
  assert.equal(installShards({ zylosDir: z, sync, ...quiet }), true);
  assert.ok(lines.some((l) => /restarts once when idle; memory and context are kept/.test(l)));
  assert.equal(installShards({ zylosDir: z, sync, ...quiet }), true);
  assert.deepEqual(calls, [z]);
  writeSlotHooks(z, { slots: [1, 3, 4] });
  assert.equal(installShards({ zylosDir: z, sync, ...quiet }), true);
  assert.deepEqual(calls, [z, z]);

  const y = zylos();
  assert.equal(installShards({ zylosDir: y, sync: () => {}, ...quiet }), false, 'a sync that adds no hooks');
  assert.equal(installShards({ zylosDir: y, sync: () => { throw new Error('boom'); }, ...quiet }), false);
  assert.equal(installShards({ zylosDir: zylos({ registry: false }), sync: () => calls.push('x'), ...quiet }), false);
  assert.equal(calls.length, 2);
});

test('the slot hooks are looked for in the hook file of the active runtime', () => {
  const z = zylos();
  ensureDeclarations(z);
  writeSlotHooks(z, { runtime: 'codex' });
  assert.equal(hooksPresent(z), false);
  fs.mkdirSync(path.join(z, '.zylos'), { recursive: true });
  fs.writeFileSync(path.join(z, '.zylos', 'config.json'), '{"runtime":"codex"}');
  assert.equal(hooksPresent(z), true);
  assert.equal(declarationsReady(z), true);
  fs.writeFileSync(path.join(z, '.codex', 'hooks.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [
    ...[1, 2, 3].map((n) => ({ command: `node /x/session-start-orchestrator.js --shard market-template-${n}` })),
    { command: 'node /x/session-start-orchestrator.js --shard market-template-40' },
    { command: 'node /x/other.js --shard market-template-4' },
  ] }] } }));
  assert.equal(hooksPresent(z), false);
  for (const bad of ['not json', '{}', '{"hooks":{"SessionStart":{}}}', '{"hooks":{"SessionStart":[null,{"hooks":[null]}]}}']) {
    fs.writeFileSync(path.join(z, '.codex', 'hooks.json'), bad);
    assert.equal(hooksPresent(z), false, bad);
  }
});

test('hook sync runs the installed zylos sync-settings-hooks.js with ZYLOS_DIR', () => {
  const pkg = path.join(tmpHome(), 'zylos-pkg');
  fs.mkdirSync(path.join(pkg, 'cli', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(pkg, 'cli', 'zylos.js'), '');
  fs.writeFileSync(path.join(pkg, 'cli', 'lib', 'sync-settings-hooks.js'), '');
  const bin = path.join(tmpHome(), 'bin');
  fs.mkdirSync(bin);
  fs.symlinkSync(path.join(pkg, 'cli', 'zylos.js'), path.join(bin, 'zylos'));
  const env = { PATH: `/nonexistent${path.delimiter}${bin}` };
  const script = fs.realpathSync(path.join(pkg, 'cli', 'lib', 'sync-settings-hooks.js'));
  assert.equal(findHookSyncScript(env), script);
  assert.equal(findHookSyncScript({ PATH: '/nonexistent' }), null);
  let seen;
  syncHooks('/z', { env, spawn: (cmd, args, opts) => { seen = { cmd, args, dir: opts.env.ZYLOS_DIR }; return { status: 0 }; } });
  assert.deepEqual(seen, { cmd: process.execPath, args: [script], dir: '/z' });
  assert.throws(() => syncHooks('/z', { env, spawn: () => ({ status: 1 }) }), /hook sync failed/);
});

// A data dir with slot 1 mapped to a template whose inject.md is `text`.
function slotted(text, { recorded = sha(Buffer.from(text)) } = {}) {
  const d = path.join(tmpHome(), 'd');
  fs.mkdirSync(path.join(d, 'templates', ID), { recursive: true });
  fs.writeFileSync(path.join(d, 'templates', ID, 'inject.md'), text);
  writeSlots(d, { 1: { adoption_id: ID, inject_sha256: recorded } });
  return d;
}

test('the emitter prints a mapped slot and nothing for empty slots or a missing map', () => {
  const d = slotted('# Role\n\nDo things.\n');
  assert.equal(emitSlot(1, { dataDir: d }), `Template files are under ${path.join(d, 'templates', ID)}/\n\n# Role\n\nDo things.\n`);
  assert.equal(emitSlot(2, { dataDir: d }), '');
  assert.equal(emitSlot(1, { dataDir: path.join(tmpHome(), 'none') }), '');
  assert.equal(readSlots(path.join(tmpHome(), 'none')), null);
});

test('the emitter prints nothing on a sha mismatch, links, a malformed map or an over-budget segment', () => {
  const d = slotted('changed', { recorded: sha('original') });
  assert.equal(emitSlot(1, { dataDir: d }), '');

  const linked = slotted('x');
  const inject = path.join(linked, 'templates', ID, 'inject.md');
  fs.renameSync(inject, `${inject}.real`);
  fs.symlinkSync(`${inject}.real`, inject);
  assert.equal(emitSlot(1, { dataDir: linked }), '');

  const dirLink = slotted('x');
  fs.renameSync(path.join(dirLink, 'templates', ID), path.join(dirLink, 'real'));
  fs.symlinkSync(path.join(dirLink, 'real'), path.join(dirLink, 'templates', ID));
  assert.equal(emitSlot(1, { dataDir: dirLink }), '');

  const bad = slotted('x');
  fs.writeFileSync(path.join(bad, 'slots.json'), '{"1":{"adoption_id":"../x","inject_sha256":"0"}}');
  assert.equal(emitSlot(1, { dataDir: bad }), '');
  fs.writeFileSync(path.join(bad, 'slots.json'), 'not json');
  assert.equal(emitSlot(1, { dataDir: bad }), '');

  assert.notEqual(emitSlot(1, { dataDir: slotted('a'.repeat(8000)) }), '');
  assert.equal(emitSlot(1, { dataDir: slotted('a'.repeat(8001)) }), '');
});

test('each slot entry file emits its own slot through the data dir of the environment', async (t) => {
  const d = slotted('slot three\n');
  writeSlots(d, { 3: readSlots(d)['1'] });
  const prev = process.env.OM_MARKETPLACE_CLIENT_HOME;
  process.env.OM_MARKETPLACE_CLIENT_HOME = d;
  t.after(() => { if (prev === undefined) delete process.env.OM_MARKETPLACE_CLIENT_HOME; else process.env.OM_MARKETPLACE_CLIENT_HOME = prev; });
  const out = await Promise.all([1, 2, 3, 4].map(async (n) => (await import(`../src/shards/market-template-${n}.js`)).emit()));
  assert.deepEqual(out.map((o) => o.endsWith('slot three\n')), [false, false, true, false]);
});
