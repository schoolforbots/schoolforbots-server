import type { Static } from 'typebox'
import type { ClubClosingMessage } from '../protocol/club.js'
import type { Outbox, RoomAudience, RoomEventFrame, ServerMessage } from './outbox.js'

// The students connected to the club, one connection each, and the outbox the rooms send through: a message for a
// student goes to their connection, and is dropped when they have none (a student who comes back gets the room events
// again from the room's buffer, see `Rooms.replay`).

export type ClubClosing = Static<typeof ClubClosingMessage>

/** One student's connection as the hub sees it (see connection.ts). */
export interface HubConnection {
  readonly studentId: number
  /** Sends a message to the client (or holds it a moment, see connection.ts). */
  send(message: ServerMessage): void
  /** Sends `closing` and closes the connection; the student is gone from that moment. */
  close(closing: ClubClosing): void
}

export class ClubHub implements Outbox {
  private readonly connections = new Map<number, HubConnection>()

  /** Registers the connection; gives the connection of the same student it takes the place of, if any. */
  add(connection: HubConnection): HubConnection | undefined {
    const previous = this.connections.get(connection.studentId)
    this.connections.set(connection.studentId, connection)
    return previous === connection ? undefined : previous
  }

  /**
   * Takes the connection out, when it is still the student's: false when a newer one has taken its place (or it was
   * never in), and then the student has not gone anywhere.
   */
  remove(connection: HubConnection): boolean {
    if (this.connections.get(connection.studentId) !== connection) return false
    this.connections.delete(connection.studentId)
    return true
  }

  /** The student numbers of everyone connected, in no particular order. */
  online(): number[] {
    return [...this.connections.keys()]
  }

  isOnline(studentId: number): boolean {
    return this.connections.has(studentId)
  }

  /** Sends the student `closing` and disconnects them; false when they are not connected. */
  disconnect(studentId: number, closing: ClubClosing): boolean {
    const connection = this.connections.get(studentId)
    if (connection === undefined) return false
    connection.close(closing)
    return true
  }

  /** Sends everyone connected `closing` and disconnects them. */
  disconnectAll(closing: ClubClosing): void {
    for (const connection of [...this.connections.values()]) connection.close(closing)
  }

  get size(): number {
    return this.connections.size
  }

  // ---- Outbox ----

  toStudent(studentId: number, message: ServerMessage): void {
    this.connections.get(studentId)?.send(message)
  }

  toRoom(_roomId: string, message: RoomEventFrame, audience: RoomAudience): void {
    for (const studentId of audience.seated) this.toStudent(studentId, message)
    for (const studentId of audience.spectators) this.toStudent(studentId, message)
  }
}
