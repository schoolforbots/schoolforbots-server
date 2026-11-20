import type { Static } from 'typebox'
import type { InviteEndedMessage, InviteMessage, RoomCreateMessage } from '../protocol/club.js'
import type { SchoolConfig } from '../shared/config.js'
import { localDate } from '../shared/local-time.js'
import type { AckResult } from './game.js'
import type { Outbox } from './outbox.js'
import type { ClubStudent, Rooms } from './rooms.js'

// Invitations, in memory only. Any student seated in a room invites a club member to it (`room.invite`, or `invite`
// with `room.create`, which go the same way). The one invited need not be online: an invitation waits until it
// expires (`club.inviteSeconds`), and one who connects before that is sent it again after `welcome` (`pendingFor`).
// An invitation ends when it expires, is declined, is accepted, or its room closes; the one who invited is then sent
// `invite.ended` (dropped by the outbox when they are not connected; it is not sent again). A room that fills up keeps
// the invitations not answered yet, and accepting one then is `room_full`.
//
// Whether the one invited is a club member, and their owner's email, come from the database, which this module never
// touches: the caller looks up the student numbers of a message first and gives the answers (`InviteTargets`).
//
// A student sends at most `club.invitesPerDay` invitations a day, the day by the school's timezone. Only the counts of
// the current day are kept; the first call on a new day forgets the rest. Ended invitations are forgotten at once.

type InviteFrame = Static<typeof InviteMessage>
type EndReason = Static<typeof InviteEndedMessage>['reason']
type CreateMessage = Pick<Static<typeof RoomCreateMessage>, 'visibility' | 'bots' | 'invite'>

/** A club member who may be invited: their student number, and their owner's email as the database keeps it. */
export interface InviteTarget {
  readonly studentId: number
  readonly email: string
}

/** The members among the student numbers of a message, looked up by the caller; null for one who is not a member. */
export type InviteTargets = (studentId: number) => InviteTarget | null

export interface InvitesOptions {
  readonly config: SchoolConfig
  readonly outbox: Outbox
  /** The rooms; called only when an invitation is sent or accepted, so it may be given before the rooms are made. */
  readonly rooms: () => Rooms
}

interface Invite {
  readonly id: number
  readonly roomId: string
  readonly from: ClubStudent
  readonly to: number
  readonly expiresAt: Date
}

const fail = (code: Extract<AckResult, { ok: false }>['code']): AckResult => ({ ok: false, code })

export class Invites {
  private readonly config: SchoolConfig
  private readonly outbox: Outbox
  private readonly rooms: () => Rooms
  private readonly invites = new Map<number, Invite>()
  private nextId = 1
  /** The school day the counts are of, and how many invitations each student sent on it. */
  private day = ''
  private readonly sent = new Map<number, number>()

  constructor(options: InvitesOptions) {
    this.config = options.config
    this.outbox = options.outbox
    this.rooms = options.rooms
  }

  /**
   * `room.create`, with the invitations it carries: everything is checked before the room opens, so a refused
   * invitation opens no room. `bots: true` with invitations is `invalid_message` (bots fill the room at once).
   * Refused with `in_room` when the student sits in a room, `not_member_target` when one invited is not a club member,
   * `same_owner` when one is of the student's own owner (themselves too), `invite_cap` when they would go past the
   * day's count. The result is a `RoomResult`; the invitations go out after it.
   */
  create(student: ClubStudent, message: CreateMessage, targets: InviteTargets, now: Date): AckResult {
    const invited = message.invite ?? []
    if (message.bots && invited.length > 0) return fail('invalid_message')
    const rooms = this.rooms()
    if (rooms.roomOf(student.person.studentId) !== null) return fail('in_room')
    const found: InviteTarget[] = []
    for (const studentId of invited) {
      const target = targets(studentId)
      if (target === null || target.studentId !== studentId) return fail('not_member_target')
      if (target.email === student.email) return fail('same_owner')
      found.push(target)
    }
    if (!this.mayInvite(student.person.studentId, found.length, now)) return fail('invite_cap')
    const result = rooms.create(student, { visibility: message.visibility, bots: message.bots }, now)
    if (!result.ok) return result
    const roomId = rooms.roomOf(student.person.studentId)!
    for (const target of found) this.send(student, roomId, target, now)
    return result
  }

