import type { Static } from 'typebox'
import { describe, expect, test } from 'vitest'
import { DEFAULT_DOUDIZHU_RULES, type Rules } from '../../src/club/doudizhu/index.js'
import type { RandomInt } from '../../src/club/doudizhu/deal.js'
import type {
  GameClientMessage,
  GameEmit,
  GameOutput,
  GameReply,
  GameRoomEvent,
  SeatPlayer,
} from '../../src/club/game.js'
import { botPerson, studentPerson } from '../../src/club/people.js'
import type { YourTurnMessage } from '../../src/protocol/club.js'
import { seededRandomInt } from './doudizhu/helpers.js'
import { ackFrame, answer, checkProtocol, fakeGame, type FakeGameOptions, FakeSession } from './helpers/fake-game.js'

// The doudizhu game with the clock (src/club/doudizhu-game.ts, src/club/doudizhu-clock.ts), on a fake clock: every
// time is given to the session, nothing sleeps. The sessions are the tests' fake game's, so every message they send is
// checked against the published schema too.

type YourTurn = Static<typeof YourTurnMessage>

const ROOM = 'rclock1'
const T0 = new Date('2026-11-20T08:00:00.000Z')
const CLOSES = new Date('2026-11-20T09:45:00.000Z')
/** The moment `seconds` after T0. */
const at = (seconds: number) => new Date(T0.getTime() + Math.round(seconds * 1000))
const iso = (seconds: number) => at(seconds).toISOString()

/** Bids have 10 seconds, plays 20: told apart in every deadline. */
const RULES: Rules = { ...DEFAULT_DOUDIZHU_RULES, bidSeconds: 10, playSeconds: 20 }

const students: SeatPlayer[] = [
  studentPerson({ id: 37, ownerName: '阿杰', aiName: '小鱼' }),
  studentPerson({ id: 38, ownerName: '小红', aiName: '豆豆' }),
  studentPerson({ id: 39, ownerName: 'Tom', aiName: 'Bot' }),
]
const withBots: SeatPlayer[] = [students[0]!, botPerson('陪练小一'), botPerson('陪练小二')]

const privates = (output: GameOutput) =>
  output.emits.filter((e): e is Extract<GameEmit, { to: 'seat' }> => e.to === 'seat')
const roomEvents = (output: GameOutput) => output.emits.flatMap((e) => (e.to === 'room' ? [e.event] : []))
const gameEvents = (output: GameOutput) => roomEvents(output).flatMap((e) => (e.kind === 'game' ? [e.event] : []))
const yourTurns = (output: GameOutput) =>
  privates(output).flatMap((e) => (e.message.type === 'your_turn' ? [{ seat: e.seat, turn: e.message }] : []))
/** The steps an output tells, as `seat:auto` (`-` for the seat's own). */
const steps = (output: GameOutput) =>
  gameEvents(output).flatMap((e) =>
    e.kind === 'bid' || e.kind === 'play' || e.kind === 'pass' ? [`${e.seat}:${e.auto ?? '-'}`] : [],
  )
/** Every emit, in order: a game event's kind (and the step's auto), a trustee event, or `seat:type` of a message. */
const shape = (output: GameOutput) =>
  output.emits.map((e) => {
    if (e.to === 'seat') return `${e.seat}:${e.message.type}`
    if (e.event.kind === 'trustee') return `trustee ${e.event.seat} ${e.event.on ? 'on' : 'off'} ${e.event.reason}`
    const event = e.event.event
    return 'auto' in event ? `${event.kind} ${event.seat}:${event.auto ?? '-'}` : event.kind
  })

/** One session on the fake clock, with the last `your_turn` of each seat. */
class Table {
  readonly s: FakeSession
  readonly turns = new Map<number, YourTurn>()

  constructor(players: SeatPlayer[] = students, options: FakeGameOptions = {}) {
    const game = fakeGame({
      clock: true,
      rules: RULES,
      timeBankSeconds: 30,
      trusteeDelaySeconds: 2,
      random: seededRandomInt(7),
      firstBidder: 0,
      ...options,
    })
    const start = { roomId: ROOM, players, addresses: players.map(() => null), carry: null, closesAt: () => CLOSES, now: T0 }
    this.s = game.newSession(start) as FakeSession
  }

  take(output: GameOutput): GameOutput {
    for (const { seat, turn } of yourTurns(output)) this.turns.set(seat, turn)
    return output
  }

  start(): GameOutput {
    return this.take(this.s.start(T0))
  }

  /** The seat's last `your_turn`. */
  turn(seat: number): YourTurn {
    const turn = this.turns.get(seat)
    if (turn === undefined) throw new Error(`seat ${seat} was never asked`)
    return turn
  }

  /** `message` (by default the plain answer to the seat's last `your_turn`) from `seat` at `seconds`. */
  act(seat: number, seconds: number, message?: GameClientMessage): GameReply {
    const reply = this.s.handle(seat, message ?? answer(this.turn(seat)), at(seconds))
    checkProtocol('ClubAckMessage', ackFrame('a', reply.ack))
    this.take(reply.output)
    return reply
  }

