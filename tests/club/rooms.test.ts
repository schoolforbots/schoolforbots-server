import { describe, expect, test, vi } from 'vitest'
import type { SessionStart } from '../../src/club/game.js'
import { nextClose } from '../../src/club/hours.js'
import type { RoomEventFrame, ServerMessage } from '../../src/club/outbox.js'
import type { ClubStudent } from '../../src/club/rooms.js'
import type { FakeSession } from './helpers/fake-game.js'
import { checkAck, expectError, harness, type Harness, openRoom, playOut, roomOf, student, T0 } from './helpers/rooms.js'

const A = student(1)
const B = student(2)
const C = student(3)
const D = student(4)

const kinds = (frames: RoomEventFrame[]) => frames.map((f) => f.event.kind)
const eventsOfRoom = (h: Harness, roomId: string) =>
  h.outbox.roomEvents.filter((r) => r.roomId === roomId).map((r) => r.frame)
const leftMessages = (h: Harness, studentId: number) => h.outbox.of(studentId).filter((m) => m.type === 'room.left')

/** A room of A, B and C whose first game has started. */
function fullRoom(h: Harness): string {
  const roomId = openRoom(h, A, [B])
  checkAck(h.rooms.join(C, roomId, h.now), 'RoomResult')
  return roomId
}

describe('opening and joining', () => {
  test('a new room has its host in seat 0, ready, and no game', () => {
    const h = harness()
    const result = checkAck(h.rooms.create(A, { visibility: 'public', bots: false }, h.now), 'RoomResult')
    const room = roomOf(result)
    expect(room.roomId).toMatch(/^r[0-9a-z]{6}$/)
    expect(room).toMatchObject({
      club: 'doudizhu',
      visibility: 'public',
      host: 1,
      spectators: 0,
      gamesPlayed: 0,
      closesAt: nextClose(h.config, T0).toISOString(),
      lastSeq: 1,
      game: null,
    })
    expect(room.seats).toEqual([
      { seat: 0, player: { studentId: 1, displayName: '主人1家的小鱼1 #0001', bot: false }, ready: true, online: true, trustee: false },
      { seat: 1, player: null, ready: false, online: false, trustee: false },
      { seat: 2, player: null, ready: false, online: false, trustee: false },
    ])
    // Its own `joined` is in the state it was given, so it is not sent to it.
    expect(h.outbox.of(1)).toEqual([])
    expect(h.rooms.roomOf(1)).toBe(room.roomId)
  })

  test('the others hear of whoever joins; the one who joins gets the state with their own joined', () => {
    const h = harness()
    const roomId = openRoom(h, A)
    const room = roomOf(checkAck(h.rooms.join(B, roomId, h.now), 'RoomResult'))
    expect(room.lastSeq).toBe(2)
    expect(room.seats[1]!.player!.studentId).toBe(2)
    expect(h.outbox.eventsOf(1).map((f) => [f.seq, f.event])).toEqual([
      [2, { kind: 'joined', seat: 1, player: { studentId: 2, displayName: '主人2家的小鱼2 #0002', bot: false } }],
    ])
    expect(h.outbox.of(2)).toEqual([])
  })

  test('the room fills, and the first game starts: the deal to all, each hand to its own seat alone', () => {
    const h = harness()
    const roomId = openRoom(h, A, [B])
    h.outbox.clear()
    const room = roomOf(checkAck(h.rooms.join(C, roomId, h.now), 'RoomResult'))
    // C's state is from right after it sat down; the game follows as room events.
    expect(room.game).toBeNull()
    expect(room.lastSeq).toBe(3)
    expect(h.game.sessions).toHaveLength(1)
    for (const id of [1, 2, 3]) {
      const got = h.outbox.of(id)
      const hands = got.filter((m) => m.type === 'hand')
      expect(hands).toHaveLength(1)
      expect(got.filter((m) => m.type === 'room.event').map((m) => (m as RoomEventFrame).seq)).toEqual(
        id === 3 ? [4] : [3, 4],
      )
    }
    // The first bidder (seat 0, A) alone is asked.
    expect(h.outbox.deliveries.filter((d) => d.message.type === 'your_turn').map((d) => d.studentId)).toEqual([1])
    const state = h.rooms.state(roomId, h.now)!
    expect(state.game).toMatchObject({ phase: 'bidding', toAct: 0 })
  })

  test('a game, ready, and the next game, which goes on from the last', () => {
    const h = harness()
    const roomId = fullRoom(h)
    playOut(h, roomId)
    let state = h.rooms.state(roomId, h.now)!
    expect(state.gamesPlayed).toBe(1)
    expect(state.game).toMatchObject({ phase: 'over' })
    expect(state.seats.map((s) => s.ready)).toEqual([false, false, false])

    h.outbox.clear()
    checkAck(h.rooms.ready(1, h.now))
    checkAck(h.rooms.ready(1, h.now)) // ready already: no error, nothing new
    checkAck(h.rooms.ready(2, h.now))
    expect(kinds(h.outbox.eventsOf(3))).toEqual(['ready', 'ready'])
    expect(h.outbox.eventsOf(3).map((f) => f.event)).toEqual([
      { kind: 'ready', seat: 0 },
      { kind: 'ready', seat: 1 },
    ])
    expect(h.game.sessions).toHaveLength(1)
    checkAck(h.rooms.ready(3, h.now))
    expect(h.game.sessions).toHaveLength(2)
    expect((h.game.sessions[1] as FakeSession).firstBidder).toBe(1)
    state = h.rooms.state(roomId, h.now)!
    expect(state.game).toMatchObject({ phase: 'bidding', gameId: 2 })
    playOut(h, roomId)
    expect(h.rooms.state(roomId, h.now)!.gamesPlayed).toBe(2)
  })

  test('a student in a room may not open, join or quick-join another', () => {
    const h = harness()
    const roomId = openRoom(h, A)
    const other = openRoom(h, B)
    expectError(h.rooms.create(A, { visibility: 'public', bots: false }, h.now), 'in_room')
    expectError(h.rooms.join(A, other, h.now), 'in_room')
    expectError(h.rooms.join(A, roomId, h.now), 'in_room')
    expectError(h.rooms.quick(A, h.now), 'in_room')
  })

  test('no such room, an invite-only room, a full room', () => {
    const h = harness()
    expectError(h.rooms.join(A, 'rnope00', h.now), 'room_not_found')
    const invite = openRoom(h, A, [], 'invite')
    expectError(h.rooms.join(B, invite, h.now), 'room_private')
    checkAck(h.rooms.join(B, invite, h.now, { invited: true }), 'RoomResult')
    checkAck(h.rooms.join(C, invite, h.now, { invited: true }), 'RoomResult')
    expectError(h.rooms.join(D, invite, h.now, { invited: true }), 'room_full')
  })

  test('room ids are drawn again when they are taken', () => {
    const draws = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 4, 5, 6]
    const h = harness({ randomInt: () => draws.shift() ?? 0 })
    const first = openRoom(h, A)
    const second = openRoom(h, B)
    expect(first).toBe('r000000')
    expect(second).toBe('r123456')
  })
})

describe('the same owner', () => {
  test('two students of one owner never sit in one room, by joining or by quick join', () => {
    const h = harness()
    const sibling = student(9, 'owner1@example.com')
    const roomId = openRoom(h, A)
    expectError(h.rooms.join(sibling, roomId, h.now), 'same_owner')
    expectError(h.rooms.join(sibling, roomId, h.now, { invited: true }), 'same_owner')
    const quick = checkAck(h.rooms.quick(sibling, h.now), 'QuickJoinResult')
    expect(quick).toMatchObject({ ok: true, result: { created: true } })
    expect(roomOf(quick).roomId).not.toBe(roomId)
  })
})

