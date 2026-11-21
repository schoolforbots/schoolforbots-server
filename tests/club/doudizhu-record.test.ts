import type { Static } from 'typebox'
import Value from 'typebox/value'
import { describe, expect, test } from 'vitest'
import { type Card, ranksOf } from '../../src/club/doudizhu/cards.js'
import { deal } from '../../src/club/doudizhu/deal.js'
import { springOf } from '../../src/club/doudizhu/scoring.js'
import { DEFAULT_DOUDIZHU_RULES, type RandomInt, replay, type Rules } from '../../src/club/doudizhu/index.js'
import type { DoudizhuGameEntry } from '../../src/club/doudizhu-record.js'
import { gameRecord, playerRows } from '../../src/club/doudizhu-record.js'
import type { DoudizhuGameOptions } from '../../src/club/doudizhu-game.js'
import type { GameClientMessage, GameOutput, SeatPlayer } from '../../src/club/game.js'
import { botPerson, studentPerson } from '../../src/club/people.js'
import { DoudizhuGameRecord } from '../../src/protocol/club-http.js'
import type { YourTurnMessage } from '../../src/protocol/club.js'
import { deckOf, seededRandomInt } from './doudizhu/helpers.js'
import { answer, fakeGame, FakeSession, QUICK_DECK } from './helpers/fake-game.js'

// The record of a finished doudizhu game (src/club/doudizhu-record.ts) and how a session hands it on
// (`DoudizhuGameOptions.onGameOver`). Every record is checked against the published `DoudizhuGameRecord`.

type YourTurn = Static<typeof YourTurnMessage>
type GameRecord = Static<typeof DoudizhuGameRecord>

const ROOM = 'rrecord1'
const T0 = new Date('2026-11-20T08:00:00.000Z')
const CLOSES = new Date('2026-11-20T09:45:00.000Z')
const at = (seconds: number) => new Date(T0.getTime() + Math.round(seconds * 1000))

const students: SeatPlayer[] = [
  studentPerson({ id: 37, ownerName: '阿杰', aiName: '小鱼' }),
  studentPerson({ id: 38, ownerName: '小红', aiName: '豆豆' }),
  studentPerson({ id: 39, ownerName: 'Tom', aiName: 'Bot' }),
]
const withBots: SeatPlayer[] = [students[0]!, botPerson('陪练小一'), botPerson('陪练小二')]
const ADDRESSES = ['10.0.0.1', '10.0.0.2', null]

/** A deck where seat 0 bids nothing high: every seat gets an ordinary hand. */
const PLAIN_DECK: readonly Card[] = deckOf(
  '3 4 5 6 7 8 9 10 J Q K A 2 3 4 5 6',
  '7 8 9 10 J Q K A 2 3 4 5 6 7 8 9 10',
  'J Q K A 2 3 4 5 6 7 8 9 10 J Q K A',
  '2 小王 大王',
)

/**
 * Seat 0, landlord on 3, holds the bomb 3333, the rocket and the pair straight 44 … 1010 with the bottom (9 10 10):
 * bomb, rocket, then the rest, the farmers passing: a spring with a bomb and a rocket.
 */
const SPRING_DECK: readonly Card[] = deckOf(
  '3 3 3 3 小王 大王 4 4 5 5 6 6 7 7 8 8 9',
  '4 4 5 5 6 6 7 7 8 8 9 9 10 10 J J Q',
  'J J Q Q Q K K K K A A A A 2 2 2 2',
  '9 10 10',
)

/**
 * Seat 0, landlord on 3, leads a single 3; seat 1 beats it with the rocket and, after two passes, plays out 444 … 888:
 * an anti-spring, the rocket seat 1's.
 */
const ANTI_SPRING_DECK: readonly Card[] = deckOf(
  '3 4 5 6 7 8 9 9 10 10 J J Q Q K K A',
  '小王 大王 4 4 4 5 5 5 6 6 6 7 7 7 8 8 8',
  '3 3 3 9 9 10 10 J J Q Q K K A A 2 2',
  'A 2 2',
)

/** A game on the fake game, with every entry it handed `onGameOver`. */
class Game {
  readonly s: FakeSession
  readonly entries: DoudizhuGameEntry[] = []
  readonly turns = new Map<number, YourTurn>()