  /** `act`, expecting the step to be taken. */
  ok(seat: number, seconds: number, message?: GameClientMessage): GameOutput {
    const reply = this.act(seat, seconds, message)
    expect(reply.ack).toMatchObject({ ok: true })
    return reply.output
  }

  tick(seconds: number): GameOutput {
    return this.take(this.s.tick(at(seconds)))
  }

  trusteeOff(seat: number, seconds: number): GameReply {
    const reply = this.s.trusteeOff(seat, at(seconds))
    this.take(reply.output)
    return reply
  }

  /** Puts `seat` in trusteeship as two timeouts would (the fake game's `trusteeOn`). */
  trusteeOn(seat: number, seconds: number): GameOutput {
    return this.take(this.s.trusteeOn(seat, at(seconds)))
  }

  /** Expects the seat to be asked now, for `turn` with `deadline` (seconds) and `bank` seconds shown. */
  expectAsked(seat: number, turn: number, deadline: number, bank: number): void {
    expect(this.s.state.toAct).toBe(seat)
    expect(this.s.state.turn).toBe(turn)
    expect(this.turn(seat)).toMatchObject({ turn, deadline: iso(deadline), timeBankSeconds: bank })
    expect(this.turn(seat).table.deadline).toBe(iso(deadline))
    expect(this.s.table().deadline).toBe(iso(deadline))
  }
}

const bidOf = (turn: number, bid: number): GameClientMessage => ({ id: 'b', type: 'bid', game: 'doudizhu', turn, bid })

describe('the deadline and the time bank', () => {
  test('a step has the rules\' limit, and one made by its deadline costs no bank', () => {
    const t = new Table()
    t.start()
    t.expectAsked(0, 1, 10, 30)
    t.ok(0, 5, bidOf(1, 0))
    t.expectAsked(1, 2, 15, 30)
    // Exactly at the deadline is not late yet.
    t.ok(1, 15, bidOf(2, 0))
    expect(t.s.bankAt(1, at(15))).toBe(30_000)
    t.expectAsked(2, 3, 25, 30)
    t.ok(2, 16, bidOf(3, 3))
    // A play has the play limit.
    t.expectAsked(2, 4, 36, 30)
    expect(t.s.seatCounts).toEqual([0, 1, 2].map(() => ({ timeouts: 0, trusteeMoves: 0, illegalMoves: 0 })))
  })

  test('a step past the deadline spends the time past it, to the millisecond; the bank shows whole seconds', () => {
    const t = new Table()
    t.start()
    // Asked at 0, deadline 10; made at 12.5.
    t.ok(0, 12.5, bidOf(1, 0))
    expect(t.s.bankAt(0, at(12.5))).toBe(27_500)
    // The next seat's step is asked when the step before it was made.
    t.expectAsked(1, 2, 22.5, 30)
    t.ok(1, 13, bidOf(2, 3))
    t.ok(1, 14)
    t.ok(2, 15)
    t.expectAsked(0, 5, 35, 27)
    // While asked, the bank shown runs down past the deadline: a reconnect at 40.2 sees 22.3 seconds left.
    const again = t.s.resend(0, at(40.2))
    expect(again.map((m) => m.type)).toEqual(['hand', 'your_turn'])
    expect(again[1]).toMatchObject({ turn: 5, deadline: iso(35), timeBankSeconds: 22 })
    expect(t.s.table().deadline).toBe(iso(35))
  })

  test('a step not made by the end of the bank times out; the trustee makes it and the bank is empty', () => {
    const t = new Table()
    t.start()
    expect(t.tick(39.999).emits).toEqual([])
    // The tick comes 1.5 seconds after the step was due: the next seat has its whole time from when it is asked.
    const out = t.tick(41.5)
    expect(shape(out)).toEqual(['bid 0:timeout', '1:your_turn'])
    t.expectAsked(1, 2, 51.5, 30)
    expect(t.s.bankAt(0, at(41.5))).toBe(0)
    expect(t.s.seatCounts[0]).toEqual({ timeouts: 1, trusteeMoves: 0, illegalMoves: 0 })
    // One timeout is not trusteeship.
    expect(t.s.trustee(0)).toBe(false)
    t.ok(1, 42, bidOf(2, 0))
    t.ok(2, 43, bidOf(3, 0))
    // The redeal: seat 1 bids first, then seat 2, then seat 0 with no bank left.
    t.ok(1, 44, bidOf(4, 0))
    t.ok(2, 45, bidOf(5, 0))
    t.expectAsked(0, 6, 55, 0)
  })

  test('a step at the moment it is due is too late: the trustee makes it first, and the step is a stale turn', () => {
    const late = new Table()
    late.start()
    const reply = late.act(0, 40, bidOf(1, 3))
    expect(reply.ack).toEqual({ ok: false, code: 'stale_turn' })
    expect(shape(reply.output)).toEqual(['bid 0:timeout', '1:your_turn'])
    late.expectAsked(1, 2, 50, 30)

    const inTime = new Table()
    inTime.start()
    inTime.ok(0, 39.999, bidOf(1, 0))
    expect(inTime.s.bankAt(0, at(39.999))).toBe(1)
    expect(inTime.s.seatCounts[0]!.timeouts).toBe(0)
  })

  test('the bank is one for the whole game: it carries from step to step and across redeals', () => {
    const t = new Table()
    t.start()
    t.ok(0, 15, bidOf(1, 0)) // 5 seconds late
    t.ok(1, 16, bidOf(2, 0))
    expect(gameEvents(t.ok(2, 17, bidOf(3, 0))).map((e) => e.kind)).toEqual(['bid', 'redeal', 'dealt'])
    // The redeal: seat 1 bids first.
    t.ok(1, 18, bidOf(4, 0))
    t.ok(2, 19, bidOf(5, 0))
    t.expectAsked(0, 6, 29, 25)
    t.ok(0, 33, bidOf(6, 0)) // 4 seconds late
    expect(t.s.bankAt(0, at(33))).toBe(21_000)
  })

  test('a student among bots: the bots play at once and never count, the student is asked from the timeout on', () => {
    const t = new Table(withBots, { firstBidder: 1 })
    const started = t.start()
    expect(steps(started)).toEqual(['1:bot', '2:bot'])
    t.expectAsked(0, 3, 10, 30)
    // Times out at 40: a redeal, the bot that bids first now bids at once, and seat 0 is asked from 40 on.
    expect(shape(t.tick(40))).toEqual(['bid 0:timeout', 'redeal', 'dealt', '0:hand', 'bid 2:bot', '0:your_turn'])
    t.expectAsked(0, 5, 50, 0)
    // The second timeout in a row: trusteeship, then the last deal, where the trustee has its short deadline.
    expect(shape(t.tick(50))).toEqual([
      'bid 0:timeout', 'trustee 0 on timeouts', 'bid 1:bot', 'redeal', 'dealt', '0:hand', '0:your_turn',
    ])
    t.expectAsked(0, 7, 52, 0)
    const last = t.tick(52)
    expect(steps(last)).toEqual(['0:trustee', '1:bot', '2:bot'])
    expect(last.over).toBe(true)
    expect(gameEvents(last).at(-1)).toMatchObject({ kind: 'over', result: { outcome: 'no_landlord', ranked: false } })
    expect(t.s.seatCounts[0]).toEqual({ timeouts: 2, trusteeMoves: 1, illegalMoves: 0 })
  })
})

