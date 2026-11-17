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

/** One step of a doudizhu game as the table saw it. `bid` comes only with a bid, `move` only with a play. */
export const TableAction = Type.Object(
  {
    turn: Turn,
    seat: Seat,
    action: Type.Union([Type.Literal('bid'), Type.Literal('play'), Type.Literal('pass')]),
    bid: Type.Optional(BidValue),
    move: Type.Optional(Move),
    auto: Auto,
  },
  {
    dependentSchemas: {
      bid: { properties: { action: { const: 'bid' } } },
      move: { properties: { action: { const: 'play' } } },
    },
  },
)

/**
 * The public state of a doudizhu game: what everyone may see, the spectators too. It holds no hand: only how many cards
 * each seat has left (`cardsLeft`, by seat), the bottom cards once the landlord has taken them (null before), and the
 * moves played. `firstBidder` is who bid first, `landlord` and `base` (the winning bid) are null until the landlord is
 * decided. `multiplier` is the multiplier so far, before the cap. `trick` is the trick being played: `leader` led it,
 * and `last` is the move to beat (null when nobody has played in it yet); `trick` is null outside play. `history` is
 * every step from the first bid on, by `turn`. `trustee` says, by seat, who is in trusteeship. `toAct` is the seat to
 * act and `deadline` its deadline, both null when nobody is to act.
 */
export const DoudizhuTable = Type.Object({
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
})

/**
 * A room as it is now. `host` is the student number of the host. `seats` lists every seat of the room, a free one with
 * `player: null`; `online` is whether the player is connected (bots always are), `trustee` whether the server is acting
 * for them. `spectators` is how many are watching, `gamesPlayed` how many games the room has played. `closesAt` is when
 * the club closes next, and `lastSeq` the `seq` of the room's last event. `game` is the game being played or just over,
 * null before the first; each game's state is told apart by its `game` field.
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
  lastSeq: Seq,
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
 * seat, and each player gets their cards in a `hand` message. `redeal`: nobody bid, so the cards were dealt again
 * (`count` is the how-manyth redeal); after the last redeal allowed, `over` with `no_landlord` follows instead.
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
 * what to show (a phrase's text; for an emoji, the emoji itself); `to` is null when it names nobody. `trustee`: the
 * server started acting for a seat (`on`) after timeouts or as the club closes, or stopped (`off`). `game`: something
 * happened in the game, as the game layer tells it. `closed`: the room closed, after an idle prompt nobody answered
 * (`idle`), when no student was left (`empty`), as the club closed, or for maintenance.
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
  Type.Object({
    kind: Type.Literal('react'),
    from: ClubPerson,
    to: Type.Union([ClubPerson, Type.Null()]),
    reaction: ReactionKind,
    content: Type.String(),
    text: Type.String(),
  }),
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
 * The answer to the client message with the same `id`. A failure carries a machine-readable `error.code` and a Chinese
 * `error.message` the plugin can show the owner. A bid or play taken has `result: { turn }`, the turn it was.
 */
export const ClubAckMessage = Type.Union([
  Type.Object({
    type: Type.Literal('ack'),
    id: Id,
    ok: Type.Literal(true),
    result: Type.Optional(Type.Object({}, { additionalProperties: true })),
  }),
  Type.Object({
    type: Type.Literal('ack'),
    id: Id,
    ok: Type.Literal(false),
    error: Type.Object({ code: Type.String(), message: Type.String() }, { additionalProperties: true }),
  }),
])

/**
 * The doudizhu rules in force, for the plugin to tell its model: `bidRedealLimit`, how many deals in a row nobody may
 * bid on before the game ends with no landlord; `bareTrio`, whether a trio and a trio straight may be played with no
 * kickers; `minPairStraight`, the fewest pairs of a pair straight; `soloKickersMayPair`, whether the single kickers of
 * a plane or a four-with-two may be a pair; `soloKickersMayBeJokers`, whether they may be both jokers; `fourWithTwo`,
 * whether four with two (singles or pairs) is a move; `springDoubles`, whether a spring or anti-spring doubles the
 * multiplier; `cap`, the highest multiplier. Bidding is 1 to 3 points, each seat once, and there is no doubling,
 * open hand or bottom-card multiplier.
 */
export const DoudizhuRules = Type.Object({
  game: Type.Literal('doudizhu'),
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
 * Sent after `hello`: who you are, the club, when it closes next, its limits and reactions, and the rules of its game.
 * `room` is the room you are back in after a reconnect, null otherwise. A development server that plays time
 * compressed may give fractions of seconds and minutes.
 */
export const ClubWelcomeMessage = Type.Object({
  type: Type.Literal('welcome'),
  student: ClubPersonWithClass,
  club: Type.Object({ id: ClubId, name: Type.String() }),
  closesAt: DateTime,
  limits: Type.Object({
    /** The most frames you may send in any minute, every one counted; a frame past it is `rate_limited`. */
    framesPerMinute: Type.Integer({ minimum: 1 }),
    bidSeconds: Seconds,
    playSeconds: Seconds,
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
 * sent again after a reconnect.
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

/** Your cards, sent to you alone: after the deal, after you take the bottom cards, and after a reconnect. */
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
 * just before you) and `right` the seat after you (it acts just after you). `unseen` is the card counter: all the
 * cards less your hand, the cards played and, once shown, the bottom cards. When bidding (`phase: "bid"`), `bids` lists
 * the bids you may make and `moves` is null; when playing, `moves` lists the moves you may play, each with an `id` for
 * `play`, and `bids` is null. `canPass` is whether you may pass. `movesTrimmed` is true when the list was shortened
 * (only one choice of kickers for each move): you may still play other kickers with `cards`.
 */
export const YourTurnMessage = Type.Object({
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
})

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
])
