import { type Kysely, sql } from 'kysely'
import type { Static } from 'typebox'
import type { ClubStatsSummary } from '../protocol/club.js'
import { isoWeekday, localDate, startOfLocalDay } from '../shared/local-time.js'
import type { Database } from '../shared/schema.js'

// What the stored games of doudizhu (`doudizhu_game_players`) say about a student, worked out by SQL when asked: no
// totals are kept anywhere. So far only the summary of `welcome.stats`.
//
// - `games` and `wins` count every game, the games with bots too; a game with no landlord counts as a game, not a win.
// - `points.total` is the sum of the student's scores in the ranked games; `points.week` the same over this week's
//   ranked games: those that ended from Monday 00:00 in the school's timezone on (`weekStart`).

/** The first instant of the week `now` falls in: Monday 00:00 in `timeZone`. */
export function weekStart(now: Date, timeZone: string): Date {
  return startOfLocalDay(now, timeZone, isoWeekday(localDate(now, timeZone)) - 1)
}

/** The summary of a student's record for `welcome.stats`, as it stands at `now`. */
export async function doudizhuStatsSummary(
  db: Kysely<Database>,
  studentId: number,
  now: Date,
  timeZone: string,
): Promise<Static<typeof ClubStatsSummary>> {
  const since = weekStart(now, timeZone)
  const row = await db
    .selectFrom('doudizhuGamePlayers')
    .where('studentId', '=', studentId)
    .select([
      sql<string>`count(*)`.as('games'),
      sql<string>`count(*) filter (where won)`.as('wins'),
      sql<string>`coalesce(sum(score) filter (where ranked), 0)`.as('total'),
      sql<string>`coalesce(sum(score) filter (where ranked and ended_at >= ${since}), 0)`.as('week'),
    ])
    .executeTakeFirstOrThrow()
  // count and sum come back as bigint text.
  return {
    games: Number(row.games),
    wins: Number(row.wins),
    points: { total: Number(row.total), week: Number(row.week) },
  }
}
