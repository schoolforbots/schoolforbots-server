import { type Static, Type } from 'typebox'
import { CLUB_WS_ERROR_MESSAGES, type ClubWsErrorCode } from '../club/ws-errors.js'

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
 * showing. A student has their student number as `studentId` and `bot: false`; their `displayName` is put together by
 * the server, e.g. `"阿杰家的小鱼 #0037"` (the student number zero-padded to at least 4 digits). A bot has
 * `studentId: null`, `bot: true` and a name like `"陪练小一"` with no `#`.
 */
export const ClubPerson = Type.Union([
  Type.Object({ studentId: PositiveInteger, displayName: Type.String(), bot: Type.Literal(false) }),
  Type.Object({ studentId: Type.Null(), displayName: Type.String(), bot: Type.Literal(true) }),
])

/**
 * A `ClubPerson` with the student's class, e.g. `"初中部·晚班·3 班"`; `null` for a bot. Used only in the lobby and on the
 * leaderboards.
 */
export const ClubPersonWithClass = Type.Union([
  Type.Object({
    studentId: PositiveInteger,
    displayName: Type.String(),
    bot: Type.Literal(false),
    className: Type.String(),
  }),
  Type.Object({ studentId: Type.Null(), displayName: Type.String(), bot: Type.Literal(true), className: Type.Null() }),
])

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
 * refused with `invalid_message`. `invite` invites up to two club members by student number. The `ack` has a
 * `RoomResult`, `result: { room }`, the new room's `RoomState`.
 */
export const RoomCreateMessage = Type.Object({
  id: Id,
  type: Type.Literal('room.create'),
  visibility: Type.Union([Type.Literal('public'), Type.Literal('invite')]),
  bots: Type.Boolean(),
  invite: Type.Optional(Type.Array(StudentId, { maxItems: 2, uniqueItems: true })),
})

/**
 * Enters a public room, or a room you were invited to. The `ack` has a `RoomResult`, `result: { room }`, the room's
 * `RoomState`; its room events follow.
 */
export const RoomJoinMessage = Type.Object({
  id: Id,
  type: Type.Literal('room.join'),
  roomId: RoomId,
})

/**
 * Quick join: the server seats you in the public room with a free seat that is closest to full, or opens a public room
 * with you as its host when there is none. The `ack` has a `QuickJoinResult`, `result: { room, created }`: the room's
 * `RoomState`, and `created` true for a new room.
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

/**
 * Accepts the invitation `inviteId` (from an `invite` message) and enters its room. The `ack` has a `RoomResult`,
 * `result: { room }`, the room's `RoomState`.
 */
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

/**
 * Watches a room's game. The `ack` has a `RoomResult`, `result: { room }`, the room's `RoomState`; its room events
 * follow, all but the private reactions, which go only to their sender and the one they name.
 */
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
// trustee acted on a timeout, say) never counts. A bid, play or pass taken has a `TurnResult` in its `ack`,
// `result: { turn }`.

/** A bid: 1 to 3 points, or 0 for no bid. The `ack` has a `TurnResult`, `result: { turn }`. */
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
 * allowed, so a play with both is refused. The `ack` has a `TurnResult`, `result: { turn }`.
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

/** Passes: plays nothing this trick. The `ack` has a `TurnResult`, `result: { turn }`. */
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

// ---- Server to client ----

const DateTime = Type.String({ format: 'date-time' })
const Count = Type.Integer({ minimum: 0, maximum: MAX_PG_INTEGER })
const Seconds = Type.Number({ minimum: 0 })
const ReactionKind = Type.Union([Type.Literal('emoji'), Type.Literal('phrase'), Type.Literal('text')])
const ReactionVisibility = Type.Union([Type.Literal('room'), Type.Literal('private')])