describe('leaving', () => {
  test('the one who leaves is told, the others see it, and the host passes to the next student in seat order', () => {
    const h = harness()
    const roomId = openRoom(h, A, [B])
    h.outbox.clear()
    checkAck(h.rooms.leave(1, h.now))
    expect(leftMessages(h, 1)).toEqual([{ type: 'room.left', roomId, reason: 'left' }])
    expect(h.outbox.eventsOf(1)).toEqual([])
    expect(h.outbox.eventsOf(2).map((f) => f.event)).toEqual([
      { kind: 'left', seat: 0, player: { studentId: 1, displayName: '主人1家的小鱼1 #0001', bot: false }, reason: 'left' },
      { kind: 'host', studentId: 2 },
    ])
    expect(h.rooms.roomOf(1)).toBeNull()
    expect(h.rooms.state(roomId, h.now)!.host).toBe(2)
  })

  test('the host goes round the seats', () => {
    const h = harness()
    const roomId = openRoom(h, A, [B]) // A in seat 0, B in seat 1
    checkAck(h.rooms.leave(1, h.now)) // B is host; seat 0 is free
    checkAck(h.rooms.join(C, roomId, h.now), 'RoomResult') // C takes seat 0
    checkAck(h.rooms.leave(2, h.now)) // after seat 1: seat 2 is free, then seat 0
    expect(h.rooms.state(roomId, h.now)!.host).toBe(3)
  })

  test('when the last student leaves, the room closes as empty and is forgotten', () => {
    const closed: string[] = []
    const h = harness({ listeners: { closed: (roomId, reason) => closed.push(`${roomId}:${reason}`) } })
    const roomId = openRoom(h, A)
    checkAck(h.rooms.leave(1, h.now))
    expect(closed).toEqual([`${roomId}:empty`])
    expect(h.rooms.size).toBe(0)
    expect(h.rooms.state(roomId, h.now)).toBeNull()
    expect(h.rooms.replay(1, roomId, 0)).toBeNull()
    expect(kinds(eventsOfRoom(h, roomId))).toEqual([])
  })

  test('a room with only bots left closes as empty', () => {
    const h = harness({ spectators: () => [900] })
    const roomId = roomOf(checkAck(h.rooms.create(A, { visibility: 'public', bots: true }, h.now), 'RoomResult')).roomId
    playOut(h, roomId)
    checkAck(h.rooms.leave(1, h.now))
    expect(h.rooms.size).toBe(0)
    const last = h.outbox.eventsOf(900).slice(-2).map((f) => f.event)
    expect(last).toEqual([
      expect.objectContaining({ kind: 'left', seat: 0, reason: 'left' }),
      { kind: 'closed', reason: 'empty' },
    ])
  })

  test('nobody leaves during a game; getting ready then does nothing', () => {
    const h = harness()
    const roomId = fullRoom(h)
    expectError(h.rooms.leave(2, h.now), 'game_in_progress')
    const before = h.outbox.deliveries.length
    expect(checkAck(h.rooms.ready(2, h.now))).toEqual({ ok: true })
    expect(h.outbox.deliveries).toHaveLength(before)
    expect(h.rooms.roomOf(2)).toBe(roomId)
    playOut(h, roomId)
    // It did not count for the next game.
    expect(h.rooms.state(roomId, h.now)!.seats[1]!.ready).toBe(false)
  })

  test('a student in no room', () => {
    const h = harness()
    expectError(h.rooms.leave(1, h.now), 'not_in_room')
    expectError(h.rooms.ready(1, h.now), 'not_in_room')
    expectError(h.rooms.bots(1, h.now), 'not_in_room')
    expectError(h.rooms.trusteeOff(1, h.now), 'not_in_room')
    expectError(h.rooms.gameMessage(1, { id: 'b', type: 'bid', game: 'doudizhu', turn: 1, bid: 3 }, h.now), 'not_in_room')
  })

  test('game messages before the first game', () => {
    const h = harness()
    openRoom(h, A)
    expectError(h.rooms.gameMessage(1, { id: 'b', type: 'bid', game: 'doudizhu', turn: 1, bid: 3 }, h.now), 'stale_turn')
    expectError(h.rooms.trusteeOff(1, h.now), 'not_trustee')
  })
})

