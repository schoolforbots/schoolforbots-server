import type { Static } from 'typebox'
import type { ReactMessage, RoomEvent } from '../protocol/club.js'
import type { SchoolConfig } from '../shared/config.js'
import type { AckResult, GameModule, GameReaction } from './game.js'
import { withoutClass } from './people.js'
import type { ClubStudent } from './rooms.js'
import type { Phrase } from './word-lists.js'

// Reactions at a table (`react`): who may send one, what it may say, to whom, and how often. Only a student seated in
// a room reacts, never a spectator. The kinds and visibilities are the game's (`GameModule.reactions`); an emoji is
// one whole entry of the emoji list, a phrase is named by its id, and a text (for a game that allows it) is itself.
// `to` names a student at the same table (a bot has no student number, so it cannot be named).
//
// Two reactions of one student are at least `reactMinIntervalSeconds` apart, wherever they are sent, and a student
// sends at most `reactsPerGame` in one game of a room: the count starts again when a game starts in the room, and
// what is sent before a room's first game counts as one game too. Both refusals are `react_cap`.
//
// A reaction sent to the whole table is told to the game being played there, if any, for its record
// (`ReactingRooms.reacted`, `GameSession.reacted`); a private one is not.
//
// What is kept is bounded: one record per student who reacted, dropped once their interval is over when their room
// starts a game or closes (or, after it closed, when any room does).

type React = Static<typeof ReactMessage>
type RoomEventBody = Static<typeof RoomEvent>

/** The club's word lists, as loaded from `club.wordLists`. */
export interface WordLists {
  readonly emoji: readonly string[]
  readonly phrases: readonly Static<typeof Phrase>[]
}

/** What reactions need of the rooms. */
export interface ReactingRooms {
  /** The room the student sits in, or null. */
  roomOf(studentId: number): string | null
  /** The students seated in the room. */
  students(roomId: string): ClubStudent[]
  /** Sends a room event (see `Rooms.emit`): private to `visibleTo` when given. */
  emit(roomId: string, event: RoomEventBody, now: Date, visibleTo?: Iterable<number>): number
  /**
   * A reaction of the student `from` (naming the student `to`, or nobody) has been sent to the whole table: tells the
   * game being played in the room, if any (see `Rooms.reacted`).
   */
  reacted(roomId: string, from: number, to: number | null, reaction: Omit<GameReaction, 'from' | 'to'>, now: Date): void
}

export interface ReactionsOptions {
  readonly config: SchoolConfig
  readonly game: Pick<GameModule, 'reactions'>
  readonly wordLists: WordLists
  /** The rooms; called only when a student reacts, so it may be given before the rooms are made. */
  readonly rooms: () => ReactingRooms
  /** Whether the student watches a room. */
  readonly watching: (studentId: number) => boolean
}

/** What is kept of a student's reactions: the last one, and how many they sent in the current game of `roomId`. */
interface Kept {
  lastAt: number
  /** Null once the room has closed: only `lastAt` counts then. */
  roomId: string | null
  count: number
}

const fail = (code: Extract<AckResult, { ok: false }>['code']): AckResult => ({ ok: false, code })

export class Reactions {
  private readonly config: SchoolConfig
  private readonly kinds: ReadonlySet<string>
  private readonly visibilities: ReadonlySet<string>
  private readonly emoji: ReadonlySet<string>
  private readonly phrases: ReadonlyMap<string, string>
  private readonly rooms: () => ReactingRooms
  private readonly watching: (studentId: number) => boolean
  private readonly records = new Map<number, Kept>()

  constructor(options: ReactionsOptions) {
    this.config = options.config
    this.kinds = new Set(options.game.reactions.kinds)
    this.visibilities = new Set(options.game.reactions.visibility)
    this.emoji = new Set(options.wordLists.emoji)
    this.phrases = new Map(options.wordLists.phrases.map((phrase) => [phrase.id, phrase.text]))
    this.rooms = options.rooms
    this.watching = options.watching
  }

