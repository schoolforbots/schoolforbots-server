import type { TSchema } from 'typebox'
import Value from 'typebox/value'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import type { DoudizhuGameEntry } from '../../src/club/doudizhu-record.js'
import {
  type BoardStanding,
  doudizhuGameRecord,
  doudizhuGames,
  doudizhuLeaderboard,
  doudizhuStats,
  doudizhuStatsSummary,
  rankBoard,
  type RankedBoard,
  weekStart,
} from '../../src/club/doudizhu-stats.js'
import type { GameClientMessage, SeatPlayer } from '../../src/club/game.js'
import { join, leave } from '../../src/club/members.js'
import { botPerson, studentPerson } from '../../src/club/people.js'
import { writeGame } from '../../src/club/recorder.js'
import { ClubGameList, ClubLeaderboard, DoudizhuGameRecord, DoudizhuStats } from '../../src/protocol/club-http.js'
import { ClubStatsSummary } from '../../src/protocol/club.js'
import type { StudentStatus } from '../../src/shared/schema.js'
import { createTestDb } from '../helpers/db.js'
import { insertClass, insertStudent } from '../helpers/factories.js'
import { fakeGame, type FakeSession, QUICK_DECK } from './helpers/fake-game.js'
import { exampleConfig } from './helpers/rooms.js'

// The stats, leaderboards, own games and game records worked out from the stored games (src/club/doudizhu-stats.ts),
// and the ranking of a board against a brute-force reference.

const TZ = 'Asia/Shanghai'
const config = { ...exampleConfig, timezone: TZ }
const NOW = new Date('2026-11-21T12:00:00.000Z')
/** Monday 2026-11-16 00:00 in Shanghai, and a minute before it (Sunday 23:59). */
const MONDAY = new Date('2026-11-15T16:00:00.000Z')
const SUNDAY_2359 = new Date('2026-11-15T15:59:00.000Z')

describe('weekStart', () => {
  test('is Monday 00:00 in the school timezone', () => {
    expect(weekStart(MONDAY, TZ)).toEqual(MONDAY)
    expect(weekStart(NOW, TZ)).toEqual(MONDAY)
    // Sunday 23:59 local is still that week; a minute later the next.
    expect(weekStart(new Date('2026-11-22T15:59:00.000Z'), TZ)).toEqual(MONDAY)
    expect(weekStart(new Date('2026-11-22T16:00:00.000Z'), TZ)).toEqual(new Date('2026-11-22T16:00:00.000Z'))
    // A minute before Monday 00:00 local, the week before.
    expect(weekStart(SUNDAY_2359, TZ)).toEqual(new Date('2026-11-08T16:00:00.000Z'))
  })
})

// ---- the ranking ----

const standing = (studentId: number, points: number, games = 1): BoardStanding => ({
  studentId,
  displayName: `学生 #${studentId}`,
  className: '初中部·晚班·1 班',
  points,
  games,
})

/** The board worked out the slow way, straight from the rules. */
function referenceBoard(standings: readonly BoardStanding[], studentId: number): RankedBoard {
  const rankOf = (s: BoardStanding) => 1 + standings.filter((o) => o.points > s.points).length
  const all = standings
    .map((s) => ({ rank: rankOf(s), ...s }))
    .sort((a, b) => a.rank - b.rank || a.studentId - b.studentId)
  const qualified = all.filter((e) => e.rank <= 10)
  const entries = qualified.slice(0, 20)
  let moreTied: RankedBoard['moreTied'] = null
  if (qualified.length > 20) {
    const rank = entries[19]!.rank
    moreTied = { rank, count: qualified.filter((e) => e.rank === rank).length - entries.filter((e) => e.rank === rank).length }
  }
  const mine = all.find((e) => e.studentId === studentId) ?? null
  const me = mine !== null && !entries.some((e) => e.studentId === studentId) ? mine : null
  return { entries, me, moreTied }
}

/** A seeded random number generator, so a failure comes back the same. */
function random(seed: number): () => number {
  let x = seed >>> 0 || 1
  return () => {
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    return (x >>> 0) / 2 ** 32
  }
}