describe('the idle prompt', () => {
  const IDLE = 10 * 60
  const DECIDE = 180

  test('before the first game: nobody is asked out, and room.bots fills the seats and starts', () => {
    const h = harness()
    const roomId = openRoom(h, A, [B])
    h.advance(IDLE - 1)
    expect(kinds(h.outbox.eventsOf(1))).not.toContain('idle')
    h.advance(1)
    const idle = h.outbox.eventsOf(1).find((f) => f.event.kind === 'idle')!
    expect(idle.event).toEqual({ kind: 'idle', decideBy: new Date(h.now.getTime() + DECIDE * 1000).toISOString() })
    expect(h.rooms.state(roomId, h.now)!.seats.filter((s) => s.player !== null)).toHaveLength(2)

    h.outbox.clear()
    checkAck(h.rooms.bots(2, h.now))
    const events = h.outbox.eventsOf(1)
    expect(events[0]!.event).toEqual({
      kind: 'bots',
      seats: [2],
      players: [{ studentId: null, displayName: '陪练小一', bot: true }],
    })
    expect(events[1]!.event).toMatchObject({ kind: 'game', event: { kind: 'dealt' } })
    expect(h.game.sessions).toHaveLength(1)
    expectError(h.rooms.bots(2, h.now), 'no_idle_prompt')
  })

  test('after a game: those not ready are asked out first, then the prompt', () => {
    const h = harness()
    const roomId = fullRoom(h)
    playOut(h, roomId)
    h.outbox.clear()
    checkAck(h.rooms.ready(1, h.now))
    h.advance(IDLE)
    expect(leftMessages(h, 2)).toEqual([{ type: 'room.left', roomId, reason: 'not_ready' }])
    expect(leftMessages(h, 3)).toEqual([{ type: 'room.left', roomId, reason: 'not_ready' }])
    expect(h.outbox.eventsOf(1).map((f) => f.event.kind === 'left' ? `left:${f.event.seat}:${f.event.reason}` : f.event.kind)).toEqual([
      'ready',
      'left:1:not_ready',
      'left:2:not_ready',
      'idle',
    ])
    expect(h.rooms.roomOf(2)).toBeNull()
    checkAck(h.rooms.bots(1, h.now))
    expect(h.game.sessions).toHaveLength(2)
  })

  test('a host asked out passes the host to a student who stays', () => {
    const h = harness()
    const roomId = openRoom(h, A, [B])
    checkAck(h.rooms.join(C, roomId, h.now), 'RoomResult')
    playOut(h, roomId)
    checkAck(h.rooms.ready(3, h.now))
    h.outbox.clear()
    h.advance(IDLE)
    expect(h.outbox.eventsOf(3).map((f) => f.event.kind === 'left' ? `left:${f.event.seat}` : f.event.kind)).toEqual([
      'left:1',
      'left:0',
      'host',
      'idle',
    ])
    expect(h.rooms.state(roomId, h.now)!.host).toBe(3)
  })

  test('after a game nobody is ready: everyone is asked out and the room closes as empty, with no prompt', () => {
    const h = harness({ spectators: () => [900] })
    const roomId = fullRoom(h)
    playOut(h, roomId)
    h.outbox.clear()
    h.advance(IDLE)
    expect(kinds(h.outbox.eventsOf(900))).toEqual(['left', 'left', 'left', 'closed'])
    expect(h.outbox.eventsOf(900).at(-1)!.event).toEqual({ kind: 'closed', reason: 'empty' })
    expect(h.rooms.size).toBe(0)
  })

  test('the idle clock starts again when a game ends', () => {
    const h = harness()
    const roomId = fullRoom(h)
    h.advance(IDLE + 60) // during the game: no prompt
    expect(kinds(h.outbox.eventsOf(1))).not.toContain('idle')
    playOut(h, roomId)
    for (const id of [1, 2, 3]) checkAck(h.rooms.ready(id, h.now)) // the second game starts
    playOut(h, roomId)
    h.outbox.clear()
    checkAck(h.rooms.ready(1, h.now))
    checkAck(h.rooms.ready(2, h.now))
    checkAck(h.rooms.ready(3, h.now))
    expect(h.game.sessions).toHaveLength(3)
  })

  test('nobody answers by decideBy: the room closes as idle', () => {
    const h = harness()
    const roomId = openRoom(h, A, [B])
    h.advance(IDLE)
    h.outbox.clear()
    h.advance(DECIDE - 1)
    expect(h.rooms.size).toBe(1)
    h.advance(1)
    expect(h.rooms.size).toBe(0)
    for (const id of [1, 2]) {
      expect(h.outbox.eventsOf(id).map((f) => f.event)).toEqual([{ kind: 'closed', reason: 'idle' }])
      expect(leftMessages(h, id)).toEqual([{ type: 'room.left', roomId, reason: 'closed' }])
    }
    expect(h.rooms.roomOf(1)).toBeNull()
  })

  test('room.bots at decideBy, before the tick, is too late', () => {
    const h = harness()
    openRoom(h, A, [B])
    h.advance(IDLE)
    h.now = new Date(h.now.getTime() + DECIDE * 1000)
    expectError(h.rooms.bots(1, h.now), 'no_idle_prompt')
  })

  test('the room fills before decideBy: the game starts and the prompt is over', () => {
    const h = harness()
    const roomId = openRoom(h, A, [B])
    h.advance(IDLE)
    h.advance(30)
    checkAck(h.rooms.join(C, roomId, h.now), 'RoomResult')
    expect(h.game.sessions).toHaveLength(1)
    expectError(h.rooms.bots(1, h.now), 'no_idle_prompt')
    h.advance(DECIDE) // past the old decideBy: nothing closes
    expect(h.rooms.size).toBe(1)
  })

  test('room.bots without a prompt', () => {
    const h = harness()
    openRoom(h, A)
    expectError(h.rooms.bots(1, h.now), 'no_idle_prompt')
  })

  test('a room opened with bots starts at once and never gets a prompt while it plays', () => {
    const started: string[] = []
    const h = harness({ listeners: { gameStarted: (roomId) => started.push(roomId) } })
    const result = checkAck(h.rooms.create(A, { visibility: 'invite', bots: true }, h.now), 'RoomResult')
    const roomId = roomOf(result).roomId
    expect(started).toEqual([roomId])
    const events = h.outbox.eventsOf(1)
    expect(events[0]!.event).toEqual({
      kind: 'bots',
      seats: [1, 2],
      players: [
        { studentId: null, displayName: '陪练小一', bot: true },
        { studentId: null, displayName: '陪练小二', bot: true },
      ],
    })
    expect(h.outbox.of(1).filter((m) => m.type === 'hand')).toHaveLength(1)
    h.advance(IDLE + DECIDE + 1)
    expect(kinds(h.outbox.eventsOf(1))).not.toContain('idle')
    expect(h.rooms.size).toBe(1)
    const state = h.rooms.state(roomId, h.now)!
    expect(state.seats.map((s) => [s.ready, s.online])).toEqual([
      [true, true],
      [true, true],
      [true, true],
    ])
  })

  test('bots stay ready after a game; the student alone gets ready', () => {
    const h = harness()
    const roomId = roomOf(h.rooms.create(A, { visibility: 'public', bots: true }, h.now)).roomId
    playOut(h, roomId)
    expect(h.rooms.state(roomId, h.now)!.seats.map((s) => s.ready)).toEqual([false, true, true])
    checkAck(h.rooms.ready(1, h.now))
    expect(h.game.sessions).toHaveLength(2)
  })
})

