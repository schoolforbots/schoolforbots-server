import { type Kysely, sql } from 'kysely'
import type { Static } from 'typebox'
import type { ClubGameList, ClubLeaderboard, DoudizhuGameRecord, DoudizhuStats, LeaderboardEntry } from '../protocol/club-http.js'
import type { ClubStatsSummary } from '../protocol/club.js'
import type { SchoolConfig } from '../shared/config.js'
import { className } from '../shared/identity.js'
import { isoWeekday, localDate, startOfLocalDay } from '../shared/local-time.js'
import type { Database } from '../shared/schema.js'
import type { StoredDoudizhuRecord } from './doudizhu-record.js'
import { currentMembers } from './members.js'
import { clubDisplayName } from './people.js'

// What the stored games of doudizhu (`doudizhu_games`, `doudizhu_game_players`) say, worked out by SQL when asked: no
// totals are kept anywhere. A student's record (`doudizhuStats`, and its summary for `welcome.stats`), the two
// leaderboards, a student's own games a page at a time, and the whole record of one game.
//
// - `games` and `wins` count every game, the games with bots too; a game with no landlord counts as a game, not a win.
// - `points.total` is the sum of the student's scores in the ranked games; `points.week` the same over this week's
//   ranked games: those that ended from Monday 00:00 in the school's timezone on (`weekStart`).
// - A student's record and games are theirs for good: they are there whether or not the student is still a member.
//   The leaderboards list only current members (`currentMembers`).

type Stats = Static<typeof DoudizhuStats>
type StatsSummary = Static<typeof ClubStatsSummary>
type Entry = Static<typeof LeaderboardEntry>
type Leaderboard = Static<typeof ClubLeaderboard>
type GameList = Static<typeof ClubGameList>
type GameRecord = Static<typeof DoudizhuGameRecord>
type ListedGame = GameList['games'][number]

/** The highest rank a leaderboard lists, and the most entries it lists. */
export const LEADERBOARD_TOP_RANK = 10
export const LEADERBOARD_MAX_ENTRIES = 20
/** The games on a page of a student's own games. */
export const GAMES_PAGE_SIZE = 20

/** The first instant of the week `now` falls in: Monday 00:00 in `timeZone`. */
export function weekStart(now: Date, timeZone: string): Date {
  return startOfLocalDay(now, timeZone, isoWeekday(localDate(now, timeZone)) - 1)
}

/** A student's whole record, as it stands at `now`. All 0 for a student who never played. */
export async function doudizhuStats(
  db: Kysely<Database>,
  studentId: number,
  now: Date,
  timeZone: string,
): Promise<Stats> {
  const since = weekStart(now, timeZone)
  const row = await db
    .selectFrom('doudizhuGamePlayers')
    .where('studentId', '=', studentId)
    .select([
      sql<string>`count(*)`.as('games'),
      sql<string>`count(*) filter (where won)`.as('wins'),
      sql<string>`coalesce(sum(score) filter (where ranked), 0)`.as('total'),
      sql<string>`coalesce(sum(score) filter (where ranked and ended_at >= ${since}), 0)`.as('week'),
      sql<string>`count(*) filter (where role = 'landlord')`.as('landlordGames'),
      sql<string>`count(*) filter (where role = 'landlord' and won)`.as('landlordWins'),
      sql<string>`count(*) filter (where ranked)`.as('rankedGames'),
      sql<string>`count(*) filter (where spring)`.as('springs'),
      sql<string>`count(*) filter (where anti_spring)`.as('antiSprings'),
      sql<string>`coalesce(sum(bombs), 0)`.as('bombs'),
      sql<string>`coalesce(sum(rockets), 0)`.as('rockets'),
      sql<string>`coalesce(max(multiplier), 0)`.as('maxMultiplier'),
      sql<string>`coalesce(sum(timeouts), 0)`.as('timeouts'),
      sql<string>`coalesce(sum(trustee_moves), 0)`.as('trusteeMoves'),
      sql<string>`coalesce(sum(illegal_moves), 0)`.as('illegalMoves'),
    ])
    .executeTakeFirstOrThrow()
  // count and sum come back as bigint text.
  return {
    games: Number(row.games),
    wins: Number(row.wins),
    points: { total: Number(row.total), week: Number(row.week) },
    landlordGames: Number(row.landlordGames),
    landlordWins: Number(row.landlordWins),
    rankedGames: Number(row.rankedGames),
    springs: Number(row.springs),
    antiSprings: Number(row.antiSprings),
    bombs: Number(row.bombs),
    rockets: Number(row.rockets),
    maxMultiplier: Number(row.maxMultiplier),
    timeouts: Number(row.timeouts),
    trusteeMoves: Number(row.trusteeMoves),
    illegalMoves: Number(row.illegalMoves),
  }
}

