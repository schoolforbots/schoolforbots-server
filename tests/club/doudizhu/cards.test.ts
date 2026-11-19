import { describe, expect, test } from 'vitest'
import { type Card, FULL_DECK, rankValue, ranksOf, takeRanks, toRank } from '../../../src/club/doudizhu/cards.js'

const RANKS = ['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', '2', '小王', '大王'] as const

const card = (rank: number, suit: Card['suit']): Card => ({ rank, suit })

describe('the deck', () => {
  test('has 54 different cards', () => {
    expect(FULL_DECK).toHaveLength(54)
    expect(new Set(FULL_DECK.map((c) => `${c.rank}${c.suit}`)).size).toBe(54)
  })

  test('has four suited cards of 3 to 2 and one of each joker with no suit', () => {
    for (let rank = 3; rank <= 15; rank++) {
      expect(FULL_DECK.filter((c) => c.rank === rank).map((c) => c.suit)).toEqual(['S', 'H', 'C', 'D'])
    }
    expect(FULL_DECK.filter((c) => c.rank >= 16)).toEqual([card(16, null), card(17, null)])
  })

  test('is in a fixed order, low to high', () => {
    expect(FULL_DECK.slice(0, 5)).toEqual([card(3, 'S'), card(3, 'H'), card(3, 'C'), card(3, 'D'), card(4, 'S')])
    const ranks = FULL_DECK.map((c) => c.rank)
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b))
  })
})

describe('ranks', () => {
  test('convert both ways between values and protocol names', () => {
    RANKS.forEach((name, i) => {
      expect(rankValue(name)).toBe(i + 3)
      expect(toRank(i + 3)).toBe(name)
    })
    expect(rankValue('10')).toBe(10)
    expect(rankValue('小王')).toBe(16)
    expect(rankValue('大王')).toBe(17)
    expect(toRank(card(11, 'H'))).toBe('J')
    expect(toRank(card(17, null))).toBe('大王')
  })

  test('reject what is not a rank', () => {
    expect(() => toRank(2)).toThrow(RangeError)
    expect(() => toRank(18)).toThrow(RangeError)
    expect(() => toRank(3.5)).toThrow(RangeError)
    expect(() => rankValue('1' as never)).toThrow(RangeError)
  })

  test('of a hand are shown low to high', () => {
    expect(ranksOf([card(17, null), card(10, 'D'), card(3, 'H'), card(15, 'S'), card(3, 'S')])).toEqual([
      '3',
      '3',
      '10',
      '2',
      '大王',
    ])
  })
})

describe('takeRanks', () => {
  const hand = [card(7, 'D'), card(7, 'S'), card(5, 'C'), card(7, 'C'), card(16, null), card(9, 'H')]

  test('takes the cards of each rank in suit order and keeps the rest in hand order', () => {
    expect(takeRanks(hand, [7, 7, 16])).toEqual({
      ok: true,
      taken: [card(7, 'S'), card(7, 'C'), card(16, null)],
      rest: [card(7, 'D'), card(5, 'C'), card(9, 'H')],
    })
  })

  test('takes nothing for no ranks', () => {
    expect(takeRanks(hand, [])).toEqual({ ok: true, taken: [], rest: hand })
  })

  test('lists the missing cards one by one, low to high', () => {
    expect(takeRanks(hand, [7, 7, 7, 7])).toEqual({ ok: false, missing: [7] })
    expect(takeRanks(hand, [17, 7, 8, 8, 5])).toEqual({ ok: false, missing: [8, 8, 17] })
  })

  test('does not change the hand', () => {
    const before = [...hand]
    takeRanks(hand, [7, 5])
    expect(hand).toEqual(before)
  })

  test('rejects what is not a rank', () => {
    expect(() => takeRanks(hand, [1])).toThrow(RangeError)
  })
})
