import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { tmpHome } from './helpers.js';
import { SCHEMA_FILE, SCHEMA_SHA256, SCHEMA_SOURCE, SCHEMA_SOURCE_COMMIT, readPinnedSchema } from '../src/agent/schema/pin.js';
import { createChecker } from '../src/agent/schema/check.js';
import { checkManifest, manifestProblems, readManifest } from '../src/agent/template.js';

// Shared with the market (docs/schemas/expert-template-manifest.cases.json at SCHEMA_SOURCE_COMMIT): schema_valid is
// what the schema answers for each manifest.
// Market reasons the schema covers too: such a refusal is also reported at the same pointer locally.
const STRUCTURAL = new Set('slot_render_phase1 bad_value missing_field unknown_field duplicate_key'.split(' '));
const CASES = JSON.parse(fs.readFileSync(new URL('./vectors/expert-template-manifest.cases.json', import.meta.url), 'utf8')).cases;

test('the vendored schema matches its pin and names its source', () => {
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(SCHEMA_FILE)).digest('hex'), SCHEMA_SHA256);
  assert.match(SCHEMA_SOURCE_COMMIT, /^[0-9a-f]{40}$/);
  assert.equal(SCHEMA_SOURCE, 'cws-marketplace:docs/schemas/expert-template-manifest.schema.json');
  assert.equal(readPinnedSchema().$schema, 'https://json-schema.org/draft/2020-12/schema');
});

test('an altered schema file is refused', () => {
  const f = path.join(tmpHome(), 's.json');
  fs.writeFileSync(f, Buffer.concat([fs.readFileSync(SCHEMA_FILE), Buffer.from(' ')]));
  assert.throws(() => readPinnedSchema(f), /does not match its pin/);
});

test('the shared cases: the local check agrees with the schema on every one', () => {
  assert.ok(CASES.length >= 60, `${CASES.length} cases`);
  for (const c of CASES) {
    const problems = manifestProblems(c.manifest);
    assert.equal(problems.length === 0, c.schema_valid, `${c.name}: ${JSON.stringify(problems)}`);
    if (!c.schema_valid && /^[a-z_]+@\//.test(c.server_error)) {
      // A structural refusal is reported where the market reports it.
      const [reason, pointer] = c.server_error.split('@');
      if (STRUCTURAL.has(reason)) {
        assert.ok(problems.some((p) => p.pointer === pointer), `${c.name}: no problem at ${pointer}: ${JSON.stringify(problems)}`);
      }
    }
  }
});

