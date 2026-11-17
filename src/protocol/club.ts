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

// ---- Client to server ----

// Every client message carries a client-chosen `id` that the server echoes in its `ack`. Room messages carry no
// `roomId` (but `room.join` and `watch`): a student is in one room at a time, and they act on that room.

const MAX_ID = 64
const MAX_PLUGIN_FIELD = 64
const MAX_REACT_CONTENT = 200

const Id = Type.String({ maxLength: MAX_ID })
const StudentId = PositiveInteger
/** A doudizhu bid: 1 to 3 points, or 0 for no bid. */
const BidValue = Type.Integer({ minimum: 0, maximum: 3 })

/**
 * Must be the first message after connecting. A client that reconnects to the room it was in sends its `roomId` and
 * `lastSeq`, the last room event of that room it has received, and the server replays the room events after it.
 * `lastSeq` means something only with `roomId`, so it may not come without it.
 */
export const ClubHelloMessage = Type.Object(
  {
    id: Id,
    type: Type.Literal('hello'),
    protocol: Type.Literal('v1'),
    plugin: Type.Object({
      type: Type.String({ minLength: 1, maxLength: MAX_PLUGIN_FIELD }),
      version: Type.String({ minLength: 1, maxLength: MAX_PLUGIN_FIELD }),
    }),
    club: ClubId,
    roomId: Type.Optional(RoomId),
    lastSeq: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_PG_INTEGER })),
  },
  { dependentRequired: { lastSeq: ['roomId'] } },
)

/** Asks for the lobby; the server answers with a `lobby` message. */
export const LobbyListMessage = Type.Object({
  id: Id,
  type: Type.Literal('lobby.list'),
})

/**
 * Opens a room and seats you in it as the host. A `public` room is listed in the lobby; an `invite` one is entered only
 * by invitation. `bots: true` fills the free seats with bots at once and the game starts, so `invite` with it is
 * refused with `invalid_message`. `invite` invites up to two club members by student number. The `ack` has
 * `result: { roomId }`.
 */
export const RoomCreateMessage = Type.Object({
  id: Id,
  type: Type.Literal('room.create'),
  visibility: Type.Union([Type.Literal('public'), Type.Literal('invite')]),
  bots: Type.Boolean(),
  invite: Type.Optional(Type.Array(StudentId, { maxItems: 2, uniqueItems: true })),
})

/** Enters a public room, or a room you were invited to. */
export const RoomJoinMessage = Type.Object({
  id: Id,
  type: Type.Literal('room.join'),
  roomId: RoomId,
})

/**
 * Quick join: the server seats you in the public room with a free seat that is closest to full, or opens a public room
 * with you as its host when there is none. The `ack` has `result: { roomId, created }`, `created` true for a new room.
 */
export const RoomQuickMessage = Type.Object({
  id: Id,
  type: Type.Literal('room.quick'),
})

/**
 * Invites the club member whose student number is `to` to the room you are in. The host and every student in the room
 * may invite.
 */
export const RoomInviteMessage = Type.Object({
  id: Id,
  type: Type.Literal('room.invite'),
  to: StudentId,
})

/** Accepts the invitation `inviteId` (from an `invite` message) and enters its room. */
export const RoomAcceptMessage = Type.Object({
  id: Id,
  type: Type.Literal('room.accept'),
  inviteId: PositiveInteger,
})

/** Declines the invitation `inviteId`. */
export const RoomDeclineMessage = Type.Object({
  id: Id,
  type: Type.Literal('room.decline'),
  inviteId: PositiveInteger,
})

/** After a game, says you are ready for the next one. The next game starts when every seat is ready. */
export const RoomReadyMessage = Type.Object({
  id: Id,
  type: Type.Literal('room.ready'),
})

/** Leaves the room and goes back to the lobby. Refused (`game_in_progress`) while a game is being played. */
export const RoomLeaveMessage = Type.Object({
  id: Id,
  type: Type.Literal('room.leave'),
})

