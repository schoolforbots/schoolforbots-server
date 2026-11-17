import { type Static, Type } from 'typebox'

// The club WebSocket protocol, `GET /v1/club` upgraded with `Authorization: Bearer <key>`. It has two layers: the club
// layer (connecting, the lobby, rooms, invitations, readiness, idle prompts, bots, trusteeship, reactions, watching),
// which every club shares, and the game layer, whose messages carry `game` (only `"doudizhu"` so far). A new club adds
// a game layer and leaves the club layer as it is. The protocol export publishes these schemas.

const MAX_PG_INTEGER = 2_147_483_647

const PositiveInteger = Type.Integer({ minimum: 1, maximum: MAX_PG_INTEGER })

// ---- Shared types ----

/** The club a connection plays in. Only `"doudizhu"` so far; a new club turns this into a union. */
export const ClubId = Type.Literal('doudizhu')

/**
 * Someone at a club table: a student or a bot. Tell people apart by `studentId` alone; `displayName` is only for
 * showing. A student's `displayName` is put together by the server, e.g. `"阿杰家的小鱼 #0037"` (the student number
 * zero-padded to at least 4 digits). A bot has `studentId: null`, `bot: true` and a name like `"陪练小一"` with no `#`.
 */
export const ClubPerson = Type.Object({
  studentId: Type.Union([PositiveInteger, Type.Null()]),
  displayName: Type.String(),
  bot: Type.Boolean(),
})

/**
 * A `ClubPerson` with the student's class, e.g. `"初中部·晚班·3 班"`; `null` for a bot. Used only in the lobby and on the
 * leaderboards.
 */
export const ClubPersonWithClass = Type.Object({
  studentId: Type.Union([PositiveInteger, Type.Null()]),
  displayName: Type.String(),
  bot: Type.Boolean(),
  className: Type.Union([Type.String(), Type.Null()]),
})

/** A room: a short random string, e.g. `"r7k2q"`, so rooms cannot be guessed in order. Rooms are not kept. */
export const RoomId = Type.String({ pattern: '^r[0-9a-z]{4,15}$' })

/** A game, numbered by the server and kept for good. */
export const GameId = Type.Integer({ minimum: 1, maximum: MAX_PG_INTEGER })

/**
 * The number of one step of a game. Every game action carries the `turn` of the `your_turn` it answers, so an action
 * that comes after its turn is over (say, after a timeout) does not count.
 */
export const Turn = Type.Integer({ minimum: 1, maximum: MAX_PG_INTEGER })

/** The number of a room event, counted per room from 1. */
export const Seq = Type.Integer({ minimum: 1, maximum: MAX_PG_INTEGER })

/** A seat in the club layer. A game narrows it to the seats it has (`Seat` for doudizhu). */
export const ClubSeat = Type.Integer({ minimum: 0, maximum: 9 })

/**
 * A doudizhu seat: 0, 1 or 2. Play goes round 0 → 1 → 2 → 0; the next seat acts after you, the previous one before
 * you. Who acts first is set by the rules, not by the seat number.
 */
export const Seat = Type.Integer({ minimum: 0, maximum: 2 })

/**
 * A card, by rank only: doudizhu never compares suits, so the server sends none. From low to high: `"3"` … `"10"`,
 * `"J"`, `"Q"`, `"K"`, `"A"`, `"2"`, `"小王"` (the black joker), `"大王"` (the red joker).
 */
export const Rank = Type.Union([
  Type.Literal('3'),
  Type.Literal('4'),
  Type.Literal('5'),
  Type.Literal('6'),
  Type.Literal('7'),
  Type.Literal('8'),
  Type.Literal('9'),
  Type.Literal('10'),
  Type.Literal('J'),
  Type.Literal('Q'),
  Type.Literal('K'),
  Type.Literal('A'),
  Type.Literal('2'),
  Type.Literal('小王'),
  Type.Literal('大王'),
])

/** Some cards, 1 to 20 of them (20 is a landlord's hand with the bottom cards). */
export const Cards = Type.Array(Rank, { minItems: 1, maxItems: 20 })

/**
 * The type of a move. `single` 单牌, `pair` 对牌, `trio` 三张, `trio_solo` 三带一, `trio_pair` 三带一对, `straight` 单顺,
 * `pair_straight` 双顺, `trio_straight` 三顺, `plane_solo` 飞机带单, `plane_pair` 飞机带对, `four_two_solo` 四带两单,
 * `four_two_pair` 四带两对, `bomb` 炸弹, `rocket` 火箭.
 */
export const MoveType = Type.Union([
  Type.Literal('single'),
  Type.Literal('pair'),
  Type.Literal('trio'),
  Type.Literal('trio_solo'),
  Type.Literal('trio_pair'),
  Type.Literal('straight'),
  Type.Literal('pair_straight'),
  Type.Literal('trio_straight'),
  Type.Literal('plane_solo'),
  Type.Literal('plane_pair'),
  Type.Literal('four_two_solo'),
  Type.Literal('four_two_pair'),
  Type.Literal('bomb'),
  Type.Literal('rocket'),
])

/** The Chinese name of each move type, which the server sends along with it. */
export const MOVE_TYPE_NAMES: Record<Static<typeof MoveType>, string> = {
  single: '单牌',
  pair: '对牌',
  trio: '三张',
  trio_solo: '三带一',
  trio_pair: '三带一对',
  straight: '单顺',
  pair_straight: '双顺',
  trio_straight: '三顺',
  plane_solo: '飞机带单',
  plane_pair: '飞机带对',
  four_two_solo: '四带两单',
  four_two_pair: '四带两对',
  bomb: '炸弹',
  rocket: '火箭',
}

/** One move: its type, the Chinese name of the type (from `MOVE_TYPE_NAMES`) and its cards, from low rank to high. */
export const Move = Type.Object({
  type: MoveType,
  name: Type.String(),
  cards: Cards,
})
