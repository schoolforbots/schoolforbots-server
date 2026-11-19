import { describe, expect, test } from 'vitest'
import { type Card, FULL_DECK, type RankName, ranksOf } from '../../../src/club/doudizhu/cards.js'
import { shuffle } from '../../../src/club/doudizhu/deal.js'
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
import { DEFAULT_DOUDIZHU_RULES } from '../../../src/club/doudizhu/rules.js'
import { deckOf, seededRandomInt } from './helpers.js'

const rules = DEFAULT_DOUDIZHU_RULES

const deckFrom = (seed: number): Card[] => shuffle(FULL_DECK, seededRandomInt(seed))
const decksFrom = (seed: number, n = 3): Card[][] => Array.from({ length: n }, (_, i) => deckFrom(seed * 10 + i))

/** The state and events of a step that must go. */
function ok(result: StepResult): { state: GameState; events: GameEvent[] } {
  if (!result.ok) throw new Error(`refused: ${result.error.reason}`)
  return result
}

const cards = (text: string) => ({ cards: text.split(' ') as RankName[] })

/** Every card of the game is somewhere: in a hand, in the bottom before the landlord takes it, or played. */
function assertConserved(state: GameState): void {
  const played = state.history.flatMap((step) => (step.action === 'play' ? step.move.cards : []))
  const held = state.hands.flat().length + (state.landlord === null ? state.bottom.length : 0)
  expect(held + played.length).toBe(54)
  const keys = new Set(state.hands.flat().map((c) => `${c.rank}${c.suit ?? ''}`))
  expect(keys.size).toBe(state.hands.flat().length)
}

/** The landlord's 20 cards are 3333 4444 5555 6666 小王 大王 7 7; seat 1 and seat 2 each hold two bombs. */
const BOMBS_DECK = deckOf(
  '3 3 3 3 4 4 4 4 5 5 5 5 6 6 6 6 小王',
  '7 8 8 8 8 9 9 9 9 Q Q Q Q K K K K',
  '7 10 10 10 10 J J J J A A A A 2 2 2 2',
  '7 7 大王',
)

describe('newGame', () => {
  test('deals 17 cards to each seat and 3 to the bottom, and asks the first bidder', () => {
    const { state, events } = newGame({ rules, firstBidder: 2, decks: decksFrom(1) })
    expect(state.hands.map((h) => h.length)).toEqual([17, 17, 17])
    expect(state.bottom).toHaveLength(3)
    expect(state.phase).toBe('bidding')
    expect(state.toAct).toBe(2)
    expect(state.turn).toBe(1)
    expect(state.decks).toHaveLength(1)
    expect(state.spareDecks).toHaveLength(2)
    expect(events).toEqual([{ kind: 'dealt', gameId: 0, firstBidder: 2 }])
    assertConserved(state)
  })

  test('shuffles bidRedealLimit decks with the random source given', () => {
    const a = newGame({ rules, firstBidder: 0, random: seededRandomInt(5) }).state
    const b = newGame({ rules, firstBidder: 0, random: seededRandomInt(5) }).state
    expect(a.decks.length + a.spareDecks.length).toBe(rules.bidRedealLimit)
    expect(a).toEqual(b)
    const c = newGame({ rules, firstBidder: 0 }).state
    expect(c.decks.length + c.spareDecks.length).toBe(rules.bidRedealLimit)
  })

  test('refuses a deck that is not the 54 cards', () => {
    expect(() => newGame({ rules, firstBidder: 0, decks: [FULL_DECK.slice(1)] })).toThrow()
    const twice = [...FULL_DECK.slice(1), FULL_DECK[0]!, FULL_DECK[0]!].slice(1)
    expect(() => newGame({ rules, firstBidder: 0, decks: [twice] })).toThrow()
    expect(() => newGame({ rules, firstBidder: 3, decks: [FULL_DECK] })).toThrow()
  })
})

