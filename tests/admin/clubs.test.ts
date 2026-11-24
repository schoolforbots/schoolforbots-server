import { afterEach, describe, expect, test } from 'vitest'
import type { DoudizhuPage } from '../../src/admin/clubs.js'
import { join, leave } from '../../src/club/members.js'
import type { SchoolConfig } from '../../src/shared/config.js'
import { buildAdminTestApp } from '../helpers/admin.js'
import { exampleConfig } from '../helpers/app.js'
import { insertClass, insertStudent } from '../helpers/factories.js'

// Today is Wednesday 2026-11-04, noon school time (UTC+8): the week started on Monday 11-02. Yesterday is Tuesday 11-03,
// the same day last week Tuesday 10-27, today's Wednesday 10-28.
const NOW = new Date('2026-11-04T12:00:00+08:00')
const at = (date: string, time: string) => new Date(`${date}T${time}+08:00`)
const REGISTERED = at('2026-10-01', '09:00:00')

let t: Awaited<ReturnType<typeof buildAdminTestApp>>
let cookie: string
let classId: number
afterEach(async () => {
  await t.destroy()
})

async function start(config?: SchoolConfig): Promise<void> {
  t = await buildAdminTestApp({ now: NOW, config })
  cookie = await t.session()
  classId = await insertClass(t.db, { division: 'junior', slot: 'evening', classNo: 3 })
}

async function page(days: string | number = 7) {
  return t.app.inject({ method: 'GET', url: t.url(`api/clubs/doudizhu?days=${days}`), headers: { cookie } })
}
async function read(days = 7): Promise<DoudizhuPage> {
  const reply = await page(days)
  expect(reply.statusCode, reply.body).toBe(200)
  return reply.json()
}

/** A student in class 3 who joined the club at `joined` (by default long ago), or no member with null. */
async function student(name: string, joined: Date | null = REGISTERED): Promise<number> {
  const { id } = await insertStudent(t.db, { status: 'active', classId, createdAt: REGISTERED, ownerName: name, aiName: '小鱼' })
  if (joined !== null) await join(t.db, id, 'doudizhu', joined)
  return id
}

interface Seat {
  studentId: number
  score?: number
  ip?: string | null
  timeouts?: number
  trusteeMoves?: number
  illegalMoves?: number
}

let nextGame = 1
/** A game stored straight into both tables, with a row for each seat given (the others are bots). */
async function game(endedAt: Date, seats: Seat[], ranked = seats.length === 3): Promise<number> {
  const gameId = nextGame++
  await t.db
    .insertInto('doudizhuGames')
    .values({ gameId, roomId: 'r1', startedAt: endedAt, endedAt, ranked, record: '{}' })
    .execute()
  await t.db
    .insertInto('doudizhuGamePlayers')
    .values(
      seats.map((s, seat) => ({
        gameId,
        seat,
        studentId: s.studentId,
        role: seat === 0 ? ('landlord' as const) : ('farmer' as const),
        won: (s.score ?? 0) > 0,
        score: s.score ?? 0,
        multiplier: 1,
        ranked,
        endedAt,
        bombs: 0,
        rockets: 0,
        spring: false,
        antiSpring: false,
        timeouts: s.timeouts ?? 0,
        trusteeMoves: s.trusteeMoves ?? 0,
        illegalMoves: s.illegalMoves ?? 0,
        ip: s.ip === undefined ? `10.0.0.${seat + 1}` : s.ip,
      })),
    )
    .execute()
  return gameId
}

