// Credential request rules of the market (cws-marketplace internal/domain/credentialask.go), rule for rule. The Go
// regexp classes are kept: \s is [\t\n\f\r ] and \b is an ASCII word boundary.
const S = '[\\t\\n\\f\\r ]';
const NS = '\\t\\n\\f\\r ';

const EXCLUDED = [
  ['开发', '＿＿'], ['發布', '＿＿'], ['发布', '＿＿'], ['发现', '＿＿'], ['發現', '＿＿'], ['发展', '＿＿'], ['發展', '＿＿'],
  ['发生', '＿＿'], ['發生', '＿＿'], ['触发', '＿＿'], ['觸發', '＿＿'], ['研发', '＿＿'], ['研發', '＿＿'], ['发起', '＿＿'], ['發起', '＿＿'],
  ['开發', '＿＿'], ['開發', '＿＿'], ['types of', 'kinds of'], ['type of', 'kind of'],
];
const excludedMap = new Map(EXCLUDED);
const excludedRe = new RegExp(EXCLUDED.map(([k]) => k).join('|'), 'g');

const cjkSecret = '(?:支付密码|支付密碼|登录密码|登錄密碼|密码|密碼|口令|密钥|密鑰|秘钥|秘鑰|私钥|私鑰|助记词|助記詞|验证码|驗證碼|校验码|校驗碼|'
  + '动态码|動態碼|短信码|短信碼|安全码|安全碼|登录凭证|登錄憑證|访问凭证|訪問憑證|账号凭证|帳號憑證|你的凭证|您的凭证|凭据|憑據|'
  + '登录信息|登錄信息|银行卡号|銀行卡號|信用卡号|信用卡號|卡号|卡號|身份证号|身份證號|身份证号码|访问令牌|訪問令牌|'
  + '\\bcvv\\b|\\bcvc\\b|\\bapi ?key\\b|\\baccess ?key\\b|\\bsecret ?key\\b|\\bprivate ?key\\b|\\bpassword\\b|\\bseed phrase\\b|\\bmnemonic\\b)';
const cjkWeak = '(?:\\btokens?\\b|\\bkeys?\\b|\\bpins?\\b ?码?|\\bsecrets?\\b|\\bcookies?\\b|令牌)';
const cjkYourWeak = `(?:你的|您的) ?(?:[a-z0-9_-]+ )?${cjkWeak}`;
const cjkNoun = `(?:${cjkSecret}|${cjkYourWeak})`;
const cjkAskVerb = '(?:提供|告诉|告訴|告知|粘贴|粘貼|私信|上传|上傳|报给|報給|发给我|發給我|发我|發我|发过来|發過來|发送给我|發送給我|回复给我|回覆給我|发一下|發一下)';
const cjkHandOver = '(?:发一下|發一下|发给|發給|发我|發我|发过来|發過來|发送给|發送給|告诉|告訴|提供给|提供給|给我|給我|私信|回复|回覆|贴|貼|填|输入|輸入)';
const cjkHandOverMe = '(?:发一下|發一下|发给|發給|发我|發我|发过来|發過來|发送给|發送給|告诉我|告訴我|提供给|提供給|给我|給我|私信我|回复我|回覆我)';
const cjkNeed = '(?:需要|必须|必須)';
const cjkYour = '(?:你的|您的)';
const cjkGap = (n) => `[^。！？；!?;\\n]{0,${n}}?`;

const cjkRules = [
  new RegExp(`${cjkAskVerb}${cjkGap(15)}${cjkNoun}`, 'iu'),
  new RegExp(`${cjkNoun}${cjkGap(10)}${cjkHandOverMe}`, 'iu'),
  new RegExp(`(?:把|将|將)${cjkGap(12)}${cjkNoun}${cjkGap(8)}${cjkHandOver}`, 'iu'),
  new RegExp(`(?:把|将|將)${cjkGap(6)}${cjkWeak}${cjkGap(8)}${cjkHandOver}`, 'iu'),
  new RegExp(`(?:输入|輸入|填写|填寫|填入)${cjkGap(4)}${cjkYour}${cjkGap(6)}${cjkNoun}`, 'iu'),
  new RegExp(`${cjkNoun}${cjkGap(4)}(?:是多少|是什么|是什麼|是啥|是 ?[?？])`, 'iu'),
  new RegExp(`${cjkNeed}${cjkGap(2)}${cjkYour}${cjkGap(6)}${cjkNoun}`, 'iu'),
];

