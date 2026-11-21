import type { Static, TSchema } from 'typebox'
import { Value } from 'typebox/value'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import type { DoudizhuGameEntry } from '../../src/club/doudizhu-record.js'
import type { GameClientMessage, GameOutput, SeatPlayer } from '../../src/club/game.js'
import { join, leave } from '../../src/club/members.js'
import { botPerson, studentPerson } from '../../src/club/people.js'
import { writeGame } from '../../src/club/recorder.js'
import { ClubGameList, ClubLeaderboard, DoudizhuGameRecord, DoudizhuStats } from '../../src/protocol/club-http.js'
import type { YourTurnMessage } from '../../src/protocol/club.js'
import { ErrorBody } from '../../src/protocol/http.js'
import { ERROR_MESSAGES } from '../../src/registration/errors.js'
import type { StudentStatus } from '../../src/shared/schema.js'
import { buildTestApp } from '../helpers/app.js'
import { insertClass, insertStudent } from '../helpers/factories.js'
import { seededRandomInt } from '../club/doudizhu/helpers.js'
import { fakeGame, type FakeSession, QUICK_DECK } from '../club/helpers/fake-game.js'

// The four doudizhu lookups of the registration service (src/registration/doudizhu.ts): who may ask for what, the
// parameters, and the replies against their published schemas. What the sums are is tested with the queries
// (tests/club/doudizhu-stats.test.ts).

type TestApp = Awaited<ReturnType<typeof buildTestApp>>

let t: TestApp
let classId: number

beforeEach(async () => {
  t = await buildTestApp()
  classId = await insertClass(t.db, { classNo: 1 })
  nextGame = 1
})

afterEach(async () => {
  await t.destroy()
})

const BASE = '/v1/me/clubs/doudizhu'
const REGISTERED = new Date('2026-10-01T12:00:00+08:00')
/** The test clock's time is Monday 2026-11-02 12:00 in the school's timezone: this week began at 00:00. */
const THIS_WEEK = new Date('2026-11-02T08:00:00+08:00')
const LAST_WEEK = new Date('2026-11-01T23:59:00+08:00')

function get(url: string, key: string | undefined) {
  return t.app.inject({ method: 'GET', url, ...(key === undefined ? {} : { headers: { authorization: `Bearer ${key}` } }) })
}

/** The reply's body, after checking it is a 200 that `schema` accepts. */
async function ok<T>(schema: TSchema, url: string, key: string): Promise<T> {
  const res = await get(url, key)
  expect(res.statusCode, res.body).toBe(200)
  const body = res.json<T>()
  expect(Value.Check(schema, body), JSON.stringify([...Value.Errors(schema, body)])).toBe(true)
  return body
}

async function errorOf(url: string, key: string | undefined) {
  const res = await get(url, key)
  const body = res.json<{ error: { code: string; message: string } }>()
  expect(Value.Check(ErrorBody, body)).toBe(true)
  return { status: res.statusCode, ...body.error }
}

/** A student in the class; a member of the club unless `member` is false. */
async function student(p: { member?: boolean; status?: StudentStatus } = {}) {
  const s = await insertStudent(t.db, { status: p.status ?? 'active', classId, createdAt: REGISTERED, assignedAt: REGISTERED })
  if (p.member !== false) await join(t.db, s.id, 'doudizhu', new Date('2026-10-02T12:00:00+08:00'))
  return s
}

let nextGame = 1
/** Stores a game straight into both tables, a row for each student given (the other seats are bots). */
async function game(p: { endedAt: Date; ranked: boolean; seats: { studentId: number; score: number }[] }): Promise<number> {
  const gameId = nextGame++
  await t.db
    .insertInto('doudizhuGames')
    .values({ gameId, roomId: 'r1', startedAt: p.endedAt, endedAt: p.endedAt, ranked: p.ranked, record: '{}' })
    .execute()
  await t.db
    .insertInto('doudizhuGamePlayers')
    .values(
      p.seats.map((s, seat) => ({
        gameId,
        seat,
        studentId: s.studentId,
        role: seat === 0 ? ('landlord' as const) : ('farmer' as const),
        won: s.score > 0,
        score: s.score,
        multiplier: 2,
        ranked: p.ranked,
        endedAt: p.endedAt,
        bombs: 0,
        rockets: 0,
        spring: false,
        antiSpring: false,
        timeouts: 0,
        trusteeMoves: 0,
        illegalMoves: 0,
        ip: '10.0.0.9',
      })),
    )
    .execute()
  return gameId
}