describe('rankBoard', () => {
  test('shares ranks on equal points and skips after them, ties by student number', () => {
    const board = rankBoard([standing(7, 40), standing(3, 30), standing(5, 40), standing(9, 50)], 3)
    expect(board.entries.map((e) => [e.studentId, e.rank])).toEqual([
      [9, 1],
      [5, 2],
      [7, 2],
      [3, 4],
    ])
    expect(board.me).toBeNull()
    expect(board.moreTied).toBeNull()
  })

  test('lists rank 10 and better only; me is the asking student below that', () => {
    const standings = Array.from({ length: 15 }, (_, i) => standing(i + 1, 100 - i))
    const board = rankBoard(standings, 13)
    expect(board.entries.map((e) => e.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(board.me).toEqual({ rank: 13, ...standing(13, 88) })
    expect(rankBoard(standings, 99).me).toBeNull()
    expect(rankBoard([], 1)).toEqual({ entries: [], me: null, moreTied: null })
  })

  test('cuts at 20 inside the last rank shown, and says how many more share it', () => {
    // 9 ranked 1 to 9, then 30 tied at 10: the 9 and 11 of the 30.
    const standings = [
      ...Array.from({ length: 9 }, (_, i) => standing(100 + i, 100 - i)),
      ...Array.from({ length: 30 }, (_, i) => standing(i + 1, 0)),
    ]
    const board = rankBoard(standings, 30)
    expect(board.entries).toHaveLength(20)
    expect(board.entries.slice(9).map((e) => [e.studentId, e.rank])).toEqual(
      Array.from({ length: 11 }, (_, i) => [i + 1, 10]),
    )
    expect(board.moreTied).toEqual({ rank: 10, count: 19 })
    expect(board.me).toEqual({ rank: 10, ...standing(30, 0) })
    // 50 tied at rank 1.
    const tied = rankBoard(Array.from({ length: 50 }, (_, i) => standing(i + 1, 5)), 1)
    expect(tied.entries.map((e) => e.studentId)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1))
    expect(tied.moreTied).toEqual({ rank: 1, count: 30 })
    expect(tied.me).toBeNull()
  })

  test('agrees with the reference on random boards', () => {
    const next = random(20261121)
    for (let round = 0; round < 3000; round++) {
      const n = Math.floor(next() * 45)
      // A small spread of points makes many ties; sometimes a wide one.
      const spread = next() < 0.5 ? 1 + Math.floor(next() * 4) : 1 + Math.floor(next() * 60)
      const ids = Array.from({ length: n }, (_, i) => i + 1).sort(() => next() - 0.5)
      const standings = ids.map((id) => standing(id * 3, Math.floor(next() * spread) - Math.floor(spread / 2), 1 + Math.floor(next() * 9)))
      const asking = next() < 0.8 && n > 0 ? standings[Math.floor(next() * n)]!.studentId : 1
      const board = rankBoard(standings, asking)
      expect(board).toEqual(referenceBoard(standings, asking))
      expect(board.entries.length).toBeLessThanOrEqual(20)
      // Whoever is left out of a full board shares the last rank shown, or is ranked below 10.
      const listed = new Set(board.entries.map((e) => e.studentId))
      const last = board.entries[board.entries.length - 1]
      for (const s of standings) {
        if (listed.has(s.studentId)) continue
        const rank = 1 + standings.filter((o) => o.points > s.points).length
        expect(rank > 10 || (board.moreTied !== null && rank === board.moreTied.rank && rank === last?.rank)).toBe(true)
      }
    }
  })
})

// ---- on the database ----

let t: Awaited<ReturnType<typeof createTestDb>>
let classId: number
beforeEach(async () => {
  t = await createTestDb()
  classId = await insertClass(t.db, { division: 'junior', slot: 'evening', classNo: 3 })
})
afterEach(async () => {
  await t.destroy()
})

const REGISTERED = new Date('2026-11-01T00:00:00.000Z')

/** A student in class 3; a member of the club unless `member` is false. */
async function student(p: { member?: boolean; status?: StudentStatus; ownerName?: string } = {}): Promise<number> {
  const { id } = await insertStudent(t.db, {
    status: p.status ?? 'active',
    classId,
    createdAt: REGISTERED,
    ownerName: p.ownerName ?? `主人${Math.random().toString(36).slice(2, 6)}`,
    aiName: '小鱼',
  })
  if (p.member !== false) await join(t.db, id, 'doudizhu', new Date('2026-11-02T00:00:00.000Z'))
  return id
}

interface Seat {
  studentId: number
  score?: number
  won?: boolean
  role?: 'landlord' | 'farmer' | null
  multiplier?: number
  bombs?: number
  rockets?: number
  spring?: boolean
  antiSpring?: boolean
  timeouts?: number
  trusteeMoves?: number
  illegalMoves?: number
}

let nextGame = 1
/** Stores a game straight into both tables: a row for each seat given (the others are bots). */
async function game(p: { endedAt: Date; ranked: boolean; seats: Seat[]; gameId?: number }): Promise<number> {
  const gameId = p.gameId ?? nextGame++
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
        role: s.role === undefined ? 'farmer' : s.role,
        won: s.won ?? false,
        score: s.score ?? 0,
        multiplier: s.multiplier ?? 1,
        ranked: p.ranked,
        endedAt: p.endedAt,
        bombs: s.bombs ?? 0,
        rockets: s.rockets ?? 0,
        spring: s.spring ?? false,
        antiSpring: s.antiSpring ?? false,
        timeouts: s.timeouts ?? 0,
        trusteeMoves: s.trusteeMoves ?? 0,
        illegalMoves: s.illegalMoves ?? 0,
        ip: '10.0.0.9',
      })),
    )
    .execute()
  return gameId
}
beforeEach(() => {
  nextGame = 1
})

