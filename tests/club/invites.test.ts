import { describe, expect, test } from 'vitest'
import type { ServerMessage } from '../../src/club/outbox.js'
import { checkAck, expectError, roomOf, student } from './helpers/rooms.js'
import { members, partsHarness, type PartsHarness } from './helpers/parts.js'

const A = student(1)
const B = student(2)
const C = student(3)
const D = student(4)
const everyone = members(A, B, C, D)

type Invite = Extract<ServerMessage, { type: 'invite' }>
const invitesOf = (h: PartsHarness, studentId: number) =>
  h.outbox.of(studentId).filter((m): m is Invite => m.type === 'invite')
const endedOf = (h: PartsHarness, studentId: number) =>
  h.outbox.of(studentId).filter((m) => m.type === 'invite.ended')

/** A opens an invite-only room and invites B; gives the room and the invitation. */
function invited(h: PartsHarness, visibility: 'public' | 'invite' = 'invite'): { roomId: string; invite: Invite } {
  const result = checkAck(h.invites.create(A, { visibility, bots: false, invite: [2] }, everyone, h.now), 'RoomResult')
  const roomId = roomOf(result).roomId
  const invite = invitesOf(h, 2).at(-1)!
  expect(invite.roomId).toBe(roomId)
  return { roomId, invite }
}

describe('sending invitations', () => {
  test('room.create with invite opens the room and invites each one', () => {
    const h = partsHarness()
    const result = checkAck(h.invites.create(A, { visibility: 'invite', bots: false, invite: [2, 3] }, everyone, h.now), 'RoomResult')
    const roomId = roomOf(result).roomId
    for (const id of [2, 3]) {
      expect(invitesOf(h, id)).toEqual([
        { type: 'invite', inviteId: id - 1, from: A.person, roomId, expiresAt: new Date(h.now.getTime() + 180_000).toISOString() },
      ])
    }
    expect(h.invites.size).toBe(2)
  })

  test('room.create without invite is a plain room', () => {
    const h = partsHarness()
    checkAck(h.invites.create(A, { visibility: 'public', bots: false }, everyone, h.now), 'RoomResult')
    expect(h.rooms.roomOf(1)).not.toBeNull()
    expect(h.invites.size).toBe(0)
  })

  test('bots with invite is invalid_message, and opens nothing', () => {
    const h = partsHarness()
    expectError(h.invites.create(A, { visibility: 'public', bots: true, invite: [2] }, everyone, h.now), 'invalid_message')
    expect(h.rooms.size).toBe(0)
  })

  test('room.create refused for an invitation opens no room: not a member, same owner, in a room', () => {
    const h = partsHarness()
    expectError(h.invites.create(A, { visibility: 'invite', bots: false, invite: [2, 9] }, everyone, h.now), 'not_member_target')
    const twin = student(5, A.email)
    expectError(h.invites.create(A, { visibility: 'invite', bots: false, invite: [5] }, members(twin), h.now), 'same_owner')
    expect(h.rooms.size).toBe(0)
    expect(h.outbox.deliveries).toEqual([])
    checkAck(h.invites.create(A, { visibility: 'public', bots: false }, everyone, h.now), 'RoomResult')
    expectError(h.invites.create(A, { visibility: 'public', bots: false, invite: [2] }, everyone, h.now), 'in_room')
  })

  test('room.invite: from anyone seated in the room; refused for one not a member or of the same owner as anyone in it', () => {
    const h = partsHarness()
    const roomId = invited(h, 'public').roomId
    checkAck(h.rooms.join(C, roomId, h.now), 'RoomResult')
    // C, not the host, invites D.
    expect(checkAck(h.invites.invite(C, 4, everyone, h.now))).toEqual({ ok: true })
    expect(invitesOf(h, 4).map((i) => [i.from.studentId, i.roomId])).toEqual([[3, roomId]])
    expectError(h.invites.invite(C, 9, everyone, h.now), 'not_member_target')
    // Of A's owner: refused even when C invites.
    const twin = student(5, A.email)
    expectError(h.invites.invite(C, 5, members(twin), h.now), 'same_owner')
    expectError(h.invites.invite(D, 2, everyone, h.now), 'not_in_room')
  })

  test('at most invitesPerDay a day, counted by the school day', () => {
    // 15:59 UTC is 23:59 in Shanghai.
    const h = partsHarness({ invitesPerDay: 3 }, new Date('2026-11-20T15:59:00.000Z'))
    checkAck(h.invites.create(A, { visibility: 'public', bots: false, invite: [2, 3] }, everyone, h.now), 'RoomResult')
    // Two of three gone: one more, and then no more today.
    expect(checkAck(h.invites.invite(A, 4, everyone, h.now))).toEqual({ ok: true })
    expectError(h.invites.invite(A, 5, members(A, B, C, D, student(5)), h.now), 'invite_cap')
    expect(invitesOf(h, 5)).toHaveLength(0)
    // Another student's count is their own.
    const roomId = h.rooms.roomOf(1)!
    checkAck(h.rooms.join(D, roomId, h.now), 'RoomResult')
    expect(checkAck(h.invites.invite(D, 2, everyone, h.now))).toEqual({ ok: true })
    // Midnight in Shanghai: a new day.
    h.advance(60)
    expect(checkAck(h.invites.invite(A, 5, members(student(5)), h.now))).toEqual({ ok: true })
    expect(invitesOf(h, 5)).toHaveLength(1)
  })

  test('room.create with invitations past the count is invite_cap and opens nothing', () => {
    const h = partsHarness({ invitesPerDay: 1 })
    expectError(h.invites.create(A, { visibility: 'invite', bots: false, invite: [2, 3] }, everyone, h.now), 'invite_cap')
    expect(h.rooms.size).toBe(0)
  })
})