  constructor(players: SeatPlayer[] = students, options: DoudizhuGameOptions = {}) {
    const game = fakeGame({
      firstBidder: 0,
      random: seededRandomInt(5),
      onGameOver: (entry) => this.entries.push(entry),
      ...options,
    })
    const start = { roomId: ROOM, players, addresses: ADDRESSES, carry: null, closesAt: () => CLOSES, now: T0 }
    this.s = game.newSession(start) as FakeSession
  }

  take(output: GameOutput): GameOutput {
    for (const e of output.emits) if (e.to === 'seat' && e.message.type === 'your_turn') this.turns.set(e.seat, e.message)
    return output
  }

  start(seconds = 0): GameOutput {
    return this.take(this.s.start(at(seconds)))
  }

  /** Sends `message` from `seat`, expecting it taken. */
  ok(seat: number, seconds: number, message: GameClientMessage): GameOutput {
    const reply = this.s.handle(seat, message, at(seconds))
    expect(reply.ack, JSON.stringify(reply.ack)).toMatchObject({ ok: true })
    return this.take(reply.output)
  }

  bid(seat: number, seconds: number, value: number): GameOutput {
    return this.ok(seat, seconds, { id: 'b', type: 'bid', game: 'doudizhu', turn: this.s.state.turn, bid: value })
  }

  play(seat: number, seconds: number, cards: string, as?: string): GameOutput {
    const message = {
      id: 'p',
      type: 'play',
      game: 'doudizhu',
      turn: this.s.state.turn,
      cards: cards.split(' '),
      ...(as === undefined ? {} : { as }),
    } as GameClientMessage
    return this.ok(seat, seconds, message)
  }

  pass(seat: number, seconds: number): GameOutput {
    return this.ok(seat, seconds, { id: 'x', type: 'pass', game: 'doudizhu', turn: this.s.state.turn })
  }

  /** Plays the game out with the plain answers, a second a step. */
  playOut(from: number): void {
    for (let t = from; !this.s.over; t++) {
      if (t > from + 500) throw new Error('the game did not end')
      const seat = this.s.state.toAct!
      this.ok(seat, t, answer(this.turns.get(seat)!))
    }
  }

  /** The one entry handed on. */
  get entry(): DoudizhuGameEntry {
    expect(this.entries).toHaveLength(1)
    return this.entries[0]!
  }
}

/** The ranks of a list of protocol ranks, sorted, as one string to compare. */
const sorted = (cards: readonly string[]) =>
  [...cards].sort().join(' ')

/** Throws unless `record` is a valid `DoudizhuGameRecord`, as sent (a JSON round trip). */
function checkRecord(record: GameRecord): void {
  const sent = JSON.parse(JSON.stringify(record)) as unknown
  const errors = [...Value.Errors(DoudizhuGameRecord, sent)].slice(0, 5)
  expect(Value.Check(DoudizhuGameRecord, sent), JSON.stringify(errors)).toBe(true)
}

/**
 * The cards of the record add up: each seat's dealt cards (and the bottom, for the landlord) less the cards it played
 * are the cards it has left in the result; every step is by `turn`, in order; and the steps, replayed on the deal,
 * end as the result says.
 */
function checkCards(record: GameRecord, rules: Rules): void {
  const { result } = record
  for (const seat of [0, 1, 2]) {
    const left = [...record.dealt[seat]!, ...(seat === result.landlord ? record.bottom : [])]
    for (const action of record.actions) {
      if (action.seat !== seat || action.action !== 'play') continue
      for (const card of action.move.cards) {
        const i = left.indexOf(card)
        expect(i, `seat ${seat} played a ${card} it did not hold`).toBeGreaterThanOrEqual(0)
        left.splice(i, 1)
      }
    }
    expect(sorted(left)).toBe(sorted(result.hands[seat]!))
  }
  expect(sorted(record.result.bottom!)).toBe(sorted(record.bottom))
  record.actions.forEach((action, i) => {
    if (i > 0) expect(action.turn).toBe(record.actions[i - 1]!.turn + 1)
  })
  // Replayed: the deck that deals these hands, and the steps.
  const deck = deckOf(record.dealt[0]!.join(' '), record.dealt[1]!.join(' '), record.dealt[2]!.join(' '), record.bottom.join(' '))
  const firstBidder = record.actions[0]!.seat
  const steps = record.actions.map(({ turn: _turn, ...step }) => step)
  // Only the last deal is recorded: replayed as a game of one deal, it ends the same way.
  const { state } = replay({ ...rules, bidRedealLimit: 1 }, firstBidder, [deck], steps as never)
  const { gameId: _gameId, ranked: _ranked, ...outcome } = result
  expect(state.outcome).toEqual(outcome)
}