function checked<T>(schema: TSchema, value: T): T {
  const errors = [...Value.Errors(schema, value)]
  expect(Value.Check(schema, value), JSON.stringify(errors)).toBe(true)
  return value
}

describe('the stats', () => {
  test('all 0 for a student who never played, maxMultiplier too', async () => {
    const id = await student()
    const stats = checked(DoudizhuStats, await doudizhuStats(t.db, id, NOW, TZ))
    expect(stats).toEqual({
      games: 0,
      wins: 0,
      points: { total: 0, week: 0 },
      landlordGames: 0,
      landlordWins: 0,
      rankedGames: 0,
      springs: 0,
      antiSprings: 0,
      bombs: 0,
      rockets: 0,
      maxMultiplier: 0,
      timeouts: 0,
      trusteeMoves: 0,
      illegalMoves: 0,
    })
    expect(checked(ClubStatsSummary, await doudizhuStatsSummary(t.db, id, NOW, TZ))).toEqual({
      games: 0,
      wins: 0,
      points: { total: 0, week: 0 },
    })
    expect(stats).not.toHaveProperty('winRate')
  })

  test('count every game, the points only the ranked ones, the week from Monday 00:00', async () => {
    const id = await student()
    const other = await student()
    // Last week, Sunday 23:59 local: in the total, not the week.
    await game({ endedAt: SUNDAY_2359, ranked: true, seats: [{ studentId: id, role: 'landlord', won: true, score: 8, multiplier: 4, spring: true, bombs: 1 }] })
    // This week, Monday 00:00 local.
    await game({ endedAt: MONDAY, ranked: true, seats: [{ studentId: id, role: 'farmer', score: -2, timeouts: 2, trusteeMoves: 3 }] })
    await game({ endedAt: new Date('2026-11-20T10:00:00.000Z'), ranked: true, seats: [{ studentId: id, role: 'farmer', won: true, score: 4, antiSpring: true, rockets: 1, illegalMoves: 1 }] })
    // With bots: a game and a win, no points.
    await game({ endedAt: new Date('2026-11-20T11:00:00.000Z'), ranked: false, seats: [{ studentId: id, role: 'landlord', won: true, score: 6, multiplier: 16, bombs: 2 }] })
    // No landlord: a game, not a win.
    await game({ endedAt: new Date('2026-11-20T12:00:00.000Z'), ranked: true, seats: [{ studentId: id, role: null }] })
    // Someone else's.
    await game({ endedAt: new Date('2026-11-20T12:00:00.000Z'), ranked: true, seats: [{ studentId: other, won: true, score: 100, multiplier: 64 }] })

    const stats = checked(DoudizhuStats, await doudizhuStats(t.db, id, NOW, TZ))
    expect(stats).toEqual({
      games: 5,
      wins: 3,
      points: { total: 10, week: 2 },
      landlordGames: 2,
      landlordWins: 2,
      rankedGames: 4,
      springs: 1,
      antiSprings: 1,
      bombs: 3,
      rockets: 1,
      maxMultiplier: 16,
      timeouts: 2,
      trusteeMoves: 3,
      illegalMoves: 1,
    })
    // The summary is the same counts.
    expect(await doudizhuStatsSummary(t.db, id, NOW, TZ)).toEqual({ games: 5, wins: 3, points: { total: 10, week: 2 } })
  })

  test('stay with a student who left the club', async () => {
    const id = await student()
    await game({ endedAt: MONDAY, ranked: true, seats: [{ studentId: id, won: true, score: 3 }] })
    await leave(t.db, id, 'doudizhu')
    expect((await doudizhuStats(t.db, id, NOW, TZ)).points).toEqual({ total: 3, week: 3 })
    expect((await doudizhuGames(t.db, id, null)).games.map((g) => g.gameId)).toEqual([1])
  })
})

