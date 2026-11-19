import { describe, expect, test } from 'vitest'
import { hand, ranks } from './helpers.js'

describe('test helpers', () => {
  test('ranks turns protocol names into rank values, in the order given', () => {
    expect(ranks('3 3 10 J A 2 小王 大王')).toEqual([3, 3, 10, 11, 14, 15, 16, 17])
    expect(ranks('')).toEqual([])
    expect(() => ranks('3 1')).toThrow(RangeError)
  })

  test('hand gives each card of a rank the next suit', () => {
    expect(hand('3 4 3 小王 3 3')).toEqual([
      { rank: 3, suit: 'S' },
      { rank: 4, suit: 'S' },
      { rank: 3, suit: 'H' },
      { rank: 16, suit: null },
      { rank: 3, suit: 'C' },
      { rank: 3, suit: 'D' },
    ])
  })

  test('hand refuses more cards of a rank than the deck has', () => {
    expect(() => hand('5 5 5 5 5')).toThrow(RangeError)
    expect(() => hand('小王 小王')).toThrow(RangeError)
    expect(hand('小王 大王')).toHaveLength(2)
  })
})