/** Up to 20 cards, or none: what is left of a hand. */
const CardsLeft = Type.Array(Rank, { maxItems: 20 })
/** How many cards a doudizhu seat has left. */
const CardCount = Type.Integer({ minimum: 0, maximum: 20 })
/** The base score of a doudizhu game: the winning bid. */
const Base = Type.Integer({ minimum: 1, maximum: 3 })
/** A doudizhu role; null before the landlord is decided. */
const Role = Type.Union([Type.Literal('landlord'), Type.Literal('farmer'), Type.Null()])

/**
 * Whether the server made this step for the seat, and why: `timeout`, the step timed out and the trustee made it;
 * `trustee`, the seat is in trusteeship; `bot`, the seat is a bot; `closing`, the club closed and the game was played
 * out. Null for a step the seat made itself.
 */
const Auto = Type.Union([
  Type.Null(),
  Type.Literal('timeout'),
  Type.Literal('trustee'),
  Type.Literal('bot'),
  Type.Literal('closing'),
])

/** A field a branch of a union may not carry. */
const Absent = Type.Optional(Type.Never())

/**
 * One step of a doudizhu game as the table saw it, told apart by `action`: a `bid` carries the `bid`, a `play` the
 * `move`, and a `pass` neither.
 */
export const TableAction = Type.Union([
  Type.Object({ turn: Turn, seat: Seat, action: Type.Literal('bid'), bid: BidValue, move: Absent, auto: Auto }),
  Type.Object({ turn: Turn, seat: Seat, action: Type.Literal('play'), move: Move, bid: Absent, auto: Auto }),
  Type.Object({ turn: Turn, seat: Seat, action: Type.Literal('pass'), bid: Absent, move: Absent, auto: Auto }),
])

/**
 * The public state of a doudizhu game: what everyone may see, the spectators too. It holds no hand: only how many cards
 * each seat has left (`cardsLeft`, by seat), the bottom cards once the landlord has taken them (null before, so always
 * null while `landlord` is), and the moves played. `firstBidder` is who bid first, `landlord` and `base` (the winning
 * bid) are null until the landlord is decided. `multiplier` is the multiplier so far, before the cap. `trick` is the
 * trick being played: `leader` led it, and `last` is the move to beat (null when nobody has played in it yet); `trick`
 * is null outside play. `history` is every step of the current deal from its first bid on, by `turn`. `trustee` says,
 * by seat, who is in trusteeship. `toAct` is the seat to act and `deadline` its deadline, both null when nobody is to
 * act. After a `redeal` the same `gameId` goes on with a fresh deal: `firstBidder` is the next seat in rotation, and
 * `bids` and `history` start over, empty.
 */
export const DoudizhuTable = Type.Object(
  {
    game: Type.Literal('doudizhu'),
    gameId: GameId,
    phase: Type.Union([Type.Literal('bidding'), Type.Literal('playing'), Type.Literal('over')]),
    firstBidder: Seat,
    bids: Type.Array(Type.Object({ seat: Seat, bid: BidValue }), { maxItems: 3 }),
    landlord: Type.Union([Seat, Type.Null()]),
    base: Type.Union([Base, Type.Null()]),
    bottom: Type.Union([Cards, Type.Null()]),
    cardsLeft: Type.Array(CardCount, { minItems: 3, maxItems: 3 }),
    multiplier: PositiveInteger,
    trick: Type.Union([
      Type.Object({
        leader: Seat,
        last: Type.Union([Type.Object({ seat: Seat, move: Move }), Type.Null()]),
      }),
      Type.Null(),
    ]),
    history: Type.Array(TableAction),
    trustee: Type.Array(Type.Boolean(), { minItems: 3, maxItems: 3 }),
    toAct: Type.Union([Seat, Type.Null()]),
    deadline: Type.Union([DateTime, Type.Null()]),
  },
  {
    if: { properties: { landlord: { type: 'null' } }, required: ['landlord'] },
    then: { properties: { bottom: { type: 'null' } } },
  },
)

