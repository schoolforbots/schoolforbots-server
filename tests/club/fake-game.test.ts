import { describe, expect, test } from 'vitest'
import { DEFAULT_DOUDIZHU_RULES } from '../../src/club/doudizhu/index.js'
import type { GameClientMessage, GameEmit, GameOutput, GamePrivateMessage, SeatPlayer } from '../../src/club/game.js'
import { botPerson, studentPerson } from '../../src/club/people.js'
import { seededRandomInt } from './doudizhu/helpers.js'
import { ackFrame, answer, checkProtocol, fakeGame, type FakeSession, QUICK_DECK } from './helpers/fake-game.js'

const ROOM = 'rfake01'
const T0 = new Date('2026-11-20T08:00:00.000Z')
const CLOSES = new Date('2026-11-20T09:45:00.000Z')
const later = (seconds: number) => new Date(T0.getTime() + seconds * 1000)

const students: SeatPlayer[] = [
  studentPerson({ id: 37, ownerName: '阿杰', aiName: '小鱼' }),
  studentPerson({ id: 38, ownerName: '小红', aiName: '豆豆' }),
  studentPerson({ id: 10001, ownerName: 'Tom', aiName: 'Bot' }),
]
const withBots: SeatPlayer[] = [students[0]!, botPerson('陪练小一'), botPerson('陪练小二')]

function session(players: SeatPlayer[], options: Parameters<typeof fakeGame>[0] = {}, game = fakeGame(options)) {
  const s = game.newSession({ roomId: ROOM, players, previous: null, closesAt: () => CLOSES, now: T0 }) as FakeSession
  return { game, s }
}

const privates = (output: GameOutput) =>
  output.emits.filter((e): e is Extract<GameEmit, { to: 'seat' }> => e.to === 'seat')
const roomEvents = (output: GameOutput) =>
  output.emits.flatMap((e) => (e.to === 'room' ? [e.event] : []))
const gameEvents = (output: GameOutput) =>
  roomEvents(output).flatMap((e) => (e.kind === 'game' ? [e.event] : []))
const yourTurns = (output: GameOutput) =>
  privates(output).flatMap((e) => (e.message.type === 'your_turn' ? [{ seat: e.seat, turn: e.message }] : []))

/** Plays a started session to its end with `answer`, checking every ack on the wire. Gives every output. */
function playOut(s: FakeSession, first: GameOutput): GameOutput[] {
  const outputs = [first]
  let output = first
  for (let step = 0; !output.over; step++) {
    if (step > 500) throw new Error('the game did not end')
    const asked = yourTurns(output)
    expect(asked).toHaveLength(1)
    const { seat, turn } = asked[0]!
    const message = answer(turn)
    const reply = s.handle(seat, message, later(step + 1))
    checkProtocol('ClubAckMessage', ackFrame(message.id, reply.ack))
    expect(reply.ack).toEqual({ ok: true, result: { turn: turn.turn } })
    output = reply.output
    outputs.push(output)
  }
  return outputs
}

describe('the game module', () => {
  test('says what welcome needs', async () => {
    const game = fakeGame()
    expect(game).toMatchObject({ club: 'doudizhu', name: '斗地主社', seats: 3 })
    expect(game.reactions).toEqual({ kinds: ['emoji', 'phrase'], visibility: ['room'] })
    expect(game.rules()).toEqual(DEFAULT_DOUDIZHU_RULES)
    const stats = await game.stats(37)
    expect(stats).toEqual({ games: 0, wins: 0, points: { total: 0, week: 0 } })
    checkProtocol('ClubStatsSummary', stats)
    checkProtocol('DoudizhuRules', game.rules())
  })
})

