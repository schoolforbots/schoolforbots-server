import type { Static } from 'typebox'
import type { ClubClientMessage, InviteMessage } from '../protocol/club.js'
import type { SchoolConfig } from '../shared/config.js'
import { localMoment } from '../shared/local-time.js'
import type { Maintenance } from '../shared/maintenance.js'
import { MEMBER_STATUSES } from '../shared/schema.js'
import type { StudentStatus } from '../shared/schema.js'
import type { AckResult, GameModule, GamePrivateMessage } from './game.js'
import { type ClubClosing, ClubHub } from './hub.js'
import type { Invites, InviteTargets } from './invites.js'
import type { RoomEventFrame } from './outbox.js'
import { clubParts, type ClubPartsOptions } from './parts.js'
import type { Reactions, WordLists } from './reactions.js'
import type { ClubStudent, Rooms } from './rooms.js'
import type { Watchers } from './watchers.js'

// The club in one object: the connections (`hub`, which is also the rooms' outbox), the rooms, invitations, reactions
// and watching (`clubParts`), and the game. A client message after hello goes to `handle`, which is synchronous: what
// it puts in the outbox for the student who sent it the connection sends after the `ack` (see `outbox.ts`). Time
// passing goes to `tick`, which the service calls about once a second. Nothing here touches the database: whatever a
// message needs from it (who an invitation names) the connection looks up first and gives along.
//
// Also here: the `closing` messages, and why a student may not come in (`studentRefusal`), which both the door
// (connection.ts) and the service's rounds of the students online use.

export type ClubClientFrame = Static<typeof ClubClientMessage>
/** A client message after hello. */
export type ClubAction = Exclude<ClubClientFrame, { type: 'hello' }>

type InviteFrame = Static<typeof InviteMessage>

/** A `closing` that closes the club for everyone: it closed, or went under maintenance. */
export type DoorClosing = ClubClosing & { reason: 'club_closed' | 'maintenance' }

export interface ClubOptions {
  readonly config: SchoolConfig
  readonly game: GameModule
  readonly wordLists: WordLists
  readonly randomInt?: ClubPartsOptions['randomInt']
  readonly onError?: ClubPartsOptions['onError']
  readonly nextClose?: ClubPartsOptions['nextClose']
  readonly listeners?: ClubPartsOptions['listeners']
}

/** What a student who comes back is sent after `welcome`, in this order, and the room `welcome` names. */
export interface Rejoin {
  /** The room the student sits in, or null. */
  readonly roomId: string | null
  /** The room events they missed (`replayed: true`), when their hello named the room they sit in. */
  readonly replay: RoomEventFrame[]
  /** What the game sends their seat again (their hand, their turn). */
  readonly resend: GamePrivateMessage[]
  /** The invitations to them not expired yet. */
  readonly invites: InviteFrame[]
}

export class Club {
  readonly config: SchoolConfig
  readonly game: GameModule
  readonly wordLists: WordLists
  readonly hub = new ClubHub()
  readonly rooms: Rooms
  readonly invites: Invites
  readonly reactions: Reactions
  readonly watchers: Watchers

  constructor(options: ClubOptions) {
    this.config = options.config
    this.game = options.game
    this.wordLists = options.wordLists
    const parts = clubParts({
      config: options.config,
      game: options.game,
      outbox: this.hub,
      wordLists: options.wordLists,
      ...(options.randomInt === undefined ? {} : { randomInt: options.randomInt }),
      ...(options.onError === undefined ? {} : { onError: options.onError }),
      ...(options.nextClose === undefined ? {} : { nextClose: options.nextClose }),
      ...(options.listeners === undefined ? {} : { listeners: options.listeners }),
    })
    this.rooms = parts.rooms
    this.invites = parts.invites
    this.reactions = parts.reactions
    this.watchers = parts.watchers
  }

  // ---- Client messages ----

  /** The student numbers a message names that `handle` needs looked up as invitation targets (`InviteTargets`). */
  targetsOf(message: ClubAction): number[] {
    if (message.type === 'room.create') return [...(message.invite ?? [])]
    if (message.type === 'room.invite') return [message.to]
    return []
  }

  /** Handles a client message of `student` after hello; `targets` answers for the numbers of `targetsOf`. */
  handle(student: ClubStudent, message: ClubAction, targets: InviteTargets, now: Date): AckResult {
    const studentId = student.person.studentId
    if ('game' in message) return this.rooms.gameMessage(studentId, message, now)
    switch (message.type) {
      case 'lobby.list':
        this.hub.toStudent(studentId, this.rooms.lobby())
        return { ok: true }
      case 'room.create':
        return this.invites.create(student, message, targets, now)
      case 'room.join': {
        // Into a room the student is invited to, joining is accepting the invitation (which then ends, `accepted`).
        const invite = this.invites.pendingFor(studentId, now).find((i) => i.roomId === message.roomId)
        if (invite !== undefined) return this.invites.accept(student, invite.inviteId, now)
        return this.rooms.join(student, message.roomId, now)
      }
      case 'room.quick':
        return this.rooms.quick(student, now)
      case 'room.invite':
        return this.invites.invite(student, message.to, targets, now)
      case 'room.accept':
        return this.invites.accept(student, message.inviteId, now)
      case 'room.decline':
        return this.invites.decline(studentId, message.inviteId, now)
      case 'room.ready':
        return this.rooms.ready(studentId, now)
      case 'room.leave':
        return this.rooms.leave(studentId, now)
      case 'room.bots':
        return this.rooms.bots(studentId, now)
      case 'trustee.off':
        return this.rooms.trusteeOff(studentId, now)
      case 'react':
        return this.reactions.react(student, message, now)
      case 'watch':
        return this.watchers.watch(studentId, message.roomId, now)
      case 'unwatch':
        return this.watchers.unwatch(studentId)
    }
  }

