import type { Static } from 'typebox'
import type { IllegalMoveError } from '../../protocol/club.js'
import { type Card, rankValue, type RankName, takeRanks, toRank } from './cards.js'
import { classify, type ClassifyRules, type Interpretation, type MoveType } from './classify.js'
import { beats } from './compare.js'
import { toMove } from './moves.js'
import {
  bidTooLowReason,
  cannotBeatReason,
  mustPlayReason,
  notATypeReason,
  notInHandReason,
  typeMismatchReason,
  unknownMoveReason,
} from './reasons.js'

// Checking a bid or a play against the rules. Whose turn it is and whether the `turn` matches are checked before the
// engine is called; here only the rules are. A refused step gives the parts of the protocol's `IllegalMoveError` the
// engine knows: `problem`, `reason`, and `missing` or `toBeat`.

type IllegalMoveFields = Static<typeof IllegalMoveError>

/** A bid or play against the rules: the engine's part of `IllegalMoveError`. */
export type IllegalMove = Pick<IllegalMoveFields, 'problem' | 'reason' | 'missing' | 'toBeat'>

/** The highest bid. */
const MAX_BID = 3

/**
 * Checks a bid against the bids made so far in this deal: 0 (no bid) always goes; 1 to 3 must be above every bid
 * before it. Gives `null` when the bid goes.
 */
export function checkBid(bid: number, bidsSoFar: readonly number[]): IllegalMove | null {
  if (!Number.isInteger(bid) || bid < 0 || bid > MAX_BID) throw new RangeError(`not a bid: ${bid}`)
  if (bid === 0) return null
  const highest = Math.max(0, ...bidsSoFar)
  if (bid > highest) return null
  return { problem: 'bid_too_low', reason: bidTooLowReason(highest) }
}

/** The move to beat and the seat that played it. */
export interface ToBeat {
  readonly seat: number
  readonly move: Interpretation
}

/** What a play is checked against: the seat to act, its hand, the list it was sent, and the move to beat. */
export interface PlayContext {
  /** The seat to act, 0 to 2. */
  readonly seat: number
  /** The seat's hand. */
  readonly hand: readonly Card[]
  /** The moves of this `your_turn`, in list order: the move with `id` n is `moves[n - 1]`. */
  readonly moves: readonly Interpretation[]
  /** The move to beat, or `null` when the seat leads the trick. */
  readonly toBeat: ToBeat | null
  readonly rules: ClassifyRules
}

/** A play as the protocol has it: the id of a listed move, or the cards with an optional move type. */
export type PlayInput = { readonly moveId: number } | { readonly cards: readonly RankName[]; readonly as?: MoveType }

export type PlayCheck =
  /** The play goes: the move, the cards it takes from the hand (low to high) and the hand left. */
  | { readonly ok: true; readonly move: Interpretation; readonly taken: Card[]; readonly rest: Card[] }
  | { readonly ok: false; readonly error: IllegalMove }

const refuse = (error: IllegalMove): PlayCheck => ({ ok: false, error })

function assertContext(context: Pick<PlayContext, 'seat' | 'toBeat'>): void {
  if (!Number.isInteger(context.seat) || context.seat < 0 || context.seat > 2) {
    throw new RangeError(`not a seat: ${context.seat}`)
  }
  if (context.toBeat !== null && context.toBeat.seat === context.seat) {
    throw new Error(`seat ${context.seat} cannot follow its own move: it leads the trick`)
  }
}

/**
 * Checks a play. The first rule it breaks is the `problem`, in this order: `unknown_move` (no such id in the list),
 * `not_in_hand` (with `missing`), `not_a_type`, `type_mismatch` (with `as`), `cannot_beat` (with `toBeat`). Cards given
 * without `as` are played as their first reading, in the protocol's order of types; when that does not beat but a
 * reading of another type would, the reason says to add `as`. Cards given with `as` are played as the strongest
 * reading of that type. Throws when the context is not one where the seat may play.
 */
export function checkPlay(context: PlayContext, input: PlayInput): PlayCheck {
  assertContext(context)
  const { seat, hand, toBeat, rules } = context

  if ('moveId' in input) {
    const move = Number.isInteger(input.moveId) ? context.moves[input.moveId - 1] : undefined
    if (move === undefined) return refuse({ problem: 'unknown_move', reason: unknownMoveReason(input.moveId) })
    const taken = takeRanks(hand, move.cards)
    if (!taken.ok) throw new Error(`move ${input.moveId} of the list is not in the hand`)
    if (toBeat !== null && !beats(move, toBeat.move)) throw new Error(`move ${input.moveId} of the list does not beat`)
    return { ok: true, move, taken: taken.taken, rest: taken.rest }
  }

  const ranks = input.cards.map(rankValue)
  const taken = takeRanks(hand, ranks)
  if (!taken.ok) {
    return refuse({ problem: 'not_in_hand', reason: notInHandReason(taken.missing), missing: taken.missing.map(toRank) })
  }

  const readings = classify(ranks, rules)
  if (readings.length === 0) return refuse({ problem: 'not_a_type', reason: notATypeReason(ranks, rules) })

  let move: Interpretation
  if (input.as !== undefined) {
    const as = input.as
    const reading = readings.find((r) => r.type === as)
    if (reading === undefined) {
      return refuse({ problem: 'type_mismatch', reason: typeMismatchReason(ranks, as, readings) })
    }
    move = reading
  } else {
    move = readings[0]!
  }

  if (toBeat !== null && !beats(move, toBeat.move)) {
    // Without `as`, suggest the first reading of another type that would beat.
    const other = input.as === undefined ? readings.find((r) => r.type !== move.type && beats(r, toBeat.move)) : undefined
    return refuse({
      problem: 'cannot_beat',
      reason: cannotBeatReason(seat, toBeat.seat, toBeat.move, other?.type),
      toBeat: { seat: toBeat.seat, move: toMove(toBeat.move) },
    })
  }
  return { ok: true, move, taken: taken.taken, rest: taken.rest }
}

/** Checks a pass: refused with `must_play` when the seat leads the trick, otherwise `null`. */
export function checkPass(context: Pick<PlayContext, 'seat' | 'toBeat'>): IllegalMove | null {
  assertContext(context)
  if (context.toBeat === null) return { problem: 'must_play', reason: mustPlayReason() }
  return null
}