describe('the leaderboards', () => {
  test('list current members by the points of their ranked games in the period', async () => {
    const a = await student({ ownerName: '阿杰' })
    const b = await student({ ownerName: '小红' })
    const c = await student({ ownerName: 'Tom' })
    const gone = await student({ ownerName: '退社' })
    const dropped = await student({ ownerName: '退学' })
    const never = await student({ member: false, ownerName: '没入社' })
    const botsOnly = await student({ ownerName: '陪练局' })
    // Last week, Sunday 23:59 local: all-time only.
    await game({ endedAt: SUNDAY_2359, ranked: true, seats: [{ studentId: a, score: 10 }, { studentId: b, score: -5 }, { studentId: c, score: -5 }] })
    // This week, Monday 00:00 local.
    await game({ endedAt: MONDAY, ranked: true, seats: [{ studentId: a, score: -2 }, { studentId: b, score: 4 }, { studentId: c, score: -2 }] })
    // With bots: no points, not on the boards.
    await game({ endedAt: MONDAY, ranked: false, seats: [{ studentId: a, score: 50 }, { studentId: botsOnly, score: 50 }] })
    // Those who are no current member are not on the boards.
    await game({ endedAt: MONDAY, ranked: true, seats: [{ studentId: gone, score: 99 }, { studentId: dropped, score: 99 }, { studentId: never, score: 99 }] })
    await leave(t.db, gone, 'doudizhu')
    await t.db.updateTable('students').set({ status: 'dropped' }).where('id', '=', dropped).execute()

    const week = checked(ClubLeaderboard, await doudizhuLeaderboard(t.db, config, 'week', a, NOW))
    expect(week.board).toBe('week')
    expect(week.weekStartsOn).toBe('2026-11-16')
    expect(week.entries).toEqual([
      { rank: 1, studentId: b, displayName: `小红家的小鱼 #${String(b).padStart(4, '0')}`, className: '初中部·晚班·3 班', points: 4, games: 1 },
      { rank: 2, studentId: Math.min(a, c), displayName: expect.any(String), className: '初中部·晚班·3 班', points: -2, games: 1 },
      { rank: 2, studentId: Math.max(a, c), displayName: expect.any(String), className: '初中部·晚班·3 班', points: -2, games: 1 },
    ])
    expect(week.me).toBeNull()
    expect(week.moreTied).toBeNull()

    const all = checked(ClubLeaderboard, await doudizhuLeaderboard(t.db, config, 'all', a, NOW))
    expect(all.weekStartsOn).toBeNull()
    expect(all.entries.map((e) => [e.studentId, e.rank, e.points, e.games])).toEqual([
      [a, 1, 8, 2],
      [b, 2, -1, 2],
      [c, 3, -7, 2],
    ])
    // Their own record is still there for those not on the board.
    expect((await doudizhuStats(t.db, gone, NOW, TZ)).points.total).toBe(99)
    expect((await doudizhuGames(t.db, gone, null)).games).toHaveLength(1)
  })

  test('a game at Monday 00:00 is this week, one at Sunday 23:59 is not', async () => {
    const a = await student()
    const b = await student()
    await game({ endedAt: SUNDAY_2359, ranked: true, seats: [{ studentId: a, score: 5 }] })
    await game({ endedAt: MONDAY, ranked: true, seats: [{ studentId: b, score: 1 }] })
    const week = await doudizhuLeaderboard(t.db, config, 'week', a, NOW)
    expect(week.entries.map((e) => e.studentId)).toEqual([b])
    // Seen from Sunday 23:59 itself, both games are of that (the earlier) week.
    const before = await doudizhuLeaderboard(t.db, config, 'week', a, SUNDAY_2359)
    expect(before.weekStartsOn).toBe('2026-11-09')
    expect(before.entries.map((e) => e.studentId)).toEqual([a, b])
  })

  test('me is the asking student below the top, with the 20 cap and moreTied', async () => {
    const ids: number[] = []
    for (let i = 0; i < 24; i++) ids.push(await student())
    // Everyone ties at rank 1: 20 listed, 4 more.
    await game({ endedAt: MONDAY, ranked: true, seats: ids.slice(0, 3).map((studentId) => ({ studentId, score: 1 })) })
    for (let i = 3; i < 24; i += 3) {
      await game({ endedAt: MONDAY, ranked: true, seats: ids.slice(i, i + 3).map((studentId) => ({ studentId, score: 1 })) })
    }
    const last = ids[23]!
    const board = checked(ClubLeaderboard, await doudizhuLeaderboard(t.db, config, 'all', last, NOW))
    expect(board.entries).toHaveLength(20)
    expect(board.entries.map((e) => e.studentId)).toEqual(ids.slice(0, 20))
    expect(board.moreTied).toEqual({ rank: 1, count: 4 })
    expect(board.me).toMatchObject({ rank: 1, studentId: last, points: 1, games: 1 })
  })
})

