import { type Card, toRank } from './cards.js'
import { classify, type Interpretation } from './classify.js'
import { type Auto, bid, type GameState, pass, play, type StepResult } from './game.js'
import { legalMoves } from './moves.js'

// The trustee (3.8): the steps the server makes for a seat that timed out, is in trusteeship, is a bot, or plays on as
// the club closes. It is simple and fixed, the same for everyone, and always makes the same step in the same position.
// It never bids, never uses a bomb or the rocket to beat a move, and never beats its partner.

export type TrusteeStep =
  | { readonly bid: 0 }
  | { readonly play: Interpretation }
  | { readonly pass: true }

/** The lead: the whole hand if it is one move, else the lowest cards as a single, pair, trio or trio with one. */
function lead(hand: readonly Card[], rules: GameState['rules']): Interpretation {
  const ranks = hand.map((card) => card.rank).sort((a, b) => a - b)
  const whole = classify(ranks, rules)[0]
  if (whole !== undefined) return whole

  const lowest = ranks[0]!
  const count = ranks.filter((rank) => rank === lowest).length
  const as = (cards: number[], type: Interpretation['type']): Interpretation => {
    const reading = classify(cards, rules).find((r) => r.type === type)
    if (reading === undefined) throw new Error(`the trustee made no ${type} of ${cards.join(' ')}`)
    return reading
  }
  if (count === 2) return as([lowest, lowest], 'pair')
  if (count === 3) {
    if (rules.bareTrio) return as([lowest, lowest, lowest], 'trio')
    const kicker = ranks.find((rank) => rank !== lowest)
    if (kicker !== undefined) return as([lowest, lowest, lowest, kicker], 'trio_solo')
  }
  // One card, four (a bomb is not broken up into a lead other than a single), or a trio with nothing to carry.
  return as([lowest], 'single')
}

/**
 * The trustee's step for the seat to act. Bidding: no bid. Leading: the whole hand when it is one move (its first
 * reading), else the lowest rank as a single (one card), a pair (two), a trio (three; with `bareTrio` off a trio with the
 * lowest other card, or a single when there is none) or a single (four). Following: a pass when the move to beat is
 * the other farmer's; else the lowest move of the same type and number of cards that beats it (lowest main rank, then
 * lowest kickers), never a bomb or the rocket, or a pass when there is none. Throws when `seat` is not to act.
 */
export function trusteeAction(state: GameState, seat: number): TrusteeStep {
  if (state.toAct !== seat) throw new Error(`seat ${seat} is not to act`)
  if (state.phase === 'bidding') return { bid: 0 }
  const hand = state.hands[seat]!
  const last = state.trick!.last
  if (last === null) return { play: lead(hand, state.rules) }

  const landlord = state.landlord!
  if (seat !== landlord && last.seat !== landlord) return { pass: true }
  if (last.move.type === 'bomb' || last.move.type === 'rocket') return { pass: true }
  // The untrimmed list is sorted by type, length, main rank and kickers: the first of the same type is the lowest.
  const { moves } = legalMoves(hand, last.move, state.rules, Infinity)
  const beat = moves.find((move) => move.type === last.move.type && move.length === last.move.length)
  return beat === undefined ? { pass: true } : { play: beat }
}

/**
 * Makes the trustee's step for the seat to act, marked with `auto` (`timeout`, `trustee`, `bot` or `closing`). The
 * step always goes.
 */
export function actFor(state: GameState, auto: Exclude<Auto, null>): StepResult & { ok: true } {
  const seat = state.toAct
  if (seat === null) throw new Error('nobody is to act: the game is over')
  const step = trusteeAction(state, seat)
  let result: StepResult
  if ('bid' in step) result = bid(state, seat, step.bid, auto)
  else if ('pass' in step) result = pass(state, seat, auto)
  else result = play(state, seat, { cards: step.play.cards.map(toRank), as: step.play.type }, auto)
  if (!result.ok) throw new Error(`the trustee's step was refused: ${result.error.reason}`)
  return result
}
