import Value from 'typebox/value'
import { describe, expect, test } from 'vitest'
import type { TSchema } from 'typebox'
import { DoudizhuEvent, DoudizhuTable, HandMessage, YourTurnMessage } from '../../../src/protocol/club.js'
import { type RankName, rankValue, ranksOf } from '../../../src/club/doudizhu/cards.js'
import {
  actFor,
  bid,
  DEFAULT_DOUDIZHU_RULES,
  type GameEvent,
  type GameState,
  handOf,
  newGame,
  pass,
  play,
  publicTable,
  type StepResult,
  turnView,
  type TurnView,
} from '../../../src/club/doudizhu/index.js'
import { deckOf, seededRandomInt } from './helpers.js'

const rules = DEFAULT_DOUDIZHU_RULES

const GAME_ID = 1024
const STUDENT = (n: number) => ({ studentId: 50 + n, displayName: `学生 #00${50 + n}`, bot: false as const })

function ok(result: StepResult): { state: GameState; events: GameEvent[] } {
  if (!result.ok) throw new Error(`refused: ${result.error.reason}`)
  return result
}

/** A `your_turn` as the club layer sends it: the engine's view with the time, the people and the game number. */
function asYourTurn(view: TurnView): unknown {
  return {
    type: 'your_turn',
    roomId: 'r7k2q',
    game: 'doudizhu',
    gameId: GAME_ID,
    deadline: '2026-11-20T08:01:17.000Z',
    timeBankSeconds: 60,
    closesAt: '2026-11-20T10:45:00.000Z',
    ...view,
    left: { ...view.left, player: STUDENT(view.left.seat) },
    right: { ...view.right, player: STUDENT(view.right.seat) },
    table: { ...view.table, gameId: GAME_ID, deadline: '2026-11-20T08:01:17.000Z' },
  }
}

/** An event as the club layer sends it: the game number, the seats of `dealt`, and `ranked` in `over`. */
function asProtocolEvent(event: GameEvent): unknown {
  if (event.kind === 'dealt') return { ...event, gameId: GAME_ID, seats: [STUDENT(0), STUDENT(1), STUDENT(2)] }
  if (event.kind === 'over') return { kind: 'over', result: { gameId: GAME_ID, ...event.result, ranked: true } }
  return event
}

function expectValid(schema: TSchema, value: unknown): void {
  const errors = [...Value.Errors(schema, value)].map((e) => `${e.instancePath} ${e.message}`)
  expect(errors.slice(0, 5)).toEqual([])
}

/** Ranks low to high. */
const sorted = (cards: readonly RankName[]) => [...cards].sort((a, b) => rankValue(a) - rankValue(b))

const DECK = deckOf(
  '3 3 4 4 5 5 6 6 7 7 8 8 9 9 10 10 J',
  'Q Q Q K K K A A A 2 2 2 小王 大王 J J 3',
  '4 5 6 7 8 9 10 Q K A 2 J 3 4 5 6 7',
  '8 9 10',
)

describe('publicTable', () => {
  test('while bidding: no landlord, no bottom cards, no trick', () => {
    const { state } = newGame({ rules, firstBidder: 1, decks: [DECK] })
    const table = publicTable(state)
    expect(table).toEqual({
      game: 'doudizhu',
      gameId: 0,
      phase: 'bidding',
      firstBidder: 1,
      bids: [],
      landlord: null,
      base: null,
      bottom: null,
      cardsLeft: [17, 17, 17],
      multiplier: 1,
      trick: null,
      history: [],
      trustee: [false, false, false],
      toAct: 1,
      deadline: null,
    })
    expectValid(DoudizhuTable, { ...table, gameId: GAME_ID })
  })

  test('once the landlord is decided: the bottom shown, the trick, who is in trusteeship', () => {
    let state = newGame({ rules, firstBidder: 0, decks: [DECK] }).state
    state = ok(bid(state, 0, 1)).state
    state = ok(bid(state, 1, 3)).state
    state = ok(play(state, 1, { cards: ['3'] })).state
    const table = publicTable(state, [false, true, false])
    expect(table).toMatchObject({
      phase: 'playing',
      bids: [
        { seat: 0, bid: 1 },
        { seat: 1, bid: 3 },
      ],
      landlord: 1,
      base: 3,
      bottom: ['8', '9', '10'],
      cardsLeft: [17, 19, 17],
      trick: { leader: 1, last: { seat: 1, move: { type: 'single', name: '单牌', cards: ['3'] } } },
      trustee: [false, true, false],
      toAct: 2,
    })
    expect(table.history.map((s) => s.turn)).toEqual([1, 2, 3])
    expectValid(DoudizhuTable, { ...table, gameId: GAME_ID })
  })

  test('once over: no trick and nobody to act', () => {
    let state = newGame({ rules, firstBidder: 0, decks: [DECK, DECK, DECK] }).state
    while (state.phase !== 'over') state = actFor(state, 'trustee').state
    const table = publicTable(state)
    expect(table).toMatchObject({ phase: 'over', trick: null, toAct: null, landlord: null, bottom: null })
    expectValid(DoudizhuTable, { ...table, gameId: GAME_ID })
  })
})