/** Every check of an entry: the record, its cards, what is stored, and the rows against the result. */
function checkEntry(entry: DoudizhuGameEntry, players: readonly SeatPlayer[], rules: Rules = DEFAULT_DOUDIZHU_RULES): void {
  const { record } = entry
  checkRecord(record)
  checkCards(record, rules)
  expect(record.gameId).toBe(entry.gameId)
  expect(record.startedAt).toBe(entry.startedAt.toISOString())
  expect(record.endedAt).toBe(entry.endedAt.toISOString())
  expect(record.seats).toEqual(players)
  expect(entry.ranked).toBe(players.every((p) => !p.bot))
  expect(record.result.ranked).toBe(entry.ranked)
  const { gameId: _g, startedAt: _s, endedAt: _e, ...rest } = record
  expect(entry.stored).toEqual({ ...rest, rules })
  expect(entry.stored).not.toHaveProperty('gameId')
  expect(entry.stored.result).not.toBe(record.result)
  expect(entry.stored.actions).not.toBe(record.actions)
  expect(entry.players.map((r) => r.seat)).toEqual([0, 1, 2].filter((seat) => !players[seat]!.bot))
  for (const row of entry.players) {
    const player = players[row.seat]!
    expect(row.studentId).toBe(player.studentId)
    expect(row.gameId).toBe(entry.gameId)
    expect(row.endedAt).toEqual(entry.endedAt)
    expect(row.ranked).toBe(entry.ranked)
    expect(row.score).toBe(record.result.scores[row.seat])
    expect(row.multiplier).toBe(record.result.multiplier)
    if (record.result.outcome === 'no_landlord') {
      expect(row).toMatchObject({ role: null, won: false, score: 0, spring: false, antiSpring: false })
    } else {
      expect(row.role).toBe(row.seat === record.result.landlord ? 'landlord' : 'farmer')
      expect(row.won).toBe(row.score > 0)
    }
    if (row.spring || row.antiSpring) expect(row.won).toBe(true)
    // A spring is the engine's verdict on the moves played, whatever the rules double.
    const { landlord, outcome } = record.result
    const plays = (seat: number) => record.actions.filter((a) => a.action === 'play' && a.seat === seat)
    const verdict = landlord === null ? null : springOf(landlord, outcome === 'landlord_won', [0, 1, 2].map((s) => plays(s).length))
    expect(row.spring).toBe(row.won && row.role === 'landlord' && verdict === 'spring')
    expect(row.antiSpring).toBe(row.won && row.role === 'farmer' && verdict === 'anti_spring')
    const played = (type: string) => plays(row.seat).filter((a) => a.action === 'play' && a.move.type === type).length
    expect(row.bombs).toBe(played('bomb'))
    expect(row.rockets).toBe(played('rocket'))
  }
  // Nothing in the record says where anyone played from.
  expect(JSON.stringify(record)).not.toMatch(/10\.0\.0\./)
}