describe('disconnecting', () => {
  const GRACE = 60

  test('out of a game, the seat is kept for the grace, and then the student is put out', () => {
    const h = harness()
    const roomId = openRoom(h, A, [B])
    h.rooms.disconnected(2, h.now)
    expect(h.rooms.state(roomId, h.now)!.seats[1]).toMatchObject({ online: false, ready: true })
    h.outbox.clear()
    h.advance(GRACE - 1)
    expect(h.rooms.roomOf(2)).toBe(roomId)
    h.advance(1)
    expect(h.rooms.roomOf(2)).toBeNull()
    expect(h.outbox.eventsOf(1).map((f) => f.event)).toEqual([
      expect.objectContaining({ kind: 'left', seat: 1, reason: 'disconnected_idle' }),
    ])
    // Nobody to tell: B is not connected.
    expect(h.outbox.of(2)).toEqual([])
  })

  test('coming back within the grace keeps the seat', () => {
    const h = harness()
    const roomId = openRoom(h, A, [B])
    h.rooms.disconnected(2, h.now)
    h.advance(GRACE - 1)
    h.rooms.reconnected(2, h.now)
    h.advance(GRACE * 2)
    expect(h.rooms.roomOf(2)).toBe(roomId)
    expect(h.rooms.state(roomId, h.now)!.seats[1]!.online).toBe(true)
  })

  test('the host put out passes the host on; the last one put out closes the room', () => {
    const h = harness()
    const roomId = openRoom(h, A, [B])
    h.rooms.disconnected(1, h.now)
    h.advance(GRACE)
    expect(h.rooms.state(roomId, h.now)!.host).toBe(2)
    h.rooms.disconnected(2, h.now)
    h.advance(GRACE)
    expect(h.rooms.size).toBe(0)
  })

  test('during a game the seat is kept; the grace counts from the end of the game', () => {
    const h = harness()
    const roomId = fullRoom(h)
    h.rooms.disconnected(2, h.now)
    h.advance(GRACE * 10)
    expect(h.rooms.roomOf(2)).toBe(roomId)
    expect(h.rooms.state(roomId, h.now)!.seats[1]!.online).toBe(false)
    playOut(h, roomId)
    h.advance(GRACE - 1)
    expect(h.rooms.roomOf(2)).toBe(roomId)
    h.advance(1)
    expect(h.rooms.roomOf(2)).toBeNull()
  })

  test('a room filled while a student is away does not start; their grace runs, and they are put out', () => {
    const h = harness()
    const roomId = openRoom(h, A)
    h.rooms.disconnected(1, h.now)
    checkAck(h.rooms.join(B, roomId, h.now), 'RoomResult')
    checkAck(h.rooms.join(C, roomId, h.now), 'RoomResult')
    expect(h.game.sessions).toHaveLength(0)
    expect(h.rooms.state(roomId, h.now)!.game).toBeNull()
    h.outbox.clear()
    h.advance(GRACE - 1)
    expect(h.rooms.roomOf(1)).toBe(roomId)
    h.advance(1)
    expect(h.rooms.roomOf(1)).toBeNull()
    expect(h.outbox.eventsOf(2).map((f) => f.event)).toEqual([
      expect.objectContaining({ kind: 'left', seat: 0, reason: 'disconnected_idle' }),
      { kind: 'host', studentId: 2 },
    ])
    expect(h.game.sessions).toHaveLength(0)
  })

  test('the student away comes back within the grace, and the game starts once they have had the room', () => {
    const h = harness()
    const roomId = openRoom(h, A)
    h.rooms.disconnected(1, h.now)
    checkAck(h.rooms.join(B, roomId, h.now), 'RoomResult')
    checkAck(h.rooms.join(C, roomId, h.now), 'RoomResult')
    h.advance(GRACE - 1)
    h.rooms.reconnected(1, h.now)
    // Not yet: what the student is sent on coming back is the room as it is, and the game's start follows it.
    expect(h.game.sessions).toHaveLength(0)
    h.rooms.startAfterReturn(1, h.now)
    expect(h.game.sessions).toHaveLength(1)
    expect(h.rooms.state(roomId, h.now)!.game).toMatchObject({ phase: 'bidding' })
    expect(h.outbox.of(1).filter((m) => m.type === 'hand')).toHaveLength(1)
    // Once is enough; a student with no room, or a room playing, is nothing to start.
    h.rooms.startAfterReturn(1, h.now)
    h.rooms.startAfterReturn(4, h.now)
    expect(h.game.sessions).toHaveLength(1)
    h.advance(GRACE * 2)
    expect(h.rooms.roomOf(1)).toBe(roomId)
  })

  test('one of two students away coming back does not start the game; the second does', () => {
    const h = harness()
    const roomId = openRoom(h, A, [B])
    h.rooms.disconnected(1, h.now)
    h.rooms.disconnected(2, h.now)
    checkAck(h.rooms.join(C, roomId, h.now), 'RoomResult')
    h.rooms.reconnected(1, h.now)
    h.rooms.startAfterReturn(1, h.now)
    expect(h.game.sessions).toHaveLength(0)
    h.rooms.reconnected(2, h.now)
    h.rooms.startAfterReturn(2, h.now)
    expect(h.game.sessions).toHaveLength(1)
  })

  test('after a game, the next one waits for a student away even when the others are ready', () => {
    const h = harness()
    const roomId = fullRoom(h)
    playOut(h, roomId)
    checkAck(h.rooms.ready(1, h.now))
    h.rooms.disconnected(1, h.now)
    checkAck(h.rooms.ready(2, h.now))
    checkAck(h.rooms.ready(3, h.now))
    expect(h.game.sessions).toHaveLength(1)
    h.rooms.reconnected(1, h.now)
    h.rooms.startAfterReturn(1, h.now)
    expect(h.game.sessions).toHaveLength(2)
  })

  test('a full table waiting for a student away is not prompted, nor closed as idle, however long the grace', () => {
    const IDLE = 10 * 60
    const DECIDE = 180
    const h = harness({ club: { disconnectGraceSeconds: 3600 } })
    const roomId = openRoom(h, A, [B])
    h.rooms.disconnected(2, h.now)
    checkAck(h.rooms.join(C, roomId, h.now), 'RoomResult')
    h.outbox.clear()
    for (let i = 0; i < 3; i++) h.advance(IDLE + DECIDE)
    expect(kinds(h.outbox.eventsOf(1))).toEqual([])
    expect(h.rooms.size).toBe(1)
    expectError(h.rooms.bots(1, h.now), 'no_idle_prompt')
    h.rooms.reconnected(2, h.now)
    h.rooms.startAfterReturn(2, h.now)
    expect(h.game.sessions).toHaveLength(1)
  })

  test('the host away put out at the end of the grace passes the host on, and a newcomer filling the room starts the game', () => {
    const h = harness()
    const roomId = openRoom(h, A)
    h.rooms.disconnected(1, h.now)
    checkAck(h.rooms.join(B, roomId, h.now), 'RoomResult')
    checkAck(h.rooms.join(C, roomId, h.now), 'RoomResult')
    h.advance(GRACE)
    expect(h.rooms.roomOf(1)).toBeNull()
    expect(h.rooms.state(roomId, h.now)!.host).toBe(2)
    expect(h.game.sessions).toHaveLength(0)
    checkAck(h.rooms.join(D, roomId, h.now), 'RoomResult')
    expect(h.game.sessions).toHaveLength(1)
    expect(h.game.sessions[0]!.addresses).toHaveLength(3)
    expect(h.rooms.state(roomId, h.now)!.game).toMatchObject({ phase: 'bidding' })
  })

  test('once the service is stopping, a student coming back to a full table starts no game', () => {
    const h = harness()
    const roomId = openRoom(h, A, [B])
    h.rooms.disconnected(1, h.now)
    checkAck(h.rooms.join(C, roomId, h.now), 'RoomResult')
    h.rooms.finishAll(h.now)
    h.rooms.reconnected(1, h.now)
    h.rooms.startAfterReturn(1, h.now)
    expect(h.game.sessions).toHaveLength(0)
    expect(h.rooms.state(roomId, h.now)!.game).toBeNull()
  })

  test('bot seats do not hold the start', () => {
    const h = harness()
    const roomId = roomOf(checkAck(h.rooms.create(A, { visibility: 'public', bots: true }, h.now), 'RoomResult')).roomId
    expect(h.game.sessions).toHaveLength(1)
    playOut(h, roomId)
    checkAck(h.rooms.ready(1, h.now))
    expect(h.game.sessions).toHaveLength(2)
  })

  test('a reconnect gets the events it missed that are still kept, and its hand and turn', () => {
    const h = harness()
    const roomId = fullRoom(h)
    expect(h.rooms.replay(1, 'rother0', 0)).toBeNull()
    expect(h.rooms.replay(4, roomId, 0)).toBeNull()
    const all = h.rooms.replay(1, roomId, 0)!
    expect(all.map((f) => f.seq)).toEqual([1, 2, 3, 4])
    expect(all.every((f) => f.replayed)).toBe(true)
    expect(h.rooms.replay(1, roomId, 3)!.map((f) => f.seq)).toEqual([4])
    expect(h.rooms.replay(1, roomId, 4)).toEqual([])
    expect(h.rooms.resend(1, h.now).map((m) => m.type)).toEqual(['hand', 'your_turn'])
    expect(h.rooms.resend(2, h.now).map((m) => m.type)).toEqual(['hand'])
    expect(h.rooms.resend(4, h.now)).toEqual([])
  })
})

