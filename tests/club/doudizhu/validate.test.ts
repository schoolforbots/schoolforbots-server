import { describe, expect, test } from 'vitest'
import Value from 'typebox/value'
import { IllegalMoveError } from '../../../src/protocol/club.js'
import type { RankName } from '../../../src/club/doudizhu/cards.js'
import { classify, type Interpretation, type MoveType } from '../../../src/club/doudizhu/classify.js'
import { legalMoves } from '../../../src/club/doudizhu/moves.js'
import { DEFAULT_DOUDIZHU_RULES } from '../../../src/club/doudizhu/rules.js'
import {
  checkBid,
  checkPass,
  checkPlay,
  type IllegalMove,
  type PlayContext,
  type PlayInput,
  type ToBeat,
} from '../../../src/club/doudizhu/validate.js'
import { hand, ranks } from './helpers.js'

const rules = DEFAULT_DOUDIZHU_RULES

/** The first reading of some cards, or the first of a type. */
function reading(text: string, type?: MoveType): Interpretation {
  const readings = classify(ranks(text), rules)
  const found = type === undefined ? readings[0] : readings.find((r) => r.type === type)
  if (found === undefined) throw new Error(`no reading of ${text}`)
  return found
}

/** Seat 1 to act, holding `cards`; its list is computed as `your_turn` would. */
function context(cards: string, toBeat: ToBeat | null = null, seat = 1): PlayContext {
  const h = hand(cards)
  return { seat, hand: h, moves: legalMoves(h, toBeat?.move ?? null, rules).moves, toBeat, rules }
}

const cardsOf = (text: string, as?: MoveType): PlayInput => ({
  cards: text.split(' ') as RankName[],
  ...(as === undefined ? {} : { as }),
})

/** The error of a refused play. */
function refused(ctx: PlayContext, input: PlayInput): IllegalMove {
  const result = checkPlay(ctx, input)
  if (result.ok) throw new Error(`the play went: ${result.move.type}`)
  return result.error
}

/** An error as the protocol sends it, to check it against the schema. */
const asProtocol = (error: IllegalMove): unknown => ({
  code: 'illegal_move',
  message: '这一步不合规则。',
  ...error,
  retry: { turn: 7, deadline: '2026-11-20T12:00:00.000Z', timeBankSeconds: 30 },
})

describe('checkBid', () => {
  test('0 always goes', () => {
    expect(checkBid(0, [])).toBeNull()
    expect(checkBid(0, [2])).toBeNull()
    expect(checkBid(0, [1, 2])).toBeNull()
  })

  test('a bid above every bid before it goes', () => {
    expect(checkBid(1, [])).toBeNull()
    expect(checkBid(3, [])).toBeNull()
    expect(checkBid(2, [1, 0])).toBeNull()
    expect(checkBid(3, [0, 2])).toBeNull()
  })

  test('bid_too_low: a bid not above the highest bid before it', () => {
    expect(checkBid(1, [2])).toEqual({
      problem: 'bid_too_low',
      reason: '前面已经有人叫了 2 分，你只能叫 3 分，或者叫 0 分（不叫）。',
    })
    expect(checkBid(2, [2, 0])).toEqual({
      problem: 'bid_too_low',
      reason: '前面已经有人叫了 2 分，你只能叫 3 分，或者叫 0 分（不叫）。',
    })
    expect(checkBid(1, [0, 1])).toEqual({
      problem: 'bid_too_low',
      reason: '前面已经有人叫了 1 分，你只能叫 2 分、3 分，或者叫 0 分（不叫）。',
    })
  })

  test('throws on a bid out of range', () => {
    expect(() => checkBid(4, [])).toThrow(RangeError)
    expect(() => checkBid(-1, [])).toThrow(RangeError)
  })
})

