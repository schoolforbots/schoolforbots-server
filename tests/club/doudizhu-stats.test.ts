import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { doudizhuStatsSummary, weekStart } from '../../src/club/doudizhu-stats.js'
import { createTestDb } from '../helpers/db.js'
import { insertStudent } from '../helpers/factories.js'

// The stats worked out from the stored games (src/club/doudizhu-stats.ts): so far the summary of `welcome.stats`.

const TZ = 'Asia/Shanghai'

describe('weekStart', () => {
  test('is Monday 00:00 in the school timezone', () => {
    // Monday 2026-11-16 00:00 in Shanghai is Sunday 16:00 UTC.
    const monday = new Date('2026-11-15T16:00:00.000Z')
    expect(weekStart(monday, TZ)).toEqual(monday)
    expect(weekStart(new Date('2026-11-21T12:00:00.000Z'), TZ)).toEqual(monday)
    // Sunday 23:59 local is still that week; a minute later the next.
    expect(weekStart(new Date('2026-11-22T15:59:00.000Z'), TZ)).toEqual(monday)
    expect(weekStart(new Date('2026-11-22T16:00:00.000Z'), TZ)).toEqual(new Date('2026-11-22T16:00:00.000Z'))
    // A minute before Monday 00:00 local, the week before.
    expect(weekStart(new Date('2026-11-15T15:59:00.000Z'), TZ)).toEqual(new Date('2026-11-08T16:00:00.000Z'))
  })
})

describe('the summary', () => {
  let t: Awaited<ReturnType<typeof createTestDb>>
  beforeEach(async () => {
    t = await createTestDb()
  })
  afterEach(async () => {
    await t.destroy()
  })

  let nextGame = 1
  async function game(studentId: number, p: { won: boolean; score: number; ranked: boolean; endedAt: Date; role?: 'landlord' | 'farmer' | null }) {
    const gameId = nextGame++
    await t.db
      .insertInto('doudizhuGames')
      .values({ gameId, roomId: 'r1', startedAt: p.endedAt, endedAt: p.endedAt, ranked: p.ranked, record: '{}' })
      .execute()
    await t.db
      .insertInto('doudizhuGamePlayers')
      .values({
        gameId,
        seat: 0,
        studentId,
        role: p.role === undefined ? 'landlord' : p.role,
        won: p.won,
        score: p.score,
        multiplier: 1,
        ranked: p.ranked,
        endedAt: p.endedAt,
        bombs: 0,
        rockets: 0,
        spring: false,
        antiSpring: false,
        timeouts: 0,
        trusteeMoves: 0,
        illegalMoves: 0,
        ip: null,
      })
      .execute()
  }

  test('all 0 for a student who never played', async () => {
    const { id } = await insertStudent(t.db, { status: 'active' })
    expect(await doudizhuStatsSummary(t.db, id, new Date(), TZ)).toEqual({ games: 0, wins: 0, points: { total: 0, week: 0 } })
  })

  test('games and wins count every game; the points only the ranked ones, the week from Monday 00:00', async () => {
    const { id } = await insertStudent(t.db, { status: 'active' })
    const other = await insertStudent(t.db, { status: 'active' })
    const now = new Date('2026-11-21T12:00:00.000Z')
    // Last week, Sunday 23:59 local: in the total, not the week.
    await game(id, { won: true, score: 8, ranked: true, endedAt: new Date('2026-11-15T15:59:00.000Z') })
    // This week, Monday 00:00 local.
    await game(id, { won: false, score: -2, ranked: true, endedAt: new Date('2026-11-15T16:00:00.000Z') })
    await game(id, { won: true, score: 4, ranked: true, endedAt: new Date('2026-11-20T10:00:00.000Z') })
    // With bots: a game and a win, no points.
    await game(id, { won: true, score: 6, ranked: false, endedAt: new Date('2026-11-20T11:00:00.000Z') })
    // No landlord: a game, not a win.
    await game(id, { won: false, score: 0, ranked: true, endedAt: new Date('2026-11-20T12:00:00.000Z'), role: null })
    // Someone else's.
    await game(other.id, { won: true, score: 100, ranked: true, endedAt: new Date('2026-11-20T12:00:00.000Z') })

    expect(await doudizhuStatsSummary(t.db, id, now, TZ)).toEqual({ games: 5, wins: 3, points: { total: 10, week: 2 } })
  })
})
