import { describe, expect, test } from 'vitest'
import { FULL_DECK, toRank } from '../../../src/club/doudizhu/cards.js'
import { shuffle, type RandomInt } from '../../../src/club/doudizhu/deal.js'
import {
  bid,
  currentMoves,
  type GameEvent,
  type GameState,
  newGame,
  pass,
  play,
  type StepResult,
} from '../../../src/club/doudizhu/game.js'
import { type RecordedStep, replay } from '../../../src/club/doudizhu/replay.js'
import { DEFAULT_DOUDIZHU_RULES } from '../../../src/club/doudizhu/rules.js'
import { seededRandomInt } from './helpers.js'

const rules = DEFAULT_DOUDIZHU_RULES

/** One random step that goes: a bid of 0 or above the bids so far, or a listed move, or now and then a pass. */
function randomStep(state: GameState, random: RandomInt): StepResult {
  const seat = state.toAct!
  if (state.phase === 'bidding') {
    const highest = Math.max(0, ...state.bids.map((b) => b.bid))
    const choices = [0, ...[1, 2, 3].filter((b) => b > highest)]
    // Mostly no bid, so redeals happen too.
    const value = random(3) === 0 ? choices[random(choices.length)]! : 0
    return bid(state, seat, value)
  }
  const moves = currentMoves(state).moves
  if (state.trick!.last !== null && (moves.length === 0 || random(3) === 0)) return pass(state, seat)
  if (random(2) === 0) return play(state, seat, { moveId: random(moves.length) + 1 })
  const move = moves[random(moves.length)]!
  return play(state, seat, { cards: move.cards.map(toRank), as: move.type })
}

/** A random game played to the end: its first state, last state and every event. */
function randomGame(seed: number): { first: GameState; last: GameState; events: GameEvent[] } {
  const random = seededRandomInt(seed)
  const start = newGame({ rules, firstBidder: random(3), random })
  let state = start.state
  const events = [...start.events]
  while (state.phase !== 'over') {
    const result = randomStep(state, random)
    if (!result.ok) throw new Error(result.error.reason)
    state = result.state
    events.push(...result.events)
  }
  return { first: start.state, last: state, events }
}

/** The steps of a game as its record keeps them, from its events. */
function stepsOf(events: readonly GameEvent[]): RecordedStep[] {
  const steps: RecordedStep[] = []
  for (const e of events) {
    if (e.kind === 'bid') steps.push({ seat: e.seat, action: 'bid', bid: e.bid, auto: e.auto })
    if (e.kind === 'play') steps.push({ seat: e.seat, action: 'play', move: e.move, auto: e.auto })
    if (e.kind === 'pass') steps.push({ seat: e.seat, action: 'pass', auto: e.auto })
  }
  return steps
}

/** A state without the decks shuffled ahead and never dealt: those are not part of the record. */
const dealtPart = ({ spareDecks: _, ...rest }: GameState) => rest

describe('replay', () => {
  test('plays random games again to the same state and the same events', () => {
    let redeals = 0
    for (let seed = 1; seed <= 60; seed++) {
      const { first, last, events } = randomGame(seed)
      redeals += events.filter((e) => e.kind === 'redeal').length
      const again = replay(rules, first.firstBidder, last.decks, stepsOf(events))
      expect(dealtPart(again.state), `seed ${seed}`).toEqual(dealtPart(last))
      expect(again.events, `seed ${seed}`).toEqual(events)
      // Every game adds up to 0.
      expect(last.outcome!.scores.reduce((a, b) => a + b, 0)).toBe(0)
    }
    expect(redeals).toBeGreaterThan(0)
  })

  test('replays the table history of a deal, steps as the protocol has them', () => {
    const { first, last, events } = randomGame(1001)
    const again = replay(rules, first.firstBidder, last.decks, stepsOf(events))
    expect(again.state.history).toEqual(last.history)
  })

  test('checks the turn of each step that has one', () => {
    const { first, last, events } = randomGame(11)
    const withTurns = events.flatMap((e): RecordedStep[] => {
      if (e.kind === 'bid') return [{ turn: e.turn, seat: e.seat, action: 'bid', bid: e.bid, auto: e.auto }]
      if (e.kind === 'play') return [{ turn: e.turn, seat: e.seat, action: 'play', move: e.move, auto: e.auto }]
      if (e.kind === 'pass') return [{ turn: e.turn, seat: e.seat, action: 'pass', auto: e.auto }]
      return []
    })
    const again = replay(rules, first.firstBidder, last.decks, withTurns)
    expect(again.events).toEqual(events)

    const off = withTurns.map((step, i) => (i === 2 ? { ...step, turn: step.turn! + 1 } : step))
    expect(() => replay(rules, first.firstBidder, last.decks, off)).toThrow(
      'step 3 of the record has turn 4, but the game is at turn 3',
    )
  })

  test('throws when the record does not fit the decks', () => {
    const { first, last, events } = randomGame(7)
    const otherDecks = last.decks.map((_, i) => shuffle(FULL_DECK, seededRandomInt(500 + i)))
    expect(() => replay(rules, first.firstBidder, otherDecks, stepsOf(events))).toThrow()
    expect(() => replay(rules, (first.firstBidder + 1) % 3, last.decks, stepsOf(events))).toThrow()
  })
})
