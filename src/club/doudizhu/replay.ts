import type { Card, RankName } from './cards.js'
import type { MoveType } from './classify.js'
import { type Auto, bid, type GameEvent, type GameState, newGame, pass, play, type StepResult } from './game.js'
import type { Rules } from './rules.js'

// Replaying a game from its record: the decks dealt, in order, and every step taken. The steps are the table's
// history steps (or anything with the same fields), so a game record can be fed back as it was kept.

/**
 * One recorded step: a bid, a play (its move type and cards) or a pass, by a seat. `turn`, when there, is checked
 * against the game's.
 */
export type RecordedStep =
  | {
      readonly turn?: number
      readonly seat: number
      readonly action: 'bid'
      readonly bid: number
      readonly auto?: Auto
    }
  | {
      readonly turn?: number
      readonly seat: number
      readonly action: 'play'
      readonly move: { readonly type: MoveType; readonly cards: readonly RankName[] }
      readonly auto?: Auto
    }
  | { readonly turn?: number; readonly seat: number; readonly action: 'pass'; readonly auto?: Auto }

/**
 * Plays a game again from its record and gives the state it ends in and every event on the way. `decks` are the decks
 * dealt, in order, as `GameState.decks` keeps them. Throws when a step is not the seat's to make, has another `turn`
 * than the game's, or is refused: the record does not belong to these decks.
 */
export function replay(
  rules: Rules,
  firstBidder: number,
  decks: readonly (readonly Card[])[],
  steps: readonly RecordedStep[],
): { state: GameState; events: GameEvent[] } {
  const start = newGame({ rules, firstBidder, decks })
  let state = start.state
  const events = [...start.events]
  steps.forEach((step, i) => {
    if (step.turn !== undefined && step.turn !== state.turn) {
      throw new Error(`step ${i + 1} of the record has turn ${step.turn}, but the game is at turn ${state.turn}`)
    }
    const auto = step.auto ?? null
    let result: StepResult
    if (step.action === 'bid') result = bid(state, step.seat, step.bid, auto)
    else if (step.action === 'pass') result = pass(state, step.seat, auto)
    else result = play(state, step.seat, { cards: step.move.cards, as: step.move.type }, auto)
    if (!result.ok) throw new Error(`step ${i + 1} of the record was refused: ${result.error.reason}`)
    state = result.state
    events.push(...result.events)
  })
  return { state, events }
}
