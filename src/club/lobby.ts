import type { Static } from 'typebox'
import type { LobbyMessage } from '../protocol/club.js'
import type { PersonWithClass } from './people.js'

// The lobby and quick join: which rooms a student may be pointed to. Both look only at a summary of each room, which
// `rooms.ts` gives; neither changes anything.

export type LobbyFrame = Static<typeof LobbyMessage>
export type LobbyEntry = LobbyFrame['rooms'][number]

/** What the lobby and quick join need to know of a room. */
export interface RoomSummary {
  readonly roomId: string
  readonly visibility: 'public' | 'invite'
  /** Whether a game is being played in it now. */
  readonly playing: boolean
  readonly seatsFree: number
  readonly host: PersonWithClass
  /** Whether a bot sits in it. */
  readonly bots: boolean
  readonly gamesPlayed: number
  /** The order the rooms were opened in: a room opened earlier has a smaller number. */
  readonly opened: number
  /** The owners' emails of the students seated in it. */
  readonly owners: ReadonlySet<string>
  /** Whether a student seated in it is not connected now (their seat waits for them, and no game starts). */
  readonly away: boolean
}

/** Whether a room is open to anyone who comes by: public, not playing, and with a free seat. */
function open(room: RoomSummary): boolean {
  return room.visibility === 'public' && !room.playing && room.seatsFree >= 1
}

/** Fewest free seats first (closest to full), then the room opened first. */
function byFullness(a: RoomSummary, b: RoomSummary): number {
  return a.seatsFree - b.seatsFree || a.opened - b.opened
}

/**
 * The lobby: the open rooms (public, not playing, with a free seat), the fullest first and, among as full, the oldest
 * first, at most `max` of them.
 */
export function lobbyMessage(rooms: Iterable<RoomSummary>, max: number): LobbyFrame {
  const listed = [...rooms].filter(open).sort(byFullness).slice(0, max)
  return {
    type: 'lobby',
    rooms: listed.map((room) => ({
      roomId: room.roomId,
      host: room.host,
      seatsFree: room.seatsFree,
      bots: room.bots,
      gamesPlayed: room.gamesPlayed,
    })),
  }
}

/**
 * The room quick join seats a student in: the open room with the fewest free seats, the oldest among as full, leaving
 * out the rooms where a student of the same owner (`email`) sits, and those where a seated student is away (a game
 * would not start there until they are back). Null when there is none, and a new room is opened.
 */
export function quickJoinRoom(rooms: Iterable<RoomSummary>, email: string): RoomSummary | null {
  const candidates = [...rooms].filter((room) => open(room) && !room.away && !room.owners.has(email)).sort(byFullness)
  return candidates[0] ?? null
}
