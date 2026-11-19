import { MOVE_TYPE_NAMES, type Move as MoveSchema } from '../../protocol/club.js'
import type { Static } from 'typebox'
import { BLACK_JOKER, type Card, MAX_RANK, MIN_RANK, RED_JOKER, toRank } from './cards.js'
import { type ClassifyRules, type Interpretation, MOVE_TYPES, type MoveType } from './classify.js'
import { beats } from './compare.js'

// The legal moves of a hand: every move it can lead, or every move that beats the move to beat. The moves are built
// from the counts of each rank, never by trying every subset of the cards, so a 20-card hand takes a few milliseconds.

/** A list longer than this is trimmed to one choice of kickers per move body. */
export const MOVES_LIMIT = 300

/** The highest rank a chain (straight, pair straight, trio straight, plane) may reach: the ace. */
const ACE = 14

/** The most cards one move can have. */
const MAX_LENGTH = 20

export interface LegalMoves {
  /** The moves in list order; the `id` of a move in `your_turn` is its index plus 1. */
  readonly moves: Interpretation[]
  /** Whether the list was trimmed to one choice of kickers for each type and body. */
  readonly trimmed: boolean
}

/** What a move to beat needs: what `beats` looks at. */
export type MoveToBeat = Pick<Interpretation, 'type' | 'main' | 'length'>

const TYPE_ORDER: ReadonlyMap<MoveType, number> = new Map(MOVE_TYPES.map((type, i) => [type, i]))

/** Compares two lists of ranks card by card, low to high; a shorter list that is a prefix comes first. */
function compareRanks(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const d = a[i]! - b[i]!
    if (d !== 0) return d
  }
  return a.length - b.length
}

/**
 * The list order: by type (the protocol's order, so bombs and the rocket come last), then by number of cards, then by
 * main rank, then by kickers compared card by card from the lowest.
 */
export function compareMoves(a: Interpretation, b: Interpretation): number {
  return (
    TYPE_ORDER.get(a.type)! - TYPE_ORDER.get(b.type)! ||
    a.length - b.length ||
    a.main - b.main ||
    compareRanks(a.kickers, b.kickers)
  )
}

/** The protocol's `Move` for a move: its type, the Chinese name of the type and its cards as ranks, low to high. */
export function toMove(move: Pick<Interpretation, 'type' | 'cards'>): Static<typeof MoveSchema> {
  return { type: move.type, name: MOVE_TYPE_NAMES[move.type], cards: [...move.cards].sort((a, b) => a - b).map(toRank) }
}

const repeat = (rank: number, times: number): number[] => new Array<number>(times).fill(rank)

/**
 * Every multiset of `size` kickers from `pool` (a count per rank), at most `maxPer` of a rank, low to high. `skip`
 * rejects a finished choice.
 */
function kickerChoices(
  pool: readonly number[],
  size: number,
  maxPer: number,
  skip: (kickers: readonly number[]) => boolean,
): number[][] {
  const out: number[][] = []
  const chosen: number[] = []
  const walk = (rank: number, left: number): void => {
    if (left === 0) {
      if (!skip(chosen)) out.push([...chosen])
      return
    }
    if (rank > MAX_RANK) return
    const most = Math.min(pool[rank] ?? 0, maxPer, left)
    for (let n = most; n >= 0; n--) {
      for (let i = 0; i < n; i++) chosen.push(rank)
      walk(rank + 1, left - n)
      for (let i = 0; i < n; i++) chosen.pop()
    }
  }
  walk(MIN_RANK, size)
  return out
}

/**
 * Every move the counts can make, of the `wanted` types (all when `null`). The same cards played as the same type come
 * once, with the highest main rank: `333444555666` as a plane with solo wings is the plane on `444555666`.
 */