describe('trusteeship after timeouts', () => {
  /** A table with no time bank: a step times out at its deadline. */
  const noBank = () => new Table(students, { timeBankSeconds: 0 })

  test('two timeouts in a row of one seat put it in trusteeship, right after the second', () => {
    const t = noBank()
    t.start()
    expect(shape(t.tick(10))).toEqual(['bid 0:timeout', '1:your_turn'])
    t.ok(1, 11, bidOf(2, 3))
    t.ok(1, 12)
    t.ok(2, 13)
    t.expectAsked(0, 5, 33, 0)
    const out = t.tick(33)
    expect(shape(out).slice(0, 2)).toEqual([expect.stringMatching(/^(play|pass) 0:timeout$/), 'trustee 0 on timeouts'])
    expect(t.s.trustee(0)).toBe(true)
    expect(t.s.table().trustee).toEqual([true, false, false])
    expect(t.s.seatCounts[0]).toEqual({ timeouts: 2, trusteeMoves: 0, illegalMoves: 0 })
  })

  test('a step of the seat\'s own between two timeouts starts the count again', () => {
    const t = noBank()
    t.start()
    t.tick(10) // seat 0: 1
    t.ok(1, 11, bidOf(2, 3))
    t.ok(1, 12)
    t.ok(2, 13)
    t.ok(0, 14) // seat 0's own: 0
    t.ok(1, 15)
    t.ok(2, 16)
    t.expectAsked(0, 8, 36, 0)
    expect(shape(t.tick(36))).not.toContain('trustee 0 on timeouts') // 1
    t.ok(1, 37)
    t.ok(2, 38)
    t.expectAsked(0, 11, 58, 0)
    expect(shape(t.tick(58))).toContain('trustee 0 on timeouts') // 2
  })

  test('taking the seat back starts the count again', () => {
    const t = noBank()
    t.start()
    t.tick(10)
    t.ok(1, 11, bidOf(2, 3))
    t.ok(1, 12)
    t.ok(2, 13)
    t.tick(33)
    expect(t.s.trustee(0)).toBe(true)
    // Seat 1 is to act; seat 0 takes its seat back.
    expect(t.trusteeOff(0, 34).ack).toEqual({ ok: true })
    t.ok(1, 35)
    t.ok(2, 36)
    t.expectAsked(0, 8, 56, 0)
    expect(shape(t.tick(56))).not.toContain('trustee 0 on timeouts')
    expect(t.s.trustee(0)).toBe(false)
  })
})

