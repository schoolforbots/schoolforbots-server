// Letters of other scripts that are drawn like a Latin letter. Someone who wants to slip a word past the word list
// (or to take a classmate's name) swaps some of its letters for these: Cyrillic "раураl" reads as "paypal".
// The skeleton of a text puts the Latin letters back, so the look-alike spelling and the real one end up equal.
//
// Only letters that look the same in ordinary fonts are listed, so that real text in those scripts is not
// disturbed more than necessary: Greek Δ μ π and most of Cyrillic stay as they are. Keys and values keep their
// case; a caller that wants lower case lowers it after mapping (an upper-case look-alike has to meet the table
// before it becomes a lower-case letter that is not in it).
export const CONFUSABLES: ReadonlyMap<string, string> = new Map([
  // Cyrillic
  ['\u0410', 'A'], // А
  ['\u0412', 'B'], // В
  ['\u0415', 'E'], // Е
  ['\u041A', 'K'], // К
  ['\u041C', 'M'], // М
  ['\u041D', 'H'], // Н
  ['\u041E', 'O'], // О
  ['\u0420', 'P'], // Р
  ['\u0421', 'C'], // С
  ['\u0422', 'T'], // Т
  ['\u0425', 'X'], // Х
  ['\u0423', 'Y'], // У
  ['\u0405', 'S'], // Ѕ
  ['\u0406', 'I'], // І
  ['\u0408', 'J'], // Ј
  ['\u051A', 'Q'], // Ԛ
  ['\u051C', 'W'], // Ԝ
  ['\u04C0', 'I'], // Ӏ
  ['\u0430', 'a'], // а
  ['\u0435', 'e'], // е
  ['\u043E', 'o'], // о
  ['\u0440', 'p'], // р
  ['\u0441', 'c'], // с
  ['\u0445', 'x'], // х
  ['\u0443', 'y'], // у
  ['\u0455', 's'], // ѕ
  ['\u0456', 'i'], // і
  ['\u0458', 'j'], // ј
  ['\u0501', 'd'], // ԁ
  ['\u051B', 'q'], // ԛ
  ['\u051D', 'w'], // ԝ
  ['\u04BB', 'h'], // һ
  // Greek
  ['\u0391', 'A'], // Α
  ['\u0392', 'B'], // Β
  ['\u0395', 'E'], // Ε
  ['\u0396', 'Z'], // Ζ
  ['\u0397', 'H'], // Η
  ['\u0399', 'I'], // Ι
  ['\u039A', 'K'], // Κ
  ['\u039C', 'M'], // Μ
  ['\u039D', 'N'], // Ν
  ['\u039F', 'O'], // Ο
  ['\u03A1', 'P'], // Ρ
  ['\u03A4', 'T'], // Τ
  ['\u03A5', 'Y'], // Υ
  ['\u03A7', 'X'], // Χ
  ['\u03BF', 'o'], // ο
  ['\u03BD', 'v'], // ν
  ['\u03C1', 'p'], // ρ
  ['\u03B9', 'i'], // ι
  ['\u03BA', 'k'], // κ
  ['\u03C5', 'u'], // υ
  ['\u03B1', 'a'], // α
  // Armenian
  ['\u0555', 'O'], // Օ
  ['\u0585', 'o'], // օ
  ['\u054D', 'U'], // Ս
  ['\u057D', 'u'], // ս
  ['\u053C', 'L'], // Լ
  ['\u0570', 'h'], // հ
  ['\u0578', 'n'], // ո
  ['\u0581', 'g'], // ց
  // Cherokee
  ['\u13AA', 'A'], // Ꭺ
  ['\u13F4', 'B'], // Ᏼ
  ['\u13DF', 'C'], // Ꮯ
  ['\u13AC', 'E'], // Ꭼ
  ['\u13BB', 'H'], // Ꮋ
  ['\u13AB', 'J'], // Ꭻ
  ['\u13E6', 'K'], // Ꮶ
  ['\u13DE', 'L'], // Ꮮ
  ['\u13B7', 'M'], // Ꮇ
  ['\u13E2', 'P'], // Ꮲ
  ['\u13DA', 'S'], // Ꮪ
  ['\u13A2', 'T'], // Ꭲ
  ['\u13D9', 'V'], // Ꮩ
  ['\u13B3', 'W'], // Ꮃ
  ['\u13C3', 'Z'], // Ꮓ
])

/**
 * Replaces the look-alike letters of Cyrillic, Greek, Armenian and Cherokee with the Latin letters they imitate.
 * Case is kept; every other character stays.
 */
export function toSkeleton(text: string): string {
  let out = ''
  for (const ch of text) out += CONFUSABLES.get(ch) ?? ch
  return out
}