/** Plays one whole game on the fake game (seat 0 bids 3 and plays out at once) and stores it as the recorder does. */
async function playedGame(seats: SeatPlayer[]): Promise<DoudizhuGameEntry> {
  const t0 = THIS_WEEK
  const at = (seconds: number) => new Date(t0.getTime() + seconds * 1000)
  const entries: DoudizhuGameEntry[] = []
  const g = fakeGame({ decks: [QUICK_DECK], firstBidder: 0, onGameOver: (entry) => entries.push(entry) })
  const s = g.newSession({ roomId: 'rhttp1', players: seats, addresses: [null, null, null], carry: null, closesAt: () => at(3600), now: t0 }) as FakeSession
  s.start(t0)
  expect(s.handle(0, { id: 'b', type: 'bid', game: 'doudizhu', turn: s.state.turn, bid: 3 }, at(1)).ack.ok).toBe(true)
  const cards = '3 3 4 4 5 5 6 6 7 7 8 8 9 9 10 10 J J Q Q'.split(' ')
  const play = { id: 'p', type: 'play', game: 'doudizhu', turn: s.state.turn, cards, as: 'pair_straight' } as GameClientMessage
  expect(s.handle(0, play, at(2)).ack.ok).toBe(true)
  expect(entries).toHaveLength(1)
  await writeGame(t.db, entries[0]!)
  return entries[0]!
}

const person = (id: number) => studentPerson({ id, ownerName: '主人', aiName: '小鱼' })

const at = (seconds: number) => new Date(THIS_WEEK.getTime() + seconds * 1000)
/** Text that JSON has to escape, as a reaction may carry. */
const AWKWARD = 'say "hi" \\ back\nnext line'

/**
 * Plays a longer game on a shuffled deck and stores it: seats 0 and 1 are students who bid the highest and then pass
 * whenever they may (playing the first move offered otherwise), seat 2 a bot. Reactions go to the table along the way,
 * and seat 1 is put in trusteeship after a few steps, so the record has passes, `auto: "bot"` and `auto: "trustee"`.
 */
async function longerGame(players: SeatPlayer[]): Promise<DoudizhuGameEntry> {
  const entries: DoudizhuGameEntry[] = []
  const turns = new Map<number, Static<typeof YourTurnMessage>>()
  const take = (o: GameOutput) => {
    for (const e of o.emits) if (e.to === 'seat' && e.message.type === 'your_turn') turns.set(e.seat, e.message)
  }
  const g = fakeGame({ random: seededRandomInt(20261102), firstBidder: 0, firstGameId: 7, onGameOver: (e) => entries.push(e) })
  const start = { roomId: 'rhttp2', players, addresses: ['10.0.0.1', '10.0.0.2', null], carry: null, closesAt: () => at(99_999), now: THIS_WEEK }
  const s = g.newSession(start) as FakeSession
  take(s.start(THIS_WEEK))
  s.reacted({ from: 0, to: null, kind: 'text', content: AWKWARD, text: AWKWARD }, at(1))
  s.reacted({ from: 1, to: 2, kind: 'emoji', content: '👍', text: '👍' }, at(2))
  for (let step = 0; !s.over; step++) {
    if (step > 500) throw new Error('the game does not end')
    if (step === 6) take(s.trusteeOn(1, at(3 + step)))
    if (s.over) break
    const seat = s.state.toAct!
    const turn = turns.get(seat)!
    expect(turn.turn).toBe(s.state.turn)
    const base = { id: `m${step}`, game: 'doudizhu' as const, turn: turn.turn }
    const message: GameClientMessage =
      turn.phase === 'bid'
        ? { ...base, type: 'bid', bid: turn.bids![turn.bids!.length - 1]! }
        : turn.canPass
          ? { ...base, type: 'pass' }
          : { ...base, type: 'play', moveId: turn.moves![0]!.id }
    const reply = s.handle(seat, message, at(3 + step))
    expect(reply.ack.ok, JSON.stringify(reply.ack)).toBe(true)
    take(reply.output)
    if (step === 2) s.reacted({ from: 0, to: 1, kind: 'phrase', content: 'nice', text: '打得好' }, at(3 + step))
  }
  expect(entries).toHaveLength(1)
  await writeGame(t.db, entries[0]!)
  return entries[0]!
}

