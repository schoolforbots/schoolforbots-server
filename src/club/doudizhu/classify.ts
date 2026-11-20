import type { Static } from 'typebox'
import type { MoveType as MoveTypeSchema } from '../../protocol/club.js'
import { BLACK_JOKER, MAX_RANK, MIN_RANK, RED_JOKER } from './cards.js'
import type { Rules } from './rules.js'

// Move types: which kinds of move a set of cards can be played as. A set of cards can be more than one kind
// (`555666777888` is a trio straight and a plane with solo wings), so `classify` gives every reading.

export type MoveType = Static<typeof MoveTypeSchema>

/** The move types in the protocol's order. Readings of the same cards are listed in this order. */
export const MOVE_TYPES: readonly MoveType[] = [
  'single',
  'pair',
  'trio',
  'trio_solo',
  'trio_pair',
  'straight',
  'pair_straight',
  'trio_straight',
  'plane_solo',
  'plane_pair',
  'four_two_solo',
  'four_two_pair',
  'bomb',
  'rocket',
]

export const TYPE_ORDER: ReadonlyMap<MoveType, number> = new Map(MOVE_TYPES.map((type, i) => [type, i]))

/** One way of playing a set of cards. */
export interface Interpretation {
  readonly type: MoveType
  /**
   * The rank moves are compared by: the rank of the single, pair, trio or four; the highest rank of a straight or of
   * the trios of a plane; the red joker for the rocket.
   */
  readonly main: number
  /** The number of cards. */
  readonly length: number
  /** All the cards, low to high. */
  readonly cards: readonly number[]
  /** The cards that make the type (the trios of a plane, the four of a four with two), low to high. */
  readonly body: readonly number[]
  /** The cards carried along (the wings of a plane, the kicker of a trio with one), low to high; empty if none. */
  readonly kickers: readonly number[]
}

/** The most cards one move can have: the landlord's whole hand. */
export const MAX_MOVE_LENGTH = 20

/** The highest rank a straight, pair straight, trio straight or plane may reach: the ace. */
export const ACE = 14

/** The rules `classify` looks at. */
export type ClassifyRules = Pick<
  Rules,
  'bareTrio' | 'minPairStraight' | 'soloKickersMayPair' | 'soloKickersMayBeJokers' | 'fourWithTwo'
>

export const repeat = (rank: number, times: number): number[] => new Array<number>(times).fill(rank)

/** The ranks, low to high, given by a count per rank. */
function expand(counts: ReadonlyMap<number, number>): number[] {
  return [...counts].sort(([a], [b]) => a - b).flatMap(([rank, n]) => repeat(rank, n))
}

/**
 * Whether some cards may be carried as solo kickers. Kickers never share a rank with the body (the caller makes sure
 * of that). With `soloKickersMayPair` off no two kickers have the same rank; with `soloKickersMayBeJokers` off they are
 * not both jokers.
 */
function soloKickersAllowed(kickers: ReadonlyMap<number, number>, rules: ClassifyRules): boolean {
  if (!rules.soloKickersMayPair && [...kickers.values()].some((n) => n > 1)) return false
  if (!rules.soloKickersMayBeJokers && kickers.has(BLACK_JOKER) && kickers.has(RED_JOKER)) return false
  return true
}

/**
 * Whether some cards may be carried as `pairs` pair kickers: exactly that many pairs, each of a different rank (four of
 * a rank is not two pairs). Two jokers are not a pair: each joker comes once, so they never make a count of 2.
 */
function pairKickersAllowed(kickers: ReadonlyMap<number, number>, pairs: number): boolean {
  return kickers.size === pairs && [...kickers.values()].every((n) => n === 2)
}

/**
 * Every way the cards can be played, in the protocol's order of move types. Readings of the same type differ in their
 * body: `333444555666` is a plane with solo wings on `444555666` (wings `333`) or on `333444555` (wings `666`); those
 * come highest main rank first, so the first reading of a type is the strongest. Gives an empty array when the cards
 * make no move, and for more than 20 cards or more of a rank than the deck has.
 */