describe('a quick game', () => {
  test('deals, takes the bid of 3 and the one move, and is over', () => {
    const { s } = session(students, { decks: [QUICK_DECK], firstBidder: 0 })
    const started = s.start(T0)

    expect(gameEvents(started)).toEqual([
      { kind: 'dealt', gameId: 1, seats: students, firstBidder: 0 },
    ])
    // Each student gets their own hand, and the first bidder its turn, in that order after the deal.
    expect(started.emits.map((e) => (e.to === 'room' ? 'room' : `${e.seat}:${e.message.type}`))).toEqual([
      'room', '0:hand', '1:hand', '2:hand', '0:your_turn',
    ])
    const [turn] = yourTurns(started)
    expect(turn!.turn).toMatchObject({
      roomId: ROOM, gameId: 1, turn: 1, phase: 'bid', bids: [0, 1, 2, 3], timeBankSeconds: 0,
      deadline: later(60).toISOString(), closesAt: CLOSES.toISOString(),
    })
    expect(started.over).toBe(false)

    const bid = s.handle(0, { id: 'b', type: 'bid', game: 'doudizhu', turn: 1, bid: 3 }, later(5))
    expect(bid.ack).toEqual({ ok: true, result: { turn: 1 } })
    expect(gameEvents(bid.output).map((e) => e.kind)).toEqual(['bid', 'landlord'])
    const hand = privates(bid.output).find((e) => e.message.type === 'hand')!
    expect(hand.seat).toBe(0)
    expect(hand.message).toMatchObject({ cards: expect.arrayContaining(['Q']) })
    expect((hand.message as Extract<GamePrivateMessage, { type: 'hand' }>).cards).toHaveLength(20)
    expect(yourTurns(bid.output)[0]!.turn).toMatchObject({ phase: 'play', turn: 2, deadline: later(65).toISOString() })

    const cards = (hand.message as Extract<GamePrivateMessage, { type: 'hand' }>).cards
    const played = s.handle(0, { id: 'p', type: 'play', game: 'doudizhu', turn: 2, cards, as: 'pair_straight' }, later(9))
    expect(played.ack).toEqual({ ok: true, result: { turn: 2 } })
    expect(played.output.over).toBe(true)
    expect(s.over).toBe(true)
    expect(privates(played.output)).toEqual([])
    const over = gameEvents(played.output).at(-1)!
    expect(over).toMatchObject({
      kind: 'over',
      result: { gameId: 1, outcome: 'landlord_won', landlord: 0, ranked: true, doublings: [{ kind: 'spring', seat: null }] },
    })
    expect(s.table()).toMatchObject({ phase: 'over', toAct: null, deadline: null, gameId: 1 })
    checkProtocol('DoudizhuTable', s.table())
  })
})

describe('whole games', () => {
  test.each([1, 2, 3, 4, 5])('three students play a shuffled game to the end (seed %i)', (seed) => {
    const { s } = session(students, { random: seededRandomInt(seed) })
    const outputs = playOut(s, s.start(T0))
    expect(s.over).toBe(true)
    const last = gameEvents(outputs.at(-1)!).at(-1)!
    expect(last.kind).toBe('over')
    // Each private message went to its own seat: a hand or a turn is never someone else's.
    for (const output of outputs) {
      for (const e of privates(output)) {
        if (e.message.type === 'your_turn') expect(e.message.me.seat).toBe(e.seat)
      }
    }
  })

  test('with bots, the bots play at once and only the student is sent anything', () => {
    const { s } = session(withBots, { random: seededRandomInt(9) })
    const outputs = playOut(s, s.start(T0))
    for (const output of outputs) for (const e of privates(output)) expect(e.seat).toBe(0)
    const autos = outputs.flatMap(gameEvents).flatMap((e) => ('auto' in e && e.auto !== null ? [e] : []))
    expect(autos.length).toBeGreaterThan(0)
    for (const e of autos) {
      expect('seat' in e && e.seat).not.toBe(0)
      expect(e.auto).toBe('bot')
    }
    const over = outputs.flatMap(gameEvents).at(-1)!
    expect(over).toMatchObject({ kind: 'over', result: { ranked: false } })
  })

  test('the next game of a room bids first one seat on, with the next game number', () => {
    const { game, s } = session(students, { decks: [QUICK_DECK], firstBidder: 2 })
    s.start(T0)
    const next = game.newSession({ roomId: ROOM, players: students, previous: s, closesAt: () => CLOSES, now: later(1) })
    const started = next.start(later(1))
    expect(gameEvents(started)[0]).toMatchObject({ kind: 'dealt', gameId: 2, firstBidder: 0 })
    expect(game.sessions).toEqual([s, next])
  })
})

