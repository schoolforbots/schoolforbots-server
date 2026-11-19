import { describe, expect, test } from 'vitest'
import { rawMultiplier, settle, springOf } from '../../../src/club/doudizhu/scoring.js'

describe('rawMultiplier', () => {
  test('starts at 1 and doubles for each doubling, with no cap', () => {
    expect(rawMultiplier([])).toBe(1)
    expect(rawMultiplier([{}, {}, {}])).toBe(8)
    expect(rawMultiplier(new Array(8).fill({}))).toBe(256)
  })
})

describe('springOf', () => {
  test('a spring: the landlord won and neither farmer played', () => {
    expect(springOf(1, true, [0, 5, 0])).toBe('spring')
    expect(springOf(1, true, [1, 5, 0])).toBeNull()
    expect(springOf(1, true, [0, 5, 2])).toBeNull()
  })

  test('an anti-spring: the farmers won and the landlord played only once', () => {
    expect(springOf(2, false, [3, 4, 1])).toBe('anti_spring')
    expect(springOf(2, false, [3, 4, 2])).toBeNull()
  })

  test('a win of the other side is never a spring', () => {
    expect(springOf(0, false, [5, 0, 0])).toBeNull()
    expect(springOf(0, true, [3, 1, 0])).toBeNull()
  })
})

describe('settle', () => {
  test('the landlord wins twice the score, each farmer loses it', () => {
    expect(settle(0, 3, true, 4, 64)).toEqual({ multiplier: 4, capped: false, scores: [24, -12, -12] })
  })

  test('the farmers win the score each, the landlord loses twice it', () => {
    expect(settle(2, 1, false, 1, 64)).toEqual({ multiplier: 1, capped: false, scores: [1, 1, -2] })
  })

  test('the cap cuts the multiplier, and capped says so only above the cap', () => {
    expect(settle(1, 2, true, 128, 64)).toEqual({ multiplier: 64, capped: true, scores: [-128, 256, -128] })
    expect(settle(1, 2, true, 64, 64)).toEqual({ multiplier: 64, capped: false, scores: [-128, 256, -128] })
  })

  test('the scores add up to 0', () => {
    for (const landlord of [0, 1, 2]) {
      for (const base of [1, 2, 3]) {
        for (const won of [true, false]) {
          const { scores } = settle(landlord, base, won, 16, 8)
          expect(scores.reduce((a, b) => a + b, 0)).toBe(0)
        }
      }
    }
  })
})
