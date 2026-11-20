import type { Outbox, RoomAudience, RoomEventFrame, ServerMessage } from '../../../src/club/outbox.js'
import { checkProtocol } from './fake-game.js'

// An outbox for tests: it keeps every message, checked against `protocol/club.schema.json` as it comes in, and what
// each student got, in order.

/** One message as a student got it: sent to them alone, or as a seated student or a spectator of a room. */
export interface Delivery {
  readonly studentId: number
  readonly as: 'student' | 'seated' | 'spectator'
  readonly message: ServerMessage
}

export class RecordingOutbox implements Outbox {
  readonly deliveries: Delivery[] = []
  /** Every room event as it was sent, with its audience. */
  readonly roomEvents: { roomId: string; frame: RoomEventFrame; audience: RoomAudience }[] = []

  toStudent(studentId: number, message: ServerMessage): void {
    checkProtocol('ClubServerMessage', message)
    this.deliveries.push({ studentId, as: 'student', message })
  }

  toRoom(roomId: string, frame: RoomEventFrame, audience: RoomAudience): void {
    checkProtocol('RoomEventMessage', frame)
    if (frame.roomId !== roomId) throw new Error(`a frame of ${frame.roomId} sent to ${roomId}`)
    this.roomEvents.push({ roomId, frame, audience: { seated: [...audience.seated], spectators: [...audience.spectators] } })
    for (const studentId of audience.seated) this.deliveries.push({ studentId, as: 'seated', message: frame })
    for (const studentId of audience.spectators) this.deliveries.push({ studentId, as: 'spectator', message: frame })
  }

  /** What the student got, in order. */
  of(studentId: number): ServerMessage[] {
    return this.deliveries.filter((d) => d.studentId === studentId).map((d) => d.message)
  }

  /** The room events the student got, in order. */
  eventsOf(studentId: number): RoomEventFrame[] {
    return this.of(studentId).filter((m): m is RoomEventFrame => m.type === 'room.event')
  }

  /** Forgets everything so far. */
  clear(): void {
    this.deliveries.length = 0
    this.roomEvents.length = 0
  }
}
