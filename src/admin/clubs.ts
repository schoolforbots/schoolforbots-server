import { TypeBoxValidatorCompiler, type TypeBoxTypeProvider } from '@fastify/type-provider-typebox'
import type { FastifyPluginAsync } from 'fastify'
import { sql, type Kysely } from 'kysely'
import type { Static } from 'typebox'
import { Type } from 'typebox'
import { rankAll, weekStandings, weekStart } from '../club/doudizhu-stats.js'
import { currentMembers } from '../club/members.js'
import { clubDisplayName } from '../club/people.js'
import type { LeaderboardEntry } from '../protocol/club-http.js'
import type { SchoolConfig } from '../shared/config.js'
import { className } from '../shared/identity.js'
import { addDaysToDate, atLocalTime, localDate } from '../shared/local-time.js'
import type { Database } from '../shared/schema.js'
import type { AdminDeps } from './app.js'
import { sameTimeOn } from './stats.js'

// The clubs page, one answer for each club, since each has numbers of its own. Doudizhu's: today so far and yesterday,
// each next to the same day a week before, the daily curves up to yesterday, and this week's board and what to look
// into. Everything is counted from the stored games and memberships when the page asks, by the school's calendar day.
//
// - Games: the games that ended that day; those without bots (ranked) and those with (the rest).
// - Players: the different students who played a game that ended that day.
// - New members: the current members who joined that day. Leaving deletes the membership, and joining again starts it
//   anew, so a student who joined and left again is not counted: how many left cannot be told at all.
// - The week runs from Monday 00:00 school time, as the board's does. Its board lists every current member with a
//   ranked game this week, as the students' board would rank them, but all of them up to `BOARD_ROWS`.
// - What to look into this week: how many student seats ran out of time, were played by the trustee or tried an
//   illegal move; the games where two student seats played from one address (the address itself is never shown); and
//   the pairs of students who sat at the most ranked games together.

/** How many entries of the week's board the page lists, and how many games and pairs it lists to look into. */
export const BOARD_ROWS = 50
export const SAME_ADDRESS_ROWS = 20
export const PAIR_ROWS = 10

export interface ClubDay {
  date: string
  games: number
  /** The games without bots. */
  rankedGames: number
  players: number
  newMembers: number
}

/** A student as the page names them: their name in the club, and their class (null once they have none). */
export interface ClubStudent {
  studentId: number
  displayName: string
  className: string | null
}

export interface DoudizhuPage {
  /** Whether the clubs are open (`club.enabled`). */
  enabled: boolean
  /** The current members. */
  members: number
  /** Today from its midnight up to `asOf`. */
  todaySoFar: ClubDay
  /** The same day last week up to the same time of day. */
  sameTimeLastWeek: ClubDay
  asOf: string
  yesterday: ClubDay
  sameDayLastWeek: ClubDay
  /** The `days` days up to yesterday, oldest first. */
  series: ClubDay[]
  week: {
    /** The Monday the week started on. */
    startsOn: string
    board: { entries: Static<typeof LeaderboardEntry>[]; total: number }
    conduct: {
      /** Student seats in the games of the week. */
      seats: number
      timedOut: { seats: number; times: number }
      trustee: { seats: number; moves: number }
      illegal: { seats: number; moves: number }
    }
    /** The games where two student seats (or all three) played from one address, the newest first. */
    sameAddress: {
      total: number
      games: { gameId: number; endedAt: string; ranked: boolean; students: ClubStudent[] }[]
    }
    /** The pairs of students at the most ranked games together, each one's points from those games. */
    pairs: { students: [ClubStudent, ClubStudent]; games: number; points: [number, number] }[]
  }
  timeZone: string
  today: string
}

const emptyDay = (date: string): ClubDay => ({ date, games: 0, rankedGames: 0, players: 0, newMembers: 0 })