describe('room events', () => {
  test('seq counts from 1 without a gap, and only the last roomEventBuffer are kept', () => {
    const h = harness({ club: { roomEventBuffer: 5 }, game: {} })
    const roomId = fullRoom(h)
    playOut(h, roomId)
    const sent = eventsOfRoom(h, roomId).map((f) => f.seq)
    const last = h.rooms.state(roomId, h.now)!.lastSeq
    expect(last).toBeGreaterThan(5)
    // Every seq from 2 on went out (seq 1, A's joined, had nobody else to go to).
    expect(sent).toEqual(Array.from({ length: last - 1 }, (_, i) => i + 2))
    expect(h.rooms.replay(1, roomId, 0)!.map((f) => f.seq)).toEqual([last - 4, last - 3, last - 2, last - 1, last])
  })

  test('the spectators get the public events but no private message, and are counted', () => {
    const h = harness({ spectators: () => [900, 901] })
    const watched = openRoom(h, A, [B])
    expect(h.rooms.state(watched, h.now)!.spectators).toBe(2)
    checkAck(h.rooms.join(C, watched, h.now), 'RoomResult')
    playOut(h, watched)
    const toSpectator = h.outbox.deliveries.filter((d) => d.studentId === 900)
    expect(toSpectator.length).toBeGreaterThan(0)
    expect(toSpectator.every((d) => d.as === 'spectator' && d.message.type === 'room.event')).toBe(true)
    expect(h.outbox.eventsOf(900).map((f) => f.seq)).toEqual(eventsOfRoom(h, watched).map((f) => f.seq))
  })

  test('a private event goes to those it names who sit in the room, and is replayed to them alone', () => {
    const h = harness({ spectators: () => [900] })
    const roomId = openRoom(h, A, [B])
    h.outbox.clear()
    const from = { studentId: 1, displayName: '主人1家的小鱼1 #0001', bot: false as const }
    const to = { studentId: 2, displayName: '主人2家的小鱼2 #0002', bot: false as const }
    const seq = h.rooms.emit(
      roomId,
      { kind: 'react', from, to, reaction: 'phrase', content: 'p1', text: '好牌', visibility: 'private' },
      h.now,
      [1, 2, 77],
    )
    const pub = h.rooms.emit(roomId, { kind: 'ready', seat: 0 }, h.now)
    expect(pub).toBe(seq + 1)
    expect(h.outbox.roomEvents.map((r) => r.audience)).toEqual([
      { seated: [1, 2], spectators: [] },
      { seated: [1, 2], spectators: [900] },
    ])
    checkAck(h.rooms.join(C, roomId, h.now), 'RoomResult')
    playOut(h, roomId)
    expect(h.rooms.replay(1, roomId, 0)!.map((f) => f.seq)).toContain(seq)
    expect(h.rooms.replay(3, roomId, 0)!.map((f) => f.seq)).not.toContain(seq)
    expect(h.rooms.replay(3, roomId, 0)!.map((f) => f.seq)).toContain(pub)
  })

  test('a hand goes to its seat alone, and a bot seat gets nothing', () => {
    const h = harness({ spectators: () => [900] })
    roomOf(h.rooms.create(A, { visibility: 'public', bots: true }, h.now))
    const privates = h.outbox.deliveries.filter((d) => d.message.type === 'hand' || d.message.type === 'your_turn')
    expect(privates.map((d) => [d.studentId, d.as, d.message.type])).toEqual([
      [1, 'student', 'hand'],
      [1, 'student', 'your_turn'],
    ])
  })
})

describe('closing the club', () => {
  test('a game being played is played out, then every room closes and its students are put out', () => {
    const closed: string[] = []
    const h = harness({ listeners: { closed: (_, reason) => closed.push(reason) } })
    const playing = fullRoom(h)
    const waiting = openRoom(h, D)
    h.outbox.clear()
    h.rooms.closeAll('club_closed', h.now)
    const events = h.outbox.eventsOf(1)
    const auto = events.flatMap((f) =>
      f.event.kind === 'game' && 'auto' in f.event.event ? [f.event.event.auto] : [],
    )
    expect(auto.length).toBeGreaterThan(0)
    expect(auto.every((a) => a === 'closing')).toBe(true)
    expect(events.some((f) => f.event.kind === 'game' && f.event.event.kind === 'over')).toBe(true)
    expect(events.at(-1)!.event).toEqual({ kind: 'closed', reason: 'club_closed' })
    expect((h.game.sessions[0] as FakeSession).over).toBe(true)
    for (const id of [1, 2, 3]) expect(leftMessages(h, id)).toEqual([{ type: 'room.left', roomId: playing, reason: 'closed' }])
    expect(leftMessages(h, 4)).toEqual([{ type: 'room.left', roomId: waiting, reason: 'closed' }])
    expect(h.rooms.size).toBe(0)
    expect(closed).toEqual(['club_closed', 'club_closed'])
    expect(h.rooms.roomOf(1)).toBeNull()
    expect(h.rooms.lobby().rooms).toEqual([])
  })

  test('maintenance closes the rooms the same way', () => {
    const h = harness()
    openRoom(h, A)
    h.rooms.closeAll('maintenance', h.now)
    expect(h.outbox.eventsOf(1).at(-1)!.event).toEqual({ kind: 'closed', reason: 'maintenance' })
    expect(h.rooms.size).toBe(0)
  })

  test('the memory of closed rooms is let go', () => {
    const h = harness()
    for (let i = 0; i < 100; i++) {
      const s = student(100 + i)
      openRoom(h, s)
      checkAck(h.rooms.leave(s.person.studentId, h.now))
    }
    expect(h.rooms.size).toBe(0)
  })
})

describe('the trustee', () => {
  test('trustee.off goes to the game and the state shows the seat in trusteeship', () => {
    const h = harness()
    const roomId = fullRoom(h)
    const session = h.game.sessions[0] as FakeSession
    // Seat 1 goes to the trustee; it acts only when seat 1 is to act, which seat 0 is now.
    const out = session.trusteeOn(1, h.now)
    expect(out.emits).toHaveLength(1)
    expect(h.rooms.state(roomId, h.now)!.seats.map((s) => s.trustee)).toEqual([false, true, false])
    checkAck(h.rooms.trusteeOff(2, h.now))
    expect(h.rooms.state(roomId, h.now)!.seats.map((s) => s.trustee)).toEqual([false, false, false])
    expect(h.outbox.eventsOf(1).at(-1)!.event).toEqual({ kind: 'trustee', seat: 1, on: false, reason: 'off' })
    expectError(h.rooms.trusteeOff(2, h.now), 'not_trustee')
  })
})

describe('a newcomer during an idle prompt', () => {
  const IDLE = 10 * 60
  const DECIDE = 180

  function prompted() {
    const h = harness()
    const roomId = openRoom(h, A)
    h.advance(IDLE)
    const idle = h.outbox.eventsOf(1).find((f) => f.event.kind === 'idle')!
    h.advance(30)
    h.outbox.clear()
    const result = checkAck(h.rooms.quick(B, h.now), 'QuickJoinResult')
    expect(roomOf(result).roomId).toBe(roomId)
    return { h, roomId, idle, state: roomOf(result) }
  }

  test('is told of the prompt after their joined, with the same decideBy, and may answer it', () => {
    const { h, roomId, idle, state } = prompted()
    const toB = h.outbox.eventsOf(2)
    expect(toB.map((f) => f.seq)).toEqual([state.lastSeq + 1])
    expect(toB[0]!.event).toEqual(idle.event)
    expect(toB[0]!.seq).toBeGreaterThan(idle.seq)
    expect(h.outbox.eventsOf(1).map((f) => f.event.kind)).toEqual(['joined', 'idle'])
    checkAck(h.rooms.bots(2, h.now))
    expect(h.game.sessions).toHaveLength(1)
    expect(h.rooms.state(roomId, h.now)!.game).not.toBeNull()
  })

  test('the idle clock does not start again: unanswered, the room closes at the first decideBy', () => {
    const { h } = prompted()
    h.advance(DECIDE - 30 - 1)
    expect(h.rooms.size).toBe(1)
    h.advance(1)
    expect(h.rooms.size).toBe(0)
    expect(leftMessages(h, 2)).toEqual([expect.objectContaining({ reason: 'closed' })])
  })

  test('one who fills the room while a student is away ends the prompt; the room waits out the grace, then prompts again', () => {
    const GRACE = 60
    const { h, roomId } = prompted()
    // 10 seconds before decideBy, B goes, and C fills the room.
    h.advance(DECIDE - 30 - 10)
    h.rooms.disconnected(2, h.now)
    h.outbox.clear()
    checkAck(h.rooms.join(C, roomId, h.now), 'RoomResult')
    expect(h.outbox.eventsOf(3)).toEqual([])
    expect(h.outbox.eventsOf(1).map((f) => f.event.kind)).toEqual(['joined'])
    expect(h.game.sessions).toHaveLength(0)
    expectError(h.rooms.bots(3, h.now), 'no_idle_prompt')
    // decideBy passes: the room stays, C in it.
    h.advance(10)
    expect(h.rooms.size).toBe(1)
    expect(h.rooms.roomOf(3)).toBe(roomId)
    h.advance(GRACE - 10 - 1)
    expect(h.rooms.roomOf(2)).toBe(roomId)
    expect(h.outbox.eventsOf(3).map((f) => f.event.kind)).toEqual([])
    // B's grace ends: the seat is free, and the room, which has waited long already, is prompted again at once.
    h.outbox.clear()
    h.advance(1)
    expect(h.rooms.roomOf(2)).toBeNull()
    expect(h.outbox.eventsOf(3).map((f) => f.event)).toEqual([
      expect.objectContaining({ kind: 'left', seat: 1, reason: 'disconnected_idle' }),
      { kind: 'idle', decideBy: new Date(h.now.getTime() + DECIDE * 1000).toISOString() },
    ])
    checkAck(h.rooms.bots(3, h.now))
    expect(h.game.sessions).toHaveLength(1)
  })

  test('one who fills the room gets the game, not the prompt', () => {
    const { h, roomId } = prompted()
    h.outbox.clear()
    checkAck(h.rooms.join(C, roomId, h.now), 'RoomResult')
    expect(h.outbox.eventsOf(3).map((f) => f.event.kind)).not.toContain('idle')
    expect(h.game.sessions).toHaveLength(1)
  })
})

