import type { TSchema } from 'typebox'
import Value from 'typebox/value'
import { describe, expect, test } from 'vitest'
import {
  Cards,
  ClubClientMessage,
  ClubPerson,
  ClubPersonWithClass,
  MOVE_TYPE_NAMES,
  Move,
  MoveType,
  Rank,
  RoomId,
  Seat,
} from '../../src/protocol/club.js'

const ok = (schema: TSchema, value: unknown): boolean => Value.Check(schema, value)
type Case = [name: string, value: unknown]

const RANKS = ['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', '2', '小王', '大王']
const MOVE_TYPES = [
  'single', 'pair', 'trio', 'trio_solo', 'trio_pair', 'straight', 'pair_straight', 'trio_straight',
  'plane_solo', 'plane_pair', 'four_two_solo', 'four_two_pair', 'bomb', 'rocket',
]

const student = { studentId: 37, displayName: '阿杰家的小鱼 #0037', bot: false }
const bot = { studentId: null, displayName: '陪练小一', bot: true }

describe('shared types', () => {
  test.each(RANKS)('Rank accepts %s', (rank) => {
    expect(ok(Rank, rank)).toBe(true)
  })

  test.each(['1', 'T', 'joker', '♠3', '', 3])('Rank rejects %s', (rank) => {
    expect(ok(Rank, rank)).toBe(false)
  })

  test('Cards accepts 1 to 20 cards', () => {
    expect(ok(Cards, ['3'])).toBe(true)
    expect(ok(Cards, Array<string>(20).fill('3'))).toBe(true)
  })

  test.each<Case>([
    ['an empty array', []],
    ['21 cards', Array<string>(21).fill('3')],
    ['a card with a suit', ['♠3']],
  ])('Cards rejects %s', (_name, cards) => {
    expect(ok(Cards, cards)).toBe(false)
  })

  test.each<Case>([
    ['a student', student],
    ['a bot', bot],
  ])('ClubPerson accepts %s', (_name, person) => {
    expect(ok(ClubPerson, person)).toBe(true)
  })

  test.each<Case>([
    ['studentId 0', { ...student, studentId: 0 }],
    ['a fractional studentId', { ...student, studentId: 1.5 }],
    ['no bot', { studentId: 37, displayName: '阿杰家的小鱼 #0037' }],
    ['no displayName', { studentId: 37, bot: false }],
  ])('ClubPerson rejects %s', (_name, person) => {
    expect(ok(ClubPerson, person)).toBe(false)
  })

  test('ClubPersonWithClass takes a class name, or null for a bot', () => {
    expect(ok(ClubPersonWithClass, { ...student, className: '初中部·晚班·3 班' })).toBe(true)
    expect(ok(ClubPersonWithClass, { ...bot, className: null })).toBe(true)
    expect(ok(ClubPersonWithClass, student)).toBe(false)
  })

  test('RoomId is a short lowercase string starting with r', () => {
    expect(ok(RoomId, 'r7k2q')).toBe(true)
    expect(ok(RoomId, 'r' + 'a'.repeat(15))).toBe(true)
    expect(ok(RoomId, 'r7k2')).toBe(false)
    expect(ok(RoomId, 'R7K2Q')).toBe(false)
    expect(ok(RoomId, 'x7k2q')).toBe(false)
    expect(ok(RoomId, 'r' + 'a'.repeat(16))).toBe(false)
  })

  test('Seat is 0, 1 or 2', () => {
    expect([0, 1, 2].every((seat) => ok(Seat, seat))).toBe(true)
    expect(ok(Seat, 3)).toBe(false)
    expect(ok(Seat, -1)).toBe(false)
    expect(ok(Seat, 1.5)).toBe(false)
  })

  test('MoveType has exactly the 14 move types', () => {
    expect(MOVE_TYPES.every((type) => ok(MoveType, type))).toBe(true)
    expect(ok(MoveType, 'quad')).toBe(false)
  })

  test('MOVE_TYPE_NAMES has a Chinese name for exactly the values of MoveType', () => {
    const values = (MoveType as unknown as { anyOf: { const: string }[] }).anyOf.map((s) => s.const)
    expect(Object.keys(MOVE_TYPE_NAMES).sort()).toEqual([...values].sort())
    expect(Object.keys(MOVE_TYPE_NAMES).sort()).toEqual([...MOVE_TYPES].sort())
    for (const name of Object.values(MOVE_TYPE_NAMES)) expect(name).toMatch(/^[一-鿿]+$/)
  })

  test('Move takes a type, its Chinese name and the cards', () => {
    expect(ok(Move, { type: 'pair', name: '对牌', cards: ['9', '9'] })).toBe(true)
    expect(ok(Move, { type: 'pair', name: '对牌', cards: [] })).toBe(false)
    expect(ok(Move, { type: 'quad', name: '四张', cards: ['9', '9', '9', '9'] })).toBe(false)
  })
})

