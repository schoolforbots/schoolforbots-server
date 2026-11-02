import { describe, expect, test } from 'vitest'
import { CONFUSABLES, toSkeleton } from '../../src/moderation/confusables.js'

// The table of the brief, written as code points: a look-alike letter and the Latin letter it stands for.
const REQUIRED: Record<string, [string, string][]> = {
  cyrillic: [
    ['\u0410', 'A'], ['\u0412', 'B'], ['\u0415', 'E'], ['\u041A', 'K'],
    ['\u041C', 'M'], ['\u041D', 'H'], ['\u041E', 'O'], ['\u0420', 'P'],
    ['\u0421', 'C'], ['\u0422', 'T'], ['\u0425', 'X'], ['\u0423', 'Y'],
    ['\u0405', 'S'], ['\u0406', 'I'], ['\u0408', 'J'], ['\u051A', 'Q'],
    ['\u051C', 'W'], ['\u04C0', 'I'], ['\u0430', 'a'], ['\u0435', 'e'],
    ['\u043E', 'o'], ['\u0440', 'p'], ['\u0441', 'c'], ['\u0445', 'x'],
    ['\u0443', 'y'], ['\u0455', 's'], ['\u0456', 'i'], ['\u0458', 'j'],
    ['\u0501', 'd'], ['\u051B', 'q'], ['\u051D', 'w'], ['\u04BB', 'h'],
  ],
  greek: [
    ['\u0391', 'A'], ['\u0392', 'B'], ['\u0395', 'E'], ['\u0396', 'Z'],
    ['\u0397', 'H'], ['\u0399', 'I'], ['\u039A', 'K'], ['\u039C', 'M'],
    ['\u039D', 'N'], ['\u039F', 'O'], ['\u03A1', 'P'], ['\u03A4', 'T'],
    ['\u03A5', 'Y'], ['\u03A7', 'X'], ['\u03BF', 'o'], ['\u03BD', 'v'],
    ['\u03C1', 'p'], ['\u03B9', 'i'], ['\u03BA', 'k'], ['\u03C5', 'u'],
    ['\u03B1', 'a'],
  ],
  armenian: [
    ['\u0555', 'O'], ['\u0585', 'o'], ['\u054D', 'U'], ['\u057D', 'u'],
    ['\u053C', 'L'], ['\u0570', 'h'], ['\u0578', 'n'], ['\u0581', 'g'],
  ],
  cherokee: [
    ['\u13AA', 'A'], ['\u13F4', 'B'], ['\u13DF', 'C'], ['\u13AC', 'E'],
    ['\u13BB', 'H'], ['\u13AB', 'J'], ['\u13E6', 'K'], ['\u13DE', 'L'],
    ['\u13B7', 'M'], ['\u13E2', 'P'], ['\u13DA', 'S'], ['\u13A2', 'T'],
    ['\u13D9', 'V'], ['\u13B3', 'W'], ['\u13C3', 'Z'],
  ],
}

describe('toSkeleton', () => {
  test('turns Cyrillic, Greek, Armenian and Cherokee look-alikes into Latin letters', () => {
    expect(toSkeleton('\u0422\u043Em')).toBe('Tom')
    expect(toSkeleton('\u03A4\u039F\u039C')).toBe('TOM')
    expect(toSkeleton('\u0440\u0430\u0443\u0440\u0430l')).toBe('paypal')
    expect(toSkeleton('\u0555\u057D')).toBe('Ou')
    expect(toSkeleton('\u13AA\u13A2')).toBe('AT')
  })

  test('keeps the case of the letter it maps', () => {
    expect(toSkeleton('\u041E\u043E')).toBe('Oo')
    expect(toSkeleton('\u0410\u0430')).toBe('Aa')
    expect(toSkeleton('\u0391\u03B1')).toBe('Aa')
  })

  test('leaves everything else alone: Latin, CJK, digits, punctuation, emoji', () => {
    expect(toSkeleton('Tom')).toBe('Tom')
    expect(toSkeleton('阿杰家的小鱼')).toBe('阿杰家的小鱼')
    expect(toSkeleton('12345 .,!? -_')).toBe('12345 .,!? -_')
    expect(toSkeleton('🐟👨\u200D👩')).toBe('🐟👨\u200D👩')
    expect(toSkeleton('')).toBe('')
  })

  test('leaves Greek letters that are not in the table, such as Δ μ π', () => {
    expect(toSkeleton('\u0394x')).toBe('\u0394x')
    expect(toSkeleton('\u03BCm')).toBe('\u03BCm')
    expect(toSkeleton('\u03C0r')).toBe('\u03C0r')
  })

  test('maps only the look-alikes inside a mixed text', () => {
    expect(toSkeleton('阿杰家的\u0422\u043Em 123')).toBe('阿杰家的Tom 123')
  })

  test('is idempotent', () => {
    const once = toSkeleton('\u0440\u0430\u0443\u0440\u0430l \u0391\u0392\u13AA')
    expect(toSkeleton(once)).toBe(once)
  })
})

describe('the look-alike table', () => {
  test.each(Object.entries(REQUIRED))('maps every %s letter of the brief', (_script, pairs) => {
    for (const [glyph, latin] of pairs) {
      expect(CONFUSABLES.get(glyph), glyph.codePointAt(0)?.toString(16)).toBe(latin)
      expect(toSkeleton(glyph)).toBe(latin)
    }
  })

  test('maps single non-ASCII letters of the four scripts to single ASCII letters', () => {
    for (const [glyph, latin] of CONFUSABLES) {
      expect([...glyph]).toHaveLength(1)
      expect(glyph).toMatch(/[\p{Script=Cyrillic}\p{Script=Greek}\p{Script=Armenian}\p{Script=Cherokee}]/u)
      expect(latin).toMatch(/^[A-Za-z]$/)
    }
  })
})
