import fs from 'node:fs';
import { looksLikeSecret } from '../secretscan.js';
import { credentialRequest } from './credential.js';

export const PREFIX = '｜ ';
export const END_LINE = '（以上为模板作者提供的内容）';
export const LINK_REMOVED = '[链接已移除]';
export const LIMITS = Object.freeze({ name: 40, firstGuide: 2000, tasks: 3, title: 40, prompt: 500, addressee: 64 });

// IANA root zone TLDs (data.iana.org/TLD/tlds-alpha-by-domain.txt), lower-cased.
export const TLDS = new Set(fs.readFileSync(new URL('./tlds.txt', import.meta.url), 'utf8')
  .split('\n').map((l) => l.trim().toLowerCase()).filter((l) => l && !l.startsWith('#')));

const BREAKS = /\r\n|[\r\n\v\f\u0085\u2028\u2029]/gu;
// Control, format, surrogate and default-ignorable code points (zero-width and bidi controls included).
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Default_Ignorable_Code_Point}]/gu;

// Full-width . / : \ fold to ASCII for matching.
const FOLD_WIDE = new Set([0xff0e, 0xff0f, 0xff1a, 0xff3c]);

// Characters folded only for matching, one UTF-16 unit to one, so offsets stay valid in the original text.
function foldForMatch(s) {
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c === 0x3002 || c === 0xff61) out += '.';
    else if (FOLD_WIDE.has(c) || (c >= 0xff10 && c <= 0xff19) || (c >= 0xff21 && c <= 0xff3a) || (c >= 0xff41 && c <= 0xff5a)) {
      out += String.fromCharCode(c - 0xfee0);
    } else out += ch;
  }
  return out;
}

// Replaces each match of re found in the folded text with the placeholder; accept may refine the matched length.
function removeMatches(text, re, accept = (m) => m[0].length) {
  const folded = foldForMatch(text);
  let out = '';
  let last = 0;
  re.lastIndex = 0;
  for (let m = re.exec(folded); m; m = re.exec(folded)) {
    const len = accept(m, folded);
    if (!len) {
      re.lastIndex = m.index + 1;
      continue;
    }
    out += text.slice(last, m.index) + LINK_REMOVED;
    last = m.index + len;
    re.lastIndex = last;
  }
  return out + text.slice(last);
}