  /**
   * `room.invite`: invites `to` to the room the student sits in. Refused with `not_in_room`, `not_member_target` (the
   * one invited is not a club member), `same_owner` (they are of the same owner as someone in the room) and
   * `invite_cap`.
   */
  invite(student: ClubStudent, to: number, targets: InviteTargets, now: Date): AckResult {
    const rooms = this.rooms()
    const roomId = rooms.roomOf(student.person.studentId)
    if (roomId === null) return fail('not_in_room')
    const target = targets(to)
    if (target === null || target.studentId !== to) return fail('not_member_target')
    if (rooms.students(roomId).some((s) => s.email === target.email)) return fail('same_owner')
    if (!this.mayInvite(student.person.studentId, 1, now)) return fail('invite_cap')
    this.send(student, roomId, target, now)
    return { ok: true }
  }

  /**
   * `room.accept`: the student takes their seat in the room of the invitation. `invite_not_found` when there is no
   * such invitation for them (or it has expired; it ends then, `expired`). Otherwise as `Rooms.join` for someone
   * invited: `in_room`, `same_owner` and `room_full` are checked again then, and leave the invitation as it was. The
   * result is a `RoomResult`.
   */
  accept(student: ClubStudent, inviteId: number, now: Date): AckResult {
    const invite = this.live(student.person.studentId, inviteId, now)
    if (invite === null) return fail('invite_not_found')
    const result = this.rooms().join(student, invite.roomId, now, { invited: true })
    if (result.ok) this.end(invite, 'accepted')
    return result
  }

  /** `room.decline`: the invitation ends, `declined`. `invite_not_found` as for `accept`. */
  decline(studentId: number, inviteId: number, now: Date): AckResult {
    const invite = this.live(studentId, inviteId, now)
    if (invite === null) return fail('invite_not_found')
    this.end(invite, 'declined')
    return { ok: true }
  }

  /** The invitations to the student not expired yet, oldest first: what is sent again after their `welcome`. */
  pendingFor(studentId: number, now: Date): InviteFrame[] {
    return [...this.invites.values()]
      .filter((invite) => invite.to === studentId && now.getTime() < invite.expiresAt.getTime())
      .map((invite) => this.frameOf(invite))
  }

  /** About once a second: the invitations that have expired end (`expired`). */
  tick(now: Date): void {
    for (const invite of [...this.invites.values()]) {
      if (now.getTime() >= invite.expiresAt.getTime()) this.end(invite, 'expired')
    }
    this.countsOf(now)
  }

  /** The room closed: its invitations end (`room_closed`). */
  roomClosed(roomId: string): void {
    for (const invite of [...this.invites.values()]) if (invite.roomId === roomId) this.end(invite, 'room_closed')
  }

  /** How many invitations are waiting for an answer. */
  get size(): number {
    return this.invites.size
  }

  // ---- Inside ----

  /** The invitation `inviteId` to the student, or null; one that has expired ends now. */
  private live(studentId: number, inviteId: number, now: Date): Invite | null {
    const invite = this.invites.get(inviteId)
    if (invite === undefined || invite.to !== studentId) return null
    if (now.getTime() >= invite.expiresAt.getTime()) {
      this.end(invite, 'expired')
      return null
    }
    return invite
  }

  /** Whether the student may send `count` more invitations today. */
  private mayInvite(studentId: number, count: number, now: Date): boolean {
    return (this.countsOf(now).get(studentId) ?? 0) + count <= this.config.club.invitesPerDay
  }

  /** The counts of today, the counts of an earlier day forgotten. */
  private countsOf(now: Date): Map<number, number> {
    const today = localDate(now, this.config.timezone)
    if (today !== this.day) {
      this.day = today
      this.sent.clear()
    }
    return this.sent
  }

  private send(from: ClubStudent, roomId: string, target: InviteTarget, now: Date): void {
    const counts = this.countsOf(now)
    counts.set(from.person.studentId, (counts.get(from.person.studentId) ?? 0) + 1)
    const invite: Invite = {
      id: this.nextId++,
      roomId,
      from,
      to: target.studentId,
      expiresAt: new Date(now.getTime() + this.config.club.inviteSeconds * 1000),
    }
    this.invites.set(invite.id, invite)
    this.outbox.toStudent(invite.to, this.frameOf(invite))
  }

  private end(invite: Invite, reason: EndReason): void {
    if (!this.invites.delete(invite.id)) return
    this.outbox.toStudent(invite.from.person.studentId, { type: 'invite.ended', inviteId: invite.id, reason })
  }

  private frameOf(invite: Invite): InviteFrame {
    return {
      type: 'invite',
      inviteId: invite.id,
      from: invite.from.person,
      roomId: invite.roomId,
      expiresAt: invite.expiresAt.toISOString(),
    }
  }
}