describe('the own games', () => {
  test('newest first, 20 a page, nextBefore null on the last', async () => {
    const id = await student()
    const other = await student()
    for (let i = 0; i < 45; i++) {
      const role = i % 5 === 4 ? null : i % 2 === 0 ? 'landlord' : 'farmer'
      await game({
        endedAt: new Date(MONDAY.getTime() + i * 60_000),
        ranked: i % 2 === 0,
        seats: [{ studentId: id, role, won: role !== null && i % 3 === 0, score: i }],
      })
    }
    await game({ endedAt: MONDAY, ranked: true, seats: [{ studentId: other }] })

    const first = checked(ClubGameList, await doudizhuGames(t.db, id, null))
    expect(first.games.map((g) => g.gameId)).toEqual(Array.from({ length: 20 }, (_, i) => 45 - i))
    expect(first.nextBefore).toBe(26)
    const second = checked(ClubGameList, await doudizhuGames(t.db, id, first.nextBefore))
    expect(second.games.map((g) => g.gameId)).toEqual(Array.from({ length: 20 }, (_, i) => 25 - i))
    const third = checked(ClubGameList, await doudizhuGames(t.db, id, second.nextBefore))
    expect(third.games.map((g) => g.gameId)).toEqual([5, 4, 3, 2, 1])
    expect(third.nextBefore).toBeNull()

    // Exactly a page: no next one.
    expect((await doudizhuGames(t.db, id, 21)).nextBefore).toBeNull()
    expect(await doudizhuGames(t.db, other, 1)).toEqual({ games: [], nextBefore: null })

    // Game 1 (i = 0): a landlord who won. Game 2: a farmer who lost. Game 4: a farmer who won. Game 5: no landlord.
    expect(third.games.find((g) => g.gameId === 1)).toEqual({
      gameId: 1,
      endedAt: MONDAY.toISOString(),
      outcome: 'landlord_won',
      role: 'landlord',
      score: 0,
      multiplier: 1,
      ranked: true,
    })
    expect(third.games.find((g) => g.gameId === 5)).toMatchObject({ outcome: 'no_landlord', role: null })
    expect(third.games.find((g) => g.gameId === 2)).toMatchObject({ outcome: 'landlord_won', role: 'farmer', ranked: false })
    expect(third.games.find((g) => g.gameId === 4)).toMatchObject({ outcome: 'farmers_won', role: 'farmer' })
    expect(third.games.find((g) => g.gameId === 3)).toMatchObject({ outcome: 'farmers_won', role: 'landlord' })
  })
})

