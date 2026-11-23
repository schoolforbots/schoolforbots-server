import { BLACK_JOKER, type Card, RED_JOKER, toRank, TWO } from './cards.js'
import { classify, type Interpretation } from './classify.js'
import { type Auto, bid, type GameState, pass, play, type StepResult } from './game.js'
import { legalMoves } from './moves.js'
import { checkBid } from './validate.js'

// The trustee (3.8): the steps the server makes for a seat that timed out, is in trusteeship, is a bot, or plays on as
// the club closes. It is simple and fixed, the same for everyone, and always makes the same step in the same position.
// It never bids, never uses a bomb or the rocket to beat a move, and never beats its partner. A practice bot plays as
// the trustee does, but bids by the strength of its hand (`handBid`), the same way for the same cards: a seat in
// trusteeship, timed out or played out at closing is a student's, and the trustee takes no stakes for it.

export type TrusteeStep =
  | { readonly bid: number }
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
 * lowest kickers), never a bomb or the rocket, or a pass when there is none. A set of cards counts only as its
 * strongest reading of a type, as in the move list. Throws when `seat` is not to act.
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

const ACE = 14

/**
 * A practice bot's bid for a hand: points for its high cards (the red joker 4, the black joker 3, each 2 2, each A 1)
 * and 4 for each bomb (four of a rank); 7 points or more bid 1, 9 or more 2, 12 or more 3. A bid that is not above
 * the bids before it is no bid (0). The order of the cards does not matter.
 */
export function handBid(hand: readonly Card[], bidsSoFar: readonly number[]): number {
  const counts = new Map<number, number>()
  for (const card of hand) counts.set(card.rank, (counts.get(card.rank) ?? 0) + 1)
  let points = 0
  for (const [rank, count] of counts) {
    if (rank === RED_JOKER) points += 4
    else if (rank === BLACK_JOKER) points += 3
    else if (rank === TWO) points += 2 * count
    else if (rank === ACE) points += count
    if (count === 4) points += 4
  }
  const wanted = points >= 12 ? 3 : points >= 9 ? 2 : points >= 7 ? 1 : 0
  return checkBid(wanted, bidsSoFar) === null ? wanted : 0
}

/** A practice bot's step for the seat to act: a bid by its hand (`handBid`), else the trustee's step. */
export function botAction(state: GameState, seat: number): TrusteeStep {
  if (state.toAct !== seat) throw new Error(`seat ${seat} is not to act`)
  if (state.phase !== 'bidding') return trusteeAction(state, seat)
  return { bid: handBid(state.hands[seat]!, state.bids.map((b) => b.bid)) }
}

/**
 * Makes the trustee's step for the seat to act, marked with `auto` (`timeout`, `trustee`, `bot` or `closing`); a bot's
 * (`bot`) is `botAction`'s. The step always goes.
 */
export function actFor(state: GameState, auto: Exclude<Auto, null>): StepResult & { ok: true } {
  const seat = state.toAct
  if (seat === null) throw new Error('nobody is to act: the game is over')
  const step = auto === 'bot' ? botAction(state, seat) : trusteeAction(state, seat)
  let result: StepResult
  if ('bid' in step) result = bid(state, seat, step.bid, auto)
  else if ('pass' in step) result = pass(state, seat, auto)
  else result = play(state, seat, { cards: step.play.cards.map(toRank), as: step.play.type }, auto)
  if (!result.ok) throw new Error(`the trustee's step was refused: ${result.error.reason}`)
  return result
}