/**
 * A room as it is now. `host` is the student number of the host. `seats` lists every seat of the room, a free one with
 * `player: null`; `online` is whether the player is connected (bots always are), `trustee` whether the server is acting
 * for them. `spectators` is how many are watching, `gamesPlayed` how many games the room has played. `closesAt` is when
 * the club closes next, and `lastSeq` the `seq` of the room's last event, 0 when it has had none yet. `game` is the
 * game being played or just over, null before the first; each game's state is told apart by its `game` field.
 */
export const RoomState = Type.Object({
  roomId: RoomId,
  club: ClubId,
  visibility: Type.Union([Type.Literal('public'), Type.Literal('invite')]),
  host: StudentId,
  seats: Type.Array(
    Type.Object({
      seat: ClubSeat,
      player: Type.Union([ClubPerson, Type.Null()]),
      ready: Type.Boolean(),
      online: Type.Boolean(),
      trustee: Type.Boolean(),
    }),
    { maxItems: 10 },
  ),
  spectators: Count,
  gamesPlayed: Count,
  closesAt: DateTime,
  lastSeq: Type.Integer({ minimum: 0, maximum: MAX_PG_INTEGER }),
  game: Type.Union([DoudizhuTable, Type.Null()]),
})

/**
 * How a doudizhu game ended. `outcome` is `no_landlord` when nobody bid three deals in a row; `landlord` and `base` are
 * then null. `doublings` lists every doubling with its cause (a bomb or rocket played, with the seat that played it; a
 * spring or anti-spring, with no seat). `multiplier` is the multiplier after the cap, `capped` whether the cap cut it.
 * `scores` is each seat's score, by seat, adding up to 0 (all 0 with no landlord). `hands` is the cards each seat had
 * left, by seat. `ranked` is true when the game counts on the leaderboards, which only games without bots do.
 */
export const DoudizhuResult = Type.Object({
  gameId: GameId,
  outcome: Type.Union([Type.Literal('landlord_won'), Type.Literal('farmers_won'), Type.Literal('no_landlord')]),
  landlord: Type.Union([Seat, Type.Null()]),
  base: Type.Union([Base, Type.Null()]),
  doublings: Type.Array(
    Type.Object({
      kind: Type.Union([Type.Literal('bomb'), Type.Literal('rocket'), Type.Literal('spring'), Type.Literal('anti_spring')]),
      seat: Type.Union([Seat, Type.Null()]),
    }),
  ),
  multiplier: PositiveInteger,
  capped: Type.Boolean(),
  scores: Type.Array(Type.Integer(), { minItems: 3, maxItems: 3 }),
  hands: Type.Array(CardsLeft, { minItems: 3, maxItems: 3 }),
  bottom: Type.Union([Cards, Type.Null()]),
  ranked: Type.Boolean(),
})

/**
 * What happened in a doudizhu game, told apart by `kind`. `dealt`: a game was dealt; `seats` is who sits where, by
 * seat, and each player gets their cards in a `hand` message. `redeal`: nobody bid, so the cards are dealt again
 * (`count` is the how-manyth redeal). The same `gameId` goes on: a fresh `dealt` follows with the next first bidder in
 * rotation, each player gets their new cards in a new `hand` message, and the table's `bids` and `history` start over.
 * After the last redeal allowed, `over` with `no_landlord` comes instead of a `redeal`.
 * `landlord`: the landlord is decided and takes the bottom cards, shown to all. `play`: `cardsLeft` is how many cards
 * the seat has left after it, `multiplier` the multiplier after it. `over`: the game is over; it is the summary of the
 * game.
 */
