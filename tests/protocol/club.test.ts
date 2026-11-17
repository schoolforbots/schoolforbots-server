import type { TSchema } from 'typebox'
import Value from 'typebox/value'
import { describe, expect, test } from 'vitest'
import {
  Cards,
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