describe('the record of a game', () => {
  test('a quick game: the record, what is stored and a row for each student', () => {
    const g = new Game(students, { decks: [QUICK_DECK] })
    g.start(0)
    g.bid(0, 3, 3)
    expect(g.entries).toEqual([])
    g.play(0, 7, '3 3 4 4 5 5 6 6 7 7 8 8 9 9 10 10 J J Q Q', 'pair_straight')
    const entry = g.entry
    checkEntry(entry, students)
    expect(entry).toMatchObject({ gameId: 1, roomId: ROOM, startedAt: at(0), endedAt: at(7), ranked: true })
    const deck = deal(QUICK_DECK)
    expect(entry.record.dealt).toEqual(deck.hands.map(ranksOf))
    expect(entry.record.bottom).toEqual(ranksOf(deck.bottom))
    expect(entry.record.actions.map((a) => `${a.turn} ${a.seat} ${a.action}`)).toEqual(['1 0 bid', '2 0 play'])
    expect(entry.record.result).toMatchObject({ outcome: 'landlord_won', landlord: 0, base: 3, multiplier: 2 })
    expect(entry.players).toEqual([
      expect.objectContaining({ seat: 0, studentId: 37, role: 'landlord', won: true, score: 12, spring: true, ip: '10.0.0.1' }),
      expect.objectContaining({ seat: 1, studentId: 38, role: 'farmer', won: false, score: -6, spring: false, ip: '10.0.0.2' }),
      expect.objectContaining({ seat: 2, studentId: 39, role: 'farmer', won: false, score: -6, ip: null }),
    ])
  })

  test('a game dealt again records the last deal: dealt, bottom and actions', () => {
    const g = new Game(students, { decks: [PLAIN_DECK, PLAIN_DECK, QUICK_DECK], firstBidder: 1 })
    g.start(0)
    // Deals 1 (first bidder 1) and 2 (first bidder 2): nobody bids. Deal 3: seat 0 bids first, 3, and plays out.
    for (let i = 0; i < 6; i++) g.bid(g.s.state.toAct!, 1 + i, 0)
    expect(g.s.state.firstBidder).toBe(0)
    g.bid(0, 8, 3)
    g.play(0, 9, '3 3 4 4 5 5 6 6 7 7 8 8 9 9 10 10 J J Q Q', 'pair_straight')
    const { record } = g.entry
    checkEntry(g.entry, students)
    const last = deal(QUICK_DECK)
    const plain = deal(PLAIN_DECK)
    expect(record.dealt).toEqual(last.hands.map((h) => ranksOf(h)))
    expect(record.dealt).not.toEqual(plain.hands.map((h) => ranksOf(h)))
    expect(record.bottom).toEqual(ranksOf(last.bottom))
    expect(record.actions.map((a) => a.turn)).toEqual([7, 8])
    expect(record.actions[0]).toMatchObject({ seat: 0, action: 'bid', bid: 3, auto: null })
  })

  test('no landlord: three deals nobody bids on', () => {
    const g = new Game(students, { decks: [PLAIN_DECK, SPRING_DECK, ANTI_SPRING_DECK] })
    g.start(0)
    for (let i = 0; i < 9; i++) g.bid(g.s.state.toAct!, 1 + i, 0)
    expect(g.s.over).toBe(true)
    const { record, players } = g.entry
    checkEntry(g.entry, students)
    expect(record.result).toMatchObject({ outcome: 'no_landlord', landlord: null, base: null, scores: [0, 0, 0] })
    expect(record.dealt).toEqual(deal(ANTI_SPRING_DECK).hands.map((h) => ranksOf(h)))
    expect(record.actions.map((a) => a.turn)).toEqual([7, 8, 9])
    expect(record.result.hands).toEqual(record.dealt)
    for (const row of players) {
      expect(row).toMatchObject({ role: null, won: false, score: 0, multiplier: 1, bombs: 0, rockets: 0 })
    }
  })

  test('a spring with a bomb and a rocket, capped', () => {
    const rules: Rules = { ...DEFAULT_DOUDIZHU_RULES, cap: 4 }
    const g = new Game(students, { decks: [SPRING_DECK], rules })
    g.start(0)
    g.bid(0, 1, 3)
    g.play(0, 2, '3 3 3 3', 'bomb')
    g.pass(1, 3)
    g.pass(2, 4)
    g.play(0, 5, '小王 大王', 'rocket')
    g.pass(1, 6)
    g.pass(2, 7)
    g.play(0, 8, '4 4 5 5 6 6 7 7 8 8 9 9 10 10', 'pair_straight')
    const { record, players } = g.entry
    checkEntry(g.entry, students, rules)
    expect(record.result).toMatchObject({ outcome: 'landlord_won', multiplier: 4, capped: true, scores: [24, -12, -12] })
    expect(record.result.doublings.map((d) => d.kind)).toEqual(['bomb', 'rocket', 'spring'])
    expect(players[0]).toMatchObject({ role: 'landlord', won: true, bombs: 1, rockets: 1, spring: true, antiSpring: false })
    for (const row of players.slice(1)) {
      expect(row).toMatchObject({ role: 'farmer', won: false, bombs: 0, rockets: 0, spring: false, antiSpring: false })
    }
    expect(g.entry.stored.rules.cap).toBe(4)
  })

  test('a spring counts when the rules do not double it', () => {
    const rules: Rules = { ...DEFAULT_DOUDIZHU_RULES, springDoubles: false }
    const g = new Game(students, { decks: [QUICK_DECK], rules })
    g.start(0)
    g.bid(0, 1, 3)
    g.play(0, 2, '3 3 4 4 5 5 6 6 7 7 8 8 9 9 10 10 J J Q Q', 'pair_straight')
    checkEntry(g.entry, students, rules)
    expect(g.entry.record.result).toMatchObject({ doublings: [], multiplier: 1 })
    expect(g.entry.players[0]).toMatchObject({ role: 'landlord', won: true, spring: true, antiSpring: false })
  })

  test('an anti-spring counts when the rules do not double it', () => {
    const rules: Rules = { ...DEFAULT_DOUDIZHU_RULES, springDoubles: false }
    const g = new Game(students, { decks: [ANTI_SPRING_DECK], rules })
    g.start(0)
    g.bid(0, 1, 3)
    g.play(0, 2, '3', 'single')
    g.play(1, 3, '小王 大王', 'rocket')
    g.pass(2, 4)
    g.pass(0, 5)
    g.play(1, 6, '4 4 4 5 5 5 6 6 6 7 7 7 8 8 8', 'trio_straight')
    checkEntry(g.entry, students, rules)
    expect(g.entry.record.result.doublings).toEqual([{ kind: 'rocket', seat: 1 }])
    expect(g.entry.players.map((r) => r.antiSpring)).toEqual([false, true, true])
  })

  test('an anti-spring, the rocket a farmer’s', () => {
    const g = new Game(students, { decks: [ANTI_SPRING_DECK] })
    g.start(0)
    g.bid(0, 1, 3)
    g.play(0, 2, '3', 'single')
    g.play(1, 3, '小王 大王', 'rocket')
    g.pass(2, 4)
    g.pass(0, 5)
    g.play(1, 6, '4 4 4 5 5 5 6 6 6 7 7 7 8 8 8', 'trio_straight')
    const { record, players } = g.entry
    checkEntry(g.entry, students)
    expect(record.result).toMatchObject({ outcome: 'farmers_won', multiplier: 4, capped: false, scores: [-24, 12, 12] })
    expect(record.result.doublings).toEqual([{ kind: 'rocket', seat: 1 }, { kind: 'anti_spring', seat: null }])
    expect(players[0]).toMatchObject({ role: 'landlord', won: false, rockets: 0, spring: false, antiSpring: false })
    expect(players[1]).toMatchObject({ role: 'farmer', won: true, rockets: 1, antiSpring: true })
    expect(players[2]).toMatchObject({ role: 'farmer', won: true, rockets: 0, antiSpring: true })
  })

  test('with bots: not ranked, and no rows for the bots', () => {
    const g = new Game(withBots, { decks: [QUICK_DECK] })
    g.start(0)
    g.bid(0, 1, 3)
    g.play(0, 2, '3 3 4 4 5 5 6 6 7 7 8 8 9 9 10 10 J J Q Q', 'pair_straight')
    const entry = g.entry
    checkEntry(entry, withBots)
    expect(entry.ranked).toBe(false)
    expect(entry.record.result.ranked).toBe(false)
    expect(entry.players).toHaveLength(1)
    expect(entry.players[0]).toMatchObject({ seat: 0, studentId: 37, ranked: false, ip: '10.0.0.1' })
    expect(entry.record.seats).toEqual(withBots)
  })

  test('the counts are the session’s: timeouts, trustee steps and illegal steps', () => {
    const g = new Game(students, {
      clock: true,
      rules: { ...DEFAULT_DOUDIZHU_RULES, bidSeconds: 10, playSeconds: 20 },
      timeBankSeconds: 5,
      decks: [PLAIN_DECK],
    })
    g.start(0)
    // An illegal bid (0 is fine, but 1 after a 2 is too low), then everyone left alone until the game ends.
    g.bid(0, 1, 2)
    const reply = g.s.handle(1, { id: 'i', type: 'bid', game: 'doudizhu', turn: g.s.state.turn, bid: 1 }, at(2))
    expect(reply.ack).toMatchObject({ ok: false, code: 'illegal_move' })
    for (let t = 3; !g.s.over; t += 7) {
      if (t > 100_000) throw new Error('the game did not end')
      g.take(g.s.tick(at(t)))
    }
    const { players } = g.entry
    checkEntry(g.entry, students, { ...DEFAULT_DOUDIZHU_RULES, bidSeconds: 10, playSeconds: 20 })
    const counts = g.s.seatCounts
    expect(counts.some((c) => c.timeouts > 0)).toBe(true)
    expect(counts.some((c) => c.trusteeMoves > 0)).toBe(true)
    expect(counts[1]!.illegalMoves).toBe(1)
    for (const row of players) {
      expect({ timeouts: row.timeouts, trusteeMoves: row.trusteeMoves, illegalMoves: row.illegalMoves }).toEqual(
        counts[row.seat],
      )
    }
  })

  test('the reactions during the game and the last address of each seat are kept', () => {
    const g = new Game(students, { decks: [QUICK_DECK] })
    g.start(0)
    g.s.reacted({ from: 1, to: 0, kind: 'emoji', content: '👍', text: '👍' }, at(1))
    g.s.reacted({ from: 2, to: null, kind: 'phrase', content: 'nice', text: '打得好' }, at(2))
    g.s.addressChanged(1, '10.0.0.9', at(2))
    g.s.addressChanged(2, '10.0.0.7', at(2))
    g.bid(0, 3, 3)
    g.play(0, 4, '3 3 4 4 5 5 6 6 7 7 8 8 9 9 10 10 J J Q Q', 'pair_straight')
    // After the end: not the game's.
    g.s.reacted({ from: 1, to: null, kind: 'emoji', content: '😭', text: '😭' }, at(5))
    g.s.addressChanged(0, '10.0.0.8', at(5))
    const { record, players } = g.entry
    checkRecord(record)
    expect(record.reacts).toEqual([
      { at: at(1).toISOString(), from: 1, to: 0, kind: 'emoji', content: '👍', text: '👍' },
      { at: at(2).toISOString(), from: 2, to: null, kind: 'phrase', content: 'nice', text: '打得好' },
    ])
    expect(players.map((r) => r.ip)).toEqual(['10.0.0.1', '10.0.0.9', '10.0.0.7'])
  })

  test('the pure functions throw for a game not over', () => {
    const g = new Game(students, { decks: [QUICK_DECK] })
    g.start(0)
    const game = {
      gameId: 1, roomId: ROOM, startedAt: at(0), endedAt: at(1), players: students, state: g.s.state,
      reactions: [], addresses: ADDRESSES, seatCounts: g.s.seatCounts,
    }
    expect(() => gameRecord(game)).toThrow(/not over/)
    expect(() => playerRows(game)).toThrow(/not over/)
  })
})

