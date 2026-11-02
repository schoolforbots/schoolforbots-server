import { toSkeleton } from './confusables.js'

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

// Dropping characters can bring two others together that NFKC had to leave apart: a letter and its combining
// accent with a combining grapheme joiner between them, or two Hangul jamo with a filler between them. The
// text is therefore composed once more after every drop, so it ends up the same as if the invisible
// character had never been there.

/**
 * Drops the characters that show as nothing (see INVISIBLE); whitespace stays. Apply it after NFKC, and apply
 * NFKC again to the result (see above).
 */
export function removeInvisible(text: string): string {
  return text.replace(INVISIBLE, '')
}

/**
 * NFKC, look-alike letters to Latin ones, lowercase, drop all whitespace and invisible characters, then NFKC again.
 * The look-alikes (Cyrillic о, Greek Ο, ...) are mapped before the text is lowercased, because the table is keyed by
 * the case a letter has when someone types it: an upper-case Т has to become T before it can become t.
 */
export function normalizeForMatch(text: string): string {
  return toSkeleton(text.normalize('NFKC')).toLowerCase().replace(IGNORABLE, '').normalize('NFKC')
}

/**
 * NFKC, lowercase, drop invisible characters only, then NFKC again. Whitespace and
 * newlines stay: privacy rules judge a pasted chat log line by line.
 */
export function normalizeForPrivacy(text: string): string {
  return removeInvisible(canonical(text)).normalize('NFKC')
}