/** The answer to an idle prompt (the `idle` room event): bots fill the free seats and the game starts. */
export const RoomBotsMessage = Type.Object({
  id: Id,
  type: Type.Literal('room.bots'),
})

/** Takes your seat back from the trustee, so the server stops acting for you. Any valid game action does it too. */
export const TrusteeOffMessage = Type.Object({
  id: Id,
  type: Type.Literal('trustee.off'),
})

/**
 * A reaction at the table. With `kind: "emoji"`, `content` is one whole entry of the emoji list; with `"phrase"`, the
 * id of a phrase; with `"text"`, the text itself. `to` names someone at the table by student number. `visibility` is
 * `"room"` (the default: the whole table and the spectators see it, `to` or not) or `"private"` (only `to` sees it),
 * and `"private"` needs `to`. Which kinds and visibilities a club allows is in `welcome.reactions`; anything else is
 * refused with `react_not_allowed`.
 */
export const ReactMessage = Type.Object(
  {
    id: Id,
    type: Type.Literal('react'),
    kind: Type.Union([Type.Literal('emoji'), Type.Literal('phrase'), Type.Literal('text')]),
    content: Type.String({ minLength: 1, maxLength: MAX_REACT_CONTENT }),
    to: Type.Optional(StudentId),
    visibility: Type.Optional(Type.Union([Type.Literal('room'), Type.Literal('private')])),
  },
  {
    if: { properties: { visibility: { const: 'private' } }, required: ['visibility'] },
    then: { required: ['to'] },
  },
)

/** Watches a room's game. The `ack` has `result: { room }`, the room's `RoomState`; its room events follow. */
export const WatchMessage = Type.Object({
  id: Id,
  type: Type.Literal('watch'),
  roomId: RoomId,
})

/** Stops watching. */
export const UnwatchMessage = Type.Object({
  id: Id,
  type: Type.Literal('unwatch'),
})

// The doudizhu game layer. Every game action carries `game` and the `turn` copied from the `your_turn` it answers. An
// action whose `turn` is not the current one is refused with `stale_turn`, so an action that comes late (after the
// trustee acted on a timeout, say) never counts. A bid or play taken has the `ack` `result: { turn }`.

/** A bid: 1 to 3 points, or 0 for no bid. */
export const DoudizhuBidMessage = Type.Object({
  id: Id,
  type: Type.Literal('bid'),
  game: Type.Literal('doudizhu'),
  turn: Turn,
  bid: BidValue,
})

/**
 * A play, given one of two ways and never both: `moveId`, the id of a move in the list of the `your_turn`; or `cards`,
 * the cards themselves, with `as` to say which move type they are played as when they could be more than one
 * (`555666777888` is a `trio_straight` without `as`, a `plane_solo` with `as: "plane_solo"`). No other fields are
 * allowed, so a play with both is refused.
 */
export const DoudizhuPlayMessage = Type.Union([
  Type.Object(
    {
      id: Id,
      type: Type.Literal('play'),
      game: Type.Literal('doudizhu'),
      turn: Turn,
      moveId: PositiveInteger,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      id: Id,
      type: Type.Literal('play'),
      game: Type.Literal('doudizhu'),
      turn: Turn,
      cards: Cards,
      as: Type.Optional(MoveType),
    },
    { additionalProperties: false },
  ),
])

/** Passes: plays nothing this trick. */
export const DoudizhuPassMessage = Type.Object({
  id: Id,
  type: Type.Literal('pass'),
  game: Type.Literal('doudizhu'),
  turn: Turn,
})

export const ClubClientMessage = Type.Union([
  ClubHelloMessage,
  LobbyListMessage,
  RoomCreateMessage,
  RoomJoinMessage,
  RoomQuickMessage,
  RoomInviteMessage,
  RoomAcceptMessage,
  RoomDeclineMessage,
  RoomReadyMessage,
  RoomLeaveMessage,
  RoomBotsMessage,
  TrusteeOffMessage,
  ReactMessage,
  WatchMessage,
  UnwatchMessage,
  DoudizhuBidMessage,
  DoudizhuPlayMessage,
  DoudizhuPassMessage,
])