export function classify(ranks: readonly number[], rules: ClassifyRules): Interpretation[] {
  const length = ranks.length
  if (length === 0 || length > MAX_MOVE_LENGTH) return []
  const counts = new Map<number, number>()
  for (const rank of ranks) {
    if (!Number.isInteger(rank) || rank < MIN_RANK || rank > MAX_RANK) throw new RangeError(`not a rank: ${rank}`)
    counts.set(rank, (counts.get(rank) ?? 0) + 1)
  }
  for (const [rank, n] of counts) if (n > (rank >= BLACK_JOKER ? 1 : 4)) return []

  const cards = expand(counts)
  const found: Interpretation[] = []
  const add = (type: MoveType, main: number, body: readonly number[], kickers: readonly number[] = []): void => {
    found.push({ type, main, length, cards, body, kickers })
  }

  const ranksByCount = (n: number): number[] =>
    [...counts]
      .filter(([, count]) => count === n)
      .map(([rank]) => rank)
      .sort((a, b) => a - b)
  const distinct = [...counts.keys()].sort((a, b) => a - b)
  const lowest = distinct[0]!
  const highest = distinct[distinct.length - 1]!
  const consecutive = highest <= ACE && highest - lowest + 1 === distinct.length
  /** Every rank comes `n` times and the ranks run on from 3 to A at most. */
  const chainOf = (n: number): boolean => consecutive && [...counts.values()].every((count) => count === n)

  // Single, pair, trio, trio with one, trio with a pair.
  if (length === 1) add('single', lowest, cards)
  if (length === 2 && counts.size === 1) add('pair', lowest, cards)
  if (length === 3 && counts.size === 1 && rules.bareTrio) add('trio', lowest, cards)
  if (length === 4 || length === 5) {
    const [trio] = ranksByCount(3)
    if (trio !== undefined) {
      const kickers = cards.filter((rank) => rank !== trio)
      if (length === 4) add('trio_solo', trio, repeat(trio, 3), kickers)
      else if (ranksByCount(2).length === 1) add('trio_pair', trio, repeat(trio, 3), kickers)
    }
  }

  // Straights.
  if (length >= 5 && chainOf(1)) add('straight', highest, cards)
  if (length % 2 === 0 && length / 2 >= rules.minPairStraight && chainOf(2)) add('pair_straight', highest, cards)
  if (length % 3 === 0 && length / 3 >= 2 && rules.bareTrio && chainOf(3)) add('trio_straight', highest, cards)

  // Planes: k consecutive trios and k solo or k pair wings. A rank of the body must come exactly 3 times: a fourth
  // card of it would be a kicker of the body's rank. Bodies are tried highest first.
  const planes = (k: number, type: 'plane_solo' | 'plane_pair'): void => {
    for (let top = ACE; top - k + 1 >= MIN_RANK; top--) {
      const bodyRanks = Array.from({ length: k }, (_, i) => top - k + 1 + i)
      if (!bodyRanks.every((rank) => counts.get(rank) === 3)) continue
      const kickers = new Map(counts)
      for (const rank of bodyRanks) kickers.delete(rank)
      const ok = type === 'plane_solo' ? soloKickersAllowed(kickers, rules) : pairKickersAllowed(kickers, k)
      if (ok) add(type, top, bodyRanks.flatMap((rank) => repeat(rank, 3)), expand(kickers))
    }
  }
  if (length % 4 === 0 && length / 4 >= 2) planes(length / 4, 'plane_solo')
  if (length % 5 === 0 && length / 5 >= 2) planes(length / 5, 'plane_pair')

  // Four with two, and the bomb.
  const [four] = ranksByCount(4)
  if (four !== undefined) {
    const kickers = new Map(counts)
    kickers.delete(four)
    const kickerCards = expand(kickers)
    if (rules.fourWithTwo && length === 6 && soloKickersAllowed(kickers, rules)) {
      add('four_two_solo', four, repeat(four, 4), kickerCards)
    }
    if (rules.fourWithTwo && length === 8 && pairKickersAllowed(kickers, 2)) {
      add('four_two_pair', four, repeat(four, 4), kickerCards)
    }
    if (length === 4) add('bomb', four, cards)
  }

  if (length === 2 && counts.has(BLACK_JOKER) && counts.has(RED_JOKER)) add('rocket', RED_JOKER, cards)

  // The readings were added in type order already; the sort keeps it so if the code above is ever reordered.
  return found
    .map((reading, i) => ({ reading, i }))
    .sort((a, b) => TYPE_ORDER.get(a.reading.type)! - TYPE_ORDER.get(b.reading.type)! || a.i - b.i)
    .map(({ reading }) => reading)
}