describe('private events at a full table', () => {
  test('one naming A and B never reaches C, now or in a replay', () => {
    const h = harness({ spectators: () => [900] })
    const roomId = fullRoom(h)
    h.outbox.clear()
    const from = { studentId: 1, displayName: '主人1家的小鱼1 #0001', bot: false as const }
    const to = { studentId: 2, displayName: '主人2家的小鱼2 #0002', bot: false as const }
    const seq = h.rooms.emit(
      roomId,
      { kind: 'react', from, to, reaction: 'phrase', content: 'p1', text: '好牌', visibility: 'private' },
      h.now,
      [1, 2],
    )
    expect(h.outbox.roomEvents.map((r) => r.audience)).toEqual([{ seated: [1, 2], spectators: [] }])
    expect(h.outbox.eventsOf(1).map((f) => f.seq)).toEqual([seq])
    expect(h.outbox.eventsOf(2).map((f) => f.seq)).toEqual([seq])
    expect(h.outbox.eventsOf(3)).toEqual([])
    expect(h.outbox.eventsOf(900)).toEqual([])
    expect(h.rooms.replay(3, roomId, 0)!.map((f) => f.seq)).not.toContain(seq)
    expect(h.rooms.replay(2, roomId, 0)!.map((f) => f.seq)).toContain(seq)
  })
})

describe('the tick', () => {
  test('a room whose game throws is reported, and the other rooms go on', () => {
    const errors: [string, unknown][] = []
    const h = harness({ onError: (roomId, err) => errors.push([roomId, err]) })
    const broken = fullRoom(h)
    const waiting = openRoom(h, D)
    const session = h.game.sessions[0] as FakeSession
    session.tick = () => {
      throw new Error('boom')
    }
    h.advance(10 * 60)
    expect(errors).toEqual([[broken, expect.objectContaining({ message: 'boom' })]])
    // The other room got its idle prompt all the same.
    expect(h.outbox.eventsOf(4).map((f) => f.event.kind)).toContain('idle')
    expect(h.rooms.state(waiting, h.now)).not.toBeNull()
  })
})

describe('the next close', () => {
  test('is found once and reused until it comes, then found again', () => {
    const first = new Date(T0.getTime() + 3600_000)
    const second = new Date(T0.getTime() + 7200_000)
    let calls = 0
    const h = harness({
      nextClose: (now) => {
        calls++
        return now.getTime() < first.getTime() ? first : now.getTime() < second.getTime() ? second : now
      },
    })
    const roomId = openRoom(h, A, [B])
    checkAck(h.rooms.join(C, roomId, h.now), 'RoomResult') // states and turns, all from the cache
    expect(h.rooms.state(roomId, h.now)!.closesAt).toBe(first.toISOString())
    expect(calls).toBe(1)
    h.now = new Date(first.getTime() - 1)
    expect(h.rooms.state(roomId, h.now)!.closesAt).toBe(first.toISOString())
    expect(calls).toBe(1)
    h.now = first
    expect(h.rooms.state(roomId, h.now)!.closesAt).toBe(second.toISOString())
    expect(calls).toBe(2)
  })

  test('agrees with nextClose of the config across a closure', () => {
    const h = harness()
    const roomId = openRoom(h, A)
    for (let hours = 0; hours < 48; hours += 0.5) {
      const now = new Date(T0.getTime() + hours * 3600_000)
      expect(h.rooms.state(roomId, now)!.closesAt).toBe(nextClose(h.config, now).toISOString())
    }
  })
})

describe('what the game is told', () => {
  type YourTurn = Extract<ServerMessage, { type: 'your_turn' }>
  const lastTurn = (h: Harness) => h.outbox.deliveries.filter((d) => d.message.type === 'your_turn').at(-1)!

  /** Every student bids nothing until the game ends: the deal is redealt up to the limit, and nobody is landlord. */
  function bidNothing(h: Harness, roomId: string): void {
    for (let step = 0; h.rooms.state(roomId, h.now)!.game!.phase !== 'over'; step++) {
      if (step > 50) throw new Error('the game did not end')
      const { studentId, message } = lastTurn(h)
      const turn = (message as YourTurn).turn
      checkAck(h.rooms.gameMessage(studentId, { id: 'b', type: 'bid', game: 'doudizhu', turn, bid: 0 }, h.now))
    }
  }

  const readyAll = (h: Harness) => {
    for (const id of [1, 2, 3]) checkAck(h.rooms.ready(id, h.now))
  }

  test('the next game is given the last game’s carry, not the session: one seat on from the last deal, redeals included', () => {
    const h = harness()
    const starts: SessionStart[] = []
    const newSession = h.game.newSession.bind(h.game)
    h.game.newSession = (start) => {
      starts.push(start)
      return newSession(start)
    }
    const roomId = fullRoom(h)
    expect(starts[0]!.carry).toBeNull()

    // Game 1 bids first from seat 0; nobody bids, so its deals bid first from 0, 1 and 2.
    bidNothing(h, roomId)
    const dealts = eventsOfRoom(h, roomId).flatMap((f) =>
      f.event.kind === 'game' && f.event.event.kind === 'dealt' ? [f.event.event.firstBidder] : [],
    )
    expect(dealts).toEqual([0, 1, 2])
    readyAll(h)
    expect(starts[1]!.carry).toEqual({ firstBidder: 2 })
    expect(h.game.sessions).not.toContain(starts[1]!.carry)
    expect((h.game.sessions[1] as FakeSession).firstBidder).toBe(0)

    // Game 2 has a landlord at its first deal, from seat 0: game 3 bids first from seat 1.
    playOut(h, roomId)
    readyAll(h)
    expect(starts[2]!.carry).toEqual({ firstBidder: 0 })
    expect((h.game.sessions[2] as FakeSession).firstBidder).toBe(1)
  })

  const withAddress = (s: ClubStudent, address: string): ClubStudent => ({ ...s, address })

  test('each student seat’s address at the start, and a new one on a reconnect during the game; never sent', () => {
    const h = harness()
    const roomId = openRoom(h, withAddress(A, '203.0.113.1'), [withAddress(B, '203.0.113.2')])
    // A reconnect between games changes the address the next game starts with.
    h.rooms.disconnected(2, h.now)
    h.rooms.reconnected(2, h.now, '203.0.113.22')
    checkAck(h.rooms.join(C, roomId, h.now), 'RoomResult') // no address known
    const session = h.game.sessions[0]!
    expect(session.addresses).toEqual(['203.0.113.1', '203.0.113.22', null])

    const told = vi.spyOn(session, 'addressChanged')
    h.rooms.disconnected(1, h.now)
    h.rooms.reconnected(1, h.now, '203.0.113.11')
    expect(told).toHaveBeenCalledWith(0, '203.0.113.11', h.now)
    expect(session.addresses).toEqual(['203.0.113.11', '203.0.113.22', null])

    // Once the game is over it is not told, and the next game starts with the address now.
    playOut(h, roomId)
    h.rooms.reconnected(3, h.now, '203.0.113.3')
    expect(told).toHaveBeenCalledTimes(1)
    readyAll(h)
    expect(h.game.sessions[1]!.addresses).toEqual(['203.0.113.11', '203.0.113.22', '203.0.113.3'])

    expect(JSON.stringify(h.outbox.deliveries)).not.toContain('203.0.113')
    expect(JSON.stringify(h.rooms.state(roomId, h.now))).not.toContain('203.0.113')
  })

  test('a bot seat has no address', () => {
    const h = harness()
    checkAck(h.rooms.create(withAddress(A, '203.0.113.1'), { visibility: 'public', bots: true }, h.now), 'RoomResult')
    expect(h.game.sessions[0]!.addresses).toEqual(['203.0.113.1', null, null])
  })
})