  // ---- Connections ----

  /**
   * The student has come in (their connection is in the hub): their seat, if they have one, is theirs for good again,
   * and this is what they are sent after `welcome`. The room events after `lastSeq` are replayed when `roomId` names
   * the room they sit in; a `lastSeq` past that room's last event is of another room that had the same id, and the
   * room is replayed whole then (what is kept of it).
   */
  rejoined(studentId: number, hello: { roomId?: string; lastSeq?: number }, now: Date): Rejoin {
    this.rooms.reconnected(studentId, now)
    const roomId = this.rooms.roomOf(studentId)
    let replay: RoomEventFrame[] = []
    if (roomId !== null && hello.roomId === roomId) {
      const last = this.rooms.state(roomId, now)!.lastSeq
      const lastSeq = hello.lastSeq ?? 0
      replay = this.rooms.replay(studentId, roomId, lastSeq <= last ? lastSeq : 0) ?? []
    }
    return {
      roomId,
      replay,
      resend: this.rooms.resend(studentId, now),
      invites: this.invites.pendingFor(studentId, now),
    }
  }

  /** The student's connection is gone (and no newer one took its place): their seat waits, they stop watching. */
  left(studentId: number, now: Date): void {
    this.rooms.disconnected(studentId, now)
    this.watchers.stop(studentId)
  }

  // ---- Time and closing ----

  /** About once a second: the rooms (games, graces, idle prompts) and the invitations' expiry. */
  tick(now: Date): void {
    this.rooms.tick(now)
    this.invites.tick(now)
  }

  /**
   * The club closes, or goes under maintenance: every game is played out, every room closes (`closed` with the
   * closing's reason), and then everyone connected is sent `closing` and disconnected.
   */
  closeDoors(closing: DoorClosing, now: Date): void {
    // Everyone is sent away even if closing the rooms went wrong.
    try {
      this.rooms.closeAll(closing.reason, now)
    } finally {
      this.hub.disconnectAll(closing)
    }
  }

  /** Everyone connected is sent `closing` and disconnected; the rooms are left as they are (the service stopping). */
  disconnectAll(closing: ClubClosing): void {
    this.hub.disconnectAll(closing)
  }

  /** The student is sent `closing` and disconnected, their seat handled as for any disconnect; false when offline. */
  disconnect(studentId: number, closing: ClubClosing): boolean {
    return this.hub.disconnect(studentId, closing)
  }

  /** The student numbers of everyone connected. */
  online(): number[] {
    return this.hub.online()
  }
}

// ---- Closing messages ----

const closing = (reason: ClubClosing['reason'], message: string): ClubClosing => ({ type: 'closing', reason, message })

export const REPLACED = closing('replaced', '这个学号在别的地方连上了社团，这里的连接已经断开。')
export const HELLO_TIMEOUT = closing('service_stopping', '连上以后没有及时收到 hello，连接已经断开。')
/** What everyone is told when the service stops. */
export const SERVICE_STOPPING = closing('service_stopping', '社团服务正在重启，请稍后重连。')

/**
 * The club is closed: until `reopensAt`, or, when that is not known (the clubs are switched off), with no `reopensAt`.
 */
export function clubClosedClosing(reopensAt: Date | null, config: SchoolConfig): DoorClosing {
  if (reopensAt === null) return { type: 'closing', reason: 'club_closed', message: '社团暂时关闭了，什么时候开放另行通知。' }
  return {
    type: 'closing',
    reason: 'club_closed',
    message: `社团现在关门了，${localMoment(reopensAt, config.timezone)} 以后再来。`,
    reopensAt: reopensAt.toISOString(),
  }
}

/** The school is under maintenance: what the operator wrote, as written, and when it is expected back. */
export function maintenanceClosing(m: Maintenance): DoorClosing {
  const expectedBackAt = m.expectedBackAt?.toISOString() ?? null
  return { type: 'closing', reason: 'maintenance', message: m.message, expectedBackAt }
}

/** What a student's standing is made of, as the `students` table has it, and whether they are a current member. */
export interface Standing {
  readonly status: StudentStatus
  readonly suspendedUntil: Date | null
  readonly classId: number | null
  readonly member: boolean
}

/**
 * Why the student may not come in now, as the `closing` that says so; null when they may. A suspension that has
 * ended does not count (the student is as if active until the status is put back). Suspended, then expelled, then
 * anyone not a current member of the club in good standing (`not_member`, the message saying which: withdrawn, in no
 * class yet, or not a member).
 */
export function studentRefusal(
  s: Standing,
  game: Pick<GameModule, 'name'>,
  config: SchoolConfig,
  now: Date,
): ClubClosing | null {
  const until = s.suspendedUntil
  if (s.status === 'suspended' && (until === null || until.getTime() > now.getTime())) {
    const message =
      until === null ? '你正在停课，暂时不能来社团。' : `你正在停课，${localMoment(until, config.timezone)} 以后才能回来社团。`
    return closing('suspended', message)
  }
  if (s.status === 'expelled') return closing('expelled', '你已经被开除，不能再来社团了。')
  if (s.status === 'dropped') return closing('not_member', '你已经退学，不能来社团了。')
  if (s.classId === null || !(MEMBER_STATUSES as readonly StudentStatus[]).includes(s.status)) {
    return closing('not_member', '你还没有分班，分到班级以后才能入社。')
  }
  if (!s.member) return closing('not_member', `你还不是${game.name}的社员，请主人打开社团的开关入社以后再来。`)
  return null
}
