import { randomInt as cryptoRandomInt } from 'node:crypto'
import type { Static } from 'typebox'
import type { RoomEvent, RoomState } from '../protocol/club.js'
import type { SchoolConfig } from '../shared/config.js'
import type {
  AckResult,
  GameClientMessage,
  GameModule,
  GameOutput,
  GamePrivateMessage,
  GameReaction,
  GameSession,
} from './game.js'
import { nextClose } from './hours.js'
import { type LobbyFrame, lobbyMessage, quickJoinRoom, type RoomSummary } from './lobby.js'
import type { Outbox, RoomEventFrame } from './outbox.js'
import { newBots, type Person, type StudentPersonWithClass, withoutClass } from './people.js'

// The club's rooms, in memory only: seats, the host, readiness, the room events and their `seq`, starting games, the
// idle prompt, the grace a disconnected student is given, and closing. Nothing here touches a connection or the
// database: every call is given who acts (`ClubStudent`, looked up by the caller) and the time, and what is to be sent
// goes to the `Outbox`. Whatever depends on time passing (a disconnected student's grace, the idle prompt and its
// `decideBy`, the game's own timeouts) happens in `tick`, which the service calls about once a second.
//
// A student sits in one room at a time. A room lives while a student sits in it: when the last one goes, it closes
// (`empty`) and is forgotten, as are the rooms closed for any other reason, so the memory held is bounded by the
// students connected (and the grace of those who are not).
//
// The ack of a call that seats a student (`create`, `join`, `quick`) carries the room's state as it was right after
// they sat down, with `lastSeq` the `seq` of their own `joined` event; that event is not sent to them, and every room
// event after it is (the bots, the deal …), after the ack (see `outbox.ts`).

type RoomEventBody = Static<typeof RoomEvent>
type RoomStateFrame = Static<typeof RoomState>
type Visibility = RoomStateFrame['visibility']

/** Why a room closed (`closed` room event). */
export type CloseReason = Extract<RoomEventBody, { kind: 'closed' }>['reason']

/**
 * Why a room is gone, for the listeners: a `CloseReason`, or `failed` for a room closed because its tick kept failing.
 * The protocol has no reason for that, so such a room sends no `closed` event: its students get `room.left`
 * (`closed`), and its spectators just stop watching.
 */
export type GoneReason = CloseReason | 'failed'

/** Why a seat was left (`left` room event). */
type LeftReason = Extract<RoomEventBody, { kind: 'left' }>['reason']

/** A student as the rooms see them, looked up by the caller (see `people.ts` for `person`). */
export interface ClubStudent {
  readonly person: StudentPersonWithClass
  /**
   * The owner's email, as the database keeps it (trimmed and lower-cased). Two students with the same one have the
   * same owner, and never sit in the same room.
   */
  readonly email: string
  /**
   * The address of the connection the student came in on; null or absent when not known. Only for the game (see
   * `SessionStart.addresses`): never sent to anyone.
   */
  readonly address?: string | null
}

/** Hooks for what the other parts of the club (invitations, reactions, watching) need to hear of. */
export interface RoomListeners {
  /** A student is about to sit down in the room (before the others hear of it): they stop watching any room. */
  seated?(roomId: string, studentId: number, now: Date): void
  /** A game started in the room. */
  gameStarted?(roomId: string, now: Date): void
  /** The room closed and is gone; its `closed` event has been sent (none when it `failed`, see `GoneReason`). */
  closed?(roomId: string, reason: GoneReason, now: Date): void
}

export interface RoomsOptions {
  readonly config: SchoolConfig
  readonly game: GameModule
  readonly outbox: Outbox
  /** A random integer from 0 up to `max`, not including it: `crypto.randomInt` when absent. Picks room ids. */
  readonly randomInt?: (max: number) => number
  /** The spectators of a room, by student number; none when absent (watching plugs in here). */
  readonly spectators?: (roomId: string) => readonly number[]
  readonly listeners?: RoomListeners
  /** Something went wrong in a room's tick; the other rooms go on. Thrown away when absent. */
  readonly onError?: (roomId: string, err: unknown) => void
  /** When the club next closes, seen from `now`: `nextClose` of the config when absent. */
  readonly nextClose?: (now: Date) => Date
}