describe('the record of a game', () => {
  const T0 = new Date('2026-11-20T08:00:00.000Z')
  const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000)

  /** Plays one game on the fake game (seat 0 bids 3 and plays out at once) and gives the entry it handed on. */
  function playGame(seats: SeatPlayer[]): DoudizhuGameEntry {
    const entries: DoudizhuGameEntry[] = []
    const g = fakeGame({ decks: [QUICK_DECK], firstBidder: 0, onGameOver: (entry) => entries.push(entry) })
    const s = g.newSession({ roomId: 'rstat1', players: seats, addresses: ['10.0.0.1', null, null], carry: null, closesAt: () => at(3600), now: T0 }) as FakeSession
    s.start(T0)
    expect(s.handle(0, { id: 'b', type: 'bid', game: 'doudizhu', turn: s.state.turn, bid: 3 }, at(1)).ack.ok).toBe(true)
    const cards = '3 3 4 4 5 5 6 6 7 7 8 8 9 9 10 10 J J Q Q'.split(' ')
    expect(s.handle(0, { id: 'p', type: 'play', game: 'doudizhu', turn: s.state.turn, cards, as: 'pair_straight' } as GameClientMessage, at(2)).ack.ok).toBe(true)
    expect(entries).toHaveLength(1)
    return entries[0]!
  }

  test('comes back whole to the students who played it, and to nobody else', async () => {
    const ids = [await student(), await student(), await student()]
    const outsider = await student()
    const entry = playGame(ids.map((id) => studentPerson({ id, ownerName: '主人', aiName: '小鱼' })))
    await writeGame(t.db, entry)

    for (const id of ids) {
      const record = await doudizhuGameRecord(t.db, entry.gameId, id)
      expect(record).toEqual(entry.record)
      checked(DoudizhuGameRecord, record)
      expect(record).not.toHaveProperty('rules')
    }
    // Not one of the three, or no such game: the same answer.
    expect(await doudizhuGameRecord(t.db, entry.gameId, outsider)).toBeNull()
    expect(await doudizhuGameRecord(t.db, entry.gameId + 1, ids[0]!)).toBeNull()

    // The game is in their lists and stats as the recorder stored it.
    const list = checked(ClubGameList, await doudizhuGames(t.db, ids[0]!, null))
    expect(list.games).toEqual([
      {
        gameId: entry.gameId,
        endedAt: entry.endedAt.toISOString(),
        outcome: entry.record.result.outcome,
        role: 'landlord',
        score: entry.record.result.scores[0],
        multiplier: entry.record.result.multiplier,
        ranked: true,
      },
    ])
  })

  test('a game with bots: in the games and the stats, not in the points or on the boards', async () => {
    const id = await student()
    const entry = playGame([studentPerson({ id, ownerName: '主人', aiName: '小鱼' }), botPerson('陪练小一'), botPerson('陪练小二')])
    await writeGame(t.db, entry)
    expect(entry.ranked).toBe(false)
    const record = checked(DoudizhuGameRecord, await doudizhuGameRecord(t.db, entry.gameId, id))
    expect(record).toEqual(entry.record)
    const stats = await doudizhuStats(t.db, id, at(10), TZ)
    expect(stats).toMatchObject({ games: 1, wins: 1, rankedGames: 0, points: { total: 0, week: 0 } })
    expect(stats.maxMultiplier).toBe(entry.record.result.multiplier)
    expect((await doudizhuLeaderboard(t.db, config, 'all', id, at(10))).entries).toEqual([])
  })
})