describe('a game hook that fails', () => {
  test('addressChanged throwing is reported, and the student is back all the same', () => {
    const errors: [string, unknown][] = []
    const h = harness({ onError: (roomId, err) => errors.push([roomId, err]) })
    const roomId = fullRoom(h)
    const failure = new Error('addressChanged failed')
    vi.spyOn(h.game.sessions[0]!, 'addressChanged').mockImplementation(() => {
      throw failure
    })
    h.rooms.disconnected(2, h.now)
    h.rooms.reconnected(2, h.now, '203.0.113.2')
    expect(errors).toEqual([[roomId, failure]])
    expect(h.rooms.state(roomId, h.now)!.seats[1]!.online).toBe(true)
    expect(h.rooms.resend(2, h.now).map((m) => m.type)).toEqual(['hand'])
  })

  test('a game failing to start as a student comes back is reported, and the room is closed', () => {
    const errors: [string, unknown][] = []
    const h = harness({ onError: (roomId, err) => errors.push([roomId, err]) })
    const roomId = openRoom(h, A, [B])
    h.rooms.disconnected(1, h.now)
    checkAck(h.rooms.join(C, roomId, h.now), 'RoomResult')
    const failure = new Error('newSession failed')
    h.game.newSession = () => {
      throw failure
    }
    h.rooms.reconnected(1, h.now)
    expect(() => h.rooms.startAfterReturn(1, h.now)).not.toThrow()
    expect(errors).toEqual([[roomId, failure]])
    expect(h.rooms.size).toBe(0)
    expect(h.rooms.roomOf(1)).toBeNull()
    expect(leftMessages(h, 1)).toEqual([{ type: 'room.left', roomId, reason: 'closed' }])
  })

  test('carry throwing is reported; the game ends as any other and the next one starts with no carry', () => {
    const errors: [string, unknown][] = []
    const h = harness({ onError: (roomId, err) => errors.push([roomId, err]) })
    const roomId = fullRoom(h)
    const failure = new Error('carry failed')
    vi.spyOn(h.game.sessions[0]!, 'carry').mockImplementation(() => {
      throw failure
    })
    h.rooms.disconnected(3, h.now)
    playOut(h, roomId)
    expect(errors).toEqual([[roomId, failure]])
    const state = h.rooms.state(roomId, h.now)!
    expect(state.gamesPlayed).toBe(1)
    expect(state.seats.map((s) => s.ready)).toEqual([false, false, false])
    // The grace of the absent student started.
    h.advance(h.config.club.disconnectGraceSeconds)
    expect(h.rooms.roomOf(3)).toBeNull()

    const starts: SessionStart[] = []
    const newSession = h.game.newSession.bind(h.game)
    h.game.newSession = (start) => {
      starts.push(start)
      return newSession(start)
    }
    checkAck(h.rooms.join(C, roomId, h.now), 'RoomResult')
    for (const id of [1, 2]) checkAck(h.rooms.ready(id, h.now))
    expect(starts).toHaveLength(1)
    expect(starts[0]!.carry).toBeNull()
  })
})