/** Someone in a seat. A bot is always online and ready, and has no `student`. */
interface Occupant {
  readonly player: Person
  readonly student: ClubStudent | null
  ready: boolean
  online: boolean
  /** When a disconnected student is put out of the room; null while online, or while a game is played. */
  graceUntil: Date | null
  /** The address of the student's connection now, or of the last one; null for a bot, or when not known. */
  address: string | null
}

/** A room event as the room keeps it for a reconnect: the frame, and who may see it (null: everyone). */
interface KeptEvent {
  readonly frame: RoomEventFrame
  readonly visibleTo: ReadonlySet<number> | null
}

interface Room {
  readonly id: string
  readonly visibility: Visibility
  /** The order rooms were opened in, for the lobby and quick join. */
  readonly opened: number
  readonly seats: (Occupant | null)[]
  /** The host's student number. */
  host: number
  /** The `seq` of the last room event, 0 before the first. */
  seq: number
  /** The last `roomEventBuffer` room events, oldest first. */
  readonly events: KeptEvent[]
  /**
   * The game being played, or the last one, over (kept only for its `table` and `resend`); null before the first.
   */
  session: GameSession | null
  /** What the last game handed on to the next (`GameSession.carry`); null before the first game ended. */
  carry: unknown
  /** Whether `session` is being played and its end has not been dealt with yet. */
  inGame: boolean
  gamesPlayed: number
  /** Since when the room has waited for a game: when it opened, or when the last game ended. */
  waitingSince: Date
  /** The idle prompt out now, or null. */
  prompt: { decideBy: Date } | null
  closed: boolean
}

const ROOM_ID_CHARS = '0123456789abcdefghijklmnopqrstuvwxyz'
const ROOM_ID_LENGTH = 6

const fail = (code: Extract<AckResult, { ok: false }>['code']): AckResult => ({ ok: false, code })

export class Rooms {
  private readonly config: SchoolConfig
  private readonly game: GameModule
  private readonly outbox: Outbox
  private readonly randomInt: (max: number) => number
  private readonly spectators: (roomId: string) => readonly number[]
  private readonly listeners: RoomListeners
  private readonly rooms = new Map<string, Room>()
  /** The room each seated student sits in. */
  private readonly seated = new Map<number, Room>()
  private opened = 0
  /** Set by `finishAll`, for good: no game starts any more (the service is stopping). */
  private gamesStopped = false
  private readonly onError: (roomId: string, err: unknown) => void
  private readonly findNextClose: (now: Date) => Date
  /** The last next close found, and the moment it was found from. */
  private nextCloseCache: { from: number; at: Date } | null = null

  constructor(options: RoomsOptions) {
    this.config = options.config
    this.game = options.game
    this.outbox = options.outbox
    this.randomInt = options.randomInt ?? ((max) => cryptoRandomInt(max))
    this.spectators = options.spectators ?? (() => [])
    this.listeners = options.listeners ?? {}
    this.onError = options.onError ?? (() => {})
    const config = options.config
    this.findNextClose = options.nextClose ?? ((now) => nextClose(config, now))
  }

  /**
   * When the club next closes, seen from `now`. The answer found from an earlier moment holds until it comes (the
   * config does not change while the service runs), so it is reused until then instead of searching days ahead for
   * every room state and turn. Also `welcome.closesAt`.
   */
  closesAt(now: Date): Date {
    const t = now.getTime()
    const cached = this.nextCloseCache
    if (cached !== null && cached.from <= t && t < cached.at.getTime()) return cached.at
    const at = this.findNextClose(now)
    this.nextCloseCache = { from: t, at }
    return at
  }

  // ---- Client messages ----