export const DoudizhuEvent = Type.Union([
  Type.Object({
    kind: Type.Literal('dealt'),
    gameId: GameId,
    seats: Type.Array(ClubPerson, { minItems: 3, maxItems: 3 }),
    firstBidder: Seat,
  }),
  Type.Object({ kind: Type.Literal('bid'), turn: Turn, seat: Seat, bid: BidValue, auto: Auto }),
  Type.Object({ kind: Type.Literal('redeal'), count: PositiveInteger }),
  Type.Object({ kind: Type.Literal('landlord'), seat: Seat, base: Base, bottom: Cards }),
  Type.Object({
    kind: Type.Literal('play'),
    turn: Turn,
    seat: Seat,
    move: Move,
    cardsLeft: CardCount,
    multiplier: PositiveInteger,
    auto: Auto,
  }),
  Type.Object({ kind: Type.Literal('pass'), turn: Turn, seat: Seat, auto: Auto }),
  Type.Object({ kind: Type.Literal('over'), result: DoudizhuResult }),
])

/**
 * One thing that happened in a room, told apart by `kind`. `joined` and `left`: someone took or left a seat; `left`
 * says why: they left, they were asked out before an idle prompt for never getting ready (`not_ready`), or they were
 * disconnected while the room waited (`disconnected_idle`). `host`: the host is now `studentId`. `ready`: the seat is
 * ready for the next game. `bots`: bots took the seats `seats`. `idle`: the idle prompt: the room has waited too long,
 * so before `decideBy` someone sends `room.bots` to fill the free seats with bots, or the students go elsewhere; when
 * nobody chooses, the room closes. `react`: a reaction; `reaction` is its kind, `content` what was sent, and `text`
 * what to show (a phrase's text; for an emoji, the emoji itself); `to` is null when it names nobody; `visibility` is
 * `"room"` when the whole table and the spectators see it, or `"private"` when only `to` (never null then) does. A
 * private reaction is still a room event with its own `seq`, but it is sent only to its sender and to `to`, never to
 * the others at the table or the spectators, so they see a gap in `seq` where it was (see `RoomEventMessage`).
 * `trustee`: the server started acting for a seat (`on`) after timeouts or as the club closes, or stopped (`off`).
 * `game`: something happened in the game, as the game layer tells it. `closed`: the room closed, after an idle prompt
 * nobody answered (`idle`), when no student was left (`empty`), as the club closed, or for maintenance.
 */
export const RoomEvent = Type.Union([
  Type.Object({ kind: Type.Literal('joined'), seat: ClubSeat, player: ClubPerson }),
  Type.Object({
    kind: Type.Literal('left'),
    seat: ClubSeat,
    player: ClubPerson,
    reason: Type.Union([Type.Literal('left'), Type.Literal('not_ready'), Type.Literal('disconnected_idle')]),
  }),
  Type.Object({ kind: Type.Literal('host'), studentId: StudentId }),
  Type.Object({ kind: Type.Literal('ready'), seat: ClubSeat }),
  Type.Object({
    kind: Type.Literal('bots'),
    seats: Type.Array(ClubSeat, { minItems: 1, maxItems: 10 }),
    players: Type.Array(ClubPerson, { minItems: 1, maxItems: 10 }),
  }),
  Type.Object({ kind: Type.Literal('idle'), decideBy: DateTime }),
  Type.Object(
    {
      kind: Type.Literal('react'),
      from: ClubPerson,
      to: Type.Union([ClubPerson, Type.Null()]),
      reaction: ReactionKind,
      content: Type.String(),
      text: Type.String(),
      visibility: ReactionVisibility,
    },
    {
      if: { properties: { visibility: { const: 'private' } }, required: ['visibility'] },
      then: { properties: { to: { type: 'object' } } },
    },
  ),
  Type.Object({
    kind: Type.Literal('trustee'),
    seat: ClubSeat,
    on: Type.Boolean(),
    reason: Type.Union([Type.Literal('timeouts'), Type.Literal('off'), Type.Literal('closing')]),
  }),
  Type.Object({ kind: Type.Literal('game'), game: Type.Literal('doudizhu'), event: DoudizhuEvent }),
  Type.Object({
    kind: Type.Literal('closed'),
    reason: Type.Union([
      Type.Literal('idle'),
      Type.Literal('empty'),
      Type.Literal('club_closed'),
      Type.Literal('maintenance'),
    ]),
  }),
])

