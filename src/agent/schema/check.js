// Checks a value against the expert template manifest schema and reports every problem with its JSON Pointer.
// Supports the JSON Schema 2020-12 keywords that schema uses; any other keyword is an error, so a newer schema is
// never half-applied.
const KEYWORDS = new Set(['$schema', '$id', '$defs', '$ref', '$comment', 'title', 'description', 'type', 'const', 'enum', 'pattern',
  'minLength', 'maxLength', 'minimum', 'maximum', 'minItems', 'maxItems', 'uniqueItems', 'items', 'properties', 'required',
  'additionalProperties', 'allOf', 'anyOf', 'not', 'if', 'then', 'else']);

// Plain wording of the patterns the schema uses; any other pattern is quoted.
const PATTERN_TEXT = {
  '\\S': 'must not be blank',
  '\\{\\{': 'no {{ placeholders in instruction fields',
  '^[^\\S\\n]*\\S': 'the first line must not be blank',
  '\\S[^\\S\\n]*$': 'the last line must not be blank',
  '^[^\\n]*(\\n[^\\n]*){0,19}$': 'at most 20 lines',
  '\\n[^\\S\\n]*\\n[^\\S\\n]*\\n': 'no two blank lines in a row',
  '\\n': 'one line only',
};

const typeOf = (v) => {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
};
const esc = (k) => String(k).replaceAll('~', '~0').replaceAll('/', '~1');
const canon = (v) => JSON.stringify(v, (_, x) => (x && typeof x === 'object' && !Array.isArray(x)
  ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));
const codePoints = (s) => [...s].length;

export function createChecker(schema) {
  const res = new Map();
  const re = (p) => {
    // Patterns come only from the schema file checked against its pin.
    // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
    if (!res.has(p)) res.set(p, new RegExp(p, 'u'));
    return res.get(p);
  };
  const resolve = (ref) => {
    const m = /^#\/\$defs\/([^/]+)$/.exec(ref);
    if (!m || !schema.$defs?.[m[1]]) throw new Error(`manifest schema: unsupported $ref ${ref}`);
    return schema.$defs[m[1]];
  };

  // Appends {pointer, reason, message} for each failure of v at ptr; hint is the rule text of the enclosing allOf item,
  // desc the nearest description, used when a pattern has no plain wording.
  function walk(s, v, ptr, out, hint, desc) {
    if (typeof s === 'boolean') {
      if (!s) out.push({ pointer: ptr, reason: 'bad_value', message: hint ?? 'not allowed' });
      return;
    }
    for (const k of Object.keys(s)) if (!KEYWORDS.has(k)) throw new Error(`manifest schema: unsupported keyword ${k}`);
    const say = (reason, message, at = ptr) => out.push({ pointer: at, reason, message: hint ?? message });
    if (s.$ref) walk(resolve(s.$ref), v, ptr, out, hint);
    const t = typeOf(v);
    if (s.type && s.type !== t && !(s.type === 'number' && t === 'integer')) {
      say('bad_value', `must be ${s.type === 'integer' ? 'an integer' : `a${/^[aeiou]/.test(s.type) ? 'n' : ''} ${s.type}`}`);
      return;
    }
    if ('const' in s && canon(s.const) !== canon(v)) say('bad_value', `must be ${JSON.stringify(s.const)}`);
    if (s.enum && !s.enum.some((e) => canon(e) === canon(v))) say('bad_value', `must be one of ${s.enum.map((e) => JSON.stringify(e)).join(', ')}`);
    if (t === 'string') {
      const n = codePoints(v);
      if (s.minLength != null && n < s.minLength) say('bad_value', PATTERN_TEXT['\\S']);
      else if (s.pattern && !re(s.pattern).test(v)) say('bad_value', PATTERN_TEXT[s.pattern] ?? s.description ?? desc ?? `must match ${s.pattern}`);
      if (s.maxLength != null && n > s.maxLength) say('bad_value', `at most ${s.maxLength} characters (has ${n})`);
    }
    if (t === 'integer') {
      if ((s.minimum != null && v < s.minimum) || (s.maximum != null && v > s.maximum)) {
        say('bad_value', `must be ${s.minimum ?? '…'} to ${s.maximum ?? '…'}`);
      }
    }
    if (t === 'array') {
      if (s.minItems != null && v.length < s.minItems) say('bad_value', `at least ${s.minItems} item${s.minItems === 1 ? '' : 's'}`);
      if (s.maxItems != null && v.length > s.maxItems) say('bad_value', `at most ${s.maxItems} items (has ${v.length})`);
      if (s.items) v.forEach((e, i) => walk(s.items, e, `${ptr}/${i}`, out));
      if (s.uniqueItems) {
        const seen = new Set();
        v.forEach((e, i) => {
          const c = canon(e);
          if (seen.has(c)) say('duplicate_key', 'repeats an earlier item', `${ptr}/${i}`);
          seen.add(c);
        });
      }
    }
    if (t === 'object') {
      for (const k of s.required ?? []) if (!Object.hasOwn(v, k)) say('missing_field', 'required', `${ptr}/${esc(k)}`);
      for (const [k, e] of Object.entries(v)) {
        if (s.properties && Object.hasOwn(s.properties, k)) walk(s.properties[k], e, `${ptr}/${esc(k)}`, out, hint);
        else if (s.additionalProperties === false) out.push({ pointer: `${ptr}/${esc(k)}`, reason: 'unknown_field', message: 'not a manifest field' });
      }
    }
    for (const sub of s.allOf ?? []) walk(sub, v, ptr, out, sub.description ?? hint, s.description ?? desc);
    if (s.anyOf && !s.anyOf.some((sub) => valid(sub, v))) say('bad_value', s.description ?? 'matches none of the allowed forms');
    if (s.not && valid(s.not, v)) {
      const n = s.not;
      const key = n.required?.length === 1 && t === 'object' ? n.required[0] : null;
      const placeholder = n.pattern === '\\{\\{' || n.anyOf?.some((x) => x.pattern === '\\{\\{' && valid(x, v));
      const what = n.anyOf ? n.anyOf.filter((x) => valid(x, v)).map((x) => PATTERN_TEXT[x.pattern] ?? x.pattern).join('; ')
        : (n.description ?? PATTERN_TEXT[n.pattern] ?? 'not allowed');
      say(placeholder ? 'slot_render_phase1' : 'bad_value', key ? `${key}: not allowed here` : what, key ? `${ptr}/${esc(key)}` : ptr);
    }
    if (s.if) {
      const branch = valid(s.if, v) ? s.then : s.else;
      if (branch) walk(branch, v, ptr, out, hint);
    }
  }

  function valid(s, v) {
    const out = [];
    walk(s, v, '', out);
    return out.length === 0;
  }

  // Every problem of v, at most one per pointer, in document order of the schema walk.
  return function check(v) {
    const out = [];
    walk(schema, v, '', out);
    const seen = new Set();
    return out.filter((p) => !seen.has(p.pointer) && seen.add(p.pointer));
  };
}
