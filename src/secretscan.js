// Credential scan of short texts, the same rules the market applies (EXAMPLE_SECRET_DETECTED rules): a text that hits
// is never sent. Matches are never logged or returned.

const S = '[\\t\\n\\f\\r ]';
const NS = '[^\\t\\n\\f\\r ]';
const KEY = '(?:password|passwd|passphrase|pwd|secret|token|api[_\\-]?key)';

const RULES = [
  /-----BEGIN[A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/,
  /(?:^|[^A-Za-z0-9])(?:sk-|sk_live_|sk_test_|rk_live_|ghp_|gho_|ghs_|ghu_|ghr_|github_pat_|glpat-|glrt-|gldt-|glptt-|npm_|hf_|xox[abpr]-|xapp-)[A-Za-z0-9_-]{16,}/,
  /(?:^|[^A-Za-z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}/,
  /(?:^|[^A-Za-z0-9])AIza[0-9A-Za-z_-]{35}/,
  /(?:^|[^A-Za-z0-9_-])eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/,
  new RegExp(`(?:^|[^a-z0-9_])(?:bearer|basic)[ \\t]+${NS}{20,}`, 'i'),
  new RegExp(`[a-z][a-z0-9+.\\-]*://[^\\t\\n\\f\\r /?#@:]*:[^\\t\\n\\f\\r /?#@]+@`, 'i'),
  new RegExp(`${KEY}${S}*[=:：＝]${S}*${NS}{8,}`, 'i'),
  new RegExp(`${KEY}["']${S}*[=:]${S}*["']?[^\\t\\n\\f\\r "']{8,}`, 'i'),
];
const QUOTED_PHRASE = new RegExp(
  `(?:password|passphrase|pwd|secret)["'”’」』]?${S}*[=:：＝]${S}*(?:"([^"\\n]*)"|'([^'\\n]*)'|“([^”\\n]*)”|‘([^’\\n]*)’|「([^」\\n]*)」|『([^』\\n]*)』)`,
  'gi',
);
const HEX_RUN = /[0-9A-Fa-f]{32,}/g;
const BASE64_RUN = /[A-Za-z0-9+/_-]{32,}=*/g;
const IGNORABLE = /[\p{Cf}\p{Default_Ignorable_Code_Point}\p{Variation_Selector}]/gu;
const MARK = /\p{M}/gu;

const isAlnumAt = (s, i) => i >= 0 && i < s.length && /[0-9A-Za-z]/.test(s[i]);
const hasHexPrefix = (s, i) => i >= 2 && (s[i - 1] === 'x' || s[i - 1] === 'X') && s[i - 2] === '0' && !isAlnumAt(s, i - 3);

function entropy(s) {
  const counts = new Map();
  const chars = [...s];
  for (const c of chars) counts.set(c, (counts.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / chars.length;
    h -= p * Math.log2(p);
  }
  return h;
}

function quotedPassphrase(text) {
  for (const m of text.matchAll(QUOTED_PHRASE)) {
    const v = m.slice(1).filter(Boolean).join('');
    if ([...v].length >= 12 && /[ \t　]/.test(v)) return true;
  }
  return false;
}

function hitsForm(text) {
  if (quotedPassphrase(text)) return true;
  if (RULES.some((re) => re.test(text))) return true;
  for (const m of text.matchAll(HEX_RUN)) {
    const start = m.index;
    const end = start + m[0].length;
    if ((isAlnumAt(text, start - 1) && !hasHexPrefix(text, start)) || isAlnumAt(text, end)) continue;
    if (entropy(m[0]) >= 3.0) return true;
  }
  for (const m of text.matchAll(BASE64_RUN)) {
    const body = m[0].replace(/=+$/, '');
    if (/^[0-9A-Fa-f]*$/.test(body) || !(/[A-Z]/.test(body) && /[a-z]/.test(body) && /[0-9]/.test(body))) continue;
    if (entropy(body) >= 4.0) return true;
  }
  return false;
}

// NFC and NFKC, each also without default-ignorables, and NFKD without default-ignorables and combining marks.
export function looksLikeSecret(s) {
  if (typeof s !== 'string' || s === '') return false;
  const strip = (t) => t.replace(IGNORABLE, '');
  const nfc = s.normalize('NFC');
  const nfkc = s.normalize('NFKC');
  const forms = new Set([nfc, nfkc, strip(nfc), strip(nfkc), strip(s.normalize('NFKD')).replace(MARK, '')]);
  for (const f of forms) if (hitsForm(f)) return true;
  return false;
}