describe('bots give up their seats', () => {
  /** A public room of A and two bots, its first game started. */
  const botRoom = (h: Harness): string =>
    roomOf(checkAck(h.rooms.create(A, { visibility: 'public', bots: true }, h.now), 'RoomResult')).roomId
  const seatEvents = (frames: RoomEventFrame[]) =>
    frames.flatMap((f) =>
      f.event.kind === 'left'
        ? [`left:${f.event.seat}:${f.event.reason}:${f.event.player.displayName}`]
        : f.event.kind === 'joined'
          ? [`joined:${f.event.seat}:${f.event.player.studentId}`]
          : [],
    )
  const who = (h: Harness, roomId: string) =>
    h.rooms.state(roomId, h.now)!.seats.map((s) => s.player?.studentId ?? s.player?.displayName ?? null)

  test('between games, a student takes a bot seat at once', () => {
    const h = harness()
    const roomId = botRoom(h)
    playOut(h, roomId)
    h.outbox.clear()
    const room = roomOf(checkAck(h.rooms.join(B, roomId, h.now), 'RoomResult'))
    expect(room.seats.map((s) => s.player?.studentId ?? s.player?.displayName)).toEqual([1, 2, '陪练小二'])
    expect(room.seats[1]).toMatchObject({ ready: true, online: true })
    expect(room.waiting).toEqual([])
    expect(seatEvents(h.outbox.eventsOf(1))).toEqual(['left:1:replaced:陪练小一', 'joined:1:2'])
    // Its own `joined` is in the state it was given.
    expect(h.outbox.of(2)).toEqual([])
    expect(room.lastSeq).toBe(h.outbox.eventsOf(1).at(-1)!.seq)
    // A gets ready, and the next game starts with B in it.
    checkAck(h.rooms.ready(1, h.now))
    expect(h.game.sessions).toHaveLength(2)
    expect(h.rooms.state(roomId, h.now)!.game).not.toBeNull()
    expect(who(h, roomId)).toEqual([1, 2, '陪练小二'])
  })

  test('during a game, a student waits for a bot seat, hears the game, and sits down when it ends', () => {
    const h = harness()
    const roomId = botRoom(h)
    const room = roomOf(checkAck(h.rooms.join(B, roomId, h.now), 'RoomResult'))
    expect(room.waiting).toEqual([{ studentId: 2, displayName: '主人2家的小鱼2 #0002', bot: false }])
    expect(room.seats.map((s) => s.player?.bot)).toEqual([false, true, true])
    expect(h.rooms.roomOf(2)).toBe(roomId)
    // The others are not told that B waits.
    expect(seatEvents(h.outbox.eventsOf(1))).toEqual([])

    const before = h.outbox.eventsOf(2).length
    playOut(h, roomId)
    const got = h.outbox.eventsOf(2).slice(before)
    // B heard the game, but none of what is sent to a seat alone.
    const over = got.findIndex((f) => f.event.kind === 'game' && f.event.event.kind === 'over')
    expect(over).toBeGreaterThanOrEqual(0)
    expect(h.outbox.of(2).filter((m) => m.type === 'hand' || m.type === 'your_turn')).toEqual([])
    // Once the game is over, the bot gives up its seat to B, who is told too (no ack carries it).
    expect(seatEvents(got.slice(over + 1))).toEqual(['left:1:replaced:陪练小一', 'joined:1:2'])
    expect(seatEvents(h.outbox.eventsOf(1)).slice(-2)).toEqual(['left:1:replaced:陪练小一', 'joined:1:2'])
    const after = h.rooms.state(roomId, h.now)!
    expect(after.waiting).toEqual([])
    expect(after.seats[1]).toMatchObject({ player: { studentId: 2 }, ready: true, online: true })
    // Ready already: the next game waits for A alone.
    checkAck(h.rooms.ready(2, h.now))
    expect(h.game.sessions).toHaveLength(1)
    checkAck(h.rooms.ready(1, h.now))
    expect(h.game.sessions).toHaveLength(2)
  })

  test('as many wait as there are bots; the next one finds the room full', () => {
    const h = harness()
    const roomId = botRoom(h)
    checkAck(h.rooms.join(B, roomId, h.now), 'RoomResult')
    const room = roomOf(checkAck(h.rooms.join(C, roomId, h.now), 'RoomResult'))
    expect(room.waiting.map((p) => p.studentId)).toEqual([2, 3])
    expectError(h.rooms.join(D, roomId, h.now), 'room_full')
    expect(h.rooms.lobby().rooms).toEqual([])
    playOut(h, roomId)
    // In the order they came; no bot is left.
    expect(who(h, roomId)).toEqual([1, 2, 3])
    checkAck(h.rooms.ready(1, h.now))
    expect(h.game.sessions).toHaveLength(2)
    expect(h.rooms.state(roomId, h.now)!.seats.every((s) => s.player!.bot === false)).toBe(true)
  })

  test('nobody of the same owner as a student waiting comes in', () => {
    const h = harness()
    const roomId = botRoom(h)
    checkAck(h.rooms.join(B, roomId, h.now), 'RoomResult')
    expectError(h.rooms.join(student(5, B.email), roomId, h.now), 'same_owner')
  })

  test('a student waiting plays no part: no turn, no trustee, no idle prompt; ready is no error', () => {
    const h = harness()
    const roomId = botRoom(h)
    checkAck(h.rooms.join(B, roomId, h.now), 'RoomResult')
    const pass = { id: 'm', type: 'pass', game: 'doudizhu', turn: 1 } as Parameters<Harness['rooms']['gameMessage']>[1]
    expectError(h.rooms.gameMessage(2, pass, h.now), 'not_your_turn')
    expectError(h.rooms.trusteeOff(2, h.now), 'not_trustee')
    expectError(h.rooms.bots(2, h.now), 'no_idle_prompt')
    checkAck(h.rooms.ready(2, h.now))
    expect(h.rooms.resend(2, h.now)).toEqual([])
    expectError(h.rooms.create(B, { visibility: 'public', bots: false }, h.now), 'in_room')
    expectError(h.rooms.quick(B, h.now), 'in_room')
    expectError(h.rooms.join(B, roomId, h.now), 'in_room')
  })

  test('a student waiting may leave during the game; nobody else is told', () => {
    const h = harness()
    const roomId = botRoom(h)
    checkAck(h.rooms.join(B, roomId, h.now), 'RoomResult')
    const before = h.outbox.eventsOf(1).length
    checkAck(h.rooms.leave(2, h.now))
    expect(leftMessages(h, 2)).toEqual([{ type: 'room.left', roomId, reason: 'left' }])
    expect(h.outbox.eventsOf(1)).toHaveLength(before)
    expect(h.rooms.roomOf(2)).toBeNull()
    expect(h.rooms.state(roomId, h.now)!.waiting).toEqual([])
    playOut(h, roomId)
    expect(h.rooms.state(roomId, h.now)!.seats.map((s) => s.player!.bot)).toEqual([false, true, true])
  })

  test('the events replayed to a student waiting who comes back are the public ones', () => {
    const h = harness()
    const roomId = botRoom(h)
    const lastSeq = roomOf(checkAck(h.rooms.join(B, roomId, h.now), 'RoomResult')).lastSeq
    h.rooms.disconnected(2, h.now)
    h.rooms.emit(roomId, { kind: 'ready', seat: 0 }, h.now, [1])
    const pub = h.rooms.emit(roomId, { kind: 'ready', seat: 0 }, h.now)
    h.rooms.reconnected(2, h.now)
    expect(h.rooms.replay(2, roomId, lastSeq)!.map((f) => f.seq)).toEqual([pub])
  })

  describe('a student waiting who disconnects', () => {
    const GRACE = 5

    test('stops waiting once the grace ends', () => {
      const h = harness({ club: { disconnectGraceSeconds: GRACE } })
      const roomId = botRoom(h)
      checkAck(h.rooms.join(B, roomId, h.now), 'RoomResult')
      h.rooms.disconnected(2, h.now)
      h.advance(GRACE - 1)
      expect(h.rooms.roomOf(2)).toBe(roomId)
      h.advance(1)
      expect(h.rooms.roomOf(2)).toBeNull()
      expect(h.rooms.state(roomId, h.now)!.waiting).toEqual([])
    })

    test('keeps their place when back within the grace', () => {
      const h = harness({ club: { disconnectGraceSeconds: GRACE } })
      const roomId = botRoom(h)
      checkAck(h.rooms.join(B, roomId, h.now), 'RoomResult')
      h.rooms.disconnected(2, h.now)
      h.advance(GRACE - 1)
      h.rooms.reconnected(2, h.now)
      h.advance(GRACE * 2)
      expect(h.rooms.roomOf(2)).toBe(roomId)
    })

    test('sits down away when the game ends first, the grace going on in the seat', () => {
      const h = harness({ club: { disconnectGraceSeconds: GRACE } })
      const roomId = botRoom(h)
      checkAck(h.rooms.join(B, roomId, h.now), 'RoomResult')
      h.rooms.disconnected(2, h.now)
      playOut(h, roomId)
      expect(h.rooms.state(roomId, h.now)!.seats[1]).toMatchObject({ player: { studentId: 2 }, online: false })
      // The next game waits for B.
      checkAck(h.rooms.ready(1, h.now))
      expect(h.game.sessions).toHaveLength(1)
      h.outbox.clear()
      h.advance(GRACE)
      expect(h.rooms.roomOf(2)).toBeNull()
      expect(seatEvents(h.outbox.eventsOf(1))[0]).toBe('left:1:disconnected_idle:主人2家的小鱼2 #0002')
    })
  })

  test('the club closing puts a student waiting out with the others, and seats nobody', () => {
    const h = harness()
    const roomId = botRoom(h)
    checkAck(h.rooms.join(B, roomId, h.now), 'RoomResult')
    h.outbox.clear()
    h.rooms.closeAll('club_closed', h.now)
    expect(seatEvents(h.outbox.eventsOf(1))).toEqual([])
    expect(h.outbox.eventsOf(2).at(-1)!.event).toEqual({ kind: 'closed', reason: 'club_closed' })
    expect(leftMessages(h, 2)).toEqual([{ type: 'room.left', roomId, reason: 'closed' }])
    expect(h.rooms.roomOf(2)).toBeNull()
  })

  test('an invite-only room with bots takes someone invited, who waits for a bot seat', () => {
    const h = harness()
    const roomId = openRoom(h, A, [B], 'invite')
    h.advance(10 * 60)
    checkAck(h.rooms.bots(1, h.now))
    expectError(h.rooms.join(C, roomId, h.now), 'room_private')
    const room = roomOf(checkAck(h.rooms.join(C, roomId, h.now, { invited: true }), 'RoomResult'))
    expect(room.waiting.map((p) => p.studentId)).toEqual([3])
  })

  test('the listener hears of a student once they start waiting, so they stop watching', () => {
    const seated: number[] = []
    const h = harness({ listeners: { seated: (_, id) => seated.push(id) } })
    const roomId = botRoom(h)
    checkAck(h.rooms.join(B, roomId, h.now), 'RoomResult')
    expect(seated).toEqual([1, 2])
  })
})
