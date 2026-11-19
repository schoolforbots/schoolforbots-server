import { randomInt } from 'node:crypto'
import { describe, expect, test, vi } from 'vitest'
import { type Card, FULL_DECK } from '../../../src/club/doudizhu/cards.js'
import { deal, type RandomInt, shuffle } from '../../../src/club/doudizhu/deal.js'
import { seededRandomInt } from './helpers.js'

// Wrap crypto.randomInt in a spy that still calls the real one, so a test can see the default source is used.
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>()
  return { ...actual, randomInt: vi.fn(actual.randomInt) }
})

const key = (c: Card) => `${c.rank}${c.suit ?? ''}`

/**
 * The chi-square statistic of how often each card lands at each position over `runs` shuffles, and its degrees of
 * freedom. `shuffleIndices` shuffles the card indices 0 to 53.
 */
function positionChiSquare(runs: number, shuffleIndices: () => number[]): { chiSquare: number; df: number } {
  const counts = Array.from({ length: 54 }, () => new Array<number>(54).fill(0))
  for (let run = 0; run < runs; run++) {
    shuffleIndices().forEach((card, position) => counts[position]![card]!++)
  }
  const expected = runs / 54
  let chiSquare = 0
  for (const row of counts) for (const count of row) chiSquare += (count - expected) ** 2 / expected
  return { chiSquare, df: 54 * 53 }
}

describe('shuffle', () => {
  test('keeps all 54 cards and leaves the deck as it was', () => {
    const before = [...FULL_DECK]
    const shuffled = shuffle(FULL_DECK, seededRandomInt(1))
    expect(shuffled).toHaveLength(54)
    expect(new Set(shuffled.map(key))).toEqual(new Set(FULL_DECK.map(key)))
    expect(shuffled).not.toEqual(FULL_DECK)
    expect(FULL_DECK).toEqual(before)
  })

  test('gives the same order for the same seed and another for another seed', () => {
    expect(shuffle(FULL_DECK, seededRandomInt(42))).toEqual(shuffle(FULL_DECK, seededRandomInt(42)))
    expect(shuffle(FULL_DECK, seededRandomInt(42))).not.toEqual(shuffle(FULL_DECK, seededRandomInt(43)))
  })

  test('uses crypto.randomInt by default', () => {
    const spy = vi.mocked(randomInt)
    spy.mockClear()
    const shuffled = shuffle(FULL_DECK)
    expect(new Set(shuffled.map(key)).size).toBe(54)
    // One call per position from the last down to the second: randomInt(54), randomInt(53), …, randomInt(2).
    expect(spy.mock.calls.map((args) => args[0])).toEqual(Array.from({ length: 53 }, (_, i) => 54 - i))
  })

  test('rejects a random source that goes out of range', () => {
    expect(() => shuffle(FULL_DECK, (n) => n)).toThrow(RangeError)
    expect(() => shuffle(FULL_DECK, () => -1)).toThrow(RangeError)
    expect(() => shuffle(FULL_DECK, () => 0.5)).toThrow(RangeError)
  })

  // A chi-square test over all 54 × 54 (position, card) cells. The seed is fixed, so the result is the same on every
  // run; the bound is loose (6 standard deviations), so only a really biased shuffle fails it.
  const RUNS = 54 * 100

  test('puts every card at every position about equally often', () => {
    const indices = FULL_DECK.map((_, i) => i)
    const random = seededRandomInt(2026)
    const { chiSquare, df } = positionChiSquare(RUNS, () => shuffle(indices, random))
    const sd = Math.sqrt(2 * df)
    expect(chiSquare).toBeGreaterThan(df - 6 * sd)
    expect(chiSquare).toBeLessThan(df + 6 * sd)
  })

  test('the same check catches a biased shuffle', () => {
    // The classic mistake: swapping with any position, not only with those not yet fixed.
    const random: RandomInt = seededRandomInt(2026)
    const { chiSquare, df } = positionChiSquare(RUNS, () => {
      const cards = FULL_DECK.map((_, i) => i)
      for (let i = cards.length - 1; i > 0; i--) {
        const j = random(cards.length)
        const swap = cards[i]!
        cards[i] = cards[j]!
        cards[j] = swap
      }
      return cards
    })
    expect(chiSquare).toBeGreaterThan(df + 6 * Math.sqrt(2 * df))
  })
})

describe('deal', () => {
  test('gives each seat 17 cards and leaves 3 bottom cards, 54 different cards in all', () => {
    const { hands, bottom } = deal(shuffle(FULL_DECK, seededRandomInt(7)))
    for (const hand of hands) expect(hand).toHaveLength(17)
    expect(bottom).toHaveLength(3)
    expect(new Set([...hands.flat(), ...bottom].map(key)).size).toBe(54)
  })

  test('deals round the seats in turn and keeps the last 3 cards for the bottom', () => {
    // FULL_DECK is 3♠ 3♥ 3♣ 3♦ 4♠ …, so seat 0 gets cards 0, 3, 6, …, seat 1 cards 1, 4, 7, …
    const { hands, bottom } = deal(FULL_DECK)
    expect(hands[0].slice(0, 3).map(key)).toEqual(['3S', '3D', '4C'])
    expect(hands[1].slice(0, 3).map(key)).toEqual(['3H', '4S', '4D'])
    expect(hands[2].slice(0, 3).map(key)).toEqual(['3C', '4H', '5S'])
    expect(bottom.map(key)).toEqual(['15D', '16', '17'])
  })

  test('sorts each hand and the bottom low to high', () => {
    const { hands, bottom } = deal(shuffle(FULL_DECK, seededRandomInt(8)))
    for (const cards of [...hands, bottom]) {
      const ranks = cards.map((c) => c.rank)
      expect(ranks).toEqual([...ranks].sort((a, b) => a - b))
    }
  })

  test('deals the same cards for the same seed', () => {
    expect(deal(shuffle(FULL_DECK, seededRandomInt(99)))).toEqual(deal(shuffle(FULL_DECK, seededRandomInt(99))))
  })

  test('rejects a deck that is not 54 cards', () => {
    expect(() => deal(FULL_DECK.slice(1))).toThrow(RangeError)
  })
})