describe('bidding', () => {
  test('a bid of 3 ends it at once: the landlord takes the bottom cards and leads', () => {
    const start = newGame({ rules, firstBidder: 1, decks: decksFrom(2) }).state
    const { state, events } = ok(bid(start, 1, 3))
    expect(events).toEqual([
      { kind: 'bid', turn: 1, seat: 1, bid: 3, auto: null },
      { kind: 'landlord', seat: 1, base: 3, bottom: ranksOf(start.bottom) },
    ])
    expect(state.phase).toBe('playing')
    expect(state.landlord).toBe(1)
    expect(state.base).toBe(3)
    expect(state.toAct).toBe(1)
    expect(state.hands[1]).toHaveLength(20)
    expect(state.hands[1]).toEqual(expect.arrayContaining([...start.bottom]))
    expect(state.trick).toEqual({ leader: 1, last: null, passes: 0 })
    expect(state.turn).toBe(2)
    assertConserved(state)
  })

  test('the highest bid wins once every seat has bid', () => {
    let state = newGame({ rules, firstBidder: 2, decks: decksFrom(3) }).state
    state = ok(bid(state, 2, 1)).state
    state = ok(bid(state, 0, 2)).state
    const last = ok(bid(state, 1, 0))
    expect(last.state.landlord).toBe(0)
    expect(last.state.base).toBe(2)
    expect(last.state.toAct).toBe(0)
    expect(last.events.map((e) => e.kind)).toEqual(['bid', 'landlord'])
    expect(last.state.bids).toEqual([
      { seat: 2, bid: 1 },
      { seat: 0, bid: 2 },
      { seat: 1, bid: 0 },
    ])
    expect(last.state.history.map((s) => s.turn)).toEqual([1, 2, 3])
  })

  test('a single bid of 1 wins when the others do not bid', () => {
    let state = newGame({ rules, firstBidder: 0, decks: decksFrom(4) }).state
    state = ok(bid(state, 0, 0)).state
    state = ok(bid(state, 1, 1)).state
    const last = ok(bid(state, 2, 0))
    expect(last.state.landlord).toBe(1)
    expect(last.state.base).toBe(1)
  })

  test('a bid not above the bids before it is refused, and the state stays as it was', () => {
    let state = newGame({ rules, firstBidder: 0, decks: decksFrom(5) }).state
    state = ok(bid(state, 0, 2)).state
    const result = bid(state, 1, 1)
    expect(result).toEqual({
      ok: false,
      error: { problem: 'bid_too_low', reason: '前面已经有人叫了 2 分，你只能叫 3 分，或者叫 0 分（不叫）。' },
    })
    expect(ok(bid(state, 1, 3)).state.landlord).toBe(1)
  })

  test('throws when the seat is not to bid', () => {
    const state = newGame({ rules, firstBidder: 0, decks: decksFrom(6) }).state
    expect(() => bid(state, 1, 0)).toThrow()
    expect(() => play(state, 0, cards('3'))).toThrow()
    expect(() => pass(state, 0)).toThrow()
  })

  test('when nobody bids, deals the next deck with the next seat first, and turn goes on', () => {
    const decks = decksFrom(7)
    let state = newGame({ rules, firstBidder: 2, decks }).state
    state = ok(bid(state, 2, 0)).state
    state = ok(bid(state, 0, 0)).state
    const { state: redealt, events } = ok(bid(state, 1, 0))
    expect(events).toEqual([
      { kind: 'bid', turn: 3, seat: 1, bid: 0, auto: null },
      { kind: 'redeal', count: 1 },
      { kind: 'dealt', gameId: 0, firstBidder: 0 },
    ])
    expect(redealt.phase).toBe('bidding')
    expect(redealt.firstBidder).toBe(0)
    expect(redealt.toAct).toBe(0)
    expect(redealt.turn).toBe(4)
    expect(redealt.bids).toEqual([])
    expect(redealt.history).toEqual([])
    expect(redealt.decks).toEqual([decks[0], decks[1]])
    expect(redealt.spareDecks).toEqual([decks[2]])
    expect(redealt.hands[0]).not.toEqual(state.hands[0])
    assertConserved(redealt)

    // The next deal's steps go on from turn 4.
    const after = ok(bid(redealt, 0, 1))
    expect(after.events).toEqual([{ kind: 'bid', turn: 4, seat: 0, bid: 1, auto: null }])
    expect(after.state.history).toEqual([{ turn: 4, seat: 0, action: 'bid', bid: 1, auto: null }])
  })

  test('after bidRedealLimit deals with no bid the game is over with no landlord', () => {
    let state = newGame({ rules, firstBidder: 0, decks: decksFrom(8) }).state
    const kinds: string[] = []
    for (let i = 0; i < 9; i++) {
      const result = ok(bid(state, state.toAct!, 0))
      kinds.push(...result.events.map((e) => (e.kind === 'redeal' ? `redeal ${e.count}` : e.kind)))
      state = result.state
    }
    expect(kinds.filter((k) => k !== 'bid')).toEqual(['redeal 1', 'dealt', 'redeal 2', 'dealt', 'over'])
    expect(state.phase).toBe('over')
    expect(state.toAct).toBeNull()
    expect(state.turn).toBe(10)
    expect(state.outcome).toEqual({
      outcome: 'no_landlord',
      landlord: null,
      base: null,
      doublings: [],
      multiplier: 1,
      capped: false,
      scores: [0, 0, 0],
      hands: state.hands.map(ranksOf),
      bottom: ranksOf(state.bottom),
    })
    expect(() => bid(state, 0, 0)).toThrow()
  })

  test('a limit of 1 ends the game on the first deal nobody bids on', () => {
    let state = newGame({ rules: { ...rules, bidRedealLimit: 1 }, firstBidder: 1 }).state
    expect(state.spareDecks).toHaveLength(0)
    state = ok(bid(state, 1, 0)).state
    state = ok(bid(state, 2, 0)).state
    const last = ok(bid(state, 0, 0))
    expect(last.events.map((e) => e.kind)).toEqual(['bid', 'over'])
  })
})

