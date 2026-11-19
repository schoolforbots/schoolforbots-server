import { describe, expect, test } from 'vitest'
import { classify, type Interpretation, type MoveType } from '../../../src/club/doudizhu/classify.js'
import { beats } from '../../../src/club/doudizhu/compare.js'
import { DEFAULT_DOUDIZHU_RULES } from '../../../src/club/doudizhu/rules.js'
import { ranks } from './helpers.js'

/** The reading of some cards as a type; the first one when there are several. */
function move(text: string, type?: MoveType): Interpretation {
  const readings = classify(ranks(text), DEFAULT_DOUDIZHU_RULES)
  const found = readings.find((reading) => type === undefined || reading.type === type)
  if (found === undefined) throw new Error(`${text} is not ${type ?? 'a move'}`)
  return found
}

describe('beats', () => {
  test('the rocket beats everything', () => {
    const rocket = move('小王 大王')
    for (const text of ['大王', '2 2', '2 2 2 2', '3 3 3 4 4 4 5 6', 'A A A A K Q']) {
      expect(beats(rocket, move(text))).toBe(true)
      expect(beats(move(text), rocket)).toBe(false)
    }
  })

  test('a bomb beats everything but the rocket, and bombs compare by rank', () => {
    const bomb = move('3 3 3 3')
    for (const text of ['大王', '2 2', '2 2 2 小王', '10 J Q K A', '3 3 4 4 5 5 6 6 7 7 8 8 9 9 10 10 J J Q Q']) {
      expect(beats(bomb, move(text))).toBe(true)
      expect(beats(move(text), bomb)).toBe(false)
    }
    expect(beats(move('4 4 4 4'), bomb)).toBe(true)
    expect(beats(bomb, move('4 4 4 4'))).toBe(false)
    expect(beats(move('2 2 2 2'), move('A A A A'))).toBe(true)
  })

  test('other moves beat the same type and length with a higher main rank', () => {
    expect(beats(move('4'), move('3'))).toBe(true)
    expect(beats(move('大王'), move('小王'))).toBe(true)
    expect(beats(move('2 2'), move('A A'))).toBe(true)
    expect(beats(move('4 4 4 3'), move('3 3 3 2'))).toBe(true)
    expect(beats(move('4 5 6 7 8'), move('3 4 5 6 7'))).toBe(true)
    expect(beats(move('4 4 4 5 5 5 小王 大王'), move('3 3 3 4 4 4 9 9'))).toBe(true)
  })

  test('the same main rank does not beat', () => {
    expect(beats(move('5'), move('5'))).toBe(false)
    expect(beats(move('5 5 5 小王'), move('5 5 5 3'))).toBe(false)
    expect(beats(move('3 4 5 6 7'), move('3 4 5 6 7'))).toBe(false)
  })

  test('a lower main rank does not beat', () => {
    expect(beats(move('3'), move('4'))).toBe(false)
    expect(beats(move('3 3 3 4 4 4 5 5'), move('4 4 4 5 5 5 6 7'))).toBe(false)
  })

  test('only the main rank counts, not the kickers', () => {
    expect(beats(move('4 4 4 3'), move('3 3 3 2'))).toBe(true)
    expect(beats(move('3 3 3 2'), move('4 4 4 3'))).toBe(false)
    expect(beats(move('6 6 6 6 3 4'), move('5 5 5 5 小王 大王'))).toBe(true)
  })

  test('straights of different lengths do not beat each other', () => {
    expect(beats(move('4 5 6 7 8 9'), move('3 4 5 6 7'))).toBe(false)
    expect(beats(move('8 9 10 J Q'), move('3 4 5 6 7 8'))).toBe(false)
    expect(beats(move('5 5 6 6 7 7 8 8'), move('3 3 4 4 5 5'))).toBe(false)
    expect(beats(move('5 5 5 6 6 6 7 7 7 3 4 8'), move('3 3 3 4 4 4 9 9'))).toBe(false)
  })

  test('a trio with one and a trio with a pair do not beat each other', () => {
    expect(beats(move('4 4 4 3 3'), move('3 3 3 5'))).toBe(false)
    expect(beats(move('4 4 4 5'), move('3 3 3 5 5'))).toBe(false)
  })

  test('different types of the same length do not beat each other', () => {
    // Four with two singles and a pair straight are both six cards.
    expect(beats(move('A A A A 3 4'), move('3 3 4 4 5 5'))).toBe(false)
    expect(beats(move('J J Q Q K K'), move('3 3 3 3 4 5'))).toBe(false)
    // A trio straight and a plane with solo wings of the same cards.
    expect(beats(move('5 5 5 6 6 6 7 7 7 8 8 8', 'plane_solo'), move('3 3 3 4 4 4 5 5 5 6 6 6'))).toBe(false)
    expect(beats(move('5 5 5 6 6 6 7 7 7 8 8 8'), move('3 3 3 4 4 4 5 5 5 6 6 6'))).toBe(true)
  })

  test('four with two singles does not beat a bomb, and a bomb beats four with two', () => {
    expect(beats(move('2 2 2 2 小王 大王'), move('3 3 3 3'))).toBe(false)
    expect(beats(move('2 2 2 2 A A K K'), move('3 3 3 3'))).toBe(false)
    expect(beats(move('3 3 3 3'), move('2 2 2 2 小王 大王'))).toBe(true)
    expect(beats(move('3 3 3 3'), move('2 2 2 2 A A K K'))).toBe(true)
  })
})