  /**
   * `react` from the student: checked, and sent to the room as a `react` room event (a private one only to the
   * student and `to`). Refused with `not_in_room` when they sit in no room (`react_not_allowed` when they watch one),
   * `react_not_allowed` for a kind, visibility or content the club does not allow or a `to` who is not another student
   * at the table, and `react_cap` when it comes too soon after the last one or past the game's count.
   */
  react(student: ClubStudent, message: React, now: Date): AckResult {
    const studentId = student.person.studentId
    const rooms = this.rooms()
    const roomId = rooms.roomOf(studentId)
    if (roomId === null) return fail(this.watching(studentId) ? 'react_not_allowed' : 'not_in_room')

    const visibility = message.visibility ?? 'room'
    if (!this.kinds.has(message.kind) || !this.visibilities.has(visibility)) return fail('react_not_allowed')
    const text = this.textOf(message.kind, message.content)
    if (text === null) return fail('react_not_allowed')
    let to: ClubStudent | null = null
    if (message.to !== undefined) {
      if (message.to === studentId) return fail('react_not_allowed')
      to = rooms.students(roomId).find((s) => s.person.studentId === message.to) ?? null
      if (to === null) return fail('react_not_allowed')
    }
    // The schema has it already: a private reaction names someone.
    if (visibility === 'private' && to === null) return fail('invalid_message')

    const t = now.getTime()
    const record = this.records.get(studentId)
    const count = record?.roomId === roomId ? record.count : 0
    if (record !== undefined && t < record.lastAt + this.config.club.reactMinIntervalSeconds * 1000) {
      return fail('react_cap')
    }
    if (count >= this.config.club.reactsPerGame) return fail('react_cap')
    this.records.set(studentId, { lastAt: t, roomId, count: count + 1 })

    const event: RoomEventBody = {
      kind: 'react',
      from: withoutClass(student.person),
      to: to === null ? null : withoutClass(to.person),
      reaction: message.kind,
      content: message.content,
      text,
      visibility,
    }
    if (visibility === 'private') {
      rooms.emit(roomId, event, now, [studentId, to!.person.studentId])
    } else {
      rooms.emit(roomId, event, now)
      const reaction = { kind: message.kind, content: message.content, text }
      rooms.reacted(roomId, studentId, to?.person.studentId ?? null, reaction, now)
    }
    return { ok: true }
  }

  /** A game started in the room: every count in it starts again. */
  gameStarted(roomId: string, now: Date): void {
    this.sweep(roomId, now)
  }

  /**
   * The room closed: its counts go, but a student who reacted in it less than the interval ago keeps the time of it,
   * so a new room does not let them react again at once.
   */
  roomClosed(roomId: string, now: Date): void {
    this.sweep(roomId, now)
    for (const record of this.records.values()) if (record.roomId === roomId) record.roomId = null
  }

  /**
   * The counts in the room start again, and a record whose interval is over goes when it is of the room or of no room
   * (of a room that closed), so what is kept stays bounded.
   */
  private sweep(roomId: string, now: Date): void {
    const due = now.getTime() - this.config.club.reactMinIntervalSeconds * 1000
    for (const [studentId, record] of this.records) {
      if (record.roomId !== roomId && record.roomId !== null) continue
      if (record.lastAt <= due) this.records.delete(studentId)
      else record.count = 0
    }
  }

  /** What a reaction shows (a phrase's text, an emoji or a text itself), or null when its content is not allowed. */
  private textOf(kind: React['kind'], content: string): string | null {
    switch (kind) {
      case 'emoji':
        return this.emoji.has(content) ? content : null
      case 'phrase':
        return this.phrases.get(content) ?? null
      case 'text':
        // No club allows free text yet; one that does would check it (moderation) before it goes out.
        return content
    }
  }

  /** How many students' reactions are kept. */
  get size(): number {
    return this.records.size
  }
}