  /**
   * `room.create`: opens a room with the student as its host. With `bots`, bots take the free seats and the game
   * starts at once. The result is a `RoomResult`. (Invitations sent along are not the rooms' business.)
   */
  create(student: ClubStudent, options: { visibility: Visibility; bots: boolean }, now: Date): AckResult {
    if (this.seated.has(student.person.studentId)) return fail('in_room')
    const room = this.open(student, options.visibility, now)
    const state = this.sit(room, student, now)
    if (options.bots) this.fillWithBots(room, now)
    this.startIfReady(room, now)
    return { ok: true, result: { room: state } }
  }

  /**
   * `room.join`: seats the student in the room `roomId`. An invite-only room takes only someone `invited` (the caller
   * says so, after checking their invitation). The result is a `RoomResult`.
   */
  join(student: ClubStudent, roomId: string, now: Date, options: { invited?: boolean } = {}): AckResult {
    if (this.seated.has(student.person.studentId)) return fail('in_room')
    const room = this.rooms.get(roomId)
    if (room === undefined) return fail('room_not_found')
    if (room.visibility === 'invite' && options.invited !== true) return fail('room_private')
    if (this.sameOwner(room, student.email)) return fail('same_owner')
    if (room.seats.every((seat) => seat !== null)) return fail('room_full')
    const state = this.sit(room, student, now)
    this.startIfReady(room, now)
    return { ok: true, result: { room: state } }
  }

  /**
   * `room.quick`: seats the student in the open room closest to full where nobody of the same owner sits, or opens a
   * public room for them when there is none. The result is a `QuickJoinResult`.
   */
  quick(student: ClubStudent, now: Date): AckResult {
    if (this.seated.has(student.person.studentId)) return fail('in_room')
    const found = quickJoinRoom(this.summaries(), student.email)
    const created = found === null
    const room = found === null ? this.open(student, 'public', now) : this.rooms.get(found.roomId)!
    const state = this.sit(room, student, now)
    this.startIfReady(room, now)
    return { ok: true, result: { room: state, created } }
  }

  /** `room.leave`: the student leaves their room, unless a game is being played in it. */
  leave(studentId: number, now: Date): AckResult {
    const room = this.seated.get(studentId)
    if (room === undefined) return fail('not_in_room')
    if (this.playing(room)) return fail('game_in_progress')
    this.outbox.toStudent(studentId, { type: 'room.left', roomId: room.id, reason: 'left' })
    this.unseat(room, this.seatOf(room, studentId), 'left', now)
    return { ok: true }
  }

  /**
   * `room.ready`: after a game, the student is ready for the next one, which starts once every seat is taken and
   * ready, and every student in it is connected. Being ready already is no error; during a game it does nothing (the
   * student is asked again after it).
   */
  ready(studentId: number, now: Date): AckResult {
    const room = this.seated.get(studentId)
    if (room === undefined) return fail('not_in_room')
    if (this.playing(room)) return { ok: true }
    const seat = this.seatOf(room, studentId)
    const occupant = room.seats[seat]!
    if (occupant.ready) return { ok: true }
    occupant.ready = true
    this.emit(room.id, { kind: 'ready', seat }, now)
    this.startIfReady(room, now)
    return { ok: true }
  }

  /** `room.bots`: answers the idle prompt: bots take the free seats and the game starts. */
  bots(studentId: number, now: Date): AckResult {
    const room = this.seated.get(studentId)
    if (room === undefined) return fail('not_in_room')
    if (room.prompt === null || now.getTime() >= room.prompt.decideBy.getTime()) return fail('no_idle_prompt')
    room.prompt = null
    this.fillWithBots(room, now)
    this.startIfReady(room, now)
    return { ok: true }
  }

  /** A game-layer message (`bid`, `play`, `pass`) from a seated student, for the room's game. */
  gameMessage(studentId: number, message: GameClientMessage, now: Date): AckResult {
    const room = this.seated.get(studentId)
    if (room === undefined) return fail('not_in_room')
    // Before the first game there is no turn at all, so any turn is not the current one.
    if (room.session === null) return fail('stale_turn')
    const reply = room.session.handle(this.seatOf(room, studentId), message, now)
    this.dispatch(room, reply.output, now)
    return reply.ack
  }