/** Three students who bid nothing on any of the three deals: a game with no landlord. Stored. */
async function noLandlordGame(players: SeatPlayer[]): Promise<DoudizhuGameEntry> {
  const entries: DoudizhuGameEntry[] = []
  const g = fakeGame({ random: seededRandomInt(7), firstBidder: 1, firstGameId: 8, onGameOver: (e) => entries.push(e) })
  const start = { roomId: 'rhttp3', players, addresses: [null, null, null], carry: null, closesAt: () => at(99_999), now: THIS_WEEK }
  const s = g.newSession(start) as FakeSession
  s.start(THIS_WEEK)
  s.reacted({ from: 2, to: null, kind: 'text', content: AWKWARD, text: AWKWARD }, at(1))
  for (let i = 0; i < 9; i++) {
    const bid = { id: `b${i}`, type: 'bid', game: 'doudizhu', turn: s.state.turn, bid: 0 } as const
    const reply = s.handle(s.state.toAct!, bid, at(2 + i))
    expect(reply.ack.ok, JSON.stringify(reply.ack)).toBe(true)
  }
  expect(s.over).toBe(true)
  expect(entries).toHaveLength(1)
  await writeGame(t.db, entries[0]!)
  return entries[0]!
}

describe('the stats', () => {
  test('the student’s own record, this week’s points from Monday 00:00', async () => {
    const me = await student()
    const other = await student()
    await game({ endedAt: LAST_WEEK, ranked: true, seats: [{ studentId: me.id, score: 6 }, { studentId: other.id, score: -3 }] })
    await game({ endedAt: THIS_WEEK, ranked: true, seats: [{ studentId: me.id, score: -2 }] })
    await game({ endedAt: THIS_WEEK, ranked: false, seats: [{ studentId: me.id, score: 9 }] })

    const stats = await ok<{ games: number; wins: number; points: object; rankedGames: number }>(DoudizhuStats, `${BASE}/stats`, me.key)
    expect(stats).toMatchObject({ games: 3, wins: 2, points: { total: 4, week: -2 }, rankedGames: 2, maxMultiplier: 2 })
    expect(await ok(DoudizhuStats, `${BASE}/stats`, other.key)).toMatchObject({ games: 1, points: { total: -3, week: 0 } })
  })

  test('all 0 for one who never played, and there for one who left the club or the school', async () => {
    const never = await student({ member: false })
    expect(await ok(DoudizhuStats, `${BASE}/stats`, never.key)).toMatchObject({ games: 0, wins: 0, maxMultiplier: 0 })

    const left = await student()
    const dropped = await student()
    await game({ endedAt: THIS_WEEK, ranked: true, seats: [{ studentId: left.id, score: 3 }, { studentId: dropped.id, score: -3 }] })
    await leave(t.db, left.id, 'doudizhu')
    await t.db.updateTable('students').set({ status: 'dropped', classId: null }).where('id', '=', dropped.id).execute()
    expect(await ok(DoudizhuStats, `${BASE}/stats`, left.key)).toMatchObject({ games: 1, points: { total: 3, week: 3 } })
    expect(await ok(DoudizhuStats, `${BASE}/stats`, dropped.key)).toMatchObject({ games: 1, points: { total: -3, week: -3 } })
  })
})