describe('play', () => {
  /** Seat 0 is the landlord of the bombs deck. */
  const landlordGame = (r = rules) => ok(bid(newGame({ rules: r, firstBidder: 0, decks: [BOMBS_DECK] }).state, 0, 3)).state

  test('the leader may not pass; after two passes the last player leads again', () => {
    let state = landlordGame()
    expect(pass(state, 0)).toEqual({
      ok: false,
      error: { problem: 'must_play', reason: '这一轮由你先出，不能不要，请出任意一手合法的牌。' },
    })
    state = ok(play(state, 0, cards('7 7'))).state
    expect(state.toAct).toBe(1)
    expect(state.trick).toMatchObject({ leader: 0, last: { seat: 0 }, passes: 0 })
    state = ok(pass(state, 1)).state
    expect(state.toAct).toBe(2)
    const { state: after, events } = ok(pass(state, 2))
    expect(events).toEqual([{ kind: 'pass', turn: 4, seat: 2, auto: null }])
    expect(after.toAct).toBe(0)
    expect(after.trick).toEqual({ leader: 0, last: null, passes: 0 })
    expect(after.history.map((s) => s.action)).toEqual(['bid', 'play', 'pass', 'pass'])
  })

  test('a pass between two plays starts the count again', () => {
    let state = landlordGame()
    state = ok(play(state, 0, cards('7 7'))).state
    state = ok(pass(state, 1)).state
    state = ok(play(state, 2, cards('A A'))).state
    state = ok(pass(state, 0)).state
    expect(state.toAct).toBe(1)
    expect(state.trick).toMatchObject({ leader: 0, last: { seat: 2 }, passes: 1 })
    state = ok(pass(state, 1)).state
    expect(state.toAct).toBe(2)
    expect(state.trick).toEqual({ leader: 2, last: null, passes: 0 })
  })

  test('refuses a play against the rules and leaves the state as it was', () => {
    let state = landlordGame()
    state = ok(play(state, 0, cards('7 7'))).state
    const result = play(state, 1, cards('7'))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.problem).toBe('cannot_beat')
    expect(play(state, 1, { moveId: 999 })).toMatchObject({ ok: false, error: { problem: 'unknown_move' } })
  })

  test('a moveId is looked up in currentMoves, the list your_turn shows', () => {
    let state = landlordGame()
    state = ok(play(state, 0, cards('7 7'))).state
    const list = currentMoves(state)
    const queens = list.moves.findIndex((m) => m.type === 'pair' && m.main === 12)
    const { state: after, events } = ok(play(state, 1, { moveId: queens + 1 }))
    expect(events[0]).toMatchObject({ kind: 'play', seat: 1, move: { type: 'pair', cards: ['Q', 'Q'] }, cardsLeft: 15 })
    expect(after.hands[1]).toHaveLength(15)
  })

  test('the old state is never changed', () => {
    const state = landlordGame()
    const copy = structuredClone(state)
    ok(play(state, 0, cards('3 3 3 3')))
    expect(state).toEqual(copy)
  })

  test('each bomb and the rocket double the multiplier, and the cap cuts it', () => {
    let state = landlordGame()
    const multipliers: number[] = []
    const go = (result: StepResult) => {
      const step = ok(result)
      for (const e of step.events) if (e.kind === 'play') multipliers.push(e.multiplier)
      state = step.state
      return step
    }
    go(play(state, 0, cards('3 3 3 3')))
    go(play(state, 1, cards('8 8 8 8')))
    go(play(state, 2, cards('10 10 10 10')))
    go(play(state, 0, cards('小王 大王')))
    go(pass(state, 1))
    go(pass(state, 2))
    for (const bomb of ['4 4 4 4', '5 5 5 5', '6 6 6 6']) {
      go(play(state, 0, cards(bomb)))
      go(pass(state, 1))
      go(pass(state, 2))
    }
    const last = go(play(state, 0, cards('7 7')))
    expect(multipliers).toEqual([2, 4, 8, 16, 32, 64, 128, 128])
    expect(last.events.at(-1)).toEqual({
      kind: 'over',
      result: {
        outcome: 'landlord_won',
        landlord: 0,
        base: 3,
        doublings: [
          { kind: 'bomb', seat: 0 },
          { kind: 'bomb', seat: 1 },
          { kind: 'bomb', seat: 2 },
          { kind: 'rocket', seat: 0 },
          { kind: 'bomb', seat: 0 },
          { kind: 'bomb', seat: 0 },
          { kind: 'bomb', seat: 0 },
        ],
        multiplier: 64,
        capped: true,
        scores: [384, -192, -192],
        hands: [
          [],
          ['7', '9', '9', '9', '9', 'Q', 'Q', 'Q', 'Q', 'K', 'K', 'K', 'K'],
          ['7', 'J', 'J', 'J', 'J', 'A', 'A', 'A', 'A', '2', '2', '2', '2'],
        ],
        bottom: ['7', '7', '大王'],
      },
    })
    expect(state.phase).toBe('over')
    expect(state.toAct).toBeNull()
    expect(state.trick).toBeNull()
    expect(last.events.at(-1)).toEqual({ kind: 'over', result: state.outcome })
  })

  test('a higher cap leaves the multiplier as it is', () => {
    let state = landlordGame({ ...rules, cap: 256 })
    const steps: [number, string | null][] = [
      [0, '3 3 3 3'], [1, '8 8 8 8'], [2, '10 10 10 10'], [0, '小王 大王'], [1, null], [2, null],
      [0, '4 4 4 4'], [1, null], [2, null], [0, '5 5 5 5'], [1, null], [2, null], [0, '6 6 6 6'], [1, null], [2, null],
      [0, '7 7'],
    ]
    let events: GameEvent[] = []
    for (const [seat, text] of steps) {
      const step = ok(text === null ? pass(state, seat) : play(state, seat, cards(text)))
      state = step.state
      events = step.events
    }
    expect(events.at(-1)).toMatchObject({
      kind: 'over',
      result: { multiplier: 128, capped: false, scores: [768, -384, -384] },
    })
  })
})

