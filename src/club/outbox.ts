import type { Static } from 'typebox'
import type { ClubServerMessage, RoomEventMessage } from '../protocol/club.js'

// Where the club's room logic puts what it sends. The rooms never touch a connection: they say who a message is for,
// and the connection layer delivers it to whoever is connected (and drops it for whoever is not; a student who comes
// back gets the room events again from the room's buffer, see `Rooms.replay`).
//
// Messages are put in the outbox in the order they are to be sent. A call that answers a client message (say,
// `Rooms.join`) may put messages in it for the student who sent it too; the connection layer sends the `ack` first and
// then what the call put in the outbox, so a room's events always come after the `RoomState` they follow.

export type ServerMessage = Static<typeof ClubServerMessage>
export type RoomEventFrame = Static<typeof RoomEventMessage>

/**
 * Who a room event goes to: the students seated in the room it is for, and the spectators. A private event (a private
 * reaction) goes to some of the seated students only, and never to a spectator.
 */
export interface RoomAudience {
  /** The student numbers of the seated students it goes to. */
  readonly seated: readonly number[]
  /** The student numbers of the spectators it goes to; empty for a private event. */
  readonly spectators: readonly number[]
}

export interface Outbox {
  /** A message for one student alone (an ack's follow-up, `room.left`, `lobby`, a seat's `hand` or `your_turn`). */
  toStudent(studentId: number, message: ServerMessage): void
  /** A room event of the room `roomId`, for the students in `audience`. */
  toRoom(roomId: string, message: RoomEventFrame, audience: RoomAudience): void
}
