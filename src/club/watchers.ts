import type { Static } from 'typebox'
import type { RoomState } from '../protocol/club.js'
import type { SchoolConfig } from '../shared/config.js'
import type { AckResult } from './game.js'

// Watching: who watches which room. A student watches one room at a time, and only while they sit in none; a room has
// at most `club.maxSpectators` of them. Spectators get the room's public room events (the rooms ask `spectators` whom
// to send to), never a private reaction and never what a game sends a seat. Nothing is kept for a spectator who is
// gone: one who disconnects stops watching and has to `watch` again, and a room that closes takes its spectators with
// it (after its `closed` event has reached them).
//
// That the student is a club member is the caller's to know (a connection is only open for members).

type RoomStateFrame = Static<typeof RoomState>

const fail = (code: Extract<AckResult, { ok: false }>['code']): AckResult => ({ ok: false, code })

/** What watching needs to know of the rooms. */
export interface WatchedRooms {
  /** The room the student sits in, or null. */
  roomOf(studentId: number): string | null
  /** The room's state now, or null when there is no such room. */
  state(roomId: string, now: Date): RoomStateFrame | null
}

export interface WatchersOptions {
  readonly config: SchoolConfig
  /** The rooms; called only when a student watches, so it may be given before the rooms are made. */
  readonly rooms: () => WatchedRooms
}

export class Watchers {
  private readonly config: SchoolConfig
  private readonly rooms: () => WatchedRooms
  /** The room each spectator watches. */
  private readonly watching = new Map<number, string>()
  /** The spectators of each watched room, in the order they came. */
  private readonly byRoom = new Map<string, Set<number>>()

  constructor(options: WatchersOptions) {
    this.config = options.config
    this.rooms = options.rooms
  }

  /**
   * `watch`: the student watches the room `roomId`, and stops watching the one they watched before, if any. The
   * result is a `RoomResult`, the room's state with the student counted among its spectators. Refused when they sit
   * in a room (`in_room`), when there is no such room (`room_not_found`) or when it has `maxSpectators` already
   * (`spectators_full`); then whatever they watched they still watch. Watching the room they watch already is no
   * error.
   */
  watch(studentId: number, roomId: string, now: Date): AckResult {
    const rooms = this.rooms()
    if (rooms.roomOf(studentId) !== null) return fail('in_room')
    if (rooms.state(roomId, now) === null) return fail('room_not_found')
    if (this.watching.get(studentId) !== roomId) {
      if ((this.byRoom.get(roomId)?.size ?? 0) >= this.config.club.maxSpectators) return fail('spectators_full')
      this.stop(studentId)
      this.watching.set(studentId, roomId)
      let spectators = this.byRoom.get(roomId)
      if (spectators === undefined) {
        spectators = new Set()
        this.byRoom.set(roomId, spectators)
      }
      spectators.add(studentId)
    }
    return { ok: true, result: { room: rooms.state(roomId, now)! } }
  }

  /** `unwatch`: the student stops watching. Not watching anything is no error. */
  unwatch(studentId: number): AckResult {
    this.stop(studentId)
    return { ok: true }
  }

  /** The student's connection is gone, or they sat down in a room: they watch nothing any more. */
  stop(studentId: number): void {
    const roomId = this.watching.get(studentId)
    if (roomId === undefined) return
    this.watching.delete(studentId)
    const spectators = this.byRoom.get(roomId)!
    spectators.delete(studentId)
    if (spectators.size === 0) this.byRoom.delete(roomId)
  }

  /** The room closed (its `closed` event has gone out): its spectators watch nothing any more. */
  roomClosed(roomId: string): void {
    const spectators = this.byRoom.get(roomId)
    if (spectators === undefined) return
    for (const studentId of spectators) this.watching.delete(studentId)
    this.byRoom.delete(roomId)
  }

  /** The spectators of the room, by student number, in the order they came. */
  spectators(roomId: string): number[] {
    return [...(this.byRoom.get(roomId) ?? [])]
  }

  /** The room the student watches, or null. */
  watchedBy(studentId: number): string | null {
    return this.watching.get(studentId) ?? null
  }

  /** How many students watch a room. */
  get size(): number {
    return this.watching.size
  }
}