  /** `trustee.off` from a seated student. */
  trusteeOff(studentId: number, now: Date): AckResult {
    const room = this.seated.get(studentId)
    if (room === undefined) return fail('not_in_room')
    if (room.session === null) return fail('not_trustee')
    const reply = room.session.trusteeOff(this.seatOf(room, studentId), now)
    this.dispatch(room, reply.output, now)
    return reply.ack
  }

  /** The lobby (`lobby.list`'s answer). */
  lobby(): LobbyFrame {
    return lobbyMessage(this.summaries(), this.config.club.lobbyMaxRooms)
  }

  // ---- Connections ----

  /**
   * The student's connection is gone. Out of a game their seat is kept `club.disconnectGraceSeconds`, and then they
   * are put out (`disconnected_idle`); during a game it is kept, and the grace starts when the game ends.
   */
  disconnected(studentId: number, now: Date): void {
    const room = this.seated.get(studentId)
    if (room === undefined) return
    const occupant = room.seats[this.seatOf(room, studentId)]!
    occupant.online = false
    occupant.graceUntil = this.playing(room) ? null : this.graceFrom(now)
  }

  /**
   * The student is connected again, from `address` (null when not known): their seat is theirs for good again. The
   * game being played is told the address; a game failing to take it goes to `onError`, and the student is back all
   * the same. A game the room waited for them to start is not started here, but by `startAfterReturn`, once the
   * student has been given the room as it is.
   */
  reconnected(studentId: number, now: Date, address: string | null = null): void {
    const room = this.seated.get(studentId)
    if (room === undefined) return
    const seat = this.seatOf(room, studentId)
    const occupant = room.seats[seat]!
    occupant.online = true
    occupant.graceUntil = null
    occupant.address = address
    if (!this.playing(room)) return
    try {
      room.session!.addressChanged(seat, address, now)
    } catch (err) {
      this.onError(room.id, err)
    }
  }

  /**
   * The student who reconnected has been given their room as it is (`state`, `replay`, `resend`): if the room is
   * full and ready, and everyone in it is connected now, its game starts, and its events reach them after what they
   * were given, as they reach the others. Nothing when they sit in no room, or a game is being played there. A game
   * failing to start goes to `onError` and the room is closed, as when its tick fails: the student is back all the
   * same.
   */
  startAfterReturn(studentId: number, now: Date): void {
    const room = this.seated.get(studentId)
    if (room === undefined) return
    try {
      this.startIfReady(room, now)
    } catch (err) {
      this.onError(room.id, err)
      this.abandon(room, now)
    }
  }

  /**
   * A reaction of the student `from` (to the student `to`, or nobody) has been sent to the whole table of their room:
   * the game being played there, if any, is told of it (see `GameReaction`). A game failing to take it goes to
   * `onError`: the reaction is out already.
   */
  reacted(
    roomId: string,
    from: number,
    to: number | null,
    reaction: Omit<GameReaction, 'from' | 'to'>,
    now: Date,
  ): void {
    const room = this.rooms.get(roomId)
    if (room === undefined || !this.playing(room)) return
    const toSeat = to === null ? null : this.seatOf(room, to)
    const told = { ...reaction, from: this.seatOf(room, from), to: toSeat }
    try {
      room.session!.reacted(told, now)
    } catch (err) {
      this.onError(room.id, err)
    }
  }

  /**
   * The room events of `roomId` after `lastSeq` that are still kept and that the student may see, marked `replayed`,
   * for a reconnect. Null when the student does not sit in that room (then nothing is replayed).
   */
  replay(studentId: number, roomId: string, lastSeq: number): RoomEventFrame[] | null {
    const room = this.seated.get(studentId)
    if (room === undefined || room.id !== roomId) return null
    return room.events
      .filter((kept) => kept.frame.seq > lastSeq && (kept.visibleTo === null || kept.visibleTo.has(studentId)))
      .map((kept) => ({ ...kept.frame, replayed: true }))
  }

  /** What the game sends the student again after a reconnect (their hand, their turn), after the replay. */
  resend(studentId: number, now: Date): GamePrivateMessage[] {
    const room = this.seated.get(studentId)
    if (room === undefined || room.session === null) return []
    return room.session.resend(this.seatOf(room, studentId), now)
  }

