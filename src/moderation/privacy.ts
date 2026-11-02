// Input must already be normalized with `normalizeForPrivacy`: NFKC, lowercase,
// format characters removed, whitespace kept.

// An optional single separator between digit groups: a space, a hyphen-minus or
// a Unicode dash (U+2010..U+2015). "138 1234 5678" and "138-1234-5678" are leaks too.
const SEP = String.raw`[ \-\u2010-\u2015]?`

export type PrivacyKind = 'phone' | 'email' | 'idCard' | 'qq' | 'wechat'

export interface PrivacyRule {
  kind: PrivacyKind
  pattern: RegExp
}

// Every quantifier below is bounded, so matching stays linear in the input length
// (an unbounded `+` in front of the `@` rescans a long run at every start position).
// The QQ and WeChat patterns name the part that is the secret (`secret`, always at the end of the match), so that
// `maskPrivacy` can hide it and leave the context word alone.
export const PRIVACY_RULES: readonly PrivacyRule[] = [
  // mobile phone number
  { kind: 'phone', pattern: new RegExp(String.raw`(?<!\d)1[3-9]\d${SEP}\d{4}${SEP}\d{4}(?!\d)`) },
  // e-mail address (local part <= 64, domain <= 253, top-level label <= 63)
  { kind: 'email', pattern: /[a-z0-9._%+-]{1,64}@[a-z0-9.-]{1,253}\.[a-z]{2,63}/ },
  // national ID number (the check digit may be x)
  { kind: 'idCard', pattern: new RegExp(String.raw`(?<!\d)\d{6}${SEP}\d{8}${SEP}\d{3}[\dx](?!\d)`) },
  // QQ number (5 to 11 digits), only with a context word
  { kind: 'qq', pattern: new RegExp(String.raw`(qq|扣扣|企鹅)[^\d]{0,4}(?<secret>\d(?:${SEP}\d){4,10})`) },
  // WeChat id, only with a context word
  { kind: 'wechat', pattern: /(微信|weixin|vx|wx|v信)[^a-z0-9]{0,4}(?<secret>[a-z][-_a-z0-9]{5,19})/ },
]

// A line that starts with a clock time (12:01) or a date (2026-11-02).
const TIMESTAMPED_LINE = /^[^\S\r\n]*(?:\d{1,2}:\d{2}|\d{4}-\d{1,2}-\d{1,2})/
const CHAT_LOG_MIN_LINES = 3

export interface ChatLog {
  /** Offset of the first timestamped line. */
  start: number
  /** Offset just after the last timestamped line, before its line break. */
  end: number
  /** The first timestamped line, as written. */
  firstLine: string
}

/**
 * Finds a pasted chat log: three or more lines that start with a time or a date. It runs from the first such line to
 * the end of the last one, so the lines in between belong to it. Lines end at `\n`, with a `\r` before it dropped.
 */
export function findChatLog(text: string): ChatLog | null {
  let count = 0
  let first: { start: number; end: number } | null = null
  let end = 0
  for (let start = 0; start <= text.length; ) {
    const newline = text.indexOf('\n', start)
    const lineEnd = newline === -1 ? text.length : newline
    const contentEnd = newline !== -1 && lineEnd > start && text[lineEnd - 1] === '\r' ? lineEnd - 1 : lineEnd
    if (TIMESTAMPED_LINE.test(text.slice(start, contentEnd))) {
      count++
      first ??= { start, end: contentEnd }
      end = contentEnd
    }
    start = lineEnd + 1
  }
  if (count < CHAT_LOG_MIN_LINES || first === null) return null
  return { start: first.start, end, firstLine: text.slice(first.start, first.end) }
}

/**
 * Returns the fragment that looks like leaked personal information, or null.
 * For a pasted chat log the fragment is its first timestamped line.
 */
export function findPrivacyLeak(text: string): string | null {
  for (const { pattern } of PRIVACY_RULES) {
    const m = pattern.exec(text)
    if (m !== null) return m[0]
  }
  const log = findChatLog(text)
  return log === null ? null : log.firstLine.trim()
}