function enumerate(
  counts: readonly number[],
  rules: ClassifyRules,
  wanted: ReadonlySet<MoveType> | null,
): Interpretation[] {
  const found = new Map<string, Interpretation>()
  const want = (type: MoveType): boolean => wanted === null || wanted.has(type)
  const add = (type: MoveType, main: number, body: number[], kickers: number[] = []): void => {
    const cards = [...body, ...kickers].sort((a, b) => a - b)
    const key = `${type}:${cards.join(',')}`
    const known = found.get(key)
    if (known !== undefined && known.main >= main) return
    found.set(key, { type, main, length: cards.length, cards, body, kickers })
  }
  const count = (rank: number): number => counts[rank] ?? 0

  /** Solo kickers: no rank of the body, a pair only with `soloKickersMayPair`, both jokers only with the switch. */
  const soloKickers = (exclude: readonly number[], size: number): number[][] => {
    const pool = [...counts]
    for (const rank of exclude) pool[rank] = 0
    const bothJokers = (k: readonly number[]): boolean => k.includes(BLACK_JOKER) && k.includes(RED_JOKER)
    const skip = (k: readonly number[]): boolean => !rules.soloKickersMayBeJokers && bothJokers(k)
    return kickerChoices(pool, size, rules.soloKickersMayPair ? 4 : 1, skip)
  }
  /** Pair kickers: `size` pairs of different ranks, none of the body. Jokers never pair. */
  const pairKickers = (exclude: readonly number[], size: number): number[][] => {
    const pool: number[] = []
    for (let rank = MIN_RANK; rank < BLACK_JOKER; rank++) {
      if (!exclude.includes(rank) && count(rank) >= 2) pool[rank] = 1
    }
    return kickerChoices(pool, size, 1, () => false).map((ranks) => ranks.flatMap((rank) => repeat(rank, 2)))
  }

  for (let rank = MIN_RANK; rank <= MAX_RANK; rank++) {
    const n = count(rank)
    if (n >= 1 && want('single')) add('single', rank, [rank])
    if (n >= 2 && want('pair')) add('pair', rank, repeat(rank, 2))
    if (n >= 3) {
      const trio = repeat(rank, 3)
      if (rules.bareTrio && want('trio')) add('trio', rank, trio)
      if (want('trio_solo')) for (const k of soloKickers([rank], 1)) add('trio_solo', rank, trio, k)
      if (want('trio_pair')) for (const k of pairKickers([rank], 1)) add('trio_pair', rank, trio, k)
    }
    if (n === 4) {
      const four = repeat(rank, 4)
      if (rules.fourWithTwo && want('four_two_solo')) {
        for (const k of soloKickers([rank], 2)) add('four_two_solo', rank, four, k)
      }
      if (rules.fourWithTwo && want('four_two_pair')) {
        for (const k of pairKickers([rank], 2)) add('four_two_pair', rank, four, k)
      }
      if (want('bomb')) add('bomb', rank, four)
    }
  }
  if (count(BLACK_JOKER) >= 1 && count(RED_JOKER) >= 1 && want('rocket')) {
    add('rocket', RED_JOKER, [BLACK_JOKER, RED_JOKER])
  }

  // Chains: every run of ranks from `low` up to `top` (A at most) with at least `per` cards of each.
  const chains = (per: number, minLength: number, each: (low: number, top: number) => void): void => {
    for (let low = MIN_RANK; low <= ACE; low++) {
      for (let top = low; top <= ACE && count(top) >= per; top++) {
        const links = top - low + 1
        if (links >= minLength) each(low, top)
      }
    }
  }
  const run = (low: number, top: number, per: number): number[] => {
    const cards: number[] = []
    for (let rank = low; rank <= top; rank++) cards.push(...repeat(rank, per))
    return cards
  }
  const ranksOf = (low: number, top: number): number[] => Array.from({ length: top - low + 1 }, (_, i) => low + i)

  if (want('straight')) chains(1, 5, (low, top) => add('straight', top, run(low, top, 1)))
  if (want('pair_straight')) {
    chains(2, rules.minPairStraight, (low, top) => {
      if ((top - low + 1) * 2 <= MAX_LENGTH) add('pair_straight', top, run(low, top, 2))
    })
  }
  chains(3, 2, (low, top) => {
    const links = top - low + 1
    const body = run(low, top, 3)
    if (rules.bareTrio && want('trio_straight') && links * 3 <= MAX_LENGTH) add('trio_straight', top, body)
    if (want('plane_solo') && links * 4 <= MAX_LENGTH) {
      for (const k of soloKickers(ranksOf(low, top), links)) add('plane_solo', top, body, k)
    }
    if (want('plane_pair') && links * 5 <= MAX_LENGTH) {
      for (const k of pairKickers(ranksOf(low, top), links)) add('plane_pair', top, body, k)
    }
  })

  return [...found.values()]
}

/**
 * The legal moves of a hand (cards, or their ranks). With no move to beat, every move the hand can lead; otherwise
 * every move that beats `toBeat`: the same type and number of cards with a higher main rank, any bomb that beats it,
 * and the rocket. The same cards played as the same type come once, read with the highest main rank, which is the
 * strongest reading. Moves are sorted by `compareMoves`. A list longer than `limit` is trimmed: of the moves of one type
 * and one body (the same trios of a plane, the same four), only the first is kept, the one with the lowest kickers.
 */
export function legalMoves(
  hand: readonly Card[] | readonly number[],
  toBeat: MoveToBeat | null,
  rules: ClassifyRules,
  limit: number = MOVES_LIMIT,
): LegalMoves {
  const counts = new Array<number>(MAX_RANK + 1).fill(0)
  for (const card of hand) {
    const rank = typeof card === 'number' ? card : card.rank
    if (!Number.isInteger(rank) || rank < MIN_RANK || rank > MAX_RANK) throw new RangeError(`not a rank: ${rank}`)
    counts[rank]!++
  }

  let wanted: Set<MoveType> | null = null
  if (toBeat !== null) {
    if (toBeat.type === 'rocket') return { moves: [], trimmed: false }
    wanted = new Set<MoveType>([toBeat.type, 'bomb', 'rocket'])
  }
  let moves = enumerate(counts, rules, wanted)
  if (toBeat !== null) moves = moves.filter((move) => beats(move, toBeat))
  moves.sort(compareMoves)

  if (moves.length <= limit) return { moves, trimmed: false }
  const bodies = new Set<string>()
  const kept = moves.filter((move) => {
    const key = `${move.type}:${move.body.join(',')}`
    if (bodies.has(key)) return false
    bodies.add(key)
    return true
  })
  return { moves: kept, trimmed: true }
}