// The rest of a URL: printable ASCII except quotes and angle brackets.
const REST = '[!#-&(-;=?-_a-~]*';
const TAIL = `(?::\\d{1,5})?(?:[/?#]${REST})?`;
const MD_LINK = /!?\[[^\]\n]*\]\([^)\n]*\)/g;
const SCHEME = new RegExp(`[a-z][a-z0-9+.-]*:[\\\\/]{2}${REST}`, 'gi');
const WWW = new RegExp(`(?<![a-z0-9-])www\\.${REST}`, 'gi');
const IPV6_BRACKET = new RegExp(`\\[[0-9a-f:.%]*:[0-9a-f:.%]*\\]${TAIL}`, 'gi');
const IPV4 = new RegExp(`(?<![0-9.])(?:\\d{1,3}\\.){3}\\d{1,3}(?![0-9])${TAIL}`, 'g');
const IPV6 = new RegExp(`(?<![0-9a-z:])(?:[0-9a-f]{0,4}:){2,7}(?:[0-9a-f]{1,4}|(?:\\d{1,3}\\.){3}\\d{1,3})?(?![0-9a-z:])${TAIL}`, 'gi');
const HOST_CHAIN = /(?<![a-z0-9-])[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+/gi;
const TAIL_AT = new RegExp(`^${TAIL}`, 'i');

const ipv6Like = (s) => /[0-9a-f]/i.test(s) && (s.includes('::') || (s.match(/:/g) ?? []).length >= 7);

// Length of the longest leading part of a host chain that ends in a known TLD (at least two labels), with its port and path.
function bareDomain(m, folded) {
  const labels = m[0].toLowerCase().split('.');
  for (let n = labels.length; n >= 2; n--) {
    if (!TLDS.has(labels[n - 1])) continue;
    const host = labels.slice(0, n).join('.').length;
    const tail = TAIL_AT.exec(folded.slice(m.index + host))[0].length;
    return host + tail;
  }
  return 0;
}

// URLs, markdown links and images, www. hosts, IPv4 / IPv6 addresses and bare domains (full-width periods folded) are
// each replaced by LINK_REMOVED.
export function removeLinks(text) {
  let t = removeMatches(text, MD_LINK);
  t = removeMatches(t, SCHEME);
  t = removeMatches(t, WWW);
  t = removeMatches(t, IPV6_BRACKET);
  t = removeMatches(t, IPV4);
  t = removeMatches(t, IPV6, (m) => (ipv6Like(m[0].split(/[/?#]/)[0]) ? m[0].length : 0));
  return removeMatches(t, HOST_CHAIN, bareDomain);
}

const truncate = (s, max) => Array.from(s).slice(0, max).join('');

// A member display name as the market cleans it: NFC and trimmed; a line break, an invisible character or a
// secret-looking value drops it; longer than LIMITS.addressee code points is cut.
export function cleanDisplayName(raw) {
  if (typeof raw !== 'string') return '';
  const s = raw.normalize('NFC').trim();
  if (new RegExp(BREAKS.source, 'u').test(s) || new RegExp(INVISIBLE.source, 'u').test(s) || s.includes('\ufffd') || looksLikeSecret(s)) return '';
  return truncate(s, LIMITS.addressee).trim();
}

// One field through the filters: invisible characters out, links out, @ made full-width, then lines and length.
export function cleanText(raw, { max, multiline }) {
  let t = String(raw ?? '').replace(BREAKS, '\n').replace(INVISIBLE, (c) => (c === '\n' ? '\n' : ''));
  t = removeLinks(t).replaceAll('@', '＠');
  if (!multiline) return truncate(t.replaceAll('\n', ' ').replace(/\s+/gu, ' ').trim(), max).trim();
  const lines = t.split('\n').map((l) => l.trimEnd());
  const kept = [];
  for (const l of lines) if (l.trim() || (kept.length && kept.at(-1) !== '')) kept.push(l.trim() ? l : '');
  while (kept.at(-1) === '') kept.pop();
  return truncate(kept.join('\n'), max).replace(/\s+$/u, '');
}

// The fields of the message after filtering; at most LIMITS.tasks starter tasks, empty ones dropped.
export function cleanContent({ addressee, templateName, firstGuide, starterTasks }) {
  return {
    addressee: cleanText(addressee, { max: LIMITS.addressee, multiline: false }),
    templateName: cleanText(templateName, { max: LIMITS.name, multiline: false }),
    firstGuide: cleanText(firstGuide, { max: LIMITS.firstGuide, multiline: true }),
    starterTasks: (Array.isArray(starterTasks) ? starterTasks : []).slice(0, LIMITS.tasks).map((x) => ({
      title: cleanText(x?.title, { max: LIMITS.title, multiline: false }),
      prompt: cleanText(x?.prompt, { max: LIMITS.prompt, multiline: true }),
    })).filter((x) => x.title || x.prompt),
  };
}

// True when any field, as given or after filtering, asks for a credential.
export function asksForCredential(raw, clean) {
  const fields = (c) => [c.templateName, c.firstGuide, ...(Array.isArray(c.starterTasks) ? c.starterTasks : []).flatMap((x) => [x?.title, x?.prompt])];
  return [...fields(raw), ...fields(clean)].some((f) => typeof f === 'string' && f !== '' && credentialRequest(f));
}

const prefixed = (text) => text.split('\n').map((l) => PREFIX + l);

// The message text of filtered content: every line of author text starts with PREFIX and END_LINE is the last line.
export function renderStarter(clean) {
  const name = clean.templateName;
  const lines = [
    `你好${clean.addressee ? `，${clean.addressee}` : ''}。专家模板「${name}」已装到我这里。`,
    `以下引导来自模板「${name}」的作者：`,
  ];
  if (clean.firstGuide) lines.push(...prefixed(clean.firstGuide));
  if (clean.starterTasks.length) {
    lines.push(`${PREFIX}可以先试试这些任务（复制发给我即可）：`);
    clean.starterTasks.forEach((x, i) => {
      const head = `${i + 1}. ${x.title}${x.title && x.prompt ? '：' : ''}`;
      const [first, ...rest] = x.prompt.split('\n');
      lines.push(PREFIX + head + first, ...rest.map((l) => PREFIX + l));
    });
  }
  lines.push(END_LINE);
  return lines.join('\n');
}

export const hasContent = (clean) => Boolean(clean.templateName && (clean.firstGuide || clean.starterTasks.length));