const enSecret = '(?:passwords?|passcodes?|passphrases?|pin codes?|otps?|one[- ]time (?:pass)?codes?|2fa codes?|'
  + 'verification codes?|security codes?|auth(?:entication)? codes?|login codes?|sms codes?|'
  + '(?:api|access|secret|private|ssh|wallet)[ _-]?keys?|(?:access|auth|bearer|refresh|api) tokens?|'
  + 'seed phrases?|recovery phrases?|mnemonics?|credentials?|login (?:details|info|information)|'
  + '(?:credit |debit |bank )?card numbers?|cvvs?|cvcs?|ssns?|social security numbers?|id numbers?)';
const enWeak = '(?:tokens?|keys?|pins?|secrets?|cookies?)';
const enYour = '(?:your|ur)';
const enAskVerb = '(?:send|provide|enter|give|tell|share|paste|type|input|submit|upload|text|reply with|dm|forward)';
const enWord = `(?:${S}+[^${NS}.!?;]+)`;
const enYourNoun = `(?:${enSecret}|(?:[^${NS}.!?;]+${S}+)?${enWeak})`;

const enRules = [
  new RegExp(`\\b${enAskVerb}\\b${enWord}{0,3}?${S}+${enSecret}\\b`, 'iu'),
  new RegExp(`\\b${enAskVerb}\\b${enWord}?${S}+${enYour}${S}+${enYourNoun}\\b`, 'iu'),
  new RegExp(`\\bwhat(?:'s|’s|${S}+is|${S}+are)${S}+${enYour}${enWord}{0,1}?${S}+${enYourNoun}\\b`, 'iu'),
  new RegExp(`\\bwhat(?:'s|’s|${S}+is)${S}+the${enWord}?${S}+(?:password|passcode|pin|verification code)${S}*[?？]`, 'iu'),
  new RegExp(`\\b${enYour}${S}+${enYourNoun}\\b[^.!?;\\n]{0,30}?\\b${enAskVerb}\\b`, 'iu'),
  new RegExp(`\\b(?:need|needs|require|requires|must have)${S}+${enYour}${enWord}{0,1}?${S}+${enYourNoun}\\b`, 'iu'),
];

const qualifiedEN = new RegExp(`\\b(?:passwords?|passcodes?|pins?|tokens?|keys?|credentials?|cookies?|codes?)${S}+(?:policy|policies|`
  + `hygiene|managers?|expires?|expired|expiry|expiration|rotation|strength|requirements?|rules?|length|usage|limits?|resets?${S}+(?:links?|emails?|pages?|process|instructions|flow)|`
  + 'are stored|is stored|stored)\\b', 'giu');
// The topic word must sit in the same clause: full-width or ASCII clause punctuation and any white space end it.
const qualifiedCJK = new RegExp(`(?:密码|密碼|验证码|驗證碼|口令|令牌|密钥|密鑰|token|key)[^。！？；，,.!?;${NS}\\v\\u0085\\p{Z}]{0,6}?`
  + '(?:有效|位数|位數|位|长度|長度|强度|強度|规则|規則|策略|过期|過期|期限|管理器|用量)', 'gu');
const sentenceEnd = new RegExp(`[。！？；!?;\\n]|\\.(?:${S}|$)`, 'gu');
// At least three single letters separated by spaces ("p a s s w o r d", "c a t").
const singleLetters = /\b(?:[a-z] ){2,}[a-z]\b/g;

const CONFUSABLES = new Map(Object.entries({
  'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'у': 'y', 'х': 'x', 'і': 'i', 'ѕ': 's',
  'ԁ': 'd', 'ο': 'o', 'α': 'a', 'ν': 'v', 'ρ': 'p', 'κ': 'k', 'τ': 't',
}));

const ignorable = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;
const whiteSpace = /\p{White_Space}/gu;

// Per code point, as Go strings.ToLower (no context-dependent final sigma, U+0130 to i).
const toLower = (s) => Array.from(s, (c) => (c === 'İ' ? 'i' : c.toLowerCase())).join('');

function sentences(text) {
  const out = [];
  let start = 0;
  for (const m of text.matchAll(sentenceEnd)) {
    const end = m.index + m[0].length;
    out.push(text.slice(start, end));
    start = end;
  }
  out.push(text.slice(start));
  return out;
}

function asked(text) {
  if (enRules.some((r) => r.test(text))) return true;
  const compact = text.replace(whiteSpace, '');
  return cjkRules.some((r) => r.test(text) || r.test(compact));
}

// True when s asks the reader to send, provide or enter a credential. Negation is not recognised.
export function credentialRequest(s) {
  let text = toLower(String(s).normalize('NFKC').replace(ignorable, ''));
  text = Array.from(text, (c) => CONFUSABLES.get(c) ?? c).join('');
  text = text.replace(excludedRe, (m) => excludedMap.get(m));
  text = text.replace(singleLetters, (m) => m.replaceAll(' ', ''));
  text = text.replace(qualifiedEN, '＿').replace(qualifiedCJK, '＿');
  return sentences(text).some(asked);
}