describe('a seat in trusteeship', () => {
  test('is still asked, with the short deadline and its bank as it is', () => {
    const t = new Table()
    t.start()
    t.ok(0, 12, bidOf(1, 0)) // bank 28
    t.trusteeOn(0, 13)
    t.ok(1, 14, bidOf(2, 0))
    const out = t.ok(2, 15, bidOf(3, 3))
    expect(t.s.state.toAct).toBe(2)
    t.ok(2, 16)
    t.expectAsked(0, 5, 18, 28)
    expect(t.turn(0).table.trustee).toEqual([true, false, false])
    expect(out.over).toBe(false)
  })

  test('at the short deadline the trustee makes the step, and the bank is not spent', () => {
    const t = new Table()
    t.start()
    t.trusteeOn(0, 1)
    // Seat 0 is to act: asked again, from now, with the short deadline.
    t.expectAsked(0, 1, 3, 30)
    expect(t.tick(2.999).emits).toEqual([])
    expect(shape(t.tick(3))).toEqual(['bid 0:trustee', '1:your_turn'])
    t.expectAsked(1, 2, 13, 30)
    expect(t.s.bankAt(0, at(3))).toBe(30_000)
    expect(t.s.seatCounts[0]).toEqual({ timeouts: 0, trusteeMoves: 1, illegalMoves: 0 })
    expect(t.s.trustee(0)).toBe(true)
  })

  test('a valid step before the short deadline takes the seat back and is the student\'s step', () => {
    const t = new Table()
    t.start()
    t.trusteeOn(0, 1)
    const out = t.ok(0, 2.5, bidOf(1, 2))
    expect(shape(out)).toEqual(['trustee 0 off off', 'bid 0:-', '1:your_turn'])
    expect(t.s.trustee(0)).toBe(false)
    expect(t.s.bankAt(0, at(2.5))).toBe(30_000)
    expect(t.s.seatCounts[0]).toEqual({ timeouts: 0, trusteeMoves: 0, illegalMoves: 0 })
  })

  test('an illegal step does not take it back; the retry keeps the turn, the short deadline and the bank', () => {
    const t = new Table()
    t.start()
    t.trusteeOn(1, 0)
    t.ok(0, 1, bidOf(1, 2))
    t.expectAsked(1, 2, 3, 30)
    const reply = t.act(1, 2, bidOf(2, 1))
    expect(reply.ack).toEqual({
      ok: false,
      code: 'illegal_move',
      extra: { problem: 'bid_too_low', reason: expect.any(String), retry: { turn: 2, deadline: iso(3), timeBankSeconds: 30 } },
    })
    expect(reply.output.emits).toEqual([])
    expect(t.s.trustee(1)).toBe(true)
    expect(shape(t.tick(3))).toEqual(['bid 1:trustee', '2:your_turn'])
    expect(t.s.seatCounts[1]).toEqual({ timeouts: 0, trusteeMoves: 1, illegalMoves: 1 })
  })

  test('trustee.off while asked gives a new your_turn for the same turn, with the step\'s own deadline', () => {
    const t = new Table()
    t.start()
    t.trusteeOn(0, 1)
    t.expectAsked(0, 1, 3, 30)
    const reply = t.trusteeOff(0, 2)
    expect(reply.ack).toEqual({ ok: true })
    expect(shape(reply.output)).toEqual(['trustee 0 off off', '0:your_turn'])
    // Asked at 1, so the bid's own deadline is 11.
    t.expectAsked(0, 1, 11, 30)
    expect(t.tick(3).emits).toEqual([])
    expect(t.trusteeOff(0, 4).ack).toEqual({ ok: false, code: 'not_trustee' })
  })

  test('trustee.off never gives a deadline sooner than the short deadline from now', () => {
    // Out of what doudizhuGame allows (the short deadline is less than every step's own), so made directly: asked at 1
    // with 8 seconds, the bid's own deadline would be 11, but taken back at 8 the seat has at least until 16.
    const start = { roomId: ROOM, players: students, addresses: [null, null, null], carry: null, closesAt: () => CLOSES, now: T0 }
    const options = { rules: RULES, clock: true, timeBankSeconds: 30, trusteeDelaySeconds: 8, firstBidder: 0, random: seededRandomInt(7) }
    const s = new FakeSession(start, options, 1)
    s.start(T0)
    s.trusteeOn(0, at(1))
    const reply = s.trusteeOff(0, at(8))
    expect(yourTurns(reply.output).map(({ turn }) => turn.deadline)).toEqual([iso(16)])
    expect(s.table().deadline).toBe(iso(16))
  })

  test('trustee.off while another seat is to act only gives the seat back', () => {
    const t = new Table()
    t.start()
    t.trusteeOn(2, 0)
    const reply = t.trusteeOff(2, 1)
    expect(shape(reply.output)).toEqual(['trustee 2 off off'])
    t.expectAsked(0, 1, 10, 30)
  })
})

