import type { Static } from 'typebox'
import type {
  ClubClientMessage,
  ClubId,
  ClubPerson,
  ClubServerMessage,
  ClubStatsSummary,
  ClubWelcomeMessage,
  RoomEvent,
  RoomState,
} from '../protocol/club.js'
import type { ClubWsErrorCode } from './ws-errors.js'

// The seam between the club layer and a game. The club layer owns the connections, the rooms, the seats, the lobby,
// invitations, reactions and watching; a game owns everything that happens between the deal and the end of one game:
// whose turn it is, what is legal, the clock of each step, the trustee, and what each seat may see.
//
// The club layer never looks inside what a game gives it. It numbers the game's room events (`seq`), keeps them with
// the room's other events, sends each event to the room (the seats and the spectators) and each private message to
// the seat it is for, and puts the game's public table into `RoomState.game`. So whatever a game sends, it alone is
// responsible for what it shows: a private message reaches its seat and nobody else, a room event reaches everyone in
// the room, spectators included, and a reconnect replays both (see `GameSession.resend`).
//
// A game is driven only by calls: a session never sets a timer of its own and never reads the clock, it is given
// `now` on every call. The club layer calls `tick` about once a second, which is when timeouts happen. Everything is
// synchronous: the room logic runs one call at a time and needs the result at once. A game that has to store
// something (a game record, the stats) does it on its own, without making the club layer wait.
//
// Seats are numbered from 0 to `GameModule.seats - 1`, and a session's seat numbers are the room's. The club layer
// knows nothing of how many seats a game has but `seats`.

// ---- Acks ----

/**
 * What the club layer answers a client message with, made into an `ack` (see `ClubAckMessage`). A failure names a
 * `ClubWsErrorCode`; the club layer adds the Chinese `message` of the code. `extra` holds the fields an error carries
 * beyond `code` and `message`: for `illegal_move`, every other field of `IllegalMoveError` (`problem`, `reason`,
 * `retry`, and `missing` or `toBeat`); no other code has any. `extra` never replaces `code` or `message`. A success
 * may carry a `result`: for a game action taken, a `TurnResult`.
 */
export type AckResult = { ok: true; result?: object } | { ok: false; code: ClubWsErrorCode; extra?: object }

// ---- What a game takes and gives ----

type ClientMessage = Static<typeof ClubClientMessage>
type ServerMessage = Static<typeof ClubServerMessage>

/**
 * A client message of the game layer: one that carries `game` (`bid`, `play` and `pass` for doudizhu). The club layer
 * hands it to the session of the room the student sits in, as it came, after checking it against the protocol.
 * `trustee.off` is a club-layer message and goes to `GameSession.trusteeOff` instead.
 */
export type GameClientMessage = Extract<ClientMessage, { game: string }>

/**
 * A room event that belongs to the game: `game` (what happened in the game) and `trustee` (the trustee took a seat or
 * gave it back). It is the `event` of a `room.event`; the club layer adds `roomId`, `seq`, `at` and `replayed`.
 */
export type GameRoomEvent = Extract<Static<typeof RoomEvent>, { kind: 'game' | 'trustee' }>

/**
 * A message for one seat alone, sent as it is: `hand` and `your_turn` for doudizhu. It carries the room's `roomId`
 * (from `SessionStart.roomId`). Spectators never get one.
 */
export type GamePrivateMessage = Extract<ServerMessage, { type: 'hand' | 'your_turn' }>

/** The public state of a game, for `RoomState.game`. */
export type GameTable = NonNullable<Static<typeof RoomState>['game']>

/** One thing a game has to send: a room event, or a private message for one seat. */
export type GameEmit =
  | { readonly to: 'room'; readonly event: GameRoomEvent }
  | { readonly to: 'seat'; readonly seat: number; readonly message: GamePrivateMessage }

/**
 * What a call to a session gave: what to send, in the order to send it (a `dealt` event before the `hand` of each
 * seat, a `play` before the next seat's `your_turn`), and whether the game is over now. A room event and a private
 * message keep their order relative to each other. Once a call gives `over: true`, every later call gives it too.
 */
export interface GameOutput {
  readonly emits: readonly GameEmit[]
  readonly over: boolean
}

/** A call that answers a client message: the ack for it, and what it made happen (nothing when refused). */
export interface GameReply {
  readonly ack: AckResult
  readonly output: GameOutput
}

/** A seat and who sits in it: a student or a bot (see `people.ts`). */
export type SeatPlayer = Static<typeof ClubPerson>