/** Every day from `from` to `to` (both included), counted up to `until` when it is given (an instant of `to`). */
async function clubDays(
  db: Kysely<Database>,
  timeZone: string,
  from: string,
  to: string,
  until?: Date,
): Promise<Map<string, ClubDay>> {
  const days = new Map<string, ClubDay>()
  for (let day = from; day <= to; day = addDaysToDate(day, 1)) days.set(day, emptyDay(day))
  const fromAt = atLocalTime(from, '00:00', timeZone)
  const toAt = until ?? atLocalTime(addDaysToDate(to, 1), '00:00', timeZone)
  // Grouped by the first column (`group by 1`), as on the school-data page: the time zone is a parameter.
  const localDay = (column: string) => sql<string>`to_char(${sql.ref(column)} at time zone ${timeZone}, 'YYYY-MM-DD')`

  const games = await db
    .selectFrom('doudizhuGames')
    .select([
      localDay('endedAt').as('day'),
      sql<string>`count(*)`.as('games'),
      sql<string>`count(*) filter (where ranked)`.as('ranked'),
    ])
    .where('endedAt', '>=', fromAt)
    .where('endedAt', '<', toAt)
    .groupBy(sql`1`)
    .execute()
  for (const r of games) {
    const day = days.get(r.day)
    if (day === undefined) continue
    day.games = Number(r.games)
    day.rankedGames = Number(r.ranked)
  }

  const players = await db
    .selectFrom('doudizhuGamePlayers')
    .select([localDay('endedAt').as('day'), sql<string>`count(distinct student_id)`.as('players')])
    .where('endedAt', '>=', fromAt)
    .where('endedAt', '<', toAt)
    .groupBy(sql`1`)
    .execute()
  for (const r of players) {
    const day = days.get(r.day)
    if (day !== undefined) day.players = Number(r.players)
  }

  const joined = await currentMembers(db, 'doudizhu')
    .select([localDay('m.joinedAt').as('day'), sql<string>`count(*)`.as('joined')])
    .where('m.joinedAt', '>=', fromAt)
    .where('m.joinedAt', '<', toAt)
    .groupBy(sql`1`)
    .execute()
  for (const r of joined) {
    const day = days.get(r.day)
    if (day !== undefined) day.newMembers = Number(r.joined)
  }
  return days
}

async function dayUntil(db: Kysely<Database>, timeZone: string, date: string, until: Date): Promise<ClubDay> {
  return (await clubDays(db, timeZone, date, date, until)).get(date) ?? emptyDay(date)
}

/** The students `ids` as the page names them; an id with no student is left out. */
async function studentsByIds(
  db: Kysely<Database>,
  config: SchoolConfig,
  ids: readonly number[],
): Promise<Map<number, ClubStudent>> {
  const unique = [...new Set(ids)]
  if (unique.length === 0) return new Map()
  const rows = await db
    .selectFrom('students as s')
    .leftJoin('classes as c', 'c.id', 's.classId')
    .select(['s.id', 's.ownerName', 's.aiName', 'c.division', 'c.slot', 'c.classNo'])
    .where('s.id', 'in', unique)
    .execute()
  return new Map(
    rows.map((r) => [
      r.id,
      {
        studentId: r.id,
        displayName: clubDisplayName(r),
        className:
          r.division === null || r.slot === null || r.classNo === null
            ? null
            : className(r.division, r.slot, r.classNo, config),
      },
    ]),
  )
}

/** A student the page names who is not found: shown by number only. */
const unknownStudent = (studentId: number): ClubStudent => ({ studentId, displayName: `#${studentId}`, className: null })

