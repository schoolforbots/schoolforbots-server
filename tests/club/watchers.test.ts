import { describe, expect, test } from 'vitest'
import { checkAck, expectError, playOut, roomOf, student } from './helpers/rooms.js'
import { partsHarness, type PartsHarness } from './helpers/parts.js'

const A = student(1)
const B = student(2)
const C = student(3)
const S = 10

/** A room of A and B. */
function room(h: PartsHarness, host = A, other = B): string {
  checkAck(h.rooms.create(host, { visibility: 'public', bots: false }, h.now), 'RoomResult')
  const roomId = h.rooms.roomOf(host.person.studentId)!
  checkAck(h.rooms.join(other, roomId, h.now), 'RoomResult')
  return roomId
}

describe('watching', () => {
  test('watch gives the room state, counted among the spectators; unwatch stops it', () => {
    const h = partsHarness()
    const roomId = room(h)
    const state = roomOf(checkAck(h.watchers.watch(S, roomId, h.now), 'RoomResult'))
    expect(state.roomId).toBe(roomId)
    expect(state.spectators).toBe(1)
    expect(h.rooms.state(roomId, h.now)!.spectators).toBe(1)
    // Again: no error, still one.
    expect(roomOf(checkAck(h.watchers.watch(S, roomId, h.now), 'RoomResult')).spectators).toBe(1)
    expect(checkAck(h.watchers.unwatch(S))).toEqual({ ok: true })
    expect(h.watchers.spectators(roomId)).toEqual([])
    expect(h.rooms.state(roomId, h.now)!.spectators).toBe(0)
    // Not watching: no error either.
    expect(checkAck(h.watchers.unwatch(S))).toEqual({ ok: true })
  })

  test('a room that does not exist is room_not_found', () => {
    const h = partsHarness()
    expectError(h.watchers.watch(S, 'rnope00', h.now), 'room_not_found')
  })

  test('at most maxSpectators', () => {
    const h = partsHarness({ maxSpectators: 2 })
    const roomId = room(h)
    checkAck(h.watchers.watch(11, roomId, h.now), 'RoomResult')
    checkAck(h.watchers.watch(12, roomId, h.now), 'RoomResult')
    expectError(h.watchers.watch(13, roomId, h.now), 'spectators_full')
    // One already watching it may watch it again.
    checkAck(h.watchers.watch(12, roomId, h.now), 'RoomResult')
    checkAck(h.watchers.unwatch(11))
    checkAck(h.watchers.watch(13, roomId, h.now), 'RoomResult')
    expect(h.watchers.spectators(roomId)).toEqual([12, 13])
  })

  test('a student seated in a room may not watch (in_room), not even their own room', () => {
    const h = partsHarness()
    const roomId = room(h)
    checkAck(h.rooms.create(C, { visibility: 'public', bots: false }, h.now), 'RoomResult')
    expectError(h.watchers.watch(1, roomId, h.now), 'in_room')
    expectError(h.watchers.watch(3, roomId, h.now), 'in_room')
    expect(h.watchers.size).toBe(0)
  })

  test('watching another room moves the spectator there; a refused watch keeps the old one', () => {
    const h = partsHarness({ maxSpectators: 1 })
    const first = room(h)
    const second = room(h, C, student(4))
    checkAck(h.watchers.watch(S, first, h.now), 'RoomResult')
    checkAck(h.watchers.watch(S, second, h.now), 'RoomResult')
    expect(h.watchers.spectators(first)).toEqual([])
    expect(h.watchers.spectators(second)).toEqual([S])
    expect(h.watchers.watchedBy(S)).toBe(second)
    checkAck(h.watchers.watch(11, first, h.now), 'RoomResult')
    expectError(h.watchers.watch(S, first, h.now), 'spectators_full')
    expect(h.watchers.watchedBy(S)).toBe(second)
  })

  test('a spectator gets the public room events, never a hand or a your_turn, and the replay is not theirs', () => {
    const h = partsHarness()
    const roomId = room(h)
    checkAck(h.watchers.watch(S, roomId, h.now), 'RoomResult')
    h.outbox.clear()
    checkAck(h.rooms.join(C, roomId, h.now), 'RoomResult')
    playOut(h, roomId)
    const got = h.outbox.deliveries.filter((d) => d.studentId === S)
    expect(got.length).toBeGreaterThan(0)
    expect(got.every((d) => d.as === 'spectator' && d.message.type === 'room.event')).toBe(true)
    // Every public room event since the spectator came, in order.
    const all = h.outbox.roomEvents.map((r) => r.frame.seq)
    expect(got.map((d) => (d.message as { seq: number }).seq)).toEqual(all)
    expect(got.map((d) => (d.message as { event: { kind: string } }).event.kind)).toContain('game')
    expect(h.outbox.deliveries.some((d) => d.message.type === 'hand' && d.studentId === S)).toBe(false)
    expect(h.rooms.replay(S, roomId, 0)).toBeNull()
  })

  test('sitting down in a room ends watching, and the joined event goes to the room once', () => {
    const h = partsHarness()
    const roomId = room(h)
    checkAck(h.watchers.watch(3, roomId, h.now), 'RoomResult')
    h.outbox.clear()
    const state = roomOf(checkAck(h.rooms.join(C, roomId, h.now), 'RoomResult'))
    expect(state.spectators).toBe(0)
    expect(h.watchers.watchedBy(3)).toBeNull()
    expect(h.outbox.roomEvents[0]!.frame.event.kind).toBe('joined')
    expect(h.outbox.roomEvents[0]!.audience).toEqual({ seated: [1, 2], spectators: [] })
  })

  test('a spectator who disconnects watches no more', () => {
    const h = partsHarness()
    const roomId = room(h)
    checkAck(h.watchers.watch(S, roomId, h.now), 'RoomResult')
    h.watchers.stop(S)
    expect(h.watchers.watchedBy(S)).toBeNull()
    expect(h.rooms.state(roomId, h.now)!.spectators).toBe(0)
  })

  test('the room closes: its spectators get the closed event and watch no more', () => {
    const h = partsHarness()
    const roomId = room(h)
    checkAck(h.watchers.watch(S, roomId, h.now), 'RoomResult')
    checkAck(h.watchers.watch(11, roomId, h.now), 'RoomResult')
    h.outbox.clear()
    h.rooms.closeAll('club_closed', h.now)
    for (const id of [S, 11]) {
      const got = h.outbox.eventsOf(id)
      expect(got.map((f) => f.event)).toEqual([{ kind: 'closed', reason: 'club_closed' }])
      // A spectator was never seated: no room.left.
      expect(h.outbox.of(id).filter((m) => m.type === 'room.left')).toEqual([])
      expect(h.watchers.watchedBy(id)).toBeNull()
    }
    expect(h.watchers.size).toBe(0)
    expect(h.watchers.spectators(roomId)).toEqual([])
  })
})
