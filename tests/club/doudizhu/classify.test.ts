import { describe, expect, test } from 'vitest'
import { MoveType } from '../../../src/protocol/club.js'
import { classify, type ClassifyRules, MOVE_TYPES } from '../../../src/club/doudizhu/classify.js'
import { takeRanks } from '../../../src/club/doudizhu/cards.js'
import { DEFAULT_DOUDIZHU_RULES } from '../../../src/club/doudizhu/rules.js'
import { hand, ranks } from './helpers.js'

const rules: ClassifyRules = DEFAULT_DOUDIZHU_RULES
const noPair: ClassifyRules = { ...rules, soloKickersMayPair: false }
const noJokers: ClassifyRules = { ...rules, soloKickersMayBeJokers: false }
const noBareTrio: ClassifyRules = { ...rules, bareTrio: false }
const noFourWithTwo: ClassifyRules = { ...rules, fourWithTwo: false }

/** The readings of some cards as `type main`, in the order `classify` gives them. */
const readings = (text: string, r: ClassifyRules = rules): string[] =>
  classify(ranks(text), r).map((reading) => `${reading.type} ${reading.main}`)

describe('move types', () => {
  test('are listed in the order of the protocol', () => {
    expect(MOVE_TYPES).toEqual(MoveType.anyOf.map((literal) => literal.const))
  })
})

