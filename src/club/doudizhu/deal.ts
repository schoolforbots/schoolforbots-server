import { randomInt } from 'node:crypto'
import { type Card, sortCards } from './cards.js'

// Shuffling and dealing. The source of randomness is passed in, so a test can use a fixed seed and a game can be
// replayed from its shuffled deck.

/** Returns an integer in `[0, n)`. */
export type RandomInt = (n: number) => number

/** The default source of randomness: `crypto.randomInt`. */
export const cryptoRandomInt: RandomInt = (n) => randomInt(n)

export const DECK_SIZE = 54
export const HAND_SIZE = 17
export const BOTTOM_SIZE = 3

/** A Fisher–Yates shuffle of the deck (or of anything), as a new array. */
export function shuffle<T>(deck: readonly T[], random: RandomInt = cryptoRandomInt): T[] {
  const cards = [...deck]
  for (let i = cards.length - 1; i > 0; i--) {
    const j = random(i + 1)
    if (!Number.isInteger(j) || j < 0 || j > i) throw new RangeError(`random(${i + 1}) gave ${j}`)
    const card = cards[i]!
    cards[i] = cards[j]!
    cards[j] = card
  }
  return cards
}

export interface Deal {
  /** The hands of seats 0, 1 and 2, each sorted low to high. */
  hands: [Card[], Card[], Card[]]
  /** The bottom cards, sorted low to high. */
  bottom: Card[]
}

/** Deals a shuffled deck round the seats: card i of the first 51 goes to seat i % 3, the last 3 are the bottom. */
export function deal(deck: readonly Card[]): Deal {
  if (deck.length !== DECK_SIZE) throw new RangeError(`a deck has ${DECK_SIZE} cards, not ${deck.length}`)
  const hands: [Card[], Card[], Card[]] = [[], [], []]
  const dealt = DECK_SIZE - BOTTOM_SIZE
  for (let i = 0; i < dealt; i++) hands[i % 3]!.push(deck[i]!)
  return {
    hands: [sortCards(hands[0]), sortCards(hands[1]), sortCards(hands[2])],
    bottom: sortCards(deck.slice(dealt)),
  }
}