describe('handing the record on', () => {
  const quick = { decks: [QUICK_DECK] }

  test('once, from handle', () => {
    const g = new Game(students, quick)
    g.start(0)
    g.bid(0, 1, 3)
    g.play(0, 2, '3 3 4 4 5 5 6 6 7 7 8 8 9 9 10 10 J J Q Q', 'pair_straight')
    expect(g.entry.endedAt).toEqual(at(2))
    // Later calls of a game over hand nothing more.
    g.s.tick(at(3))
    g.s.finish(at(4))
    expect(g.s.handle(1, { id: 'z', type: 'pass', game: 'doudizhu', turn: 99 }, at(5)).ack).toMatchObject({ ok: false })
    g.s.trusteeOff(1, at(6))
    expect(g.entries).toHaveLength(1)
  })

  test('once, from tick: the last step timed out', () => {
    const g = new Game(students, { ...quick, clock: true })
    g.start(0)
    g.bid(0, 1, 3)
    g.take(g.s.tick(at(2)))
    expect(g.entries).toEqual([])
    // The trustee plays the whole hand when it is one move.
    expect(g.take(g.s.tick(at(1000))).over).toBe(true)
    expect(g.entry.endedAt).toEqual(at(1000))
    expect(g.entry.record.actions[1]).toMatchObject({ seat: 0, action: 'play', auto: 'timeout' })
    expect(g.entry.players[0]!.timeouts).toBe(1)
    checkEntry(g.entry, students)
    g.s.tick(at(2000))
    expect(g.entries).toHaveLength(1)
  })

  test('once, from trusteeOff: the step due before it ended the game', () => {
    const g = new Game(students, { ...quick, clock: true })
    g.start(0)
    g.bid(0, 1, 3)
    g.take(g.s.trusteeOn(0, at(2)))
    expect(g.entries).toEqual([])
    const reply = g.s.trusteeOff(0, at(10))
    expect(reply.output.over).toBe(true)
    expect(g.entry.endedAt).toEqual(at(10))
    expect(g.entry.record.actions[1]).toMatchObject({ auto: 'trustee' })
    expect(g.entry.players[0]!.trusteeMoves).toBe(1)
    checkEntry(g.entry, students)
  })

  test('once, from trusteeOn without the clock (the trustee plays at once)', () => {
    const g = new Game(students, quick)
    g.start(0)
    g.bid(0, 1, 3)
    expect(g.take(g.s.trusteeOn(0, at(2))).over).toBe(true)
    expect(g.entry.endedAt).toEqual(at(2))
  })

  test('once, from finish: the club closing plays the game out', () => {
    const g = new Game(students, { decks: [PLAIN_DECK] })
    g.start(0)
    g.bid(0, 1, 1)
    expect(g.take(g.s.finish(at(5))).over).toBe(true)
    expect(g.entry.endedAt).toEqual(at(5))
    expect(g.entry.record.actions.slice(1).every((a) => a.auto === 'closing')).toBe(true)
    checkEntry(g.entry, students)
    g.s.finish(at(6))
    expect(g.entries).toHaveLength(1)
  })

  test('nothing before the game is over, and nothing at all without onGameOver', () => {
    const g = new Game(students, { decks: [PLAIN_DECK] })
    g.start(0)
    g.bid(0, 1, 1)
    g.bid(1, 2, 2)
    expect(g.entries).toEqual([])
    const quiet = fakeGame({ decks: [QUICK_DECK], firstBidder: 0 })
    const s = quiet.newSession({ roomId: ROOM, players: students, addresses: ADDRESSES, carry: null, closesAt: () => CLOSES, now: T0 })
    s.start(at(0))
    expect(s.finish(at(1)).over).toBe(true)
  })

  test('a throwing callback does not break the game', () => {
    const errors: [unknown, number][] = []
    const boom = new Error('the recorder fell over')
    const game = fakeGame({
      decks: [QUICK_DECK],
      firstBidder: 0,
      onGameOver: () => {
        throw boom
      },
      onGameOverError: (error, gameId) => errors.push([error, gameId]),
    })
    const s = game.newSession({ roomId: ROOM, players: students, addresses: ADDRESSES, carry: null, closesAt: () => CLOSES, now: T0 })
    s.start(at(0))
    expect(s.handle(0, { id: 'b', type: 'bid', game: 'doudizhu', turn: 1, bid: 3 }, at(1)).ack.ok).toBe(true)
    const reply = s.handle(
      0,
      { id: 'p', type: 'play', game: 'doudizhu', turn: 2, cards: '3 3 4 4 5 5 6 6 7 7 8 8 9 9 10 10 J J Q Q'.split(' ') } as GameClientMessage,
      at(2),
    )
    expect(reply.ack).toEqual({ ok: true, result: { turn: 2 } })
    expect(reply.output.over).toBe(true)
    const over = reply.output.emits.find((e) => e.to === 'room' && e.event.kind === 'game' && e.event.event.kind === 'over')
    expect(over).toBeDefined()
    expect(errors).toEqual([[boom, 1]])
    expect(s.table().phase).toBe('over')
    expect(s.carry()).toEqual({ firstBidder: 0 })
    // Even an error hook that throws.
    const worse = fakeGame({
      decks: [QUICK_DECK],
      firstBidder: 0,
      onGameOver: () => {
        throw boom
      },
      onGameOverError: () => {
        throw boom
      },
    })
    const w = worse.newSession({ roomId: ROOM, players: students, addresses: ADDRESSES, carry: null, closesAt: () => CLOSES, now: T0 })
    w.start(at(0))
    expect(w.finish(at(1)).over).toBe(true)
  })
})