/**
 * The `error` of a failed `ack` for a bid or play against the rules (`illegal_move`). The step does not count, nothing
 * is lost for it, and nobody else is told. `message` is always the same sentence; `problem` says what was wrong, for
 * programs: `unknown_move`, the `moveId` is not in the list of this `your_turn`; `not_in_hand`, the cards are not all
 * in your hand (`missing` is the cards short, counted card by card: three 7s with two in hand is `["7"]`); `not_a_type`,
 * the cards make no move type; `type_mismatch`, the cards cannot be played as the `as` given; `cannot_beat`, the move
 * does not beat the move to beat, `toBeat` (another type or count, or not high enough); `must_play`, you lead this
 * trick and may not pass; `bid_too_low`, the bid is not above the bids before it (a bid of 0 always is). `reason` says
 * the same in Chinese, for the model to read as is. `retry` is the same turn, still open: send a step again with its
 * `turn` before `deadline`, as often as the frame limit allows; past it, the step times out as usual. A step that is not
 * yours (`not_your_turn`) or whose turn is over (`stale_turn`) is not `illegal_move` and cannot be sent again: wait for
 * the next `your_turn`.
 */
export const IllegalMoveError = Type.Object(
  {
    code: Type.Literal('illegal_move'),
    message: Type.String(),
    problem: Type.Union([
      Type.Literal('unknown_move'),
      Type.Literal('not_in_hand'),
      Type.Literal('not_a_type'),
      Type.Literal('type_mismatch'),
      Type.Literal('cannot_beat'),
      Type.Literal('must_play'),
      Type.Literal('bid_too_low'),
    ]),
    reason: Type.String(),
    missing: Type.Optional(Cards),
    toBeat: Type.Optional(Type.Object({ seat: Seat, move: Move })),
    retry: Type.Object({ turn: Turn, deadline: DateTime, timeBankSeconds: Seconds }),
  },
  {
    dependentSchemas: {
      missing: { properties: { problem: { const: 'not_in_hand' } } },
      toBeat: { properties: { problem: { const: 'cannot_beat' } } },
    },
    allOf: [
      {
        if: { properties: { problem: { const: 'not_in_hand' } }, required: ['problem'] },
        then: { required: ['missing'] },
      },
      {
        if: { properties: { problem: { const: 'cannot_beat' } }, required: ['problem'] },
        then: { required: ['toBeat'] },
      },
    ],
  },
)

/** The `result` of the `ack` of `room.create`, `room.join`, `room.accept` and `watch`: the room's `RoomState`. */
export const RoomResult = Type.Object({ room: RoomState })

/**
 * The `result` of the `ack` of `room.quick`: the room's `RoomState`, and `created`, true when a new room was opened for
 * you.
 */
export const QuickJoinResult = Type.Object({ room: RoomState, created: Type.Boolean() })

/** The `result` of the `ack` of a game action taken (`bid`, `play` or `pass`): the turn it was. */
export const TurnResult = Type.Object({ turn: Turn })

/** Every club error code but `illegal_move`, which comes as an `IllegalMoveError`. */
const PlainErrorCode = Type.Union(
  (Object.keys(CLUB_WS_ERROR_MESSAGES) as ClubWsErrorCode[])
    .filter((code): code is Exclude<ClubWsErrorCode, 'illegal_move'> => code !== 'illegal_move')
    .map((code) => Type.Literal(code)),
)

/**
 * The answer to the client message with the same `id`. A failure carries a machine-readable `error.code` and a Chinese
 * `error.message` the plugin can show the owner (the codes are listed with the protocol); an `illegal_move` is an
 * `IllegalMoveError`, and any other code is a plain error with no `problem` or `retry`. A success carries a `result`
 * for some messages: a `RoomResult` for `room.create`, `room.join`, `room.accept` and `watch`, a `QuickJoinResult` for
 * `room.quick`, and a `TurnResult` for `bid`, `play` and `pass`; the others have none.
 */