  // ---- Time and closing ----

  /** About once a second: the games' timeouts, the grace of disconnected students, idle prompts and their end. */
  tick(now: Date): void {
    for (const room of [...this.rooms.values()]) {
      // One room going wrong (its game throwing, say) must not stop the others. It is closed, so it does not fail
      // again at every tick.
      try {
        this.tickRoom(room, now)
      } catch (err) {
        this.onError(room.id, err)
        this.abandon(room, now)
      }
    }
  }

  /**
   * Closes a room whose tick failed: its game is played out if it can be (as when the club closes), then the room is
   * forgotten with no `closed` event (see `GoneReason`). Whatever fails on the way goes to `onError`.
   */
  private abandon(room: Room, now: Date): void {
    if (this.rooms.get(room.id) !== room) return
    try {
      if (this.playing(room)) this.dispatch(room, room.session!.finish(now), now)
    } catch (err) {
      this.onError(room.id, err)
    }
    if (this.rooms.get(room.id) !== room) return
    try {
      this.forget(room, 'failed', now)
    } catch (err) {
      this.onError(room.id, err)
    }
  }

  private tickRoom(room: Room, now: Date): void {
    if (room.closed) return
    if (this.playing(room)) this.dispatch(room, room.session!.tick(now), now)
    if (room.closed || this.playing(room)) return
    this.endGraces(room, now)
    if (room.closed) return
    if (room.prompt !== null) {
      if (now.getTime() >= room.prompt.decideBy.getTime()) this.close(room, 'idle', now)
    } else if (now.getTime() >= room.waitingSince.getTime() + this.config.club.idleMinutes * 60_000) {
      this.idlePrompt(room, now)
    }
  }

  /**
   * The club closes (`club_closed`) or goes under maintenance: every game being played is played out at once by the
   * trustee, and then every room closes.
   */
  closeAll(reason: 'club_closed' | 'maintenance', now: Date): void {
    for (const room of [...this.rooms.values()]) {
      // One room going wrong (its game throwing as it is played out, say) must not keep the others open, nor itself:
      // it is forgotten all the same, its students out of it.
      try {
        this.close(room, reason, now)
      } catch (err) {
        this.onError(room.id, err)
        if (this.rooms.get(room.id) !== room) continue
        try {
          this.forget(room, reason, now)
        } catch (again) {
          this.onError(room.id, again)
        }
      }
    }
  }

  /**
   * The service is stopping: every game being played is played out at once by the trustee, as when the club closes
   * (`auto: "closing"`), and its room events are sent as usual; from then on no game starts. The rooms stay as they
   * are: none closes, nobody is put out. One room's game failing as it is played out goes to `onError`, and the others
   * are still finished.
   */
  finishAll(now: Date): void {
    this.gamesStopped = true
    for (const room of [...this.rooms.values()]) {
      try {
        if (!room.closed && this.playing(room)) this.dispatch(room, room.session!.finish(now), now)
      } catch (err) {
        this.onError(room.id, err)
      }
    }
  }

  // ---- For the rest of the club ----

  /** The room the student sits in, or null. */
  roomOf(studentId: number): string | null {
    return this.seated.get(studentId)?.id ?? null
  }

  /** The room's state now, or null when there is no such room. */
  state(roomId: string, now: Date): RoomStateFrame | null {
    const room = this.rooms.get(roomId)
    return room === undefined ? null : this.stateOf(room, now)
  }

  /** The students seated in the room, in seat order; none when there is no such room. */
  students(roomId: string): ClubStudent[] {
    const room = this.rooms.get(roomId)
    if (room === undefined) return []
    return room.seats.flatMap((occupant) => (occupant?.student ? [occupant.student] : []))
  }

  /**
   * Sends a room event to the room and keeps it for reconnects, with the next `seq`, which it gives. With `visibleTo`
   * it is private: only the seated students named in it get it (now and in a replay), never a spectator.
   */
  emit(roomId: string, event: RoomEventBody, now: Date, visibleTo?: Iterable<number>): number {
    const room = this.rooms.get(roomId)
    if (room === undefined) throw new Error(`no room ${roomId}`)
    return this.emitTo(room, event, now, visibleTo === undefined ? null : new Set(visibleTo), null)
  }

