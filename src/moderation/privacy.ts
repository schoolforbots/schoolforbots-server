// Input must already be NFKC-normalized and lowercased, with whitespace kept.

const PRIVACY_RULES: readonly RegExp[] = [
  // mobile phone number
  /(?<!\d)1[3-9]\d{9}(?!\d)/,
  // e-mail address
  /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/,
  // national ID number (the check digit may be x)
  /(?<!\d)\d{17}[\dx](?!\d)/,
  // QQ number, only with a context word
  /(qq|扣扣|企鹅)[^\d]{0,4}\d{5,11}/,
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