describe('refused steps and reconnects', () => {
  test('an illegal step keeps the turn and its deadline, and shows the bank left at that moment', () => {
    const t = new Table()
    t.start()
    t.ok(0, 1, bidOf(1, 2))
    t.expectAsked(1, 2, 11, 30)
    const reply = t.act(1, 13.2, bidOf(2, 1))
    expect(reply.ack).toMatchObject({
      ok: false,
      code: 'illegal_move',
      extra: { problem: 'bid_too_low', retry: { turn: 2, deadline: iso(11), timeBankSeconds: 27 } },
    })
    // Retried later still, within the bank.
    t.ok(1, 14.5, bidOf(2, 3))
    expect(t.s.bankAt(1, at(14.5))).toBe(26_500)
    expect(t.s.seatCounts[1]!.illegalMoves).toBe(1)
  })

  test('a reconnect is sent the same turn and deadline, the bank as it is now', () => {
    const t = new Table()
    t.start()
    const before = t.s.resend(0, at(3))
    expect(before[1]).toEqual(t.turn(0))
    const after = t.s.resend(0, at(14.2))
    expect(after[1]).toMatchObject({ turn: 1, deadline: iso(10), timeBankSeconds: 25 })
    // A seat not to act gets only its hand.
    expect(t.s.resend(1, at(14.2)).map((m) => m.type)).toEqual(['hand'])
  })
})

describe('a late tick', () => {
  test('makes the step that was due and only delays the next: every seat asked has its whole time from then', () => {
    const t = new Table()
    t.start()
    t.trusteeOn(1, 0)
    // Seat 0's step was due at 40; seat 1, in trusteeship, is asked at 45 with its whole short deadline.
    expect(shape(t.tick(45))).toEqual(['bid 0:timeout', '1:your_turn'])
    t.expectAsked(1, 2, 47, 30)
    // Very late: the trustee bids for seat 1 (due at 47), and seat 2 is asked at 60.
    expect(shape(t.tick(60))).toEqual(['bid 1:trustee', '2:your_turn'])
    t.expectAsked(2, 3, 70, 30)
    // Seat 2's step was due at 100; at 200 it times out, nobody bid, and the new deal's first bidder (seat 1) is asked.
    expect(shape(t.tick(200))).toEqual(['bid 2:timeout', 'redeal', 'dealt', '0:hand', '1:hand', '2:hand', '1:your_turn'])
    t.expectAsked(1, 4, 202, 30)
    expect(t.s.seatCounts).toEqual([
      { timeouts: 1, trusteeMoves: 0, illegalMoves: 0 },
      { timeouts: 0, trusteeMoves: 1, illegalMoves: 0 },
      { timeouts: 1, trusteeMoves: 0, illegalMoves: 0 },
    ])
  })

  test('a reconnect after the step was due gets no your_turn for it; the next call makes the step', () => {
    const t = new Table()
    t.start()
    expect(t.s.resend(0, at(39.999)).map((m) => m.type)).toEqual(['hand', 'your_turn'])
    expect(t.s.resend(0, at(40)).map((m) => m.type)).toEqual(['hand'])
    expect(shape(t.tick(41))).toEqual(['bid 0:timeout', '1:your_turn'])
  })
})

describe('the club closing', () => {
  test('finish plays the game out at once, every step closing, with no private message', () => {
    const t = new Table()
    t.start()
    t.trusteeOn(1, 0)
    t.ok(0, 1, bidOf(1, 3))
    const out = t.take(t.s.finish(at(5)))
    expect(out.over).toBe(true)
    expect(privates(out)).toEqual([])
    expect(roomEvents(out).filter((e) => e.kind === 'trustee')).toEqual([
      { kind: 'trustee', seat: 0, on: true, reason: 'closing' },
      { kind: 'trustee', seat: 2, on: true, reason: 'closing' },
    ])
    expect(new Set(steps(out).map((s) => s.split(':')[1]))).toEqual(new Set(['closing']))
    expect(t.s.table().deadline).toBeNull()
    expect(t.tick(1000)).toEqual({ emits: [], over: true })
  })

  test('a step already due when the club closes is a timeout, and counted; the rest is played out', () => {
    const t = new Table()
    t.start()
    const out = t.take(t.s.finish(at(45)))
    expect(shape(out).slice(0, 4)).toEqual([
      'bid 0:timeout',
      'trustee 0 on closing',
      'trustee 1 on closing',
      'trustee 2 on closing',
    ])
    expect(steps(out).slice(1).every((step) => step.endsWith(':closing'))).toBe(true)
    expect(out.over).toBe(true)
    expect(privates(out)).toEqual([])
    expect(t.s.seatCounts[0]).toEqual({ timeouts: 1, trusteeMoves: 0, illegalMoves: 0 })
  })
})

describe('the short deadline', () => {
  test('must be at least a second and shorter than every step', () => {
    expect(() => fakeGame({ clock: true, rules: RULES, trusteeDelaySeconds: 10 })).toThrow(/trusteeDelaySeconds \(10\)/)
    expect(() => fakeGame({ clock: true, rules: RULES, trusteeDelaySeconds: 0 })).toThrow(RangeError)
    expect(() => fakeGame({ clock: true, rules: RULES, trusteeDelaySeconds: 9 })).not.toThrow()
    // Without the clock there is no short deadline.
    expect(() => fakeGame({ clock: false, rules: RULES, trusteeDelaySeconds: 10 })).not.toThrow()
  })
})