describe('the leaderboards', () => {
  test('the week’s and the all-time board, with me', async () => {
    const a = await student()
    const b = await student()
    await game({ endedAt: LAST_WEEK, ranked: true, seats: [{ studentId: a.id, score: 10 }, { studentId: b.id, score: -10 }] })
    await game({ endedAt: THIS_WEEK, ranked: true, seats: [{ studentId: a.id, score: -1 }, { studentId: b.id, score: 1 }] })

    type Board = { board: string; weekStartsOn: string | null; entries: { studentId: number; rank: number; points: number }[]; me: unknown; moreTied: unknown }
    const week = await ok<Board>(ClubLeaderboard, `${BASE}/leaderboard?board=week`, a.key)
    expect(week.board).toBe('week')
    expect(week.weekStartsOn).toBe('2026-11-02')
    expect(week.entries.map((e) => [e.studentId, e.rank, e.points])).toEqual([
      [b.id, 1, 1],
      [a.id, 2, -1],
    ])
    expect(week.me).toBeNull()
    expect(week.moreTied).toBeNull()

    const all = await ok<Board>(ClubLeaderboard, `${BASE}/leaderboard?board=all`, a.key)
    expect(all.weekStartsOn).toBeNull()
    expect(all.entries.map((e) => [e.studentId, e.points])).toEqual([
      [a.id, 9],
      [b.id, -9],
    ])
  })

  test('a member who never played sees the board; a suspended member too', async () => {
    const a = await student()
    const quiet = await student()
    const suspended = await student({ status: 'suspended' })
    await game({ endedAt: THIS_WEEK, ranked: true, seats: [{ studentId: a.id, score: 2 }] })
    for (const s of [quiet, suspended]) {
      const board = await ok<{ entries: { studentId: number }[]; me: unknown }>(ClubLeaderboard, `${BASE}/leaderboard?board=week`, s.key)
      expect(board.entries.map((e) => e.studentId)).toEqual([a.id])
      expect(board.me).toBeNull()
    }
  })

  test('403 not_member for anyone who is not a current member', async () => {
    const never = await student({ member: false })
    const left = await student()
    await leave(t.db, left.id, 'doudizhu')
    const dropped = await student()
    await t.db.updateTable('students').set({ status: 'dropped', classId: null }).where('id', '=', dropped.id).execute()
    const pending = await insertStudent(t.db, { status: 'pending', createdAt: REGISTERED })

    for (const s of [never, left, dropped, pending]) {
      for (const board of ['week', 'all']) {
        expect(await errorOf(`${BASE}/leaderboard?board=${board}`, s.key)).toEqual({
          status: 403,
          code: 'not_member',
          message: ERROR_MESSAGES.not_member,
        })
      }
    }
    expect(ERROR_MESSAGES.not_member).toBe('入社以后才能看排行榜。')
  })

  test('the board must be week or all, given once', async () => {
    const a = await student()
    for (const query of ['', '?board=x', '?board=WEEK', '?board=week&board=all']) {
      expect(await errorOf(`${BASE}/leaderboard${query}`, a.key), query).toMatchObject({ status: 400, code: 'invalid_request' })
    }
  })
})

describe('the own games', () => {
  test('newest first, a page at a time with before', async () => {
    const me = await student()
    const other = await student()
    for (let i = 0; i < 23; i++) await game({ endedAt: THIS_WEEK, ranked: true, seats: [{ studentId: me.id, score: i % 2 === 0 ? 2 : -1 }] })
    await game({ endedAt: THIS_WEEK, ranked: true, seats: [{ studentId: other.id, score: 1 }] })

    type List = { games: { gameId: number }[]; nextBefore: number | null }
    const first = await ok<List>(ClubGameList, `${BASE}/games`, me.key)
    expect(first.games.map((g) => g.gameId)).toEqual(Array.from({ length: 20 }, (_, i) => 23 - i))
    expect(first.nextBefore).toBe(4)
    const second = await ok<List>(ClubGameList, `${BASE}/games?before=${first.nextBefore}`, me.key)
    expect(second).toMatchObject({ games: [{ gameId: 3 }, { gameId: 2 }, { gameId: 1 }], nextBefore: null })
    // A before past the newest is the newest page; one at the oldest an empty one.
    expect((await ok<List>(ClubGameList, `${BASE}/games?before=2147483647`, me.key)).games).toHaveLength(20)
    expect(await ok<List>(ClubGameList, `${BASE}/games?before=1`, me.key)).toEqual({ games: [], nextBefore: null })
    expect((await ok<List>(ClubGameList, `${BASE}/games`, other.key)).games.map((g) => g.gameId)).toEqual([24])
  })

  test('still there for one who left the club', async () => {
    const me = await student()
    await game({ endedAt: THIS_WEEK, ranked: true, seats: [{ studentId: me.id, score: 2 }] })
    await leave(t.db, me.id, 'doudizhu')
    const list = await ok<{ games: { gameId: number }[] }>(ClubGameList, `${BASE}/games`, me.key)
    expect(list.games.map((g) => g.gameId)).toEqual([1])
  })

  test('before must be a game number', async () => {
    const me = await student()
    for (const before of ['0', 'abc', '-1', '1.5', '1e3', '%201', '2147483648', '99999999999', '']) {
      expect(await errorOf(`${BASE}/games?before=${before}`, me.key), before).toMatchObject({ status: 400, code: 'invalid_request' })
    }
    expect(await errorOf(`${BASE}/games?before=1&before=2`, me.key)).toMatchObject({ status: 400, code: 'invalid_request' })
  })
})