describe('nobody bids', () => {
  test('three deals with no bid redeal in order and end with no landlord; the next game bids first after the last deal', () => {
    const { game, s } = session(students, { decks: [QUICK_DECK], firstBidder: 0 })
    let output = s.start(T0)
    const outputs = [output]
    for (let step = 1; !output.over; step++) {
      const { seat, turn } = yourTurns(output)[0]!
      expect(turn.bids).toContain(0)
      const reply = s.handle(seat, { id: 'z', type: 'bid', game: 'doudizhu', turn: turn.turn, bid: 0 }, later(step))
      expect(reply.ack).toEqual({ ok: true, result: { turn: turn.turn } })
      output = reply.output
      outputs.push(output)
    }

    const dealts = outputs.flatMap(gameEvents).filter((e) => e.kind === 'dealt')
    expect(dealts.map((e) => e.firstBidder)).toEqual([0, 1, 2])
    // After the third bid of a deal: the redeal, the new deal, each hand, and the new first bidder's turn.
    for (const [i, firstBidder] of [[3, 1], [6, 2]] as const) {
      expect(
        outputs[i]!.emits.map((e) =>
          e.to === 'room' ? (e.event.kind === 'game' ? e.event.event.kind : e.event.kind) : `${e.seat}:${e.message.type}`,
        ),
      ).toEqual(['bid', 'redeal', 'dealt', '0:hand', '1:hand', '2:hand', `${firstBidder}:your_turn`])
    }
    const over = gameEvents(outputs.at(-1)!).at(-1)!
    expect(over).toMatchObject({ kind: 'over', result: { outcome: 'no_landlord', landlord: null, scores: [0, 0, 0] } })
    expect(privates(outputs.at(-1)!)).toEqual([])

    // The last deal's first bidder was seat 2, so the next game bids first from seat 0 (not seat 1, after the first).
    const next = game.newSession({ roomId: ROOM, players: students, previous: s, closesAt: () => CLOSES, now: later(20) })
    const started = next.start(later(20))
    expect(gameEvents(started)[0]).toMatchObject({ kind: 'dealt', gameId: 2, firstBidder: 0 })
    expect(yourTurns(started).map((t) => t.seat)).toEqual([0])
  })
})

describe('refused steps', () => {
  const bidMessage = (turn: number, bid: number): GameClientMessage => ({
    id: 'x', type: 'bid', game: 'doudizhu', turn, bid,
  })

  test('an illegal move is refused with its fields and the same turn to retry', () => {
    const { s } = session(students, { decks: [QUICK_DECK], firstBidder: 0 })
    s.start(T0)
    s.handle(0, bidMessage(1, 3), later(1))
    // Seat 0 leads and may not pass.
    const reply = s.handle(0, { id: 'x', type: 'pass', game: 'doudizhu', turn: 2 }, later(2))
    expect(reply.ack).toEqual({
      ok: false,
      code: 'illegal_move',
      extra: {
        problem: 'must_play',
        reason: expect.any(String),
        retry: { turn: 2, deadline: later(61).toISOString(), timeBankSeconds: 0 },
      },
    })
    expect(reply.output).toEqual({ emits: [], over: false })
    checkProtocol('ClubAckMessage', ackFrame('x', reply.ack))

    const missing = s.handle(0, { id: 'y', type: 'play', game: 'doudizhu', turn: 2, cards: ['大王'] }, later(3))
    expect(missing.ack).toMatchObject({ ok: false, code: 'illegal_move', extra: { problem: 'not_in_hand', missing: ['大王'] } })
    checkProtocol('ClubAckMessage', ackFrame('y', missing.ack))
  })

  test('a bid too low is an illegal move', () => {
    const { s } = session(students, { decks: [QUICK_DECK], firstBidder: 0 })
    s.start(T0)
    s.handle(0, bidMessage(1, 2), later(1))
    const reply = s.handle(1, bidMessage(2, 1), later(2))
    expect(reply.ack).toMatchObject({ ok: false, code: 'illegal_move', extra: { problem: 'bid_too_low' } })
    checkProtocol('ClubAckMessage', ackFrame('x', reply.ack))
  })

  test('not your turn, a stale turn, and the wrong step for the phase', () => {
    const { s } = session(students, { decks: [QUICK_DECK], firstBidder: 0 })
    s.start(T0)
    expect(s.handle(1, bidMessage(1, 1), later(1)).ack).toEqual({ ok: false, code: 'not_your_turn' })
    expect(s.handle(0, bidMessage(7, 1), later(1)).ack).toEqual({ ok: false, code: 'stale_turn' })
    expect(s.handle(0, { id: 'x', type: 'pass', game: 'doudizhu', turn: 1 }, later(1)).ack).toEqual({
      ok: false,
      code: 'invalid_message',
    })
    for (const code of ['not_your_turn', 'stale_turn', 'invalid_message'] as const) {
      checkProtocol('ClubAckMessage', ackFrame('x', { ok: false, code }))
    }
  })
})