/** The summary of a student's record for `welcome.stats`: the same counts as `doudizhuStats`. */
export async function doudizhuStatsSummary(
  db: Kysely<Database>,
  studentId: number,
  now: Date,
  timeZone: string,
): Promise<StatsSummary> {
  const { games, wins, points } = await doudizhuStats(db, studentId, now, timeZone)
  return { games, wins, points }
}

/** A student on a board, before ranking: their points and games over the board's period. */
export type BoardStanding = Omit<Entry, 'rank'>

/** The top of a board, and the student's own entry when it is not in the top: `ClubLeaderboard` without its period. */
export type RankedBoard = Pick<Leaderboard, 'entries' | 'me' | 'moreTied'>

/**
 * Ranks the students on a board, in any order, and picks what the board lists of them; `studentId` is the student
 * asking. Pure.
 *
 * - Ranks are shared on equal points, and the ones after skip as many (50, 40, 40, 30 rank 1, 2, 2, 4). Students with
 *   the same points are listed by student number, lowest first.
 * - `entries` are everyone ranked `LEADERBOARD_TOP_RANK` (10) or better, at most `LEADERBOARD_MAX_ENTRIES` (20) of them.
 * - When more than 20 qualify, the first 20 are listed and `moreTied` says how many of the 20th's rank were left out.
 *   The cut always falls inside a rank: a rank is never more than the place it is at, so the 21st, ranked 10 or better
 *   (it qualifies) and thus better than 21st, must share the 20th's rank. So no rank is ever left out whole, and the
 *   ones left out are exactly the rest of the last rank listed. This holds whichever rank it is: 50 tied at rank 1 list
 *   20 and leave 30 (`moreTied` rank 1, count 30); 9 ranked 1 to 9 and 30 tied at rank 10 list the 9 and 11 of the 30.
 * - `me` is the asking student's entry when they are on the board but not in `entries` (ranked below 10, or one of the
 *   tied left out), null when they are in `entries` or not on the board.
 */
export function rankBoard(standings: readonly BoardStanding[], studentId: number): RankedBoard {
  const sorted = [...standings].sort((a, b) => b.points - a.points || a.studentId - b.studentId)
  const ranked: Entry[] = []
  for (const [i, s] of sorted.entries()) {
    const before = ranked[i - 1]
    const rank = before !== undefined && before.points === s.points ? before.rank : i + 1
    ranked.push({ rank, ...s })
  }
  const qualified = ranked.filter((e) => e.rank <= LEADERBOARD_TOP_RANK)
  const entries = qualified.slice(0, LEADERBOARD_MAX_ENTRIES)
  const last = entries[entries.length - 1]
  const left = qualified.length - entries.length
  const moreTied = left > 0 && last !== undefined ? { rank: last.rank, count: left } : null
  const listed = entries.some((e) => e.studentId === studentId)
  const me = listed ? null : (ranked.find((e) => e.studentId === studentId) ?? null)
  return { entries, me, moreTied }
}

/**
 * The week's board or the all-time one, at `now`, for the student `studentId`. On it are the current members of the
 * club who played at least one ranked game in the period (this week, from `weekStart`; or ever); their points are the
 * sum of their scores in those games, and `games` how many there were. Whether the student asking may see it (a member
 * only) is the caller's to check. Members are shown by name and class as at the club's tables.
 */
