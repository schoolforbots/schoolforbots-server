import { describe, expect, test } from 'vitest'
import type { Static } from 'typebox'
import type { ReactMessage } from '../../src/protocol/club.js'
import { checkProtocol } from './helpers/fake-game.js'
import { checkAck, expectError, playOut, student } from './helpers/rooms.js'
import { partsHarness, type PartsHarness } from './helpers/parts.js'

const A = student(1)
const B = student(2)
const C = student(3)
const D = student(4)

type React = Static<typeof ReactMessage>
const react = (fields: Omit<React, 'id' | 'type'>): React => {
  const message: React = { id: 'm1', type: 'react', ...fields }
  checkProtocol('ClubClientMessage', message)
  return message
}
const SMILE = react({ kind: 'emoji', content: '😀' })
const HELLO = react({ kind: 'phrase', content: 'hello' })

const reactsOf = (h: PartsHarness, studentId: number) =>
  h.outbox.eventsOf(studentId).filter((f) => f.event.kind === 'react')

/** A room of A and B (no game yet). */
function room(h: PartsHarness): string {
  checkAck(h.rooms.create(A, { visibility: 'public', bots: false }, h.now), 'RoomResult')
  const roomId = h.rooms.roomOf(1)!
  checkAck(h.rooms.join(B, roomId, h.now), 'RoomResult')
  h.outbox.clear()
  return roomId
}

describe('what may be sent', () => {
  test('an emoji of the list and a phrase by its id go to the whole table and the spectators', () => {
    const h = partsHarness()
    const roomId = room(h)
    checkAck(h.watchers.watch(4, roomId, h.now), 'RoomResult')
    expect(checkAck(h.reactions.react(A, SMILE, h.now))).toEqual({ ok: true })
    h.now = new Date(h.now.getTime() + 5000)
    expect(checkAck(h.reactions.react(B, react({ kind: 'phrase', content: 'hello', to: 1 }), h.now))).toEqual({ ok: true })
    const sent = h.outbox.roomEvents.map((r) => [r.frame.event, r.audience])
    expect(sent).toEqual([
      [
        { kind: 'react', from: { studentId: 1, displayName: A.person.displayName, bot: false }, to: null, reaction: 'emoji', content: '😀', text: '😀', visibility: 'room' },
        { seated: [1, 2], spectators: [4] },
      ],
      [
        {
          kind: 'react',
          from: { studentId: 2, displayName: B.person.displayName, bot: false },
          to: { studentId: 1, displayName: A.person.displayName, bot: false },
          reaction: 'phrase',
          content: 'hello',
          text: '大家好，请多关照',
          visibility: 'room',
        },
        { seated: [1, 2], spectators: [4] },
      ],
    ])
    // The sender gets their own reaction too.
    expect(reactsOf(h, 1)).toHaveLength(2)
  })

  test('an emoji not on the list (or only part of an entry), and a phrase id that is not there, are react_not_allowed', () => {
    const h = partsHarness()
    room(h)
    expectError(h.reactions.react(A, react({ kind: 'emoji', content: '🦄🦄' }), h.now), 'react_not_allowed')
    expectError(h.reactions.react(A, react({ kind: 'emoji', content: '😀😀' }), h.now), 'react_not_allowed')
    expectError(h.reactions.react(A, react({ kind: 'emoji', content: 'hello' }), h.now), 'react_not_allowed')
    expectError(h.reactions.react(A, react({ kind: 'phrase', content: 'no_such_phrase' }), h.now), 'react_not_allowed')
    expectError(h.reactions.react(A, react({ kind: 'phrase', content: '大家好，请多关照' }), h.now), 'react_not_allowed')
    expect(h.outbox.roomEvents).toEqual([])
    // Nothing refused counts: the next one goes at once.
    checkAck(h.reactions.react(A, SMILE, h.now))
  })

  test('a kind or visibility the game does not allow is react_not_allowed: text, private', () => {
    const h = partsHarness()
    room(h)
    expectError(h.reactions.react(A, react({ kind: 'text', content: '你好' }), h.now), 'react_not_allowed')
    expectError(h.reactions.react(A, react({ kind: 'emoji', content: '😀', to: 2, visibility: 'private' }), h.now), 'react_not_allowed')
    expect(h.outbox.roomEvents).toEqual([])
  })

  test('to must be another student at the table: not someone elsewhere, not oneself, not a bot', () => {
    const h = partsHarness()
    const roomId = room(h)
    checkAck(h.rooms.create(C, { visibility: 'public', bots: false }, h.now), 'RoomResult')
    expect(h.rooms.roomOf(3)).not.toBe(roomId)
    expectError(h.reactions.react(A, react({ kind: 'emoji', content: '😀', to: 3 }), h.now), 'react_not_allowed')
    expectError(h.reactions.react(A, react({ kind: 'emoji', content: '😀', to: 1 }), h.now), 'react_not_allowed')
    // Bots in A's room: a bot has no student number, so whatever number is named is not one of them.
    const bots = partsHarness()
    checkAck(bots.rooms.create(A, { visibility: 'public', bots: true }, bots.now), 'RoomResult')
    expectError(bots.reactions.react(A, react({ kind: 'emoji', content: '😀', to: 2 }), bots.now), 'react_not_allowed')
  })

  test('not in a room is not_in_room; a spectator is react_not_allowed', () => {
    const h = partsHarness()
    const roomId = room(h)
    expectError(h.reactions.react(C, SMILE, h.now), 'not_in_room')
    checkAck(h.watchers.watch(3, roomId, h.now), 'RoomResult')
    expectError(h.reactions.react(C, SMILE, h.now), 'react_not_allowed')
    expect(h.outbox.roomEvents).toEqual([])
  })
})