describe('turnView', () => {
  test('while bidding: the bids left, no moves, no pass; the bottom counts as unseen', () => {
    let state = newGame({ rules, firstBidder: 0, decks: [DECK] }).state
    const first = turnView(state, 0)
    expect(first).toMatchObject({
      turn: 1,
      phase: 'bid',
      me: { seat: 0, role: null, hand: handOf(state, 0) },
      left: { seat: 2, role: null, cardsLeft: 17 },
      right: { seat: 1, role: null, cardsLeft: 17 },
      bids: [0, 1, 2, 3],
      moves: null,
      canPass: false,
      movesTrimmed: false,
    })
    // Seat 0 has not seen seat 1, seat 2 and the bottom.
    expect(first.unseen).toEqual(sorted([...handOf(state, 1), ...handOf(state, 2), '8', '9', '10']))
    expect(first.unseen).toHaveLength(37)
    expectValid(YourTurnMessage, asYourTurn(first))

    state = ok(bid(state, 0, 2)).state
    const second = turnView(state, 1)
    expect(second.bids).toEqual([0, 3])
    expect(second.left.seat).toBe(0)
    expect(second.right.seat).toBe(2)
    expectValid(YourTurnMessage, asYourTurn(second))
  })

  test('while playing: the moves, no bids, a pass unless leading; unseen once the landlord has the bottom', () => {
    let state = newGame({ rules, firstBidder: 0, decks: [DECK] }).state
    state = ok(bid(state, 0, 0)).state
    state = ok(bid(state, 1, 3)).state

    const lead = turnView(state, 1)
    expect(lead).toMatchObject({
      turn: 3,
      phase: 'play',
      me: { seat: 1, role: 'landlord' },
      left: { seat: 0, role: 'farmer', cardsLeft: 17 },
      right: { seat: 2, role: 'farmer', cardsLeft: 17 },
      bids: null,
      canPass: false,
      movesTrimmed: false,
    })
    expect(lead.me.hand).toHaveLength(20)
    expect(lead.me.hand).toEqual(expect.arrayContaining(['8', '9', '10']))
    // The landlord has seen the bottom: only the two farmers' hands are unseen.
    expect(lead.unseen).toEqual(sorted([...handOf(state, 0), ...handOf(state, 2)]))
    expect(lead.moves!.map((m) => m.id)).toEqual(lead.moves!.map((_, i) => i + 1))
    expectValid(YourTurnMessage, asYourTurn(lead))

    state = ok(play(state, 1, { cards: ['3'] })).state
    const follow = turnView(state, 2)
    expect(follow).toMatchObject({ phase: 'play', canPass: true, me: { role: 'farmer' } })
    // A farmer has not seen the other farmer's hand and the landlord's, bottom cards included, less what was played.
    expect(follow.unseen).toEqual(sorted([...handOf(state, 0), ...handOf(state, 1)]))
    expect(follow.unseen).toHaveLength(17 + 19)
    expect(follow.moves!.every((m) => m.type === 'single' || m.type === 'bomb' || m.type === 'rocket')).toBe(true)
    expectValid(YourTurnMessage, asYourTurn(follow))
  })

  test('a moveId of the list plays the move the list shows', () => {
    let state = newGame({ rules, firstBidder: 0, decks: [DECK] }).state
    state = ok(bid(state, 0, 3)).state
    const view = turnView(state, 0)
    for (const move of view.moves!) {
      const { events } = ok(play(state, 0, { moveId: move.id }))
      const played = events.find((e) => e.kind === 'play')
      expect(played).toMatchObject({ move: { type: move.type, name: move.name, cards: move.cards } })
    }
  })

  test('throws for a seat that is not to act', () => {
    const { state } = newGame({ rules, firstBidder: 0, decks: [DECK] })
    expect(() => turnView(state, 1)).toThrow()
  })

  test('throws when the trustee flags are not one per seat', () => {
    const { state } = newGame({ rules, firstBidder: 0, decks: [DECK] })
    expect(() => turnView(state, 0, [false, true])).toThrow()
    expect(() => publicTable(state, [false, false, false, false])).toThrow()
  })
})