describe('without the clock', () => {
  test('a fixed deadline, no bank, and nothing ever times out', () => {
    const t = new Table(students, { clock: false, turnSeconds: 60 })
    t.start()
    t.expectAsked(0, 1, 60, 0)
    expect(t.tick(86_400)).toEqual({ emits: [], over: false })
    t.ok(0, 100, bidOf(1, 0))
    t.expectAsked(1, 2, 160, 0)
  })
})

// ---- Random games against the clock -----------------------------------------------------------------------------

/** Games in the random run. */
const GAMES = 600
/** Time allowed for the random run, well above what it takes, for a slow machine running every test at once. */
const RUN_TIMEOUT = 120_000
/** Keys of the engine's own state that must never reach a room event before the game is over. */
const PRIVATE_KEYS = /"(suit|hand|hands|decks|spareDecks|body|kickers|main|movesBy)"/

interface Tally {
  steps: number
  own: number
  late: number
  timeouts: number
  trusteeOn: number
  trusteeMoves: number
  takenBack: number
  illegal: number
  stale: number
  finished: number
  closedLate: number
  redeals: number
}

/** A seat's last `your_turn` as the test keeps it: its deadline in ms, and whether it was asked in trusteeship. */
interface Asked {
  readonly message: YourTurn
  readonly deadline: number
  readonly inTrusteeship: boolean
}

/** Something illegal for the step `turn` asks, or null when every bid is allowed. */
function illegalFor(turn: YourTurn): GameClientMessage | null {
  if (turn.phase === 'play') {
    return { id: 'i', type: 'play', game: 'doudizhu', turn: turn.turn, moveId: turn.moves!.length + 1 }
  }
  const low = [1, 2, 3].find((b) => !turn.bids!.includes(b))
  return low === undefined ? null : bidOf(turn.turn, low)
}

/**
 * One game of students (and bots) who act in time, late, too late or not at all, try illegal steps, take their seats
 * back and reconnect, on a clock that only goes forward, with ticks that come on time or late. A model of the clock
 * kept here checks every message: the bank each `your_turn` shows, every timeout and trustee step against its
 * deadline, the trusteeship after two timeouts, the table's deadline, the session's counts, and that nothing shows a
 * hand it should not.
 */