export const ClubAckMessage = Type.Union([
  Type.Object({
    type: Type.Literal('ack'),
    id: Id,
    ok: Type.Literal(true),
    result: Type.Optional(Type.Union([RoomResult, QuickJoinResult, TurnResult])),
  }),
  Type.Object({
    type: Type.Literal('ack'),
    id: Id,
    ok: Type.Literal(false),
    error: Type.Union([
      IllegalMoveError,
      Type.Object(
        { code: PlainErrorCode, message: Type.String(), problem: Absent, retry: Absent },
        { additionalProperties: true },
      ),
    ]),
  }),
])

/**
 * The doudizhu rules in force, for the plugin to tell its model: `bidSeconds` and `playSeconds`, the time for a bid and
 * for a play or pass before the time bank is spent; `bidRedealLimit`, how many deals in a row nobody may
 * bid on before the game ends with no landlord; `bareTrio`, whether a trio and a trio straight may be played with no
 * kickers; `minPairStraight`, the fewest pairs of a pair straight; `soloKickersMayPair`, whether the single kickers of
 * a plane or a four-with-two may be a pair; `soloKickersMayBeJokers`, whether they may be both jokers; `fourWithTwo`,
 * whether four with two (singles or pairs) is a move; `springDoubles`, whether a spring or anti-spring doubles the
 * multiplier; `cap`, the highest multiplier. Bidding is 1 to 3 points, each seat once, and there is no doubling,
 * open hand or bottom-card multiplier.
 */
export const DoudizhuRules = Type.Object({
  game: Type.Literal('doudizhu'),
  bidSeconds: Seconds,
  playSeconds: Seconds,
  bidRedealLimit: PositiveInteger,
  bareTrio: Type.Boolean(),
  minPairStraight: Type.Integer({ minimum: 2, maximum: 10 }),
  soloKickersMayPair: Type.Boolean(),
  soloKickersMayBeJokers: Type.Boolean(),
  fourWithTwo: Type.Boolean(),
  springDoubles: Type.Boolean(),
  cap: PositiveInteger,
})

/**
 * A summary of the student's record in the club: the games played and won, and the points in all and this week (points
 * may be below zero). The full record is on the club's HTTP API.
 */
export const ClubStatsSummary = Type.Object({
  games: Count,
  wins: Count,
  points: Type.Object({ total: Type.Integer(), week: Type.Integer() }),
})

/**
 * Sent after `hello`: who you are, the club, when it closes next, its limits and reactions, the summary of your record
 * and the rules of its game. `limits` are the club layer's, the same for every game; the time for each step of a game
 * is the game's own, in `rules`. `room` is the room you are back in after a reconnect, null otherwise. A development
 * server that plays time compressed may give fractions of seconds and minutes.
 */
export const ClubWelcomeMessage = Type.Object({
  type: Type.Literal('welcome'),
  student: ClubPersonWithClass,
  club: Type.Object({ id: ClubId, name: Type.String() }),
  closesAt: DateTime,
  limits: Type.Object({
    /** The most frames you may send in any minute, every one counted; a frame past it is `rate_limited`. */
    framesPerMinute: Type.Integer({ minimum: 1 }),
    /** Extra time for a whole game, spent when a step runs past its own time; the trustee acts when it is gone. */
    timeBankSeconds: Seconds,
    inviteSeconds: Seconds,
    idleMinutes: Seconds,
    idleDecideSeconds: Seconds,
    maxSpectators: Count,
    reactMinIntervalSeconds: Seconds,
    reactsPerGame: Count,
  }),
  /**
   * The reactions this club allows: the kinds, the visibilities, the emoji list (each entry is sent whole) and the
   * phrases, by id.
   */
  reactions: Type.Object({
    kinds: Type.Array(ReactionKind, { uniqueItems: true }),
    visibility: Type.Array(ReactionVisibility, { uniqueItems: true }),
    emoji: Type.Array(Type.String()),
    phrases: Type.Array(Type.Object({ id: Type.String(), text: Type.String() })),
  }),
  stats: ClubStatsSummary,
  rules: DoudizhuRules,
  room: Type.Union([RoomState, Type.Null()]),
})