describe('answering invitations', () => {
  test('accept seats the one invited in an invite-only room, and the inviter hears accepted', () => {
    const h = partsHarness()
    const { roomId, invite } = invited(h)
    const result = checkAck(h.invites.accept(B, invite.inviteId, h.now), 'RoomResult')
    expect(roomOf(result).roomId).toBe(roomId)
    expect(h.rooms.roomOf(2)).toBe(roomId)
    expect(endedOf(h, 1)).toEqual([{ type: 'invite.ended', inviteId: invite.inviteId, reason: 'accepted' }])
    expect(h.invites.size).toBe(0)
    // Accepted once; not again.
    expectError(h.invites.accept(B, invite.inviteId, h.now), 'invite_not_found')
  })

  test('decline ends it, declined', () => {
    const h = partsHarness()
    const { invite } = invited(h)
    expect(checkAck(h.invites.decline(2, invite.inviteId, h.now))).toEqual({ ok: true })
    expect(endedOf(h, 1)).toEqual([{ type: 'invite.ended', inviteId: invite.inviteId, reason: 'declined' }])
    expectError(h.invites.decline(2, invite.inviteId, h.now), 'invite_not_found')
  })

  test('an invitation that does not exist, or is for someone else, is invite_not_found', () => {
    const h = partsHarness()
    const { invite } = invited(h)
    expectError(h.invites.accept(B, 99, h.now), 'invite_not_found')
    expectError(h.invites.accept(C, invite.inviteId, h.now), 'invite_not_found')
    expectError(h.invites.decline(3, invite.inviteId, h.now), 'invite_not_found')
    expect(h.invites.size).toBe(1)
  })

  test('it expires after inviteSeconds: the inviter hears expired, and accepting it then is invite_not_found', () => {
    const h = partsHarness()
    const { invite } = invited(h)
    h.advance(179)
    expect(endedOf(h, 1)).toEqual([])
    h.advance(1)
    expect(endedOf(h, 1)).toEqual([{ type: 'invite.ended', inviteId: invite.inviteId, reason: 'expired' }])
    expect(h.invites.size).toBe(0)
    expectError(h.invites.accept(B, invite.inviteId, h.now), 'invite_not_found')
  })

  test('accepting one that has expired before the tick is invite_not_found, and it ends expired', () => {
    const h = partsHarness()
    const { invite } = invited(h)
    h.now = new Date(h.now.getTime() + 180_000)
    expectError(h.invites.accept(B, invite.inviteId, h.now), 'invite_not_found')
    expect(endedOf(h, 1)).toEqual([{ type: 'invite.ended', inviteId: invite.inviteId, reason: 'expired' }])
  })

  test('a room that filled keeps the invitation: accepting is room_full, and it stays', () => {
    const h = partsHarness()
    const { roomId, invite } = invited(h, 'public')
    checkAck(h.rooms.join(C, roomId, h.now), 'RoomResult')
    checkAck(h.rooms.join(D, roomId, h.now), 'RoomResult')
    expectError(h.invites.accept(B, invite.inviteId, h.now), 'room_full')
    expect(h.invites.size).toBe(1)
    expect(endedOf(h, 1)).toEqual([])
  })

  test('accepting checks in_room and same_owner again', () => {
    const h = partsHarness()
    const { roomId, invite } = invited(h, 'public')
    // B sits elsewhere.
    checkAck(h.rooms.create(B, { visibility: 'public', bots: false }, h.now), 'RoomResult')
    expectError(h.invites.accept(B, invite.inviteId, h.now), 'in_room')
    checkAck(h.rooms.leave(2, h.now))
    // A student of B's owner has sat down in A's room since.
    checkAck(h.rooms.join(student(5, B.email), roomId, h.now), 'RoomResult')
    expectError(h.invites.accept(B, invite.inviteId, h.now), 'same_owner')
    expect(h.invites.size).toBe(1)
  })

  test('the room closes: every invitation to it ends, room_closed', () => {
    const h = partsHarness()
    const result = checkAck(h.invites.create(A, { visibility: 'invite', bots: false, invite: [2, 3] }, everyone, h.now), 'RoomResult')
    checkAck(h.rooms.leave(1, h.now))
    expect(h.rooms.state(roomOf(result).roomId, h.now)).toBeNull()
    expect(endedOf(h, 1)).toEqual([
      { type: 'invite.ended', inviteId: 1, reason: 'room_closed' },
      { type: 'invite.ended', inviteId: 2, reason: 'room_closed' },
    ])
    expect(h.invites.size).toBe(0)
    expectError(h.invites.accept(B, 1, h.now), 'invite_not_found')
  })

  test('one invited while offline gets the invitations not expired yet when they connect', () => {
    const h = partsHarness()
    const { roomId, invite } = invited(h, 'public')
    checkAck(h.rooms.join(C, roomId, h.now), 'RoomResult')
    h.advance(100)
    checkAck(h.invites.invite(C, 2, everyone, h.now))
    // The first has 80 seconds left, the second 180.
    h.advance(90)
    const pending = h.invites.pendingFor(2, h.now)
    expect(pending.map((i) => i.inviteId)).toEqual([invite.inviteId + 1])
    expect(pending[0]).toEqual(invitesOf(h, 2).at(-1))
    expect(h.invites.pendingFor(3, h.now)).toEqual([])
    // Accepted after the reconnect.
    checkAck(h.invites.accept(B, pending[0]!.inviteId, h.now), 'RoomResult')
  })

  test('inviting the same one to the same room again while the invitation waits is no error, and sends and counts nothing', () => {
    const h = partsHarness({ invitesPerDay: 2 })
    const { roomId, invite } = invited(h, 'public')
    h.advance(60)
    expect(checkAck(h.invites.invite(A, 2, everyone, h.now))).toEqual({ ok: true })
    expect(invitesOf(h, 2)).toEqual([invite])
    expect(h.invites.size).toBe(1)
    // Still one of two counted: one more goes.
    expect(checkAck(h.invites.invite(A, 3, everyone, h.now))).toEqual({ ok: true })
    expectError(h.invites.invite(A, 4, everyone, h.now), 'invite_cap')
    // Another student in the room inviting B is another invitation.
    checkAck(h.rooms.join(D, roomId, h.now), 'RoomResult')
    checkAck(h.invites.invite(D, 2, everyone, h.now))
    expect(invitesOf(h, 2)).toHaveLength(2)
    // Once the first has expired, A's invitation is a new one (and past A's count).
    h.advance(120)
    expect(endedOf(h, 1)).toEqual([{ type: 'invite.ended', inviteId: invite.inviteId, reason: 'expired' }])
    expectError(h.invites.invite(A, 2, everyone, h.now), 'invite_cap')
  })
})

describe('a room with bots', () => {
  test('an invitation counts a student waiting for a seat as in the room, and the one invited may wait too', () => {
    const h = partsHarness()
    checkAck(h.invites.create(A, { visibility: 'public', bots: true }, everyone, h.now), 'RoomResult')
    const roomId = h.rooms.roomOf(1)!
    checkAck(h.rooms.join(B, roomId, h.now), 'RoomResult')
    const twin = student(5, B.email)
    expectError(h.invites.invite(A, 5, members(twin), h.now), 'same_owner')
    expect(checkAck(h.invites.invite(A, 3, everyone, h.now))).toEqual({ ok: true })
    const invite = invitesOf(h, 3).at(-1)!
    const room = roomOf(checkAck(h.invites.accept(C, invite.inviteId, h.now), 'RoomResult'))
    expect(room.waiting.map((p) => p.studentId)).toEqual([2, 3])
  })
})
