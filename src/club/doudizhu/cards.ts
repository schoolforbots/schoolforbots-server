import type { Static } from 'typebox'
import type { Rank } from '../../protocol/club.js'

// Cards and ranks. Inside the engine a rank is a number from 3 to 17 (J = 11, Q = 12, K = 13, A = 14, 2 = 15, the
// black joker 16, the red joker 17); outside it is the protocol's `Rank` string. Suits never matter to the rules: the
// engine keeps them only so the shuffled deck can be written to the game record.

export type RankName = Static<typeof Rank>

/** A suit: spades, hearts, clubs, diamonds. A joker has none. */
export type Suit = 'S' | 'H' | 'C' | 'D'

/** The fixed order suits are taken in when a hand gives up cards of a rank. */
export const SUITS: readonly Suit[] = ['S', 'H', 'C', 'D']

export interface Card {
  /** 3 to 17. */
  readonly rank: number
  /** `null` for the jokers. */
  readonly suit: Suit | null
}

export const MIN_RANK = 3
export const TWO = 15
export const BLACK_JOKER = 16
export const RED_JOKER = 17
export const MAX_RANK = RED_JOKER

/** The protocol names of the ranks, by rank value: `RANK_NAMES[rank - 3]`. */
const RANK_NAMES: readonly RankName[] = [
  '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', '2', '小王', '大王',
]

const RANK_VALUES: ReadonlyMap<string, number> = new Map(RANK_NAMES.map((name, i) => [name, i + MIN_RANK]))

function assertRank(rank: number): void {
  if (!Number.isInteger(rank) || rank < MIN_RANK || rank > MAX_RANK) throw new RangeError(`not a rank: ${rank}`)
}

/** The protocol name of a card's rank, or of a rank value. */
export function toRank(card: Card | number): RankName {
  const rank = typeof card === 'number' ? card : card.rank
  assertRank(rank)
  return RANK_NAMES[rank - MIN_RANK]!
}

/** The rank value of a protocol rank: `'10'` is 10, `'小王'` 16, `'大王'` 17. */
export function rankValue(rank: RankName): number {
  const value = RANK_VALUES.get(rank)
  if (value === undefined) throw new RangeError(`not a rank: ${String(rank)}`)
  return value
}

const suitIndex = (suit: Suit | null): number => (suit === null ? 0 : SUITS.indexOf(suit))

/** Orders cards by rank, low to high, and within a rank by suit (♠ ♥ ♣ ♦). */
export function compareCards(a: Card, b: Card): number {
  return a.rank - b.rank || suitIndex(a.suit) - suitIndex(b.suit)
}

/** The cards sorted low to high, as a new array. */
export function sortCards(cards: readonly Card[]): Card[] {
  return [...cards].sort(compareCards)
}

/** The ranks of some cards, low to high: how a hand is shown outside the engine. */
export function ranksOf(cards: readonly Card[]): RankName[] {
  return sortCards(cards).map(toRank)
}

function buildDeck(): readonly Card[] {
  const deck: Card[] = []
  for (let rank = MIN_RANK; rank <= TWO; rank++) {
    for (const suit of SUITS) deck.push(Object.freeze({ rank, suit }))
  }
  deck.push(Object.freeze({ rank: BLACK_JOKER, suit: null }), Object.freeze({ rank: RED_JOKER, suit: null }))
  return Object.freeze(deck)
}

/** The 54 cards in a fixed order: 3♠ 3♥ 3♣ 3♦ 4♠ … 2♦, the black joker, the red joker. */
export const FULL_DECK: readonly Card[] = buildDeck()

export type TakeResult =
  | { ok: true; taken: Card[]; rest: Card[] }
  | { ok: false; missing: number[] }

/**
 * Takes cards from a hand by rank. Of each rank it takes the cards in suit order (♠ ♥ ♣ ♦). `taken` is sorted low to
 * high; `rest` keeps the order of the hand. When the hand is short, `missing` lists the cards short one by one, low to
 * high: asking for three 7s with two in hand gives `[7]`.
 */
export function takeRanks(hand: readonly Card[], ranks: readonly number[]): TakeResult {
  const wanted = new Map<number, number>()
  for (const rank of ranks) {
    assertRank(rank)
    wanted.set(rank, (wanted.get(rank) ?? 0) + 1)
  }
  const missing: number[] = []
  const takenSet = new Set<Card>()
  for (const [rank, count] of [...wanted].sort(([a], [b]) => a - b)) {
    const available = hand.filter((card) => card.rank === rank).sort(compareCards)
    for (const card of available.slice(0, count)) takenSet.add(card)
    for (let i = available.length; i < count; i++) missing.push(rank)
  }
  if (missing.length > 0) return { ok: false, missing }
  return {
    ok: true,
    taken: sortCards([...takenSet]),
    rest: hand.filter((card) => !takenSet.has(card)),
  }
}