async function lookInto(
  db: Kysely<Database>,
  config: SchoolConfig,
  since: Date,
): Promise<Omit<DoudizhuPage['week'], 'startsOn' | 'board'>> {
  const conduct = await db
    .selectFrom('doudizhuGamePlayers')
    .select([
      sql<string>`count(*)`.as('seats'),
      sql<string>`count(*) filter (where timeouts > 0)`.as('timedOutSeats'),
      sql<string>`coalesce(sum(timeouts), 0)`.as('timeouts'),
      sql<string>`count(*) filter (where trustee_moves > 0)`.as('trusteeSeats'),
      sql<string>`coalesce(sum(trustee_moves), 0)`.as('trusteeMoves'),
      sql<string>`count(*) filter (where illegal_moves > 0)`.as('illegalSeats'),
      sql<string>`coalesce(sum(illegal_moves), 0)`.as('illegalMoves'),
    ])
    .where('endedAt', '>=', since)
    .executeTakeFirstOrThrow()

  // A game with seats from one address: one group of them per game (a game has three seats, so at most one address
  // has two or more). Seats whose address was cleared (`club.ipRetentionDays`) are not counted.
  const shared = db
    .selectFrom('doudizhuGamePlayers')
    .select([
      'gameId',
      sql<number[]>`array_agg(student_id order by seat)`.as('studentIds'),
      sql<Date>`max(ended_at)`.as('endedAt'),
      sql<boolean>`bool_and(ranked)`.as('ranked'),
    ])
    .where('endedAt', '>=', since)
    .where('ip', 'is not', null)
    .groupBy(['gameId', 'ip'])
    .having(sql`count(*)`, '>', 1)
  const sharedTotal = await db
    .selectFrom(shared.as('x'))
    .select(sql<string>`count(distinct x.game_id)`.as('games'))
    .executeTakeFirstOrThrow()
  const sharedGames = await shared.orderBy('gameId', 'desc').limit(SAME_ADDRESS_ROWS).execute()

  const pairs = await db
    .selectFrom('doudizhuGamePlayers as a')
    .innerJoin('doudizhuGamePlayers as b', (join) =>
      join.onRef('b.gameId', '=', 'a.gameId').onRef('b.studentId', '>', 'a.studentId'),
    )
    .select([
      'a.studentId as first',
      'b.studentId as second',
      sql<string>`count(distinct a.game_id)`.as('games'),
      sql<string>`sum(a.score)`.as('firstPoints'),
      sql<string>`sum(b.score)`.as('secondPoints'),
    ])
    .where('a.ranked', '=', true)
    .where('a.endedAt', '>=', since)
    .groupBy(['a.studentId', 'b.studentId'])
    .orderBy(sql`count(distinct a.game_id)`, 'desc')
    .orderBy('a.studentId')
    .orderBy('b.studentId')
    .limit(PAIR_ROWS)
    .execute()

  const names = await studentsByIds(db, config, [
    ...sharedGames.flatMap((g) => g.studentIds),
    ...pairs.flatMap((p) => [p.first, p.second]),
  ])
  const named = (id: number) => names.get(id) ?? unknownStudent(id)

  return {
    conduct: {
      seats: Number(conduct.seats),
      timedOut: { seats: Number(conduct.timedOutSeats), times: Number(conduct.timeouts) },
      trustee: { seats: Number(conduct.trusteeSeats), moves: Number(conduct.trusteeMoves) },
      illegal: { seats: Number(conduct.illegalSeats), moves: Number(conduct.illegalMoves) },
    },
    sameAddress: {
      total: Number(sharedTotal.games),
      games: sharedGames.map((g) => ({
        gameId: g.gameId,
        endedAt: new Date(g.endedAt).toISOString(),
        ranked: g.ranked,
        students: g.studentIds.map(named),
      })),
    },
    pairs: pairs.map((p) => ({
      students: [named(p.first), named(p.second)],
      games: Number(p.games),
      points: [Number(p.firstPoints), Number(p.secondPoints)],
    })),
  }
}

/** The doudizhu club's page: today so far, yesterday, the curves of the last `days` days, and this week. */
export async function doudizhuPage(deps: Pick<AdminDeps, 'db' | 'config' | 'clock'>, days: number): Promise<DoudizhuPage> {
  const { db, config, clock } = deps
  const tz = config.timezone
  const now = clock.now()
  const today = localDate(now, tz)
  const yesterday = addDaysToDate(today, -1)
  const lastWeek = addDaysToDate(yesterday, -7)
  const todayLastWeek = addDaysToDate(today, -7)
  const first = addDaysToDate(yesterday, -(days - 1))
  const all = await clubDays(db, tz, lastWeek < first ? lastWeek : first, yesterday)
  const dayOf = (date: string) => all.get(date) ?? emptyDay(date)

  const members = await currentMembers(db, 'doudizhu').select(sql<string>`count(*)`.as('members')).executeTakeFirstOrThrow()
  const since = weekStart(now, tz)
  const ranked = rankAll(await weekStandings(db, config, since))

  const series: ClubDay[] = []
  for (let day = first; day <= yesterday; day = addDaysToDate(day, 1)) series.push(dayOf(day))

  return {
    enabled: config.club.enabled,
    members: Number(members.members),
    todaySoFar: await dayUntil(db, tz, today, now),
    sameTimeLastWeek: await dayUntil(db, tz, todayLastWeek, sameTimeOn(todayLastWeek, now, tz)),
    asOf: now.toISOString(),
    yesterday: dayOf(yesterday),
    sameDayLastWeek: dayOf(lastWeek),
    series,
    week: {
      startsOn: localDate(since, tz),
      board: { entries: ranked.slice(0, BOARD_ROWS), total: ranked.length },
      ...(await lookInto(db, config, since)),
    },
    timeZone: tz,
    today,
  }
}

const DaysQuery = Type.Object({ days: Type.Union([Type.Literal('7'), Type.Literal('30'), Type.Literal('90')]) })

export function clubRoutes(deps: AdminDeps): FastifyPluginAsync {
  return async (instance) => {
    const app = instance.withTypeProvider<TypeBoxTypeProvider>()
    app.setValidatorCompiler(TypeBoxValidatorCompiler)

    app.get('/clubs/doudizhu', { schema: { querystring: DaysQuery } }, async (request) =>
      doudizhuPage(deps, Number(request.query.days)),
    )
  }
}