  /** How many rooms are open. */
  get size(): number {
    return this.rooms.size
  }

  // ---- Inside ----

  private open(host: ClubStudent, visibility: Visibility, now: Date): Room {
    const room: Room = {
      id: this.newRoomId(),
      visibility,
      opened: ++this.opened,
      seats: Array<Occupant | null>(this.game.seats).fill(null),
      host: host.person.studentId,
      seq: 0,
      events: [],
      session: null,
      carry: null,
      inGame: false,
      gamesPlayed: 0,
      waitingSince: now,
      prompt: null,
      closed: false,
    }
    this.rooms.set(room.id, room)
    return room
  }

  private newRoomId(): string {
    for (;;) {
      let id = 'r'
      for (let i = 0; i < ROOM_ID_LENGTH; i++) id += ROOM_ID_CHARS[this.randomInt(ROOM_ID_CHARS.length)]
      if (!this.rooms.has(id)) return id
    }
  }

  /**
   * Seats the student in the first free seat, ready (sitting down says one is ready), and tells the others. Gives the
   * room's state right after, for the ack.
   */
  private sit(room: Room, student: ClubStudent, now: Date): RoomStateFrame {
    const seat = room.seats.indexOf(null)
    if (seat < 0) throw new Error(`room ${room.id} is full`)
    this.listeners.seated?.(room.id, student.person.studentId, now)
    const player = withoutClass(student.person)
    room.seats[seat] = { player, student, ready: true, online: true, graceUntil: null, address: student.address ?? null }
    this.seated.set(student.person.studentId, room)
    this.emitTo(room, { kind: 'joined', seat, player }, now, null, student.person.studentId)
    const state = this.stateOf(room, now)
    // A newcomer to a room under an idle prompt is told of it too (the same `decideBy`; the idle clock goes on), so
    // they may answer it. A room they have just filled starts its game instead.
    if (room.prompt !== null && room.seats.includes(null)) {
      this.emitTo(room, { kind: 'idle', decideBy: room.prompt.decideBy.toISOString() }, now, null, null)
    }
    return state
  }

  /** Takes the student out of the seat, tells the room, passes the host on, and closes the room when it is empty. */
  private unseat(room: Room, seat: number, reason: LeftReason, now: Date): void {
    const occupant = room.seats[seat]!
    room.seats[seat] = null
    const studentId = occupant.student!.person.studentId
    this.seated.delete(studentId)
    this.emitTo(room, { kind: 'left', seat, player: occupant.player, reason }, now, null, null)
    if (room.host !== studentId) return
    const next = this.nextStudentAfter(room, seat)
    if (next === null) {
      this.close(room, 'empty', now)
      return
    }
    room.host = next
    this.emitTo(room, { kind: 'host', studentId: next }, now, null, null)
  }

  /** The student number of the first student seated after `seat`, going round; null when none is left. */
  private nextStudentAfter(room: Room, seat: number): number | null {
    const n = room.seats.length
    for (let i = 1; i <= n; i++) {
      const student = room.seats[(seat + i) % n]?.student
      if (student) return student.person.studentId
    }
    return null
  }

  private fillWithBots(room: Room, now: Date): void {
    const free = room.seats.flatMap((occupant, seat) => (occupant === null ? [seat] : []))
    if (free.length === 0) return
    const seatedPeople = room.seats.flatMap((occupant) => (occupant === null ? [] : [occupant.player]))
    const bots = newBots(this.config.club.botNames, seatedPeople, free.length)
    free.forEach((seat, i) => {
      room.seats[seat] = { player: bots[i]!, student: null, ready: true, online: true, graceUntil: null, address: null }
    })
    this.emitTo(room, { kind: 'bots', seats: free, players: bots }, now, null, null)
  }

