import { Type } from 'typebox'
import { Cards, ClubId, ClubPerson, ClubStatsSummary, DoudizhuResult, GameId, Seat, TableAction } from './club.js'
import { DateText } from './date-text.js'

// The replies of the club's HTTP API, on the registration service. Playing goes over the club WebSocket
// (`src/protocol/club.ts`); joining a club and looking up records, leaderboards and past games go over HTTP. Joining
// and leaving are online; the routes for records, leaderboards and past games come online later, and these are the
// shapes they will answer with. The protocol export publishes them all with the rest of the HTTP API.

const MAX_PG_INTEGER = 2_147_483_647

const DateTime = Type.String({ format: 'date-time' })
const Count = Type.Integer({ minimum: 0, maximum: MAX_PG_INTEGER })
const PositiveInteger = Type.Integer({ minimum: 1, maximum: MAX_PG_INTEGER })

/**
 * `GET /v1/me/clubs/{club}`, `POST` to join and `DELETE` to leave: whether the student is a member of the club, and
 * since when; `joinedAt` is null when they are not.
 */
export const ClubMembership = Type.Object({
  club: ClubId,
  member: Type.Boolean(),
  joinedAt: Type.Union([DateTime, Type.Null()]),
})

/**
 * When the clubs are closed: `enabled` is false when the school has turned the clubs off, and `closures` lists the
 * times the clubs are closed from now to 24 hours from now. It is the `clubs` field of `SchoolCalendar`.
 */
export const ClubHours = Type.Object({
  enabled: Type.Boolean(),
  closures: Type.Array(Type.Object({ startsAt: DateTime, endsAt: DateTime })),
})

/**
 * `GET /v1/me/clubs/doudizhu/stats` (coming online later): the student's doudizhu record. `games` and `wins` count every
 * game, bots or not; `landlordGames` and `landlordWins` those they were the landlord in. `points` are the points of the
 * ranked games in all and this week (the leaderboards' week), and may be below zero; `rankedGames` is how many ranked
 * games there were. `springs` and `antiSprings` count the games won with a spring or anti-spring, `bombs` and `rockets`
 * the ones the student played, and `maxMultiplier` is the highest multiplier of their games (0 with none). `timeouts`
 * counts the steps that timed out, `trusteeMoves` the steps the trustee made for them, and `illegalMoves` the steps sent
 * back as `illegal_move`. No win rate is sent: work it out from the counts.
 */
export const DoudizhuStats = Type.Object({
  ...ClubStatsSummary.properties,
  landlordGames: Count,
  landlordWins: Count,
  rankedGames: Count,
  springs: Count,
  antiSprings: Count,
  bombs: Count,
  rockets: Count,
  maxMultiplier: Count,
  timeouts: Count,
  trusteeMoves: Count,
  illegalMoves: Count,
})

/** A student on a leaderboard: their rank (students with the same points share it), points and games played. */
export const LeaderboardEntry = Type.Object({
  rank: PositiveInteger,
  studentId: PositiveInteger,
  displayName: Type.String(),
  className: Type.String(),
  points: Type.Integer(),
  games: Count,
})

/**
 * `GET /v1/me/clubs/doudizhu/leaderboard?board=week|all` (coming online later): the week's board or the all-time one.
 * `weekStartsOn` is the first day of the week the board is of, null for the all-time board. `entries` is the top of the
 * board, at most 20. `me` is the student's own entry when they are on the board but not in `entries`, null otherwise.
 * `moreTied` is set when too many tie at the last rank shown to list them all: `count` more share rank `rank`.
 */
export const ClubLeaderboard = Type.Object(
  {
    board: Type.Union([Type.Literal('week'), Type.Literal('all')]),
    weekStartsOn: Type.Union([DateText, Type.Null()]),
    entries: Type.Array(LeaderboardEntry, { maxItems: 20 }),
    me: Type.Union([LeaderboardEntry, Type.Null()]),
    moreTied: Type.Union([Type.Object({ rank: PositiveInteger, count: PositiveInteger }), Type.Null()]),
  },
  {
    if: { properties: { board: { const: 'all' } }, required: ['board'] },
    then: { properties: { weekStartsOn: { type: 'null' } } },
    else: { properties: { weekStartsOn: { type: 'string' } } },
  },
)

/**
 * `GET /v1/me/clubs/doudizhu/games?before=<gameId>` (coming online later): the student's games, newest first, a page at
 * a time. `role` is null for a game with no landlord; `score` is the student's score in it. `nextBefore` is the
 * `before` of the next page, null on the last one.
 */
export const ClubGameList = Type.Object({
  games: Type.Array(
    Type.Object({
      gameId: GameId,
      endedAt: DateTime,
      outcome: DoudizhuResult.properties.outcome,
      role: Type.Union([Type.Literal('landlord'), Type.Literal('farmer'), Type.Null()]),
      score: Type.Integer(),
      multiplier: PositiveInteger,
      ranked: Type.Boolean(),
    }),
  ),
  nextBefore: Type.Union([GameId, Type.Null()]),
})

/**
 * `GET /v1/me/clubs/doudizhu/games/{gameId}` (coming online later): the whole of one game, for the three who played it
 * only. `seats` is who sat where and `dealt` the cards each seat was dealt, both by seat; `bottom` is the bottom cards.
 * `actions` is every step by `turn`. `reacts` are the reactions the whole table saw, with seats for who sent them and
 * whom they named (`to` null for nobody), and `text` what was shown. `result` is how the game ended.
 */
export const DoudizhuGameRecord = Type.Object({
  gameId: GameId,
  startedAt: DateTime,
  endedAt: DateTime,
  seats: Type.Array(ClubPerson, { minItems: 3, maxItems: 3 }),
  dealt: Type.Array(Cards, { minItems: 3, maxItems: 3 }),
  bottom: Cards,
  actions: Type.Array(TableAction),
  reacts: Type.Array(
    Type.Object({
      at: DateTime,
      from: Seat,
      to: Type.Union([Seat, Type.Null()]),
      kind: Type.Union([Type.Literal('emoji'), Type.Literal('phrase'), Type.Literal('text')]),
      content: Type.String(),
      text: Type.String(),
    }),
  ),
  result: DoudizhuResult,
})
