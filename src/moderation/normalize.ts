// Characters that show as nothing. People insert them to split a word or a number so
// that a plain match misses it, or to make a name look like someone else's:
// - \p{Cf}, format characters: zero-width space and joiners, word joiner, soft hyphen, BOM, bidi marks, ...
// - \p{Default_Ignorable_Code_Point}: the format characters again, plus the combining grapheme joiner,
//   variation selectors and Hangul fillers, which are not format characters (NFKC turns the Hangul
//   filler U+3164 into U+1160, which is default-ignorable too)
// - U+2800 BRAILLE PATTERN BLANK, a symbol to Unicode that still shows as a blank
const INVISIBLE = /[\p{Cf}\p{Default_Ignorable_Code_Point}⠀]/gu
const IGNORABLE = /[\s\p{Cf}\p{Default_Ignorable_Code_Point}⠀]/gu

function canonical(text: string): string {
  return text.normalize('NFKC').toLowerCase()
}

/** Drops the characters that show as nothing (see INVISIBLE); whitespace stays. Apply it after NFKC. */
export function removeInvisible(text: string): string {
  return text.replace(INVISIBLE, '')
}

/** NFKC, lowercase, then drop all whitespace and invisible characters. */
export function normalizeForMatch(text: string): string {
  return canonical(text).replace(IGNORABLE, '')
}

/**
 * NFKC, lowercase, then drop invisible characters only. Whitespace and
 * newlines stay: privacy rules judge a pasted chat log line by line.
 */
export function normalizeForPrivacy(text: string): string {
  return removeInvisible(canonical(text))
}