export async function doudizhuLeaderboard(
  db: Kysely<Database>,
  config: SchoolConfig,
  board: Leaderboard['board'],
  studentId: number,
  now: Date,
): Promise<Leaderboard> {
  const since = board === 'week' ? weekStart(now, config.timezone) : null
  // Summed in SQL: one row a member, never a row a game. A current member is in a class (active or suspended).
  let query = currentMembers(db, 'doudizhu')
    .innerJoin('classes as c', 'c.id', 's.classId')
    .innerJoin('doudizhuGamePlayers as p', 'p.studentId', 'm.studentId')
    .where('p.ranked', '=', true)
  if (since !== null) query = query.where('p.endedAt', '>=', since)
  const rows = await query
    .groupBy(['s.id', 's.ownerName', 's.aiName', 'c.division', 'c.slot', 'c.classNo'])
    .select([
      's.id',
      's.ownerName',
      's.aiName',
      'c.division',
      'c.slot',
      'c.classNo',
      sql<string>`sum(p.score)`.as('points'),
      sql<string>`count(*)`.as('games'),
    ])
    .execute()
  const standings: BoardStanding[] = rows.map((r) => ({
    studentId: r.id,
    displayName: clubDisplayName(r),
    className: className(r.division, r.slot, r.classNo, config),
    points: Number(r.points),
    games: Number(r.games),
  }))
  return {
    board,
    weekStartsOn: since === null ? null : localDate(since, config.timezone),
    ...rankBoard(standings, studentId),
  }
}

/**
 * The student's own games, newest first (by game number), `GAMES_PAGE_SIZE` a page: those numbered below `before`, or
 * the newest with `before` null. `nextBefore` is the `before` of the next page, null on the last.
 */
export async function doudizhuGames(
  db: Kysely<Database>,
  studentId: number,
  before: number | null,
): Promise<GameList> {
  let query = db
    .selectFrom('doudizhuGamePlayers')
    .select(['gameId', 'endedAt', 'role', 'won', 'score', 'multiplier', 'ranked'])
    .where('studentId', '=', studentId)
  if (before !== null) query = query.where('gameId', '<', before)
  // One more than a page, to tell whether there is another.
  const rows = await query
    .orderBy('gameId', 'desc')
    .limit(GAMES_PAGE_SIZE + 1)
    .execute()
  const page = rows.slice(0, GAMES_PAGE_SIZE)
  const games: ListedGame[] = page.map((r) => ({
    gameId: r.gameId,
    endedAt: r.endedAt.toISOString(),
    // The outcome as the row has it: no landlord, or whether the landlord's side won.
    outcome: r.role === null ? 'no_landlord' : (r.role === 'landlord') === r.won ? 'landlord_won' : 'farmers_won',
    role: r.role,
    score: r.score,
    multiplier: r.multiplier,
    ranked: r.ranked,
  }))
  const lastOfPage = page[page.length - 1]
  return { games, nextBefore: rows.length > GAMES_PAGE_SIZE && lastOfPage !== undefined ? lastOfPage.gameId : null }
}

/**
 * The whole record of game `gameId`, for the student `studentId`: null when there is no such game and when the
 * student did not play in it alike, so that nobody else learns whether it was played.
 */
export async function doudizhuGameRecord(
  db: Kysely<Database>,
  gameId: number,
  studentId: number,
): Promise<GameRecord | null> {
  const row = await db
    .selectFrom('doudizhuGames as g')
    .select(['g.gameId', 'g.startedAt', 'g.endedAt', 'g.record'])
    .where('g.gameId', '=', gameId)
    .where((eb) =>
      eb.exists(
        eb
          .selectFrom('doudizhuGamePlayers as p')
          .select('p.gameId')
          .whereRef('p.gameId', '=', 'g.gameId')
          .where('p.studentId', '=', studentId),
      ),
    )
    .executeTakeFirst()
  if (row === undefined) return null
  // The stored record is the whole one without the game's own columns, with the rules (not shown).
  const { rules: _rules, ...rest } = row.record as unknown as StoredDoudizhuRecord
  return {
    gameId: row.gameId,
    startedAt: row.startedAt.toISOString(),
    endedAt: row.endedAt.toISOString(),
    ...rest,
  }
}
