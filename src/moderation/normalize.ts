// Unicode format characters (\p{Cf}): zero-width space and joiners, word joiner,
// soft hyphen, BOM, bidi marks and so on. They are invisible, and people insert
// them to split a word or a number so that a plain match misses it.
const FORMAT_CHARS = /\p{Cf}/gu
const IGNORABLE = /[\s\p{Cf}]/gu

function canonical(text: string): string {
  return text.normalize('NFKC').toLowerCase()
}

/** NFKC, lowercase, then drop all whitespace and Unicode format characters. */
export function normalizeForMatch(text: string): string {
  return canonical(text).replace(IGNORABLE, '')
}

/**
 * NFKC, lowercase, then drop Unicode format characters only. Whitespace and
 * newlines stay: privacy rules judge a pasted chat log line by line.
 */
export function normalizeForPrivacy(text: string): string {
  return canonical(text).replace(FORMAT_CHARS, '')
}
