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

/**
 * A full deck that deals the given hands and bottom: `deckOf(seat0, seat1, seat2, bottom)`, each a space-separated
 * list of ranks (17, 17, 17 and 3 of them, 54 cards in all). Cards of a rank get the suits in order across all four
 * lists, so every card of the deck is used once.
 */
export function deckOf(seat0: string, seat1: string, seat2: string, bottom: string): Card[] {
  const used = new Map<number, number>()
  const cardsOf = (text: string): Card[] =>
    ranks(text).map((rank) => {
      const n = used.get(rank) ?? 0
      const card = FULL_DECK.filter((c) => c.rank === rank)[n]
      if (card === undefined) throw new RangeError(`the deck has no more cards of rank ${rank}`)
      used.set(rank, n + 1)
      return card
    })
  const hands = [cardsOf(seat0), cardsOf(seat1), cardsOf(seat2)]
  const rest = cardsOf(bottom)
  if (hands.some((h) => h.length !== 17) || rest.length !== 3) throw new RangeError('hands of 17 and a bottom of 3')
  const deck: Card[] = []
  for (let i = 0; i < 17; i++) for (const h of hands) deck.push(h[i]!)
  return [...deck, ...rest]
}