  /**
   * Starts a game when every seat is taken and ready, every student in it is connected (a bot always is), and none is
   * being played. A student away is not dealt into a game the trustee would play for them, ranked: the room waits for
   * them to come back (`startAfterReturn`), or for their grace to end.
   */
  private startIfReady(room: Room, now: Date): void {
    if (room.closed || this.playing(room) || this.gamesStopped) return
    if (!room.seats.every((occupant) => occupant !== null && occupant.ready && occupant.online)) return
    room.prompt = null
    // Everyone is connected, so no grace is running: this cuts none short.
    for (const occupant of room.seats) occupant!.graceUntil = null
    const session = this.game.newSession({
      roomId: room.id,
      players: room.seats.map((occupant) => occupant!.player),
      addresses: room.seats.map((occupant) => occupant!.address),
      carry: room.carry,
      closesAt: (at) => this.closesAt(at),
      now,
    })
    room.session = session
    room.inGame = true
    this.listeners.gameStarted?.(room.id, now)
    this.dispatch(room, session.start(now), now)
  }

  /** Sends what a game gave: its room events to the room, its private messages to the student of the seat. */
  private dispatch(room: Room, output: GameOutput, now: Date): void {
    for (const emit of output.emits) {
      if (emit.to === 'room') {
        this.emitTo(room, emit.event, now, null, null)
      } else {
        // A bot's seat has nobody to send to.
        const student = room.seats[emit.seat]?.student
        if (student) this.outbox.toStudent(student.person.studentId, emit.message)
      }
    }
    if (room.inGame && room.session?.over === true) this.gameOver(room, now)
  }

  /** A game has ended: every student is to get ready again, the idle clock and the grace of the absent start. */
  private gameOver(room: Room, now: Date): void {
    room.inGame = false
    room.gamesPlayed++
    room.waitingSince = now
    room.prompt = null
    for (const occupant of room.seats) {
      if (occupant?.student == null) continue
      occupant.ready = false
      if (!occupant.online) occupant.graceUntil = this.graceFrom(now)
    }
    // Last, so a game failing to give it leaves the room as after any game end, with no carry.
    try {
      room.carry = room.session!.carry()
    } catch (err) {
      room.carry = null
      this.onError(room.id, err)
    }
  }

  private endGraces(room: Room, now: Date): void {
    room.seats.forEach((occupant, seat) => {
      if (room.closed || occupant === null || occupant.graceUntil === null) return
      if (now.getTime() >= occupant.graceUntil.getTime()) this.unseat(room, seat, 'disconnected_idle', now)
    })
  }

  /**
   * The room has waited `idleMinutes`: the students not ready are asked out, and then, if a student is left, the room
   * gets the idle prompt.
   */
  private idlePrompt(room: Room, now: Date): void {
    // In seat order, but the host last, so the host passes (if at all) to a student who stays.
    const out = room.seats
      .flatMap((occupant, seat) => (occupant?.student != null && !occupant.ready ? [seat] : []))
      .sort((a, b) => Number(this.isHost(room, a)) - Number(this.isHost(room, b)))
    for (const seat of out) {
      if (room.closed) break
      const studentId = room.seats[seat]!.student!.person.studentId
      this.outbox.toStudent(studentId, { type: 'room.left', roomId: room.id, reason: 'not_ready' })
      this.unseat(room, seat, 'not_ready', now)
    }
    if (room.closed) return
    const decideBy = new Date(now.getTime() + this.config.club.idleDecideSeconds * 1000)
    room.prompt = { decideBy }
    this.emitTo(room, { kind: 'idle', decideBy: decideBy.toISOString() }, now, null, null)
  }

  /**
   * Closes the room: plays out a game being played (as the club closes), sends `closed`, puts every student out
   * (`room.left`, `closed`) and forgets the room.
   */
  private close(room: Room, reason: CloseReason, now: Date): void {
    if (room.closed) return
    if (this.playing(room)) this.dispatch(room, room.session!.finish(now), now)
    this.emitTo(room, { kind: 'closed', reason }, now, null, null)
    this.forget(room, reason, now)
  }