test('every problem is reported at once, at most one per pointer', () => {
  const m = {
    schema_version: 2, kind: 'expert_template', id: 'Bad Id',
    role: { name: 'R', instructions: 'Greet {{name}}.', duty: '\nx', mood: 'calm' },
    skills: [{ skill_id: 'x', skill_version_id: 'y', package_sha256: 'z' }],
    customizable_fields: [
      { key: 'who', label: 'Who', type: 'member', required: true, default: 'm1', sensitive: true },
      { key: 'n', label: 'N', type: 'integer', required: false, options: ['a'], max_len: 3 },
      { key: 's', label: 'S', type: 'text', required: true, sensitive: true },
    ],
    starter_tasks: Array.from({ length: 11 }, () => ({ title: 'T', prompt: 'P' })),
    card: { summary: 'S', tags: ['a', 'b', 'c', 'd', 'e'] },
  };
  const got = manifestProblems(m).map((p) => `${p.pointer} ${p.reason}`);
  assert.deepEqual(got.sort(), [
    '/card/tags bad_value',
    '/customizable_fields/0/default bad_value',
    '/customizable_fields/0/required bad_value',
    '/customizable_fields/0/sensitive bad_value',
    '/customizable_fields/1/max_len bad_value',
    '/customizable_fields/1/options bad_value',
    '/customizable_fields/2/required bad_value',
    '/id bad_value',
    '/role/duty bad_value',
    '/role/instructions slot_render_phase1',
    '/role/mood unknown_field',
    '/schema_version bad_value',
    '/skills/0/package_sha256 bad_value',
    '/skills/0/skill_id bad_value',
    '/skills/0/skill_version_id bad_value',
    '/starter_tasks bad_value',
  ]);
  assert.equal(new Set(got.map((g) => g.split(' ')[0])).size, got.length);
  const f = path.join(tmpHome(), 'm.json');
  fs.writeFileSync(f, JSON.stringify(m));
  let err;
  try { readManifest(f); } catch (e) { err = e; }
  assert.equal(err.code, 'manifest_invalid');
  assert.equal(err.problems.length, got.length);
  assert.match(err.message, /^manifest invalid \(16 problems\):\n {2}\//);
  assert.equal(checkManifest(m).length, 16);
});

test('a schema with a keyword the checker does not know is refused', () => {
  assert.throws(() => createChecker({ type: 'object', propertyNames: { pattern: '^a' } })({ a: 1 }), /unsupported keyword propertyNames/);
  assert.throws(() => createChecker({ $ref: 'https://example.com/x' })({}), /unsupported \$ref/);
});

test('the manifest examples in SKILL.md and README.md are the shared cases "minimal" and "every field"', () => {
  const byName = Object.fromEntries(CASES.map((c) => [c.name, c.manifest]));
  for (const doc of ['SKILL.md', 'README.md']) {
    const text = fs.readFileSync(new URL(`../${doc}`, import.meta.url), 'utf8');
    const examples = [...text.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => m[1]).filter((b) => b.includes('"schema_version"'));
    assert.equal(examples.length, 2, doc);
    assert.deepEqual(JSON.parse(examples[0]), byName.minimal, `${doc} minimal`);
    assert.deepEqual(JSON.parse(examples[1]), byName['every field'], `${doc} every field`);
  }
});

const BASE = {
  schema_version: 1, kind: 'expert_template', id: 'inbox-helper',
  role: { name: 'Inbox Helper', instructions: 'Triage the inbox every morning.', duty: 'Inbox triage.' },
  skills: [], first_guide: 'Tell me which mailbox to start with.',
  starter_tasks: [{ title: 'Triage today', prompt: "Triage today's inbox." }],
  card: { summary: 'Keeps your inbox under control.', capabilities: ['Triage mail'], tags: ['office'] },
};
const at = (m) => manifestProblems(m).map((p) => `${p.pointer} ${p.reason}`).sort();

test('the manifest i18n block: zh and en with every display field are accepted', () => {
  const text = {
    role: { name: '收件箱助手', duty: '处理收件箱。' },
    card: { summary: '帮你管好收件箱。', capabilities: ['处理邮件'], limitations: ['不打电话'], guardrails: ['只起草'], tags: ['办公'] },
    first_guide: '告诉我先处理哪个邮箱。',
    starter_tasks: [{ title: '处理今天的邮件', prompt: '处理今天收件箱里的邮件。' }],
  };
  assert.deepEqual(at({ ...BASE, i18n: { zh: text, en: { role: { name: 'Inbox Helper (EN)' } } } }), []);
  assert.deepEqual(at({ ...BASE, i18n: { en: { card: { tags: ['office'] } } } }), []);
});

test('the manifest i18n block: only zh and en, only the display fields, each with its base rules', () => {
  assert.deepEqual(at({ ...BASE, i18n: { fr: { role: { name: 'Assistant' } } } }), ['/i18n/fr unknown_field']);
  assert.deepEqual(at({ ...BASE, i18n: { 'zh-CN': { role: { name: '助手' } } } }), ['/i18n/zh-CN unknown_field']);
  assert.deepEqual(at({ ...BASE, i18n: [] }), ['/i18n bad_value']);
  assert.deepEqual(at({ ...BASE, i18n: { en: 'x' } }), ['/i18n/en bad_value']);
  assert.deepEqual(at({ ...BASE, i18n: { en: { id: 'x' } } }), ['/i18n/en/id unknown_field']);
  assert.deepEqual(at({ ...BASE, i18n: { en: { role: { instructions: 'x' } } } }), ['/i18n/en/role/instructions unknown_field']);
  assert.deepEqual(at({ ...BASE, i18n: { en: { card: { icon: 'x' } } } }), ['/i18n/en/card/icon unknown_field']);
  assert.deepEqual(at({ ...BASE, i18n: { en: { starter_tasks: [{ title: 'T' }] } } }), ['/i18n/en/starter_tasks/0/prompt missing_field']);
  assert.deepEqual(at({ ...BASE, i18n: { en: { role: { name: 'x'.repeat(101) } } } }), ['/i18n/en/role/name bad_value']);
  assert.deepEqual(at({ ...BASE, i18n: { en: { card: { tags: ['a', 'b', 'c', 'd', 'e'] } } } }), ['/i18n/en/card/tags bad_value']);
  assert.deepEqual(at({ ...BASE, i18n: { en: { starter_tasks: [{ title: 'x'.repeat(41), prompt: 'P' }] } } }), ['/i18n/en/starter_tasks/0/title bad_value']);
  assert.deepEqual(at({ ...BASE, i18n: { en: { first_guide: 'Hi {{name}}' } } }), ['/i18n/en/first_guide slot_render_phase1']);
});

test('the manifest i18n block: empty blocks and array lengths are left to the market', () => {
  const schema = JSON.stringify(readPinnedSchema());
  assert.doesNotMatch(schema, /"minProperties"|"propertyNames"/);
  assert.deepEqual(at({ ...BASE, i18n: {} }), []);
  assert.deepEqual(at({ ...BASE, i18n: { en: {} } }), []);
  assert.deepEqual(at({ ...BASE, i18n: { en: { starter_tasks: [] } } }), []);
  assert.deepEqual(at({ ...BASE, i18n: { en: { card: { capabilities: ['a', 'b'] } } } }), []);
});