describe('private reactions', () => {
  test('where the game allows them, only the sender and to get it, now and on a replay; the seq skips for the rest', () => {
    const h = partsHarness({}, undefined, { kinds: ['emoji', 'phrase'], visibility: ['room', 'private'] })
    const roomId = room(h)
    checkAck(h.rooms.join(C, roomId, h.now), 'RoomResult')
    checkAck(h.watchers.watch(4, roomId, h.now), 'RoomResult')
    h.outbox.clear()
    checkAck(h.reactions.react(A, react({ kind: 'phrase', content: 'hello', to: 2, visibility: 'private' }), h.now))
    const sent = h.outbox.roomEvents.at(-1)!
    expect(sent.frame.event).toMatchObject({ kind: 'react', visibility: 'private', to: { studentId: 2 } })
    expect(sent.audience).toEqual({ seated: [1, 2], spectators: [] })
    const seq = sent.frame.seq
    expect(h.rooms.replay(2, roomId, seq - 1)!.map((f) => f.seq)).toContain(seq)
    expect(h.rooms.replay(3, roomId, seq - 1)!.map((f) => f.seq)).not.toContain(seq)
    expect(h.outbox.of(4).some((m) => m.type === 'room.event' && m.seq === seq)).toBe(false)
  })
})

describe('how often', () => {
  test('two reactions are reactMinIntervalSeconds apart, else react_cap', () => {
    const h = partsHarness()
    room(h)
    checkAck(h.reactions.react(A, SMILE, h.now))
    h.now = new Date(h.now.getTime() + 4999)
    expectError(h.reactions.react(A, HELLO, h.now), 'react_cap')
    // B has an interval of its own.
    checkAck(h.reactions.react(B, SMILE, h.now))
    h.now = new Date(h.now.getTime() + 1)
    checkAck(h.reactions.react(A, HELLO, h.now))
  })

  test('at most reactsPerGame in a game; before the first game counts as one; a game starting counts afresh', () => {
    const h = partsHarness({ reactsPerGame: 2, reactMinIntervalSeconds: 0 })
    const roomId = room(h)
    checkAck(h.reactions.react(A, SMILE, h.now))
    checkAck(h.reactions.react(A, SMILE, h.now))
    expectError(h.reactions.react(A, SMILE, h.now), 'react_cap')
    // C fills the room; the first game starts.
    checkAck(h.rooms.join(C, roomId, h.now), 'RoomResult')
    checkAck(h.reactions.react(A, SMILE, h.now))
    checkAck(h.reactions.react(A, SMILE, h.now))
    expectError(h.reactions.react(A, SMILE, h.now), 'react_cap')
    // After the game, before the next: still the count of the game played.
    playOut(h, roomId)
    expectError(h.reactions.react(A, SMILE, h.now), 'react_cap')
    for (const s of [A, B, C]) checkAck(h.rooms.ready(s.person.studentId, h.now))
    expect(h.game.sessions).toHaveLength(2)
    checkAck(h.reactions.react(A, SMILE, h.now))
  })

  test('the interval holds across rooms', () => {
    const h = partsHarness()
    room(h)
    checkAck(h.reactions.react(B, SMILE, h.now))
    checkAck(h.rooms.leave(2, h.now))
    checkAck(h.rooms.create(B, { visibility: 'public', bots: false }, h.now), 'RoomResult')
    expectError(h.reactions.react(B, SMILE, h.now), 'react_cap')
    h.now = new Date(h.now.getTime() + 5000)
    checkAck(h.reactions.react(B, SMILE, h.now))
  })

  test('leaving the room and coming back does not start the count again; the next game does', () => {
    const h = partsHarness({ reactsPerGame: 1 })
    const roomId = room(h)
    checkAck(h.reactions.react(B, SMILE, h.now))
    checkAck(h.rooms.leave(2, h.now))
    h.now = new Date(h.now.getTime() + 5000)
    checkAck(h.rooms.join(B, roomId, h.now), 'RoomResult')
    expectError(h.reactions.react(B, SMILE, h.now), 'react_cap')
    checkAck(h.rooms.join(C, roomId, h.now), 'RoomResult')
    checkAck(h.reactions.react(B, SMILE, h.now))
  })

  test('what is kept goes when the room closes', () => {
    const h = partsHarness()
    room(h)
    checkAck(h.reactions.react(A, SMILE, h.now))
    checkAck(h.reactions.react(B, SMILE, h.now))
    expect(h.reactions.size).toBe(2)
    checkAck(h.rooms.leave(2, h.now))
    checkAck(h.rooms.leave(1, h.now))
    expect(h.reactions.size).toBe(0)
  })
})