describe('checkPlay', () => {
  test('plays a listed move by id', () => {
    const ctx = context('3 4 4 5')
    const id = ctx.moves.findIndex((move) => move.type === 'pair') + 1
    const result = checkPlay(ctx, { moveId: id })
    expect(result).toEqual({ ok: true, move: reading('4 4'), taken: hand('4 4'), rest: hand('3 5') })
  })

  test('plays cards as their first reading, or as the reading `as` names', () => {
    const ctx = context('5 5 5 6 6 6 7 7 7 8 8 8 9')
    const plain = checkPlay(ctx, cardsOf('5 5 5 6 6 6 7 7 7 8 8 8'))
    expect(plain.ok && plain.move.type).toBe('trio_straight')
    const plane = checkPlay(ctx, cardsOf('5 5 5 6 6 6 7 7 7 8 8 8', 'plane_solo'))
    // The strongest reading of the type: the plane on 666777888.
    expect(plane.ok && plane.move).toEqual(reading('5 5 5 6 6 6 7 7 7 8 8 8', 'plane_solo'))
    expect(plane.ok && plane.move.main).toBe(8)
    expect(plane.ok && plane.rest).toEqual(hand('9'))
  })

  test('takes the cards in suit order', () => {
    const result = checkPlay(context('7 7 7 7'), cardsOf('7'))
    expect(result.ok && result.taken).toEqual(hand('7'))
    expect(result.ok && result.rest).toEqual(hand('7 7 7 7').slice(1))
  })

  describe('unknown_move', () => {
    test('an id past the end of the list', () => {
      const ctx = context('3 4 5')
      expect(ctx.moves.length).toBeLessThan(42)
      expect(refused(ctx, { moveId: 42 })).toEqual({
        problem: 'unknown_move',
        reason: '清单里没有编号 42 的出法，请从这次给你的清单里选，或者直接报牌。',
      })
    })

    test('ids follow the list sent, trimmed or not', () => {
      const big = '3 3 3 4 4 4 5 5 5 6 6 6 7 7 7 8 9 10 J Q'
      const ctx = context(big)
      expect(legalMoves(hand(big), null, rules).trimmed).toBe(true)
      const last = ctx.moves.length
      expect(checkPlay(ctx, { moveId: last }).ok).toBe(true)
      expect(refused(ctx, { moveId: last + 1 }).problem).toBe('unknown_move')
      expect(refused(ctx, { moveId: 0 }).problem).toBe('unknown_move')
    })
  })

  describe('not_in_hand', () => {
    test('lists the cards short', () => {
      const error = refused(context('3 4 5 7'), cardsOf('7 7 小王'))
      expect(error).toEqual({
        problem: 'not_in_hand',
        reason: '你手里没有这些牌：还缺 一张 7、一张 小王。',
        missing: ['7', '小王'],
      })
    })

    test('counts the missing cards one by one', () => {
      // Three 7s with two in hand: one 7 short.
      expect(refused(context('7 7 8'), cardsOf('7 7 7')).missing).toEqual(['7'])
      const error = refused(context('7 8'), cardsOf('7 7 7 7 8 8'))
      expect(error.missing).toEqual(['7', '7', '7', '8'])
      expect(error.reason).toBe('你手里没有这些牌：还缺 三张 7、一张 8。')
    })

    test('comes before not_a_type and type_mismatch', () => {
      expect(refused(context('3 4'), cardsOf('3 4 9')).problem).toBe('not_in_hand')
      expect(refused(context('3 3 3'), cardsOf('3 3 3 4', 'plane_solo')).problem).toBe('not_in_hand')
    })
  })

  describe('not_a_type', () => {
    test('says when a 2 or a joker spoils a straight', () => {
      expect(refused(context('2 3 4 5 6 7'), cardsOf('3 4 5 6 2'))).toEqual({
        problem: 'not_a_type',
        reason: '3 4 5 6 2 凑不成任何牌型（2 和王不能进顺子）。',
      })
      expect(refused(context('J Q K A 2'), cardsOf('J Q K A 2')).reason).toBe(
        'J Q K A 2 凑不成任何牌型（2 和王不能进顺子）。',
      )
      expect(refused(context('Q Q K K A A 2 2'), cardsOf('K K A A 2 2')).reason).toBe(
        'K K A A 2 2 凑不成任何牌型（2 不能进双顺）。',
      )
      expect(refused(context('A A A 2 2 2'), cardsOf('A A A 2 2 2')).reason).toBe(
        'A A A 2 2 2 凑不成任何牌型（2 不能进三顺和飞机）。',
      )
    })

    test('gives no hint when it does not apply', () => {
      expect(refused(context('3 4 5'), cardsOf('3 5'))).toEqual({
        problem: 'not_a_type',
        reason: '3 5 凑不成任何牌型。',
      })
      expect(refused(context('3 3 3 3 4 4 4 4'), cardsOf('3 3 3 3 4 4 4 4')).reason).toBe(
        '3 3 3 3 4 4 4 4 凑不成任何牌型。',
      )
      // A 2, but too few ranks for a straight.
      expect(refused(context('3 4 2'), cardsOf('3 4 2')).reason).toBe('3 4 2 凑不成任何牌型。')
    })

    test('comes before type_mismatch', () => {
      expect(refused(context('3 5'), cardsOf('3 5', 'pair')).problem).toBe('not_a_type')
    })
  })

  describe('type_mismatch', () => {
    test('says what the cards can be played as', () => {
      expect(refused(context('3 3 3 4'), cardsOf('3 3 3 4', 'plane_solo'))).toEqual({
        problem: 'type_mismatch',
        reason: '3 3 3 4 不能当 飞机带单 出。这手牌可以当：三带一。',
      })
      expect(refused(context('5 5 5 6 6 6 7 7 7 8 8 8'), cardsOf('5 5 5 6 6 6 7 7 7 8 8 8', 'bomb'))).toEqual({
        problem: 'type_mismatch',
        reason: '5 5 5 6 6 6 7 7 7 8 8 8 不能当 炸弹 出。这手牌可以当：三顺、飞机带单。',
      })
    })

    test('comes before cannot_beat', () => {
      const toBeat = { seat: 0, move: reading('9 9') }
      expect(refused(context('3 3 3 4', toBeat), cardsOf('3 3 3 4', 'pair')).problem).toBe('type_mismatch')
    })
  })

  describe('cannot_beat', () => {
    test('a move of the same type that is not higher', () => {
      const error = refused(context('3 3 4 4', { seat: 0, move: reading('5 5') }), cardsOf('4 4'))
      expect(error).toEqual({
        problem: 'cannot_beat',
        reason: '上家出的是对牌（一对 5），你要出更大的对牌，或者炸弹、王炸；也可以不要。',
        toBeat: { seat: 0, move: { type: 'pair', name: '对牌', cards: ['5', '5'] } },
      })
      expect(Value.Check(IllegalMoveError, asProtocol(error))).toBe(true)
    })

    test('a move of another type, or another number of cards', () => {
      // Seat 2 played, seat 1 acts: the move came from the seat after it, the seat before it having passed.
      const straight = { seat: 2, move: reading('3 4 5 6 7 8') }
      const error = refused(context('4 5 6 7 8 9 10', straight), cardsOf('6 7 8 9 10'))
      expect(error).toEqual({
        problem: 'cannot_beat',
        reason: '下家出的是单顺（3 4 5 6 7 8），你要出同样 6 张、更大的单顺，或者炸弹、王炸；也可以不要。',
        toBeat: { seat: 2, move: { type: 'straight', name: '单顺', cards: ['3', '4', '5', '6', '7', '8'] } },
      })
      expect(refused(context('9 9 9', { seat: 0, move: reading('3') }), cardsOf('9 9 9')).problem).toBe('cannot_beat')
    })

    test('names bombs and the rocket', () => {
      expect(refused(context('3 3 3 3', { seat: 0, move: reading('5 5 5 5') }), cardsOf('3 3 3 3')).reason).toBe(
        '上家出的是炸弹（5 5 5 5），你要出更大的炸弹，或者王炸；也可以不要。',
      )
      const rocket = refused(context('2 2 2 2', { seat: 0, move: reading('小王 大王') }), cardsOf('2 2 2 2'))
      expect(rocket.reason).toBe('上家出的是火箭（小王 大王），没有牌能压住，只能不要。')
      expect(rocket.toBeat).toEqual({ seat: 0, move: { type: 'rocket', name: '火箭', cards: ['小王', '大王'] } })
      // A four with two is no bomb.
      const bomb = { seat: 0, move: reading('3 3 3 3') }
      expect(refused(context('2 2 2 2 3 4', bomb), cardsOf('2 2 2 2 3 4')).problem).toBe('cannot_beat')
    })

    test('without as, keeps the first reading and suggests as when another reading beats', () => {
      // A plane with solo wings of 12 cards, main 7, from the seat after.
      const plane = { seat: 2, move: reading('3 3 3 5 5 5 6 6 6 7 7 7') }
      expect(plane.move.type).toBe('plane_solo')
      const ctx = context('6 6 6 7 7 7 8 8 8 9 9 9', plane)
      expect(refused(ctx, cardsOf('6 6 6 7 7 7 8 8 8 9 9 9'))).toEqual({
        problem: 'cannot_beat',
        reason:
          '下家出的是飞机带单（3 3 3 5 5 5 6 6 6 7 7 7），你要出同样 12 张、更大的飞机带单，或者炸弹、王炸；也可以不要。' +
          '这手牌也能当飞机带单出，要这样出请加 "as": "plane_solo"。',
        toBeat: {
          seat: 2,
          move: { type: 'plane_solo', name: '飞机带单', cards: '3 3 3 5 5 5 6 6 6 7 7 7'.split(' ') },
        },
      })
      // With as, it goes.
      const played = checkPlay(ctx, cardsOf('6 6 6 7 7 7 8 8 8 9 9 9', 'plane_solo'))
      expect(played.ok && played.move.main).toBe(9)
      // Naming the type that does not beat gives no hint.
      const named = refused(ctx, cardsOf('6 6 6 7 7 7 8 8 8 9 9 9', 'trio_straight'))
      expect(named.problem).toBe('cannot_beat')
      expect(named.reason).not.toContain('as')
    })

    test('with as, plays the strongest reading of the type', () => {
      // 444555666777 as a plane is the plane on 555666777, main 7: it does not beat a plane of main 7.
      const plane = { seat: 0, move: reading('3 3 3 5 5 5 6 6 6 7 7 7') }
      const error = refused(context('4 4 4 5 5 5 6 6 6 7 7 7', plane), cardsOf('4 4 4 5 5 5 6 6 6 7 7 7', 'plane_solo'))
      expect(error.problem).toBe('cannot_beat')
      expect(error.reason).not.toContain('as')
      // On a plane of main 6 it beats, as main 7.
      const lower = { seat: 0, move: reading('3 3 3 4 4 4 5 5 5 6 6 6', 'plane_solo') }
      expect(lower.move.main).toBe(6)
      const played = checkPlay(context('4 4 4 5 5 5 6 6 6 7 7 7', lower), cardsOf('4 4 4 5 5 5 6 6 6 7 7 7', 'plane_solo'))
      expect(played.ok && played.move.main).toBe(7)
    })
  })

  test('throws when the seat would follow its own move', () => {
    expect(() => checkPlay(context('3 4', { seat: 1, move: reading('3') }), cardsOf('4'))).toThrow()
    expect(() => checkPass({ seat: 1, toBeat: { seat: 1, move: reading('3') } })).toThrow()
  })

  test('every refusal fits the protocol', () => {
    const errors = [
      refused(context('3 4 5'), { moveId: 42 }),
      refused(context('3 4 5 7'), cardsOf('7 7 小王')),
      refused(context('2 3 4 5 6 7'), cardsOf('3 4 5 6 2')),
      refused(context('3 3 3 4'), cardsOf('3 3 3 4', 'plane_solo')),
      refused(context('3 3 4 4', { seat: 0, move: reading('5 5') }), cardsOf('4 4')),
      checkPass({ seat: 1, toBeat: null })!,
      checkBid(1, [2])!,
    ]
    for (const error of errors) expect(Value.Check(IllegalMoveError, asProtocol(error)), error.problem).toBe(true)
    // The check has teeth: `not_in_hand` needs `missing`, and `missing` goes with nothing else.
    const { missing: _, ...noMissing } = errors[1]!
    expect(Value.Check(IllegalMoveError, asProtocol(noMissing))).toBe(false)
    expect(Value.Check(IllegalMoveError, asProtocol({ ...errors[2]!, missing: ['3'] }))).toBe(false)
  })
})

describe('checkPass', () => {
  test('must_play: the seat leads the trick', () => {
    const expected = { problem: 'must_play', reason: '这一轮由你先出，不能不要，请出任意一手合法的牌。' }
    expect(checkPass({ seat: 0, toBeat: null })).toEqual(expected)
    expect(checkPass(context('3 4 5', null, 2))).toEqual(expected)
  })

  test('a pass on a move to beat goes', () => {
    expect(checkPass({ seat: 1, toBeat: { seat: 0, move: reading('3') } })).toBeNull()
    expect(checkPass({ seat: 1, toBeat: { seat: 2, move: reading('小王 大王') } })).toBeNull()
  })
})