describe('the trustee', () => {
  test('trustee.off when not in trusteeship is not_trustee', () => {
    const { s } = session(students, { decks: [QUICK_DECK], firstBidder: 0 })
    s.start(T0)
    expect(s.trusteeOff(1, later(1)).ack).toEqual({ ok: false, code: 'not_trustee' })
  })

  test('a seat in trusteeship is played for, and trustee.off gives it back', () => {
    const { s } = session(students, { decks: [QUICK_DECK], firstBidder: 0 })
    s.start(T0)
    const on = s.trusteeOn(0, later(1))
    expect(roomEvents(on)[0]).toEqual({ kind: 'trustee', seat: 0, on: true, reason: 'timeouts' })
    expect(gameEvents(on)[0]).toMatchObject({ kind: 'bid', seat: 0, bid: 0, auto: 'trustee' })
    expect(s.trustee(0)).toBe(true)
    expect(s.table().trustee).toEqual([true, false, false])
    expect(yourTurns(on).map((t) => t.seat)).toEqual([1])

    const off = s.trusteeOff(0, later(2))
    expect(off.ack).toEqual({ ok: true })
    expect(roomEvents(off.output)).toEqual([{ kind: 'trustee', seat: 0, on: false, reason: 'off' }])
    expect(s.trustee(0)).toBe(false)
  })
})

describe('finish', () => {
  test('plays the game out with every seat in trusteeship, and sends nothing private', () => {
    const { s } = session(withBots, { random: seededRandomInt(4) })
    s.start(T0)
    const out = s.finish(later(10))
    expect(out.over).toBe(true)
    expect(s.over).toBe(true)
    expect(privates(out)).toEqual([])
    expect(roomEvents(out)[0]).toEqual({ kind: 'trustee', seat: 0, on: true, reason: 'closing' })
    const steps = gameEvents(out).flatMap((e) => ('auto' in e ? [e] : []))
    for (const e of steps) expect(e.auto).toBe(e.seat === 0 ? 'closing' : 'bot')
    expect(gameEvents(out).at(-1)).toMatchObject({ kind: 'over' })

    expect(s.finish(later(11))).toEqual({ emits: [], over: true })
    expect(s.handle(0, { id: 'x', type: 'bid', game: 'doudizhu', turn: 1, bid: 0 }, later(12)).ack).toEqual({
      ok: false,
      code: 'stale_turn',
    })
    expect(s.resend(0, later(12))).toEqual([])
  })

  test('mid-play, the game is played to its end', () => {
    const { s } = session(students, { random: seededRandomInt(5) })
    let output = s.start(T0)
    // Play a few steps, then close.
    for (let i = 0; i < 6 && !output.over; i++) {
      const { seat, turn } = yourTurns(output)[0]!
      output = s.handle(seat, answer(turn), later(i + 1)).output
    }
    const out = s.finish(later(30))
    expect(out.over).toBe(true)
    expect(roomEvents(out).filter((e) => e.kind === 'trustee')).toHaveLength(3)
    expect(gameEvents(out).at(-1)).toMatchObject({ kind: 'over' })
  })
})

describe('resend', () => {
  test('gives the hand, and the turn to the seat to act with its turn and deadline unchanged', () => {
    const { s } = session(students, { decks: [QUICK_DECK], firstBidder: 0 })
    const started = s.start(T0)
    const sent = yourTurns(started)[0]!.turn

    const again = s.resend(0, later(20))
    expect(again.map((m) => m.type)).toEqual(['hand', 'your_turn'])
    expect(again[1]).toMatchObject({ turn: sent.turn, deadline: sent.deadline })
    expect(s.resend(1, later(20)).map((m) => m.type)).toEqual(['hand'])
  })

  test('nothing for a bot', () => {
    const { s } = session(withBots, { decks: [QUICK_DECK], firstBidder: 0 })
    s.start(T0)
    expect(s.resend(1, later(1))).toEqual([])
  })
})

test('the schema check refuses a message that is not valid', () => {
  expect(() => checkProtocol('HandMessage', { type: 'hand', roomId: ROOM, game: 'doudizhu', gameId: 1, cards: [] })).toThrow(
    /not a valid HandMessage/,
  )
  expect(() => checkProtocol('NoSuchMessage', {})).toThrow(/no definition/)
})

test('tick does nothing', () => {
  const { s } = session(students, { decks: [QUICK_DECK], firstBidder: 0 })
  s.start(T0)
  expect(s.tick(later(3600))).toEqual({ emits: [], over: false })
})

test('the table shows no hand and is a valid DoudizhuTable', () => {
  const { s } = session(students, { decks: [QUICK_DECK], firstBidder: 0 })
  s.start(T0)
  const table = s.table()
  checkProtocol('DoudizhuTable', table)
  expect(table).toMatchObject({ gameId: 1, phase: 'bidding', toAct: 0, deadline: later(60).toISOString() })
  expect(JSON.stringify(table)).not.toMatch(/"hands?"/)
})
