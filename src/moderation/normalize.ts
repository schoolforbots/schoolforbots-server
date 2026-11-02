// Whitespace plus zero-width characters (U+200B..U+200D, U+FEFF), which are
// otherwise used to split a word so that a plain substring match misses it.
const IGNORABLE = /[\s​-‍﻿]/gu

/** NFKC, lowercase, then drop all whitespace and zero-width characters. */
export function normalizeForMatch(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(IGNORABLE, '')
}