/** Plays the steps in order, each `[seat, cards]` or `[seat, null]` for a pass, checking every card stays put. */
function playOut(state: GameState, moves: [number, string | null][]): { state: GameState; events: GameEvent[] } {
  let events: GameEvent[] = []
  for (const [seat, text] of moves) {
    const step = ok(text === null ? pass(state, seat) : play(state, seat, cards(text)))
    state = step.state
    events = [...events, ...step.events]
    assertConserved(state)
  }
  return { state, events }
}

describe('the end of a game', () => {
  /** Seat 0 bids `base` and the others do not bid. */
  const landlordSeat0 = (r: typeof rules, base: number): GameState => {
    let state = ok(bid(newGame({ rules: r, firstBidder: 0, decks: [deck] }).state, 0, base)).state
    if (base < 3) state = ok(bid(ok(bid(state, 1, 0)).state, 2, 0)).state
    return state
  }

  // Seat 0 leads small cards; seat 1 has the big ones.
  const deck = deckOf(
    '3 3 4 4 5 5 6 6 7 7 8 8 9 9 10 10 J',
    'Q Q Q K K K A A A 2 2 2 小王 大王 J J 3',
    '4 5 6 7 8 9 10 Q K A 2 J 3 4 5 6 7',
    '8 9 10',
  )

  test('the landlord wins a spring when neither farmer played', () => {
    const start = landlordSeat0(rules, 1)
    // Landlord: 3 3 4 4 5 5 6 6 7 7 8 8 9 9 10 10 J + 8 9 10.
    const { state, events } = playOut(start, [
      [0, '3 3 4 4 5 5 6 6 7 7'], [1, null], [2, null],
      [0, '8 8 8 9 9 9 10 10 10'], [1, null], [2, null],
      [0, 'J'],
    ])
    expect(state.outcome).toMatchObject({
      outcome: 'landlord_won',
      doublings: [{ kind: 'spring', seat: null }],
      multiplier: 2,
      capped: false,
      scores: [4, -2, -2],
    })
    expect(events.at(-1)?.kind).toBe('over')
  })

  test('a spring does not double when springDoubles is off', () => {
    const r = { ...rules, springDoubles: false }
    const start = landlordSeat0(r, 1)
    const { state } = playOut(start, [
      [0, '3 3 4 4 5 5 6 6 7 7'], [1, null], [2, null],
      [0, '8 8 8 9 9 9 10 10 10'], [1, null], [2, null],
      [0, 'J'],
    ])
    expect(state.outcome).toMatchObject({ outcome: 'landlord_won', doublings: [], multiplier: 1, scores: [2, -1, -1] })
  })

  test('the landlord wins without a spring once a farmer has played', () => {
    const start = landlordSeat0(rules, 2)
    const { state } = playOut(start, [
      [0, 'J'], [1, '2'], [2, null], [0, null],
      [1, '3'], [2, '4'], [0, '10'], [1, null], [2, null],
      [0, '3 3 4 4 5 5 6 6 7 7'], [1, null], [2, null],
      [0, '8 8 8 9 9 9 10 10'],
    ])
    expect(state.outcome).toMatchObject({ outcome: 'landlord_won', doublings: [], multiplier: 1, scores: [4, -2, -2] })
  })

  test('the farmers win an anti-spring when the landlord played only once', () => {
    const start = landlordSeat0(rules, 3)
    // Seat 1: Q Q Q K K K A A A 2 2 2 小王 大王 J J 3.
    const { state } = playOut(start, [
      [0, '3'], [1, '小王'], [2, null], [0, null],
      [1, 'Q Q Q K K K A A A J J 3'], [2, null], [0, null],
      [1, '2 2 2 大王'],
    ])
    expect(state.outcome).toMatchObject({
      outcome: 'farmers_won',
      landlord: 0,
      base: 3,
      doublings: [{ kind: 'anti_spring', seat: null }],
      multiplier: 2,
      scores: [-12, 6, 6],
    })
  })

  test('the farmers win without an anti-spring when the landlord played twice', () => {
    const start = landlordSeat0(rules, 1)
    const { state } = playOut(start, [
      [0, '3'], [1, null], [2, '4'], [0, '5'],
      [1, '小王'], [2, null], [0, null],
      [1, 'Q Q Q K K K A A A J J 3'], [2, null], [0, null],
      [1, '2 2 2 大王'],
    ])
    expect(state.outcome).toMatchObject({ outcome: 'farmers_won', doublings: [], multiplier: 1, scores: [-2, 1, 1] })
    expect(state.outcome!.scores.reduce((a, b) => a + b, 0)).toBe(0)
  })
})