/**
 * The lobby: the public rooms that have a free seat and are not playing, at most 50. `seatsFree` is how many seats are
 * free, `bots` whether bots sit in the room.
 */
export const LobbyMessage = Type.Object({
  type: Type.Literal('lobby'),
  rooms: Type.Array(
    Type.Object({
      roomId: RoomId,
      host: ClubPersonWithClass,
      seatsFree: Type.Integer({ minimum: 1, maximum: 9 }),
      bots: Type.Boolean(),
      gamesPlayed: Count,
    }),
    { maxItems: 50 },
  ),
})

/** Someone invites you to their room; answer with `room.accept` or `room.decline` before `expiresAt`. */
export const InviteMessage = Type.Object({
  type: Type.Literal('invite'),
  inviteId: PositiveInteger,
  from: ClubPersonWithClass,
  roomId: RoomId,
  expiresAt: DateTime,
})

/** Sent to the one who invited: how the invitation `inviteId` ended. */
export const InviteEndedMessage = Type.Object({
  type: Type.Literal('invite.ended'),
  inviteId: PositiveInteger,
  reason: Type.Union([
    Type.Literal('accepted'),
    Type.Literal('declined'),
    Type.Literal('expired'),
    Type.Literal('room_closed'),
  ]),
})

/**
 * One thing that happened in a room you sit in or watch. `seq` counts from 1 within the room; `replayed` marks events
 * sent again after a reconnect. A private reaction is a room event sent only to its sender and the one it names, never
 * to the others at the table or the spectators, so the `seq` you see may skip: a gap is not lost events, and a client
 * must not treat it as such.
 */
export const RoomEventMessage = Type.Object({
  type: Type.Literal('room.event'),
  roomId: RoomId,
  seq: Seq,
  replayed: Type.Boolean(),
  at: DateTime,
  event: RoomEvent,
})

/**
 * You are out of the room and back in the lobby: you left it, you were asked out for never getting ready
 * (`not_ready`), or it closed.
 */
export const RoomLeftMessage = Type.Object({
  type: Type.Literal('room.left'),
  roomId: RoomId,
  reason: Type.Union([Type.Literal('left'), Type.Literal('not_ready'), Type.Literal('closed')]),
})

/**
 * Your cards, sent to you alone and only while a game is in progress: after the deal, after you take the bottom cards
 * as the landlord, and after a reconnect during a game. Never sent when your hand is empty.
 */
export const HandMessage = Type.Object({
  type: Type.Literal('hand'),
  roomId: RoomId,
  game: Type.Literal('doudizhu'),
  gameId: GameId,
  cards: Cards,
})

/** A seat beside you as `your_turn` tells it. */
const Neighbour = Type.Object({ seat: Seat, player: ClubPerson, role: Role, cardsLeft: CardCount })

/**
 * Sent to you alone when it is your turn, with everything to decide on. Answer with `bid`, `play` or `pass` carrying
 * this `turn` before `deadline`; past it, `timeBankSeconds` of time bank is spent, and then the trustee acts.
 * `closesAt` is when the club closes next. `me` is your seat, role and hand. `left` is the seat before you (it acts
 * just before you) and `right` the seat after you (it acts just after you). `unseen` is the card counter: the cards
 * that are neither in your hand nor played yet. While bidding that is the other two hands and the bottom cards; once
 * the landlord takes the bottom cards they are part of the landlord's hand and count until played, so `unseen` is then
 * the cards still in the other two hands. When bidding (`phase: "bid"`), `bids` lists
 * the bids you may make and `moves` is null; when playing, `moves` lists the moves you may play, each with an `id` for
 * `play`, and `bids` is null. `canPass` is whether you may pass; never when bidding, where a bid of 0 is no bid.
 * `movesTrimmed` is true when the list was shortened (only one choice of kickers for each move): you may still play
 * other kickers with `cards`. `phase` here is the step asked of you, `"bid"` or `"play"`; it is not `table.phase`,
 * the phase of the game, which is `"bidding"`, `"playing"` or `"over"`.
 */