describe('classify', () => {
  test('fills in every field of a reading', () => {
    expect(classify(ranks('7 5 5 5'), rules)).toEqual([
      { type: 'trio_solo', main: 5, length: 4, cards: [5, 5, 5, 7], body: [5, 5, 5], kickers: [7] },
    ])
    expect(classify(ranks('8 7 6 5 4 3 9'), rules)).toEqual([
      { type: 'straight', main: 9, length: 7, cards: [3, 4, 5, 6, 7, 8, 9], body: [3, 4, 5, 6, 7, 8, 9], kickers: [] },
    ])
  })

  // The shortest and the longest example of each of the 14 types of 3.5.
  test.each([
    ['single', '3', 3],
    ['single', '大王', 17],
    ['pair', '3 3', 3],
    ['pair', '2 2', 15],
    ['trio', '3 3 3', 3],
    ['trio', '2 2 2', 15],
    ['trio_solo', '3 3 3 4', 3],
    ['trio_solo', '2 2 2 大王', 15],
    ['trio_pair', '3 3 3 4 4', 3],
    ['trio_pair', '2 2 2 A A', 15],
    ['straight', '3 4 5 6 7', 7],
    ['straight', '3 4 5 6 7 8 9 10 J Q K A', 14],
    ['pair_straight', '3 3 4 4 5 5', 5],
    ['pair_straight', '3 3 4 4 5 5 6 6 7 7 8 8 9 9 10 10 J J Q Q', 12],
    ['pair_straight', 'Q Q K K A A', 14],
    ['trio_straight', '3 3 3 4 4 4', 4],
    ['trio_straight', '9 9 9 10 10 10 J J J Q Q Q K K K A A A', 14],
    ['plane_solo', '3 3 3 4 4 4 5 6', 4],
    ['plane_solo', '3 3 3 4 4 4 5 5 5 6 6 6 7 7 7 8 9 10 J Q', 7],
    ['plane_pair', '3 3 3 4 4 4 5 5 6 6', 4],
    ['plane_pair', '3 3 3 4 4 4 5 5 5 6 6 6 7 7 8 8 9 9 10 10', 6],
    ['four_two_solo', '3 3 3 3 4 5', 3],
    ['four_two_solo', '2 2 2 2 小王 A', 15],
    ['four_two_pair', '3 3 3 3 4 4 5 5', 3],
    ['four_two_pair', '2 2 2 2 K K A A', 15],
    ['bomb', '3 3 3 3', 3],
    ['bomb', '2 2 2 2', 15],
    ['rocket', '小王 大王', 17],
  ])('%s: %s', (type, text, main) => {
    expect(readings(text)).toEqual([`${type} ${main}`])
  })

  test('takes the cards in any order', () => {
    expect(readings('7 3 5 4 6')).toEqual(['straight 7'])
    expect(readings('4 3 3 4 3 4 6 5')).toEqual(['plane_solo 4'])
  })

  describe('chains run from 3 to A only', () => {
    test.each([
      ['2 3 4 5 A', 'a straight cannot go round from A to 3'],
      ['10 J Q K A 2', 'a 2 is not part of a straight'],
      ['J Q K A 2', 'a 2 is not part of a straight'],
      ['3 4 5 6 小王', 'a joker is not part of a straight'],
      ['3 4 5 6', 'a straight has at least 5 cards'],
      ['3 4 5 6 8', 'a straight has no gaps'],
      ['K K A A 2 2', 'a 2 is not part of a pair straight'],
      ['3 3 4 4 6 6', 'a pair straight has no gaps'],
      ['A A A 2 2 2', 'a 2 is not part of a trio straight'],
      ['A A A 2 2 2 3 4', 'a 2 is not part of a plane'],
      ['3 3 3 5 5 5 4 6', 'the trios of a plane are consecutive'],
    ])('%s: %s', (text) => {
      expect(readings(text)).toEqual([])
    })

    test('a plane may end at the ace', () => {
      expect(readings('K K K A A A 3 4')).toEqual(['plane_solo 14'])
    })
  })

  test('a pair straight has at least minPairStraight pairs', () => {
    expect(readings('3 3 4 4')).toEqual([])
    expect(readings('3 3 4 4', { ...rules, minPairStraight: 2 })).toEqual(['pair_straight 4'])
    expect(readings('3 3 4 4 5 5', { ...rules, minPairStraight: 4 })).toEqual([])
    expect(readings('3 3 4 4 5 5 6 6', { ...rules, minPairStraight: 4 })).toEqual(['pair_straight 6'])
  })

  test('two jokers are the rocket, not a pair, and not a pair to carry', () => {
    expect(readings('小王 大王')).toEqual(['rocket 17'])
    expect(readings('3 3 3 小王 大王')).toEqual([])
    expect(readings('3 3 3 3 小王 大王 5 5')).toEqual([])
    expect(readings('3 3 3 4 4 4 小王 大王 5 5')).toEqual([])
  })

  test('the kicker of a trio with one may be a joker', () => {
    expect(readings('3 3 3 小王')).toEqual(['trio_solo 3'])
    expect(readings('3 3 3 大王', noJokers)).toEqual(['trio_solo 3'])
  })

  describe('makes no move of', () => {
    test.each([
      ['', 'no cards'],
      ['3 4', 'two different cards'],
      ['小王 大王 3', 'the rocket and a card'],
      ['3 3 3 3 4 4 4 4', 'two bombs'],
      ['3 3 3 4 4 5', 'a trio with two singles'],
      ['3 3 3 3 4', 'a bomb and a card'],
      ['3 3 3 3 3', 'more 3s than the deck has'],
      ['小王 小王', 'two black jokers'],
    ])('%s (%s)', (text) => {
      expect(readings(text)).toEqual([])
    })

    test('more than 20 cards', () => {
      const pairs = '3 3 4 4 5 5 6 6 7 7 8 8 9 9 10 10 J J Q Q K K'
      expect(readings(pairs.split(' ').slice(0, 20).join(' '))).toEqual(['pair_straight 12'])
      expect(readings(pairs)).toEqual([])
    })
  })

  test('rejects what is not a rank', () => {
    expect(() => classify([2], rules)).toThrow(RangeError)
    expect(() => classify([18], rules)).toThrow(RangeError)
    expect(() => classify([3.5], rules)).toThrow(RangeError)
  })

  describe('3.5.1, the details of kickers', () => {
    test('1. a kicker never has the rank of the body', () => {
      expect(readings('3 3 3 3')).toEqual(['bomb 3'])
      expect(readings('5 5 5 6 6 6 5 6')).toEqual([])
      expect(readings('5 5 5 5 6 6 6 7')).toEqual([])
      expect(readings('3 3 3 3 3 4')).toEqual([])
      // Four 3s and two 4s are a four with two singles, never trio 333 with 3 and 44.
      expect(readings('3 3 3 3 4 4')).toEqual(['four_two_solo 3'])
    })

    test('2. solo kickers may be a pair with soloKickersMayPair, and not without', () => {
      expect(readings('5 5 5 6 6 6 7 7')).toEqual(['plane_solo 6'])
      expect(readings('5 5 5 6 6 6 7 7', noPair)).toEqual([])
      expect(readings('5 5 5 5 7 7')).toEqual(['four_two_solo 5'])
      expect(readings('5 5 5 5 7 7', noPair)).toEqual([])
      // Different ranks are fine either way.
      expect(readings('5 5 5 6 6 6 7 8', noPair)).toEqual(['plane_solo 6'])
      expect(readings('5 5 5 5 7 8', noPair)).toEqual(['four_two_solo 5'])
      // A pair among more wings counts too.
      expect(readings('3 3 3 4 4 4 5 5 5 7 7 8')).toEqual(['plane_solo 5'])
      expect(readings('3 3 3 4 4 4 5 5 5 7 7 8', noPair)).toEqual([])
    })

    test('3. solo kickers may be both jokers with soloKickersMayBeJokers, and not without', () => {
      expect(readings('5 5 5 6 6 6 小王 大王')).toEqual(['plane_solo 6'])
      expect(readings('5 5 5 6 6 6 小王 大王', noJokers)).toEqual([])
      expect(readings('5 5 5 5 小王 大王')).toEqual(['four_two_solo 5'])
      expect(readings('5 5 5 5 小王 大王', noJokers)).toEqual([])
      // One joker is fine either way.
      expect(readings('5 5 5 6 6 6 7 小王', noJokers)).toEqual(['plane_solo 6'])
      expect(readings('5 5 5 5 7 大王', noJokers)).toEqual(['four_two_solo 5'])
    })

    test('4. the solo wings of a plane may be a trio of one rank', () => {
      expect(readings('3 3 3 4 4 4 5 5 5 7 7 7')).toEqual(['plane_solo 5'])
      // Not when the wings may not even hold a pair.
      expect(readings('3 3 3 4 4 4 5 5 5 7 7 7', noPair)).toEqual([])
    })

    test('5. two pair kickers are never four of one rank', () => {
      expect(readings('5 5 5 6 6 6 7 7 7 7')).toEqual([])
      expect(readings('3 3 3 3 4 4 4 4')).toEqual([])
      expect(readings('5 5 5 6 6 6 7 7 8 8')).toEqual(['plane_pair 6'])
      expect(readings('3 3 3 3 4 4 5 5')).toEqual(['four_two_pair 3'])
    })

    test('6. 555666777888 is a trio straight and a plane with solo wings, the trio straight first', () => {
      // The plane can be 666777888 with 555 as wings, or 555666777 with 888; the stronger one comes first.
      expect(readings('5 5 5 6 6 6 7 7 7 8 8 8')).toEqual(['trio_straight 8', 'plane_solo 8', 'plane_solo 7'])
      expect(classify(ranks('5 5 5 6 6 6 7 7 7 8 8 8'), rules).slice(1)).toMatchObject([
        { body: ranks('6 6 6 7 7 7 8 8 8'), kickers: ranks('5 5 5') },
        { body: ranks('5 5 5 6 6 6 7 7 7'), kickers: ranks('8 8 8') },
      ])
      expect(readings('3 3 3 4 4 4 5 5 5 6 6 6')).toEqual(['trio_straight 6', 'plane_solo 6', 'plane_solo 5'])
    })

    test('7. a bomb may be broken up', () => {
      const taken = takeRanks(hand('4 4 4 4 9'), ranks('4 4 4 9'))
      expect(taken.ok).toBe(true)
      if (!taken.ok) return
      expect(classify(taken.taken.map((card) => card.rank), rules).map((r) => r.type)).toEqual(['trio_solo'])
      expect(taken.rest).toEqual(hand('4 4 4 4').slice(3))
      expect(readings('4 4 4')).toEqual(['trio 4'])
      expect(readings('3 3 3 4 4 4 5 5')).toEqual(['plane_solo 4'])
    })

    test('8. the main rank does not depend on the kickers', () => {
      expect(classify(ranks('3 3 3 2'), rules)[0]?.main).toBe(3)
      expect(classify(ranks('3 3 3 4 4 4 小王 大王'), rules)[0]?.main).toBe(4)
      expect(classify(ranks('3 3 3 3 2 2 A A'), rules)[0]?.main).toBe(3)
    })
  })

  describe('more readings of the same cards', () => {
    test('a plane with solo wings may take its wings from a trio next to its body', () => {
      // 333444555666777 and 8: four trios out of five, the fifth trio and the 8 as wings, either end.
      expect(readings('3 3 3 4 4 4 5 5 5 6 6 6 7 7 7 8')).toEqual(['plane_solo 7', 'plane_solo 6'])
    })

    test('solo wings may be four of a rank when they may be a pair', () => {
      expect(readings('3 3 3 4 4 4 5 5 5 6 6 6 7 7 7 7')).toEqual(['plane_solo 6'])
      expect(readings('3 3 3 4 4 4 5 5 5 6 6 6 7 7 7 7', noPair)).toEqual([])
    })
  })

  test('with bareTrio off there is no trio and no trio straight', () => {
    expect(readings('3 3 3', noBareTrio)).toEqual([])
    expect(readings('3 3 3 4 4 4', noBareTrio)).toEqual([])
    expect(readings('5 5 5 6 6 6 7 7 7 8 8 8', noBareTrio)).toEqual(['plane_solo 8', 'plane_solo 7'])
    // Trios with kickers stay.
    expect(readings('3 3 3 4', noBareTrio)).toEqual(['trio_solo 3'])
    expect(readings('3 3 3 4 4', noBareTrio)).toEqual(['trio_pair 3'])
    expect(readings('3 3 3 4 4 4 5 6', noBareTrio)).toEqual(['plane_solo 4'])
  })

  test('with fourWithTwo off there is no four with two', () => {
    expect(readings('3 3 3 3 4 5', noFourWithTwo)).toEqual([])
    expect(readings('3 3 3 3 4 4 5 5', noFourWithTwo)).toEqual([])
    expect(readings('3 3 3 3', noFourWithTwo)).toEqual(['bomb 3'])
  })
})