  /** Puts every student out of the room (`room.left`, `closed`) and forgets it; what `close` ends with. */
  private forget(room: Room, reason: GoneReason, now: Date): void {
    room.closed = true
    room.prompt = null
    // Forgotten first, so a room that fails below is gone all the same.
    this.rooms.delete(room.id)
    for (const occupant of room.seats) {
      if (occupant?.student == null) continue
      const studentId = occupant.student.person.studentId
      if (this.seated.get(studentId) === room) this.seated.delete(studentId)
      this.outbox.toStudent(studentId, { type: 'room.left', roomId: room.id, reason: 'closed' })
    }
    this.listeners.closed?.(room.id, reason, now)
  }

  /**
   * Numbers a room event, keeps it (dropping the oldest past `roomEventBuffer`) and sends it: to the seated students
   * (but `except`) and the spectators, or, when `visibleTo` is given, to the seated students in it alone.
   */
  private emitTo(
    room: Room,
    event: RoomEventBody,
    now: Date,
    visibleTo: ReadonlySet<number> | null,
    except: number | null,
  ): number {
    room.seq++
    const frame: RoomEventFrame = {
      type: 'room.event',
      roomId: room.id,
      seq: room.seq,
      replayed: false,
      at: now.toISOString(),
      event,
    }
    room.events.push({ frame, visibleTo })
    const excess = room.events.length - this.config.club.roomEventBuffer
    if (excess > 0) room.events.splice(0, excess)
    const seated = room.seats.flatMap((occupant) => {
      const id = occupant?.student?.person.studentId
      return id === undefined || id === except || (visibleTo !== null && !visibleTo.has(id)) ? [] : [id]
    })
    const spectators = visibleTo === null ? this.spectators(room.id) : []
    if (seated.length > 0 || spectators.length > 0) this.outbox.toRoom(room.id, frame, { seated, spectators })
    return room.seq
  }

  private stateOf(room: Room, now: Date): RoomStateFrame {
    const session = room.session
    // Nobody is in trusteeship once the game is over, whatever the session still says.
    const trustee = (seat: number) => session !== null && !session.over && session.trustee(seat)
    return {
      roomId: room.id,
      club: this.game.club,
      visibility: room.visibility,
      host: room.host,
      seats: room.seats.map((occupant, seat) => ({
        seat,
        player: occupant?.player ?? null,
        ready: occupant?.ready ?? false,
        online: occupant?.online ?? false,
        trustee: occupant !== null && trustee(seat),
      })),
      spectators: this.spectators(room.id).length,
      gamesPlayed: room.gamesPlayed,
      closesAt: this.closesAt(now).toISOString(),
      lastSeq: room.seq,
      game: session?.table() ?? null,
    }
  }

  private summaries(): RoomSummary[] {
    return [...this.rooms.values()].map((room) => {
      const host = room.seats.find((occupant) => occupant?.student?.person.studentId === room.host)!.student!
      return {
        roomId: room.id,
        visibility: room.visibility,
        playing: this.playing(room),
        seatsFree: room.seats.filter((occupant) => occupant === null).length,
        host: host.person,
        bots: room.seats.some((occupant) => occupant?.player.bot === true),
        gamesPlayed: room.gamesPlayed,
        opened: room.opened,
        owners: new Set(room.seats.flatMap((occupant) => (occupant?.student ? [occupant.student.email] : []))),
        away: room.seats.some((occupant) => occupant !== null && !occupant.online),
      }
    })
  }

  private isHost(room: Room, seat: number): boolean {
    return room.seats[seat]?.student?.person.studentId === room.host
  }

  private sameOwner(room: Room, email: string): boolean {
    return room.seats.some((occupant) => occupant?.student?.email === email)
  }

  private playing(room: Room): boolean {
    return room.session !== null && !room.session.over
  }

  private seatOf(room: Room, studentId: number): number {
    const seat = room.seats.findIndex((occupant) => occupant?.student?.person.studentId === studentId)
    if (seat < 0) throw new Error(`student ${studentId} is not seated in room ${room.id}`)
    return seat
  }

  private graceFrom(now: Date): Date {
    return new Date(now.getTime() + this.config.club.disconnectGraceSeconds * 1000)
  }
}