export const YourTurnMessage = Type.Object(
  {
    type: Type.Literal('your_turn'),
    roomId: RoomId,
    game: Type.Literal('doudizhu'),
    gameId: GameId,
    turn: Turn,
    phase: Type.Union([Type.Literal('bid'), Type.Literal('play')]),
    deadline: DateTime,
    timeBankSeconds: Seconds,
    closesAt: DateTime,
    me: Type.Object({ seat: Seat, role: Role, hand: Cards }),
    left: Neighbour,
    right: Neighbour,
    table: DoudizhuTable,
    unseen: Type.Array(Rank, { maxItems: 54 }),
    bids: Type.Union([Type.Array(BidValue, { minItems: 1, maxItems: 4, uniqueItems: true }), Type.Null()]),
    moves: Type.Union([
      Type.Array(Type.Object({ id: PositiveInteger, type: MoveType, name: Type.String(), cards: Cards })),
      Type.Null(),
    ]),
    canPass: Type.Boolean(),
    movesTrimmed: Type.Boolean(),
  },
  {
    if: { properties: { phase: { const: 'bid' } }, required: ['phase'] },
    then: { properties: { bids: { type: 'array' }, moves: { type: 'null' }, canPass: { const: false } } },
    else: { properties: { bids: { type: 'null' }, moves: { type: 'array' } } },
  },
)

/**
 * Sent right before the server closes the connection; `message` is Chinese text the plugin can show the owner.
 * `replaced`: another connection with the same key took over; do not reconnect on your own, or the two take turns
 * pushing each other out. `club_closed`: the club is closed now; `reopensAt` is when it opens next, absent when that
 * is not known, and comes with this reason and with no other; reconnect then. `maintenance`: the school's operator has
 * it under maintenance; `message` is what the operator wrote, and `expectedBackAt` the moment the school is expected
 * back, null when no time is known; it comes with this reason and with no other. `suspended`: the student is suspended
 * and may not come until the suspension ends. `expelled`: the student has been expelled, and will not be let in again.
 * `not_member`: the student is not a club member, or is not a student in good standing (withdrawn, expelled or in no
 * class); `message` says which; reconnect only once that has changed. `service_stopping`: no `hello` came in time, or
 * the service is restarting; reconnect a little later.
 */
export const ClubClosingMessage = Type.Object(
  {
    type: Type.Literal('closing'),
    reason: Type.Union([
      Type.Literal('replaced'),
      Type.Literal('club_closed'),
      Type.Literal('maintenance'),
      Type.Literal('suspended'),
      Type.Literal('expelled'),
      Type.Literal('not_member'),
      Type.Literal('service_stopping'),
    ]),
    message: Type.String(),
    reopensAt: Type.Optional(DateTime),
    expectedBackAt: Type.Optional(Type.Union([DateTime, Type.Null()])),
  },
  {
    dependentSchemas: {
      reopensAt: { properties: { reason: { const: 'club_closed' } } },
      expectedBackAt: { properties: { reason: { const: 'maintenance' } } },
    },
  },
)

export const ClubServerMessage = Type.Union([
  ClubAckMessage,
  ClubWelcomeMessage,
  LobbyMessage,
  InviteMessage,
  InviteEndedMessage,
  RoomEventMessage,
  RoomLeftMessage,
  HandMessage,
  YourTurnMessage,
  ClubClosingMessage,
])