function randomGame(random: RandomInt, tally: Tally): void {
  const bots = random(3)
  const players: SeatPlayer[] = [0, 1, 2].map((seat) => (seat < 3 - bots ? students[seat]! : botPerson(`陪练${seat}`)))
  // The bots sit anywhere: the seats are turned round.
  const turnBy = random(3)
  const seated = [0, 1, 2].map((i) => players[(i + turnBy) % 3]!)
  const bankSeconds = [0, 3, 30][random(3)]!
  const rules: Rules = { ...DEFAULT_DOUDIZHU_RULES, bidSeconds: 4 + random(7), playSeconds: 4 + random(12) }
  const delay = 1 + random(3)
  const game = fakeGame({
    clock: true,
    rules,
    timeBankSeconds: bankSeconds,
    trusteeDelaySeconds: delay,
    random: seededRandomInt(random(2 ** 30)),
    firstBidder: random(3),
  })
  const start = { roomId: ROOM, players: seated, addresses: [null, null, null], carry: null, closesAt: () => CLOSES, now: T0 }
  const s = game.newSession(start) as FakeSession

  // The model.
  const bank = [0, 1, 2].map(() => bankSeconds * 1000)
  const trustee = [false, false, false]
  const inRow = [0, 0, 0]
  const counts = [0, 1, 2].map(() => ({ timeouts: 0, trusteeMoves: 0, illegalMoves: 0 }))
  const asked: (Asked | null)[] = [null, null, null]
  let lastStep = 0
  let lastAsked = 0
  let finished = false
  let pendingTrustee: number | null = null
  let now = T0.getTime()

  const bankShown = (seat: number, a: Asked, t: number) =>
    a.inTrusteeship ? bank[seat]! : Math.max(0, bank[seat]! - Math.max(0, t - a.deadline))
  const dueOf = (seat: number, a: Asked) => (a.inTrusteeship ? a.deadline : a.deadline + bank[seat]!)

  /**
   * Checks what a call at `t` gave; `own` is the seat whose own step it was, if any, and `takenBack` whether the call
   * was a `trustee.off` (which asks again with the step's own deadline).
   */
  function check(output: GameOutput, t: number, own: number | null, takenBack = false): void {
    for (const emit of output.emits) {
      if (emit.to === 'seat') {
        expect(seated[emit.seat]!.bot).toBe(false)
        const m = emit.message
        if (m.type === 'hand') continue
        expect(m.me.seat).toBe(emit.seat)
        expect(JSON.stringify([m.left, m.right, m.table])).not.toMatch(/"(hand|hands)"/)
        expect(m.turn).toBeGreaterThanOrEqual(lastAsked)
        lastAsked = m.turn
        const a: Asked = { message: m, deadline: Date.parse(m.deadline), inTrusteeship: trustee[emit.seat]! }
        expect(m.timeBankSeconds).toBe(Math.floor(bankShown(emit.seat, a, t) / 1000))
        expect(m.timeBankSeconds).toBeGreaterThanOrEqual(0)
        // Every seat asked has its whole time from now: the short deadline in trusteeship, else the step's own (or,
        // taken back, the step's own from when it was asked, and at least the short deadline from now).
        expect(a.deadline).toBeGreaterThan(t)
        const limit = (m.phase === 'bid' ? rules.bidSeconds : rules.playSeconds) * 1000
        if (a.inTrusteeship) expect(a.deadline).toBe(t + delay * 1000)
        else if (takenBack) expect(a.deadline).toBeGreaterThanOrEqual(t + delay * 1000)
        else expect(a.deadline).toBe(t + limit)
        asked[emit.seat] = a
        continue
      }
      const event: GameRoomEvent = emit.event
      if (event.kind === 'trustee') {
        const seat = event.seat
        if (event.on) {
          expect(trustee[seat]).toBe(false)
          if (event.reason === 'timeouts') {
            expect(pendingTrustee).toBe(seat)
            pendingTrustee = null
            inRow[seat] = 0
            tally.trusteeOn++
          } else {
            expect(event.reason).toBe('closing')
            expect(finished).toBe(true)
          }
          trustee[seat] = true
        } else {
          expect(event.reason).toBe('off')
          expect(trustee[seat]).toBe(true)
          trustee[seat] = false
          inRow[seat] = 0
          tally.takenBack++
        }
        continue
      }
      const e = event.event
      if (e.kind === 'over') {
        pendingTrustee = null
        continue
      }
      expect(JSON.stringify(event)).not.toMatch(PRIVATE_KEYS)
      if (e.kind === 'redeal') tally.redeals++
      if (e.kind !== 'bid' && e.kind !== 'play' && e.kind !== 'pass') continue
      // The trusteeship after a second timeout comes before the next step.
      expect(pendingTrustee).toBeNull()
      expect(e.turn).toBeGreaterThan(lastStep)
      lastStep = e.turn
      tally.steps++
      const seat = e.seat
      const a = asked[seat]?.message.turn === e.turn ? asked[seat]! : null
      if (seated[seat]!.bot) {
        expect(e.auto).toBe('bot')
        continue
      }
      if (finished) {
        expect(e.auto).toBe('closing')
        continue
      }
      if (e.auto === null) {
        expect(own).toBe(seat)
        expect(a).not.toBeNull()
        expect(t).toBeLessThan(dueOf(seat, a!))
        if (t > a!.deadline) tally.late++
        bank[seat] = bankShown(seat, a!, t)
        inRow[seat] = 0
        own = null
        tally.own++
      } else if (e.auto === 'timeout') {
        // Only a step the seat was sent a `your_turn` for times out, and only once its bank is gone.
        expect(trustee[seat]).toBe(false)
        expect(a).not.toBeNull()
        expect(a!.inTrusteeship).toBe(false)
        expect(t).toBeGreaterThanOrEqual(a!.deadline + bank[seat]!)
        tally.timeouts++
        bank[seat] = 0
        counts[seat]!.timeouts++
        if (++inRow[seat]! >= 2) pendingTrustee = seat
      } else {
        expect(e.auto).toBe('trustee')
        expect(trustee[seat]).toBe(true)
        expect(a).not.toBeNull()
        expect(a!.inTrusteeship).toBe(true)
        expect(t).toBeGreaterThanOrEqual(a!.deadline)
        counts[seat]!.trusteeMoves++
        tally.trusteeMoves++
      }
    }
    expect(pendingTrustee).toBeNull()
    expect(output.over).toBe(s.over)

    // The table and the session agree with the model.
    const table = s.table()
    if (s.over) {
      expect(table.deadline).toBeNull()
    } else {
      const seat = s.state.toAct!
      const a = asked[seat]
      expect(a?.message.turn).toBe(s.state.turn)
      expect(table.deadline).toBe(new Date(a!.deadline).toISOString())
      expect(table.trustee).toEqual(trustee)
    }
    for (const seat of [0, 1, 2]) {
      if (seated[seat]!.bot) continue
      const a = asked[seat]
      const expected = !s.over && s.state.toAct === seat ? bankShown(seat, a!, t) : bank[seat]!
      expect(s.bankAt(seat, new Date(t))).toBe(expected)
      expect(bank[seat]).toBeGreaterThanOrEqual(0)
      expect(s.seatCounts[seat]).toEqual(counts[seat])
    }
  }

  check(s.start(T0), now, null)
  for (let i = 0; !s.over; i++) {
    if (i > 3000) throw new Error('the game did not end')
    const seat = s.state.toAct!
    const a = asked[seat]!
    const due = dueOf(seat, a)
    const turn = s.state.turn
    const r = random(100)

    if (r < 50) {
      // In time (when there is time before the deadline), or late, perhaps too late.
      const t = r < 30 && a.deadline > now ? now + random(a.deadline - now) : now + random(Math.max(1, due - now + 3000))
      const reply = s.handle(seat, answer(a.message), new Date(t))
      if (t < due) {
        expect(reply.ack).toEqual({ ok: true, result: { turn } })
      } else {
        expect(reply.ack).toEqual({ ok: false, code: 'stale_turn' })
        tally.stale++
      }
      check(reply.output, t, seat)
      now = t
    } else if (r < 60 && illegalFor(a.message) !== null) {
      const t = now + random(Math.max(1, due - now + 1000))
      const reply = s.handle(seat, illegalFor(a.message)!, new Date(t))
      if (t < due) {
        const retry = { turn, deadline: a.message.deadline, timeBankSeconds: Math.floor(bankShown(seat, a, t) / 1000) }
        expect(reply.ack).toMatchObject({ ok: false, code: 'illegal_move', extra: { retry } })
        expect(reply.output.emits).toEqual([])
        counts[seat]!.illegalMoves++
        tally.illegal++
      } else {
        expect(reply.ack).toEqual({ ok: false, code: 'stale_turn' })
      }
      check(reply.output, t, null)
      now = t
    } else if (r < 67) {
      // Takes a seat back before the step due is made (or tries to, for a seat not in trusteeship).
      const inTrusteeship = [0, 1, 2].filter((x) => trustee[x])
      const who = inTrusteeship.length > 0 ? inTrusteeship[random(inTrusteeship.length)]! : seat
      const t = now + random(Math.max(1, due - now))
      const reply = s.trusteeOff(who, new Date(t))
      expect(reply.ack).toEqual(trustee[who] ? { ok: true } : { ok: false, code: 'not_trustee' })
      check(reply.output, t, null, true)
      now = t
    } else if (r < 70) {
      // A reconnect: the same turn and deadline, the bank as it is now; no turn once its step is due.
      const t = now + random(Math.max(1, due - now + 1000))
      if (t >= due) {
        expect(s.resend(seat, new Date(t)).map((m) => m.type)).toEqual(['hand'])
        // The tick then (the clock never goes back) makes the step.
        check(s.tick(new Date(t)), t, null)
        now = t
        continue
      }
      const messages = s.resend(seat, new Date(t))
      expect(messages.map((m) => m.type)).toEqual(['hand', 'your_turn'])
      const again = messages[1] as YourTurn
      expect(again).toMatchObject({ turn, deadline: a.message.deadline })
      expect(again.timeBankSeconds).toBe(Math.floor(bankShown(seat, a, t) / 1000))
      now = t
    } else if (r < 71) {
      finished = true
      tally.finished++
      // The club closes; a step due by then is made as it was due (a timeout, or the trustee's), the rest closing.
      const t = now + random(Math.max(1, due - now + 3000))
      const output = s.finish(new Date(t))
      if (t >= due) {
        expect(steps(output)[0]).toBe(`${seat}:${trustee[seat] ? 'trustee' : 'timeout'}`)
        tally.closedLate++
        // Checked in two parts: the step that was due (and the bots after it), then what closing played out.
        const closing = (e: GameEmit) =>
          e.to === 'room' &&
          ((e.event.kind === 'trustee' && e.event.reason === 'closing') ||
            (e.event.kind === 'game' && 'auto' in e.event.event && e.event.event.auto === 'closing'))
        const cut = output.emits.findIndex(closing)
        finished = false
        check({ emits: output.emits.slice(0, cut === -1 ? output.emits.length : cut), over: s.over }, t, null)
        finished = true
        if (cut !== -1) check({ emits: output.emits.slice(cut), over: s.over }, t, null)
        expect(output.over).toBe(true)
        expect(privates(output)).toEqual([])
        now = t
        continue
      }
      expect(output.over).toBe(true)
      expect(privates(output)).toEqual([])
      check(output, t, null)
      now = t
    } else {
      // A tick, on time or late by up to a few seconds, now and then much later.
      const t = now + (r < 95 ? random(4000) : random(60_000))
      check(s.tick(new Date(t)), t, null)
      now = t
    }
    if (!s.over) expect(s.state.turn).toBeGreaterThanOrEqual(turn)
  }
  expect(s.tick(new Date(now + 1000))).toEqual({ emits: [], over: true })
}

describe('random games against the clock', () => {
  test(`${GAMES} games all end, and every step, bank and timeout is as the clock says`, () => {
    const random = seededRandomInt(20261121)
    const tally: Tally = {
      steps: 0, own: 0, late: 0, timeouts: 0, trusteeOn: 0, trusteeMoves: 0, takenBack: 0,
      illegal: 0, stale: 0, finished: 0, closedLate: 0, redeals: 0,
    }
    for (let g = 0; g < GAMES; g++) randomGame(random, tally)
    // Every path was taken, many times.
    for (const [name, count] of Object.entries(tally)) expect(count, name).toBeGreaterThan(50)
  }, RUN_TIMEOUT)
})