describe('GET api/clubs/doudizhu', () => {
  test('needs a session and one of the ranges', async () => {
    await start()
    const anonymous = await t.app.inject({ method: 'GET', url: t.url('api/clubs/doudizhu?days=7') })
    expect(anonymous.statusCode).toBe(401)
    expect((await page(8)).statusCode).toBe(400)
    expect((await t.app.inject({ method: 'GET', url: t.url('api/clubs/doudizhu'), headers: { cookie } })).statusCode).toBe(400)
  })

  test('counts the games, players and new members of each day, today up to now', async () => {
    nextGame = 1
    await start()
    const a = await student('阿杰', at('2026-11-03', '20:00:00'))
    const b = await student('小美', at('2026-11-03', '21:00:00'))
    const c = await student('大壮')
    const gone = await student('走了的', at('2026-11-03', '22:00:00'))
    await leave(t.db, gone, 'doudizhu')
    await student('没入社的', null)

    // Yesterday: one ranked game and one with a bot; a game a second before midnight counts too.
    await game(at('2026-11-03', '20:30:00'), [{ studentId: a }, { studentId: b }, { studentId: c }])
    await game(at('2026-11-03', '23:59:59'), [{ studentId: a }, { studentId: b }])
    // Today: one before now, one after (a clock ahead in the test), which is not counted.
    await game(at('2026-11-04', '11:00:00'), [{ studentId: c }])
    await game(at('2026-11-04', '13:00:00'), [{ studentId: a }])
    // The same day last week, and today's last week before and after the time of day now.
    await game(at('2026-10-27', '10:00:00'), [{ studentId: a }])
    await game(at('2026-10-28', '09:00:00'), [{ studentId: a }])
    await game(at('2026-10-28', '15:00:00'), [{ studentId: a }])

    const p = await read(7)
    expect(p.enabled).toBe(true)
    expect(p.members).toBe(3)
    expect(p.yesterday).toEqual({ date: '2026-11-03', games: 2, rankedGames: 1, players: 3, newMembers: 2 })
    expect(p.sameDayLastWeek).toEqual({ date: '2026-10-27', games: 1, rankedGames: 0, players: 1, newMembers: 0 })
    expect(p.todaySoFar).toEqual({ date: '2026-11-04', games: 1, rankedGames: 0, players: 1, newMembers: 0 })
    expect(p.sameTimeLastWeek).toEqual({ date: '2026-10-28', games: 1, rankedGames: 0, players: 1, newMembers: 0 })
    expect(p.asOf).toBe(NOW.toISOString())
    expect(p.today).toBe('2026-11-04')
    expect(p.timeZone).toBe('Asia/Shanghai')
    expect(p.series.map((d) => d.date)).toEqual([
      '2026-10-28',
      '2026-10-29',
      '2026-10-30',
      '2026-10-31',
      '2026-11-01',
      '2026-11-02',
      '2026-11-03',
    ])
    expect(p.series[0]).toEqual({ date: '2026-10-28', games: 2, rankedGames: 0, players: 1, newMembers: 0 })
    expect(p.series[6]).toEqual(p.yesterday)
    expect((await read(30)).series).toHaveLength(30)
  })

  test('says when the clubs are closed', async () => {
    const config = exampleConfig()
    await start({ ...config, club: { ...config.club, enabled: false } })
    expect((await read()).enabled).toBe(false)
  })

  test("lists the week's board with shared ranks, current members only", async () => {
    nextGame = 1
    await start()
    const a = await student('阿杰')
    const b = await student('小美')
    const c = await student('大壮')
    const outsider = await student('没入社的', null)
    await game(at('2026-11-02', '20:00:00'), [
      { studentId: a, score: 4 },
      { studentId: b, score: -2 },
      { studentId: c, score: -2 },
    ])
    await game(at('2026-11-03', '20:00:00'), [
      { studentId: b, score: 4 },
      { studentId: c, score: -2 },
      { studentId: outsider, score: -2 },
    ])
    // Last week's and a game with a bot do not count.
    await game(at('2026-11-01', '20:00:00'), [
      { studentId: c, score: 40 },
      { studentId: a, score: -20 },
      { studentId: b, score: -20 },
    ])
    await game(at('2026-11-03', '21:00:00'), [{ studentId: c, score: 10 }, { studentId: a }])

    const { week } = await read()
    expect(week.startsOn).toBe('2026-11-02')
    expect(week.board.total).toBe(3)
    expect(week.board.entries.map((e) => [e.rank, e.studentId, e.points, e.games])).toEqual([
      [1, a, 4, 1],
      [2, b, 2, 2],
      [3, c, -4, 2],
    ])
    expect(week.board.entries[0]).toMatchObject({ displayName: expect.stringContaining('阿杰'), className: '初中部·晚班·3 班' })
  })

  test('counts the seats that timed out, were played by the trustee or tried illegal moves', async () => {
    nextGame = 1
    await start()
    const a = await student('阿杰')
    const b = await student('小美')
    await game(at('2026-11-03', '20:00:00'), [{ studentId: a, timeouts: 2, trusteeMoves: 5 }, { studentId: b }])
    await game(at('2026-11-04', '10:00:00'), [{ studentId: a, illegalMoves: 1, timeouts: 1 }])
    await game(at('2026-11-01', '10:00:00'), [{ studentId: b, timeouts: 9 }])

    expect((await read()).week.conduct).toEqual({
      seats: 3,
      timedOut: { seats: 2, times: 3 },
      trustee: { seats: 1, moves: 5 },
      illegal: { seats: 1, moves: 1 },
    })
  })

  test('lists the games with seats from one address, never the address', async () => {
    nextGame = 1
    await start()
    const a = await student('阿杰')
    const b = await student('小美')
    const c = await student('大壮')
    const two = await game(at('2026-11-02', '20:00:00'), [
      { studentId: a, ip: '1.2.3.4' },
      { studentId: b, ip: '5.6.7.8' },
      { studentId: c, ip: '1.2.3.4' },
    ])
    const three = await game(at('2026-11-03', '20:00:00'), [
      { studentId: a, ip: '9.9.9.9' },
      { studentId: b, ip: '9.9.9.9' },
      { studentId: c, ip: '9.9.9.9' },
    ])
    // Cleared addresses, different ones, and last week's are not listed.
    await game(at('2026-11-03', '21:00:00'), [{ studentId: a, ip: null }, { studentId: b, ip: null }])
    await game(at('2026-11-03', '22:00:00'), [{ studentId: a }, { studentId: b }])
    await game(at('2026-11-01', '22:00:00'), [{ studentId: a, ip: '1.1.1.1' }, { studentId: b, ip: '1.1.1.1' }])

    const reply = await page()
    expect(reply.body).not.toMatch(/1\.2\.3\.4|9\.9\.9\.9|10\.0\.0/)
    const { sameAddress } = (reply.json() as DoudizhuPage).week
    expect(sameAddress.total).toBe(2)
    expect(sameAddress.games.map((g) => [g.gameId, g.ranked, g.students.map((s) => s.studentId)])).toEqual([
      [three, true, [a, b, c]],
      [two, true, [a, c]],
    ])
    expect(sameAddress.games[1]?.endedAt).toBe(at('2026-11-02', '20:00:00').toISOString())
  })

  test('lists the pairs at the most ranked games together, with their points from them', async () => {
    nextGame = 1
    await start()
    const a = await student('阿杰')
    const b = await student('小美')
    const c = await student('大壮')
    const d = await student('小红')
    const seats = (x: number, y: number, z: number, xs: number) => [
      { studentId: x, score: xs },
      { studentId: y, score: -xs / 2 },
      { studentId: z, score: -xs / 2 },
    ]
    await game(at('2026-11-02', '20:00:00'), seats(a, b, c, 4))
    await game(at('2026-11-02', '21:00:00'), seats(a, b, d, 2))
    await game(at('2026-11-03', '20:00:00'), seats(b, a, d, 2))
    // Not ranked, or last week: not counted.
    await game(at('2026-11-03', '21:00:00'), [{ studentId: a }, { studentId: b }])
    await game(at('2026-11-01', '21:00:00'), seats(c, d, a, 4))

    const { pairs } = (await read()).week
    expect(pairs[0]).toMatchObject({ games: 3, points: [4 + 2 - 1, -2 - 1 + 2] })
    expect(pairs[0]?.students.map((s) => s.studentId)).toEqual([a, b])
    expect(pairs.map((p) => [p.students[0].studentId, p.students[1].studentId, p.games])).toEqual([
      [a, b, 3],
      [a, d, 2],
      [b, d, 2],
      [a, c, 1],
      [b, c, 1],
    ])
  })
})