/** Everything a new session is given. */
export interface SessionStart {
  /** The room the game is played in; every private message carries it. */
  readonly roomId: string
  /**
   * Who sits where, by seat: `players[i]` sits in seat i, and there are exactly `GameModule.seats` of them. A bot
   * (`bot: true`) is played by the game itself, at once, every step; a student is asked with private messages. The
   * players do not change during a game: a student who disconnects keeps the seat, and nobody leaves mid-game.
   */
  readonly players: readonly SeatPlayer[]
  /**
   * The room's session before this one, null for the room's first game. A game that goes on from game to game (the
   * first bidder goes round, for doudizhu) reads what it needs from it. The seats may be taken by others since; the
   * seat numbers stay.
   */
  readonly previous: GameSession | null
  /**
   * When the club closes next, seen from `now` (`welcome.closesAt`, `your_turn.closesAt`). The club layer closes the
   * club at that moment and calls `finish`; the game only shows the time.
   */
  readonly closesAt: (now: Date) => Date
  readonly now: Date
}

/**
 * One game played in one room, from the deal to the end. The room calls `start` once, then any of the others until
 * `over`, and keeps the session after it is over (for `table`, `resend` and the next game's `previous`) until the
 * next game starts or the room closes. Every call is given the time it happens at; none waits.
 */
export interface GameSession {
  /** Deals, and plays the bots' steps up to the first student to act. Called once, right after `newSession`. */
  start(now: Date): GameOutput
  /**
   * A game-layer message from the student in `seat`. The ack is the game's: `TurnResult` when the step is taken;
   * `not_your_turn`, `stale_turn`, `illegal_move` (with its fields in `extra`) or `invalid_message` when not. A step
   * taken also takes the seat back from the trustee, and the bots after it play at once. After `over`, every message is
   * refused, with `stale_turn` for doudizhu.
   */
  handle(seat: number, message: GameClientMessage, now: Date): GameReply
  /**
   * `trustee.off` from the student in `seat`: the seat is the student's again. `not_trustee` when it was not in
   * trusteeship (or the game is over).
   */
  trusteeOff(seat: number, now: Date): GameReply
  /**
   * Called about once a second while the game is not over: whatever is due by `now` (a step that timed out, the
   * trustee's step, a bot that waits before it plays). Nothing, most of the time.
   */
  tick(now: Date): GameOutput
  /**
   * The club closes (or goes under maintenance) and the game cannot wait: every student seat goes to the trustee and
   * the game is played to its end at once, the steps marked `auto: "closing"`. Afterwards `over` is true. Sends no
   * private messages. Nothing happens when the game is over already.
   */
  finish(now: Date): GameOutput
  /**
   * What the student in `seat` is sent again after a reconnect, after the room events it missed: what it alone may
   * know and still needs (doudizhu: its `hand`, and its `your_turn` when it is to act, with the same `turn` and
   * deadline as before). Nothing once the game is over, and nothing for a bot's seat.
   */
  resend(seat: number, now: Date): GamePrivateMessage[]
  /** The public table now (`RoomState.game`): what everyone in the room, spectators too, may see. */
  table(): GameTable
  /** Whether the seat is in trusteeship now (`RoomState.seats[].trustee`); always false for a bot. */
  trustee(seat: number): boolean
  readonly over: boolean
}

type Welcome = Static<typeof ClubWelcomeMessage>

/** A game the club layer can host: what it tells a student at `welcome`, and how to start a session of it. */
export interface GameModule {
  /** The club it is the game of; a connection's `hello.club`. */
  readonly club: Static<typeof ClubId>
  /** The club's name for `welcome.club.name`, e.g. `"斗地主社"`. */
  readonly name: string
  /** How many seats a table has. A room starts a game when they are all taken (and ready). */
  readonly seats: number
  /** The kinds and visibilities of reactions the game allows (`welcome.reactions`, and what `react` may use). */
  readonly reactions: {
    readonly kinds: Welcome['reactions']['kinds']
    readonly visibility: Welcome['reactions']['visibility']
  }
  /** The rules in force, for `welcome.rules`. */
  rules(): Welcome['rules']
  /** The summary of a student's record, for `welcome.stats`. */
  stats(studentId: number): Promise<Static<typeof ClubStatsSummary>>
  /** A new game for the players in `start.players`; nothing happens until `start` is called on it. */
  newSession(start: SessionStart): GameSession
}
