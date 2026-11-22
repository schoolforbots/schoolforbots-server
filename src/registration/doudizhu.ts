import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { Type } from 'typebox'
import { doudizhuGameRecord, doudizhuGames, doudizhuLeaderboard, doudizhuStats } from '../club/doudizhu-stats.js'
import { isMember } from '../club/members.js'
import { ClubGameList, ClubLeaderboard, DoudizhuGameRecord, DoudizhuStats } from '../protocol/club-http.js'
import type { RegistrationDeps } from './app.js'
import { requireStudent, studentOf } from './auth.js'
import { ApiError } from './errors.js'

// What a student can look up of their doudizhu: their record, the week's leaderboard, their own games a page at a time,
// and the whole record of one of them. The sums are worked out from the stored games when asked
// (`src/club/doudizhu-stats.ts`).
//
// - A record and games are the student's for good: any student with a valid key gets theirs, member or not, whatever
//   their status (as with the summaries and discipline records).
// - The leaderboard is for current members only: anyone else gets a 403 `not_member`. There was an all-time board too;
//   it is gone, and asking for it (`board=all`) gets a 400 that says so, so a plugin that still offers it tells its
//   owner why.
// - A game's record is for the students who played it: anyone else (one who watched it too) gets the 404 `not_found`
//   of a game that does not exist, so nobody learns whether it was played.

const MAX_PG_INTEGER = 2_147_483_647

// `all` is still let through the schema, to be answered with what became of the all-time board; any other value is the
// schema's 400.
const LeaderboardQuery = Type.Object({ board: Type.Optional(Type.Union([Type.Literal('week'), Type.Literal('all')])) })
const NO_ALL_TIME_BOARD = '总榜已经取消，只有本周榜。'
// A query or path value is text. The schemas only turn away a parameter given twice; `gameIdOf` reads the one value.
const GamesQuery = Type.Object({ before: Type.Optional(Type.String()) })
const GameParams = Type.Object({ gameId: Type.String() })

/**
 * A game number in plain digits (no sign, fraction, exponent or spaces), from 1 to the largest a game number can be.
 * Anything else is a 400 `invalid_request`.
 */
function gameIdOf(text: string): number {
  const n = /^[0-9]{1,10}$/.test(text) ? Number(text) : NaN
  if (!(n >= 1 && n <= MAX_PG_INTEGER)) throw new ApiError(400, 'invalid_request')
  return n
}

export function doudizhuRoutes(deps: RegistrationDeps): FastifyPluginAsyncTypebox {
  return async (app) => {
    app.get(
      '/v1/me/clubs/doudizhu/stats',
      { preHandler: requireStudent(deps), schema: { response: { 200: DoudizhuStats } } },
      async (request) => doudizhuStats(deps.db, studentOf(request).id, deps.clock.now(), deps.config.timezone),
    )

    app.get(
      '/v1/me/clubs/doudizhu/leaderboard',
      {
        preHandler: requireStudent(deps),
        schema: { querystring: LeaderboardQuery, response: { 200: ClubLeaderboard } },
      },
      async (request) => {
        if (request.query.board === 'all') throw new ApiError(400, 'invalid_request', {}, NO_ALL_TIME_BOARD)
        const student = studentOf(request)
        // The same members the boards list: a current member, in a class (the boards show the class). Every current
        // member is in one (active or suspended); the class is checked too so that whoever may look could be on it.
        if (student.classId === null || !(await isMember(deps.db, student.id, 'doudizhu'))) {
          throw new ApiError(403, 'not_member')
        }
        return doudizhuLeaderboard(deps.db, deps.config, student.id, deps.clock.now())
      },
    )

    app.get(
      '/v1/me/clubs/doudizhu/games',
      { preHandler: requireStudent(deps), schema: { querystring: GamesQuery, response: { 200: ClubGameList } } },
      async (request) => {
        const { before } = request.query
        return doudizhuGames(deps.db, studentOf(request).id, before === undefined ? null : gameIdOf(before))
      },
    )

    app.get(
      '/v1/me/clubs/doudizhu/games/:gameId',
      { preHandler: requireStudent(deps), schema: { params: GameParams, response: { 200: DoudizhuGameRecord } } },
      async (request) => {
        const record = await doudizhuGameRecord(deps.db, gameIdOf(request.params.gameId), studentOf(request).id)
        if (record === null) throw new ApiError(404, 'not_found')
        return record
      },
    )
  }
}
