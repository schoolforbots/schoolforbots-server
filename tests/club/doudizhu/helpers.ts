import { type Card, FULL_DECK, rankValue, type RankName } from '../../../src/club/doudizhu/cards.js'
import type { RandomInt } from '../../../src/club/doudizhu/deal.js'

// Test helpers shared by the doudizhu engine tests.

/** mulberry32: a small seeded PRNG giving floats in [0, 1). The same seed always gives the same sequence. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A seeded `RandomInt`: integers in [0, n). */
export function seededRandomInt(seed: number): RandomInt {
  const next = mulberry32(seed)
  return (n) => Math.floor(next() * n)
}

/**
 * The rank values of a space-separated list of protocol ranks, in the order given: `ranks('3 3 10 小王')` is
 * `[3, 3, 10, 16]`. An empty string gives no ranks.
 */
export function ranks(text: string): number[] {
  const names = text.trim() === '' ? [] : text.trim().split(/\s+/)
  return names.map((name) => rankValue(name as RankName))
}

/**
 * Real cards for a space-separated list of protocol ranks, in the order given: `hand('3 3 4 小王')`. Cards of the same
 * rank get the suits in order (♠ ♥ ♣ ♦), so they are all different cards from the deck. Throws when a rank comes more
 * often than the deck has it: five 3s, or two black jokers.
 */
export function hand(text: string): Card[] {
  const used = new Map<number, number>()
  return ranks(text).map((rank) => {
    const n = used.get(rank) ?? 0
    const card = FULL_DECK.filter((c) => c.rank === rank)[n]
    if (card === undefined) throw new RangeError(`the deck has no more cards of rank ${rank}: ${text}`)
    used.set(rank, n + 1)
    return card
  })
}