describe('handOf', () => {
  test('gives the hand low to high, and fits the hand message', () => {
    const { state } = newGame({ rules, firstBidder: 0, decks: [DECK] })
    const cards = handOf(state, 1)
    expect(cards).toEqual(['3', 'J', 'J', 'Q', 'Q', 'Q', 'K', 'K', 'K', 'A', 'A', 'A', '2', '2', '2', '小王', '大王'])
    expectValid(HandMessage, { type: 'hand', roomId: 'r7k2q', game: 'doudizhu', gameId: GAME_ID, cards })
  })
})

/** Plays a random game, mostly by the trustee, with random bids and now and then a random listed move. */
function* randomGame(seed: number): Generator<{ state: GameState; events: GameEvent[] }> {
  const random = seededRandomInt(seed)
  const start = newGame({ rules, firstBidder: random(3), random })
  let state = start.state
  yield start
  while (state.phase !== 'over') {
    const seat = state.toAct!
    let result: StepResult
    if (state.phase === 'bidding' && random(2) === 0) {
      const view = turnView(state, seat)
      result = bid(state, seat, view.bids![random(view.bids!.length)]!)
    } else if (state.phase === 'playing' && random(3) === 0) {
      const view = turnView(state, seat)
      const moveId = random(view.moves!.length) + 1
      const passes = view.canPass && (view.moves!.length === 0 || random(4) === 0)
      result = passes ? pass(state, seat) : play(state, seat, { moveId })
    } else result = actFor(state, 'trustee')
    const step = ok(result)
    state = step.state
    yield step
  }
}

const TABLE_KEYS = [
  'bids', 'base', 'bottom', 'cardsLeft', 'deadline', 'firstBidder', 'game', 'gameId', 'history', 'landlord',
  'multiplier', 'phase', 'toAct', 'trick', 'trustee',
].sort()

describe('every view of random games', () => {
  test('fits the protocol, and shows nobody another hand or the bottom too early', () => {
    let views = 0
    for (let seed = 1; seed <= 20; seed++) {
      for (const { state, events } of randomGame(seed)) {
        for (const event of events) expectValid(DoudizhuEvent, asProtocolEvent(event))
        const table = publicTable(state)
        expectValid(DoudizhuTable, { ...table, gameId: GAME_ID })
        // The public table holds no cards but the bottom once decided, and the moves played.
        expect(Object.keys(table).sort()).toEqual(TABLE_KEYS)
        if (state.landlord === null) expect(table.bottom).toBeNull()
        if (state.phase === 'over') continue

        const seat = state.toAct!
        const view = turnView(state, seat)
        views++
        expectValid(YourTurnMessage, asYourTurn(view))
        expect(view.me.hand).toEqual(handOf(state, seat))
        // The neighbours show only their seat, role and count.
        for (const n of [view.left, view.right]) expect(Object.keys(n).sort()).toEqual(['cardsLeft', 'role', 'seat'])
        expect(view.left.cardsLeft).toBe(state.hands[view.left.seat]!.length)
        // Unseen is exactly the other hands, plus the bottom while nobody has taken it.
        const others = [0, 1, 2].filter((s) => s !== seat).flatMap((s) => handOf(state, s))
        const bottom = state.landlord === null ? ranksOf(state.bottom) : []
        expect(view.unseen).toEqual(sorted([...others, ...bottom]))
        // Every listed move is in the seat's own hand.
        for (const move of view.moves ?? []) {
          const mine = [...view.me.hand]
          for (const card of move.cards) {
            const i = mine.indexOf(card)
            expect(i, `${move.cards.join(' ')} from ${view.me.hand.join(' ')}`).toBeGreaterThanOrEqual(0)
            mine.splice(i, 1)
          }
        }
      }
    }
    expect(views).toBeGreaterThan(250)
  })
})