// ---- Random games ----------------------------------------------------------------------------------------------------

/** Games in the random run. */
const GAMES = 600
/** Time allowed for the random run, well above what it takes, for a slow machine running every test at once. */
const RUN_TIMEOUT = 120_000

/**
 * A random step for a `your_turn`: any bid allowed (often none), any move listed, or a pass when allowed. A seat that is
 * `passive` passes whenever it may, so that springs and anti-springs come up too.
 */
function randomStep(turn: YourTurn, random: RandomInt, passive: boolean): GameClientMessage {
  const base = { id: `r${turn.turn}`, game: 'doudizhu' as const, turn: turn.turn }
  if (turn.phase === 'bid') {
    const bids = turn.bids!
    // Mostly no bid, so that games are dealt again and end with no landlord too.
    const value = random(3) === 0 ? bids[random(bids.length)]! : 0
    return { ...base, type: 'bid', bid: bids.includes(value) ? value : bids[0]! }
  }
  const moves = turn.moves!
  if (turn.canPass && (passive || moves.length === 0 || random(3) === 0)) return { ...base, type: 'pass' }
  return { ...base, type: 'play', moveId: moves[random(moves.length)]!.id }
}

describe('random games', () => {
  test(`${GAMES} games each hand on one valid record whose cards add up`, () => {
    const random = seededRandomInt(20261122)
    const outcomes = new Map<string, number>()
    let redealt = 0
    let finished = 0
    let withBotsCount = 0
    for (let n = 0; n < GAMES; n++) {
      const bots = random(3)
      const turnBy = random(3)
      const players = [0, 1, 2].map((i) => {
        const seat = (i + turnBy) % 3
        return seat < 3 - bots ? students[seat]! : botPerson(`陪练${seat}`)
      })
      if (bots > 0) withBotsCount++
      const rules: Rules = { ...DEFAULT_DOUDIZHU_RULES, cap: [4, 16, 64][random(3)]!, springDoubles: random(4) !== 0 }
      const g = new Game(players, { rules, random: seededRandomInt(random(2 ** 30)), firstBidder: random(3) })
      let t = 0
      g.start(t)
      const finishAt = random(10) === 0 ? random(40) : Infinity
      // Now and then the farmers, or the landlord, pass whenever they may.
      const mode = random(5)
      const passiveFarmers = mode === 0
      const passiveLandlord = mode === 1
      for (let i = 0; !g.s.over; i++) {
        if (i > 1000) throw new Error('the game did not end')
        t++
        if (random(10) === 0) {
          const from = [0, 1, 2].filter((seat) => !players[seat]!.bot)
          g.s.reacted({ from: from[random(from.length)]!, to: random(2) === 0 ? null : random(3), kind: 'emoji', content: '👍', text: '👍' }, at(t))
        }
        if (i >= finishAt) {
          g.take(g.s.finish(at(t)))
          finished++
          break
        }
        const seat = g.s.state.toAct!
        const landlord = g.s.state.landlord
        const passive = landlord !== null && (passiveFarmers ? seat !== landlord : passiveLandlord && seat === landlord)
        g.ok(seat, t, randomStep(g.turns.get(seat)!, random, passive))
      }
      expect(g.s.over).toBe(true)
      checkEntry(g.entry, players, rules)
      expect(g.entry.endedAt).toEqual(at(t))
      if (g.entry.record.actions[0]!.turn > 1) redealt++
      const kind = g.entry.record.result.outcome
      outcomes.set(kind, (outcomes.get(kind) ?? 0) + 1)
      for (const d of g.entry.record.result.doublings) outcomes.set(d.kind, (outcomes.get(d.kind) ?? 0) + 1)
    }
    for (const kind of ['landlord_won', 'farmers_won', 'no_landlord', 'bomb', 'rocket', 'spring', 'anti_spring']) {
      expect(outcomes.get(kind) ?? 0, kind).toBeGreaterThan(15)
    }
    expect(redealt).toBeGreaterThan(100)
    expect(finished).toBeGreaterThan(15)
    expect(withBotsCount).toBeGreaterThan(100)
  }, RUN_TIMEOUT)
})
