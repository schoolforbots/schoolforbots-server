// Input must already be normalized with `normalizeForPrivacy`: NFKC, lowercase,
// format characters removed, whitespace kept.

// An optional single separator between digit groups: a space, a hyphen-minus or
// a Unicode dash (U+2010..U+2015). "138 1234 5678" and "138-1234-5678" are leaks too.
const SEP = String.raw`[ \-\u2010-\u2015]?`

// Every quantifier below is bounded, so matching stays linear in the input length
// (an unbounded `+` in front of the `@` rescans a long run at every start position).
const PRIVACY_RULES: readonly RegExp[] = [
  // mobile phone number
  new RegExp(String.raw`(?<!\d)1[3-9]\d${SEP}\d{4}${SEP}\d{4}(?!\d)`),
  // e-mail address (local part <= 64, domain <= 253, top-level label <= 63)
  /[a-z0-9._%+-]{1,64}@[a-z0-9.-]{1,253}\.[a-z]{2,63}/,
  // national ID number (the check digit may be x)
  new RegExp(String.raw`(?<!\d)\d{6}${SEP}\d{8}${SEP}\d{3}[\dx](?!\d)`),
  // QQ number (5 to 11 digits), only with a context word
  new RegExp(String.raw`(qq|扣扣|企鹅)[^\d]{0,4}\d(?:${SEP}\d){4,10}`),
  // WeChat id, only with a context word
  /(微信|weixin|vx|wx|v信)[^a-z0-9]{0,4}[a-z][-_a-z0-9]{5,19}/,
]

// A line that starts with a clock time (12:01) or a date (2026-11-02).
const TIMESTAMPED_LINE = /^[^\S\r\n]*(?:\d{1,2}:\d{2}|\d{4}-\d{1,2}-\d{1,2})/
const CHAT_LOG_MIN_LINES = 3

/**
 * Returns the fragment that looks like leaked personal information, or null.
 * For a pasted chat log the fragment is its first timestamped line.
 */
export function findPrivacyLeak(text: string): string | null {
  for (const rule of PRIVACY_RULES) {
    const m = rule.exec(text)
    if (m !== null) return m[0]
  }
  const stamped = text.split(/\r?\n/).filter((line) => TIMESTAMPED_LINE.test(line))
  const first = stamped[0]
  if (stamped.length >= CHAT_LOG_MIN_LINES && first !== undefined) return first.trim()
  return null
}
