import { describe, expect, test } from 'vitest'
import { lobbyMessage, quickJoinRoom, type RoomSummary } from '../../src/club/lobby.js'
import { botPersonWithClass } from '../../src/club/people.js'
import { checkProtocol } from './helpers/fake-game.js'
import { checkAck, expectError, harness, type Harness, openRoom, playOut, roomOf, student } from './helpers/rooms.js'

const lobby = (h: Harness) => {
  const message = h.rooms.lobby()
  checkProtocol('LobbyMessage', message)
  checkProtocol('ClubServerMessage', message)
  return message
}

describe('the lobby', () => {
  test('lists the public rooms not playing with a free seat, the fullest first, then the oldest', () => {
    const h = harness()
    const one = openRoom(h, student(1)) // 2 free
    const two = openRoom(h, student(2), [student(3)]) // 1 free
    openRoom(h, student(4), [], 'invite') // invite only: not listed
    const three = openRoom(h, student(5)) // 2 free, newer than `one`
    const four = openRoom(h, student(6), [student(7)]) // 1 free, newer than `two`
    const playing = openRoom(h, student(8), [student(9)])
    checkAck(h.rooms.join(student(10), playing, h.now), 'RoomResult') // full and playing: not listed
    const rooms = lobby(h).rooms
    expect(rooms.map((r) => r.roomId)).toEqual([two, four, one, three])
    expect(rooms[0]).toEqual({
      roomId: two,
      host: { studentId: 2, displayName: '主人2家的小鱼2 #0002', bot: false, className: '初中部·晚班·3 班' },
      seatsFree: 1,
      bots: false,
      gamesPlayed: 0,
    })
  })

  test('a room after a game, with a bot and a free seat, is listed again', () => {
    const h = harness()
    const roomId = openRoom(h, student(1), [student(2)])
    h.advance(10 * 60) // the idle prompt
    checkAck(h.rooms.bots(2, h.now))
    expect(lobby(h).rooms).toEqual([]) // playing
    playOut(h, roomId)
    expect(lobby(h).rooms).toEqual([]) // full, though over
    checkAck(h.rooms.leave(2, h.now))
    expect(lobby(h).rooms).toEqual([
      expect.objectContaining({ roomId, seatsFree: 1, bots: true, gamesPlayed: 1 }),
    ])
  })

  test('lists at most lobbyMaxRooms rooms', () => {
    const h = harness()
    for (let i = 1; i <= 55; i++) openRoom(h, student(i))
    const rooms = lobby(h).rooms
    expect(rooms).toHaveLength(50)
    // All as full: the oldest 50.
    expect(rooms.map((r) => r.host.studentId)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1))
    const small = harness({ club: { lobbyMaxRooms: 3 } })
    for (let i = 1; i <= 5; i++) openRoom(small, student(i))
    expect(lobby(small).rooms).toHaveLength(3)
  })

  test('says whether bots sit in a room', () => {
    const summary = (over: Partial<RoomSummary>): RoomSummary => ({
      roomId: 'rabcdef',
      visibility: 'public',
      playing: false,
      seatsFree: 1,
      host: { studentId: 1, displayName: 'x #0001', bot: false, className: 'c' },
      bots: true,
      gamesPlayed: 2,
      opened: 1,
      owners: new Set(),
      ...over,
    })
    const message = lobbyMessage([summary({})], 50)
    checkProtocol('LobbyMessage', message)
    expect(message.rooms[0]).toMatchObject({ bots: true, gamesPlayed: 2 })
    // The summary never has a bot host, but the lobby would pass it on as it is.
    expect(botPersonWithClass('陪练小一').className).toBeNull()
  })
})

describe('quick join', () => {
  test('takes the open room closest to full, the oldest among as full', () => {
    const h = harness()
    openRoom(h, student(1)) // 2 free
    const fuller = openRoom(h, student(2), [student(3)]) // 1 free
    openRoom(h, student(4), [student(5)]) // 1 free, newer
    const result = checkAck(h.rooms.quick(student(6), h.now), 'QuickJoinResult')
    expect(result).toMatchObject({ ok: true, result: { created: false } })
    expect(roomOf(result).roomId).toBe(fuller)
    // `fuller` is full now and playing; the next quick join goes to the other room with one seat free.
    expect(h.game.sessions).toHaveLength(1)
  })

  test('skips invite-only rooms, rooms playing, and rooms of the same owner', () => {
    const h = harness()
    openRoom(h, student(1), [student(2)], 'invite')
    const playing = openRoom(h, student(3), [student(4)])
    checkAck(h.rooms.join(student(5), playing, h.now), 'RoomResult')
    const mine = openRoom(h, student(6, 'same@example.com'), [student(7)])
    const free = openRoom(h, student(8))
    const result = checkAck(h.rooms.quick(student(9, 'same@example.com'), h.now), 'QuickJoinResult')
    expect(roomOf(result).roomId).toBe(free)
    expect(roomOf(result).roomId).not.toBe(mine)
  })

  test('opens a public room when there is none', () => {
    const h = harness()
    const result = checkAck(h.rooms.quick(student(1), h.now), 'QuickJoinResult')
    expect(result).toMatchObject({ ok: true, result: { created: true } })
    const room = roomOf(result)
    expect(room).toMatchObject({ visibility: 'public', host: 1, lastSeq: 1 })
    expect(lobby(h).rooms.map((r) => r.roomId)).toEqual([room.roomId])
    expectError(h.rooms.quick(student(1), h.now), 'in_room')
  })

  test('the choice is the same for the same rooms', () => {
    const owners = new Set<string>()
    const host = { studentId: 1, displayName: 'x #0001', bot: false as const, className: 'c' }
    const rooms: RoomSummary[] = [
      { roomId: 'rbbbbbb', visibility: 'public', playing: false, seatsFree: 2, host, bots: false, gamesPlayed: 0, opened: 2, owners },
      { roomId: 'raaaaaa', visibility: 'public', playing: false, seatsFree: 2, host, bots: false, gamesPlayed: 0, opened: 1, owners },
      { roomId: 'rcccccc', visibility: 'public', playing: false, seatsFree: 0, host, bots: false, gamesPlayed: 0, opened: 0, owners },
    ]
    expect(quickJoinRoom(rooms, 'a@example.com')!.roomId).toBe('raaaaaa')
    expect(quickJoinRoom([...rooms].reverse(), 'a@example.com')!.roomId).toBe('raaaaaa')
    expect(quickJoinRoom([rooms[2]!], 'a@example.com')).toBeNull()
  })
})