describe('client messages', () => {
  const hello = { id: 'c1', type: 'hello', protocol: 'v1', plugin: { type: 'openclaw', version: '1.2.3' }, club: 'doudizhu' }
  const play = { id: 'c9', type: 'play', game: 'doudizhu', turn: 7 }
  const react = { id: 'c10', type: 'react' }

  test.each<Case>([
    ['hello', hello],
    ['hello with roomId', { ...hello, roomId: 'r7k2q' }],
    ['hello with roomId and lastSeq', { ...hello, roomId: 'r7k2q', lastSeq: 12 }],
    ['hello with lastSeq 0', { ...hello, roomId: 'r7k2q', lastSeq: 0 }],
    ['lobby.list', { id: 'c2', type: 'lobby.list' }],
    ['room.create', { id: 'c3', type: 'room.create', visibility: 'public', bots: false }],
    ['room.create with bots', { id: 'c3', type: 'room.create', visibility: 'invite', bots: true }],
    ['room.create inviting two', { id: 'c3', type: 'room.create', visibility: 'invite', bots: false, invite: [12, 37] }],
    ['room.join', { id: 'c4', type: 'room.join', roomId: 'r7k2q' }],
    ['room.quick', { id: 'c5', type: 'room.quick' }],
    ['room.invite', { id: 'c6', type: 'room.invite', to: 12 }],
    ['room.accept', { id: 'c7', type: 'room.accept', inviteId: 3 }],
    ['room.decline', { id: 'c7', type: 'room.decline', inviteId: 3 }],
    ['room.ready', { id: 'c8', type: 'room.ready' }],
    ['room.leave', { id: 'c8', type: 'room.leave' }],
    ['room.bots', { id: 'c8', type: 'room.bots' }],
    ['trustee.off', { id: 'c8', type: 'trustee.off' }],
    ['react with an emoji', { ...react, kind: 'emoji', content: '👍' }],
    ['react with an emoji to someone', { ...react, kind: 'emoji', content: '🙄', to: 12 }],
    ['react with a phrase', { ...react, kind: 'phrase', content: 'p01' }],
    ['react with a phrase to someone', { ...react, kind: 'phrase', content: 'p01', to: 12, visibility: 'room' }],
    ['react with private text to someone', { ...react, kind: 'text', content: '打得好', to: 12, visibility: 'private' }],
    ['react with content at the cap', { ...react, kind: 'text', content: 'x'.repeat(200) }],
    ['watch', { id: 'c11', type: 'watch', roomId: 'r7k2q' }],
    ['unwatch', { id: 'c11', type: 'unwatch' }],
    ['bid', { id: 'c12', type: 'bid', game: 'doudizhu', turn: 1, bid: 3 }],
    ['bid 0 (no bid)', { id: 'c12', type: 'bid', game: 'doudizhu', turn: 2, bid: 0 }],
    ['play by moveId', { ...play, moveId: 4 }],
    ['play by cards', { ...play, cards: ['3', '3', '3', '4'] }],
    ['play by cards as a move type', { ...play, cards: ['5', '5', '5', '6', '6', '6', '7', '7', '7', '8', '8', '8'], as: 'plane_solo' }],
    ['pass', { id: 'c13', type: 'pass', game: 'doudizhu', turn: 8 }],
  ])('accepts %s', (_name, message) => {
    expect(ok(ClubClientMessage, message)).toBe(true)
  })

  test.each<Case>([
    ['an unknown type', { id: 'c1', type: 'shout' }],
    ['no id', { type: 'room.ready' }],
    ['an id over 64 characters', { id: 'x'.repeat(65), type: 'room.ready' }],
    ['hello without club', { id: 'c1', type: 'hello', protocol: 'v1', plugin: { type: 'openclaw', version: '1.2.3' } }],
    ['hello to another club', { ...hello, club: 'chess' }],
    ['hello with lastSeq but no roomId', { ...hello, lastSeq: 12 }],
    ['hello with a negative lastSeq', { ...hello, roomId: 'r7k2q', lastSeq: -1 }],
    ['hello for another protocol', { ...hello, protocol: 'v2' }],
    ['hello with a malformed roomId', { ...hello, roomId: 'R7K2Q' }],
    ['room.create inviting three', { id: 'c3', type: 'room.create', visibility: 'invite', bots: false, invite: [12, 37, 40] }],
    ['room.create inviting someone twice', { id: 'c3', type: 'room.create', visibility: 'invite', bots: false, invite: [12, 12] }],
    ['room.create with another visibility', { id: 'c3', type: 'room.create', visibility: 'secret', bots: false }],
    ['room.create without bots', { id: 'c3', type: 'room.create', visibility: 'public' }],
    ['room.join with a malformed roomId', { id: 'c4', type: 'room.join', roomId: 'x7k2q' }],
    ['watch with a malformed roomId', { id: 'c11', type: 'watch', roomId: 'r7k' }],
    ['room.invite to studentId 0', { id: 'c6', type: 'room.invite', to: 0 }],
    ['bid 4', { id: 'c12', type: 'bid', game: 'doudizhu', turn: 1, bid: 4 }],
    ['bid 1.5', { id: 'c12', type: 'bid', game: 'doudizhu', turn: 1, bid: 1.5 }],
    ['bid without game', { id: 'c12', type: 'bid', turn: 1, bid: 3 }],
    ['bid without turn', { id: 'c12', type: 'bid', game: 'doudizhu', bid: 3 }],
    ['play with both moveId and cards', { ...play, moveId: 4, cards: ['3'] }],
    ['play with neither moveId nor cards', play],
    ['play by moveId with as', { ...play, moveId: 4, as: 'single' }],
    ['play with moveId 0', { ...play, moveId: 0 }],
    ['play with a suited card', { ...play, cards: ['♠3'] }],
    ['play as an unknown move type', { ...play, cards: ['3', '3', '3', '3'], as: 'quad' }],
    ['play with turn 0', { ...play, turn: 0, moveId: 4 }],
    ['play without game', { id: 'c9', type: 'play', turn: 7, moveId: 4 }],
    ['play in another game', { ...play, game: 'chess', moveId: 4 }],
    ['pass without game', { id: 'c13', type: 'pass', turn: 8 }],
    ['pass with turn 0', { id: 'c13', type: 'pass', game: 'doudizhu', turn: 0 }],
    ['react private without to', { ...react, kind: 'text', content: '打得好', visibility: 'private' }],
    ['react with content over 200 characters', { ...react, kind: 'text', content: 'x'.repeat(201) }],
    ['react of another kind', { ...react, kind: 'sticker', content: 'x' }],
    ['react with another visibility', { ...react, kind: 'emoji', content: '👍', visibility: 'all' }],
    ['not an object', 'hello'],
  ])('rejects %s', (_name, message) => {
    expect(ok(ClubClientMessage, message)).toBe(false)
  })
})