describe('the record of a game', () => {
  test('comes back whole to each of the three who played it', async () => {
    const players = [await student(), await student(), await student()]
    const entry = await playedGame(players.map((p) => person(p.id)))
    for (const p of players) {
      const record = await ok<object>(DoudizhuGameRecord, `${BASE}/games/${entry.gameId}`, p.key)
      expect(record).toEqual(entry.record)
      expect(record).not.toHaveProperty('rules')
    }
    // One who left the club since still has it.
    await leave(t.db, players[0]!.id, 'doudizhu')
    expect(await ok(DoudizhuGameRecord, `${BASE}/games/${entry.gameId}`, players[0]!.key)).toEqual(entry.record)
  })

  test('a longer game with a bot comes back as recorded: passes, reactions, the bot and the trustee', async () => {
    const players = [await student(), await student()]
    const entry = await longerGame([person(players[0]!.id), person(players[1]!.id), botPerson('陪练小一')])
    const { record } = entry
    // What the round trip is to carry.
    expect(record.actions.some((a) => a.action === 'pass')).toBe(true)
    expect(record.actions.some((a) => a.auto === 'bot')).toBe(true)
    expect(record.actions.some((a) => a.auto === 'trustee')).toBe(true)
    expect(record.reacts.map((r) => r.to)).toContain(null)
    expect(record.reacts.map((r) => r.text)).toContain(AWKWARD)
    for (const p of players) {
      const res = await get(`${BASE}/games/${entry.gameId}`, p.key)
      expect(res.statusCode, res.body).toBe(200)
      expect(Value.Check(DoudizhuGameRecord, res.json())).toBe(true)
      expect(res.json()).toEqual(record)
      expect(res.body).not.toMatch(/10\.0\.0|"ip"|"rules"/)
    }
  })

  test('a game with no landlord comes back as recorded', async () => {
    const players = [await student(), await student(), await student()]
    const entry = await noLandlordGame(players.map((p) => person(p.id)))
    expect(entry.record.result.outcome).toBe('no_landlord')
    expect(entry.record.actions).toHaveLength(3)
    expect(entry.record.actions.every((a) => a.action === 'bid' && a.bid === 0)).toBe(true)
    expect(entry.record.reacts.map((r) => r.text)).toContain(AWKWARD)
    for (const p of players) {
      const res = await get(`${BASE}/games/${entry.gameId}`, p.key)
      expect(res.statusCode, res.body).toBe(200)
      expect(Value.Check(DoudizhuGameRecord, res.json())).toBe(true)
      expect(res.json()).toEqual(entry.record)
    }
  })

  test('404 not_found for anyone else, as for a game that does not exist', async () => {
    const players = [await student(), await student(), await student()]
    const entry = await playedGame(players.map((p) => person(p.id)))
    // Watching leaves no row: one who watched is anyone else to the records.
    const outsider = await student()
    const notFound = { status: 404, code: 'not_found', message: ERROR_MESSAGES.not_found }
    expect(await errorOf(`${BASE}/games/${entry.gameId}`, outsider.key)).toEqual(notFound)
    expect(await errorOf(`${BASE}/games/${entry.gameId + 1}`, players[0]!.key)).toEqual(notFound)
    expect(await errorOf(`${BASE}/games/2147483647`, players[0]!.key)).toEqual(notFound)
  })

  test('the game number must be one', async () => {
    const me = await student()
    for (const gameId of ['0', 'abc', '-1', '1.5', '2147483648', '99999999999']) {
      expect(await errorOf(`${BASE}/games/${gameId}`, me.key), gameId).toMatchObject({ status: 400, code: 'invalid_request' })
    }
  })
})

describe('the key', () => {
  test('every lookup needs one', async () => {
    for (const url of [`${BASE}/stats`, `${BASE}/leaderboard?board=week`, `${BASE}/games`, `${BASE}/games/1`]) {
      for (const key of [undefined, 'not-a-key']) {
        expect(await errorOf(url, key), url).toEqual({ status: 401, code: 'unauthorized', message: ERROR_MESSAGES.unauthorized })
      }
    }
  })
})
