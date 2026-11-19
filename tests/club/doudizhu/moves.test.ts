import { describe, expect, test } from 'vitest'
import {
  classify,
  type ClassifyRules,
  type Interpretation,
  MOVE_TYPES,
  type MoveType,
} from '../../../src/club/doudizhu/classify.js'
import { beats } from '../../../src/club/doudizhu/compare.js'
import { FULL_DECK } from '../../../src/club/doudizhu/cards.js'
import { shuffle } from '../../../src/club/doudizhu/deal.js'
import { legalMoves, MOVES_LIMIT, toMove } from '../../../src/club/doudizhu/moves.js'
import { DEFAULT_DOUDIZHU_RULES } from '../../../src/club/doudizhu/rules.js'
import { hand, ranks, seededRandomInt } from './helpers.js'

const rules: ClassifyRules = DEFAULT_DOUDIZHU_RULES
const variants: [string, ClassifyRules][] = [
  ['the default rules', rules],
  ['no pair as solo kickers', { ...rules, soloKickersMayPair: false }],
  ['no jokers as solo kickers', { ...rules, soloKickersMayBeJokers: false }],
  ['no bare trio', { ...rules, bareTrio: false }],
  ['no four with two', { ...rules, fourWithTwo: false }],
  ['pair straights of two pairs', { ...rules, minPairStraight: 2 }],
]

/** A move as `type main: cards`, short enough to read in a failing test. */
const show = (move: Interpretation): string => `${move.type} ${move.main}: ${toMove(move).cards.join(' ')}`
const shown = (moves: readonly Interpretation[]): string[] => moves.map(show)

/** `n` random cards from a shuffled deck. */
function randomHand(random: (n: number) => number, n: number): number[] {
  return shuffle(FULL_DECK, random)
    .slice(0, n)
    .map((card) => card.rank)
}

/** Every sub-multiset of some ranks: the 2^n subsets of the cards, with the duplicates removed. */
function subMultisets(cards: readonly number[]): number[][] {
  const counts = new Map<number, number>()
  for (const rank of cards) counts.set(rank, (counts.get(rank) ?? 0) + 1)
  let out: number[][] = [[]]
  for (const [rank, n] of counts) {
    const next: number[][] = []
    for (const base of out) for (let k = 0; k <= n; k++) next.push([...base, ...new Array<number>(k).fill(rank)])
    out = next
  }
  return out.filter((subset) => subset.length > 0)
}

/** The list order, written out again independently of `moves.ts`. */
function listOrder(a: Interpretation, b: Interpretation): number {
  const byType = MOVE_TYPES.indexOf(a.type) - MOVE_TYPES.indexOf(b.type)
  if (byType !== 0) return byType
  if (a.length !== b.length) return a.length - b.length
  if (a.main !== b.main) return a.main - b.main
  const ka = [...a.kickers].sort((x, y) => x - y)
  const kb = [...b.kickers].sort((x, y) => x - y)
  for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i]! - kb[i]!
  return 0
}

/**
 * The legal moves found by brute force: classify every sub-multiset of the hand, keep the first (strongest) reading of
 * each type, keep what beats `toBeat`, sort.
 */
function bruteForce(readingsBySubset: readonly Interpretation[][], toBeat: Interpretation | null): Interpretation[] {
  const moves: Interpretation[] = []
  for (const readings of readingsBySubset) {
    const seen = new Set<MoveType>()
    for (const reading of readings) {
      if (seen.has(reading.type)) continue
      seen.add(reading.type)
      if (toBeat === null || beats(reading, toBeat)) moves.push(reading)
    }
  }
  return moves.sort(listOrder)
}

describe('legalMoves', () => {
  test('lists every move a small hand can lead, in list order', () => {
    expect(shown(legalMoves(hand('3 3 4 小王 大王'), null, rules).moves)).toEqual([
      'single 3: 3',
      'single 4: 4',
      'single 16: 小王',
      'single 17: 大王',
      'pair 3: 3 3',
      'rocket 17: 小王 大王',
    ])
  })

  test('takes ranks as well as cards', () => {
    expect(legalMoves(ranks('3 3 4'), null, rules)).toEqual(legalMoves(hand('3 3 4'), null, rules))
  })

  test('sorts by type, then length, then main rank, then kickers card by card', () => {
    const moves = legalMoves(hand('3 3 3 4 4 4 5 6 6 7 8 9'), null, rules).moves
    const trioSolo = shown(moves.filter((move) => move.type === 'trio_solo'))
    expect(trioSolo).toEqual([
      'trio_solo 3: 3 3 3 4',
      'trio_solo 3: 3 3 3 5',
      'trio_solo 3: 3 3 3 6',
      'trio_solo 3: 3 3 3 7',
      'trio_solo 3: 3 3 3 8',
      'trio_solo 3: 3 3 3 9',
      'trio_solo 4: 3 4 4 4',
      'trio_solo 4: 4 4 4 5',
      'trio_solo 4: 4 4 4 6',
      'trio_solo 4: 4 4 4 7',
      'trio_solo 4: 4 4 4 8',
      'trio_solo 4: 4 4 4 9',
    ])
    const straights = shown(moves.filter((move) => move.type === 'straight'))
    expect(straights).toEqual([
      'straight 7: 3 4 5 6 7',
      'straight 8: 4 5 6 7 8',
      'straight 9: 5 6 7 8 9',
      'straight 8: 3 4 5 6 7 8',
      'straight 9: 4 5 6 7 8 9',
      'straight 9: 3 4 5 6 7 8 9',
    ])
    const planes = shown(moves.filter((move) => move.type === 'plane_solo'))
    // Kickers compared card by card: 5 6 before 5 7 before 6 6.
    expect(planes.slice(0, 4)).toEqual([
      'plane_solo 4: 3 3 3 4 4 4 5 6',
      'plane_solo 4: 3 3 3 4 4 4 5 7',
      'plane_solo 4: 3 3 3 4 4 4 5 8',
      'plane_solo 4: 3 3 3 4 4 4 5 9',
    ])
    expect(planes).toContain('plane_solo 4: 3 3 3 4 4 4 6 6')
    expect(planes.indexOf('plane_solo 4: 3 3 3 4 4 4 5 9')).toBeLessThan(planes.indexOf('plane_solo 4: 3 3 3 4 4 4 6 6'))
    // Bombs and the rocket come last.
    const withBombs = legalMoves(hand('3 3 3 3 4 4 4 4 5 6 小王 大王'), null, rules).moves
    expect(shown(withBombs.slice(-3))).toEqual(['bomb 3: 3 3 3 3', 'bomb 4: 4 4 4 4', 'rocket 17: 小王 大王'])
  })

  test('lists the same cards as the same type once, with the highest main rank', () => {
    const moves = legalMoves(hand('3 3 3 4 4 4 5 5 5 6 6 6'), null, rules).moves
    const whole = moves.filter((move) => move.length === 12)
    expect(shown(whole)).toEqual([
      'trio_straight 6: 3 3 3 4 4 4 5 5 5 6 6 6',
      'plane_solo 6: 3 3 3 4 4 4 5 5 5 6 6 6',
    ])
    expect(whole[1]).toMatchObject({ body: ranks('4 4 4 5 5 5 6 6 6'), kickers: ranks('3 3 3') })
    // Each reading is the one classify gives first for its type.
    for (const move of moves) {
      expect(classify(move.cards, rules).find((reading) => reading.type === move.type)).toEqual(move)
    }
  })

  describe('following', () => {
    const toBeat = (text: string, type?: MoveType): Interpretation => {
      const readings = classify(ranks(text), rules)
      const reading = type === undefined ? readings[0] : readings.find((r) => r.type === type)
      if (reading === undefined) throw new Error(`no reading of ${text}`)
      return reading
    }

    test('lists the moves of the same type and length that beat, then bombs and the rocket', () => {
      expect(shown(legalMoves(hand('3 4 4 5 5 9 9 9 9 小王 大王'), toBeat('4 4'), rules).moves)).toEqual([
        'pair 5: 5 5',
        'pair 9: 9 9',
        'bomb 9: 9 9 9 9',
        'rocket 17: 小王 大王',
      ])
    })

    test('lists only straights of the same length', () => {
      const moves = legalMoves(hand('4 5 6 7 8 9 10'), toBeat('3 4 5 6 7 8'), rules).moves
      expect(shown(moves)).toEqual(['straight 9: 4 5 6 7 8 9', 'straight 10: 5 6 7 8 9 10'])
    })

    test('lists only the bombs that beat a bomb, and the rocket', () => {
      const moves = legalMoves(hand('3 3 3 3 8 8 8 8 小王 大王'), toBeat('5 5 5 5'), rules).moves
      expect(shown(moves)).toEqual(['bomb 8: 8 8 8 8', 'rocket 17: 小王 大王'])
    })

    test('lists nothing on the rocket', () => {
      expect(legalMoves(hand('2 2 2 2 小王'), toBeat('小王 大王'), rules)).toEqual({ moves: [], trimmed: false })
    })

    test('reads the same cards with the highest main rank before deciding whether they beat', () => {
      // 444555666777 is a plane on 555666777 (main 7) and on 444555666 (main 6): listed once, as main 7.
      const on6 = toBeat('3 3 3 4 4 4 5 5 5 6 6 6', 'plane_solo')
      expect(on6.main).toBe(6)
      const moves = legalMoves(hand('4 4 4 5 5 5 6 6 6 7 7 7'), on6, rules).moves
      expect(shown(moves)).toEqual(['plane_solo 7: 4 4 4 5 5 5 6 6 6 7 7 7'])
      // On a plane of main 7, the same cards do not beat in either reading.
      const on7 = toBeat('5 5 5 6 6 6 7 7 7 3 3 3', 'plane_solo')
      expect(on7.main).toBe(7)
      expect(legalMoves(hand('4 4 4 5 5 5 6 6 6 7 7 7'), on7, rules).moves).toEqual([])
    })
  })

  describe('agrees with brute force on small hands', () => {
    for (const [name, r] of variants) {
      test(name, () => {
        const random = seededRandomInt(name.length * 7919)
        const hands = r === rules ? 3000 : 300
        for (let i = 0; i < hands; i++) {
          const cards = randomHand(random, 1 + random(10))
          const readingsBySubset = subMultisets(cards).map((subset) => classify(subset, r))
          const lead = legalMoves(cards, null, r, Infinity)
          const expected = bruteForce(readingsBySubset, null)
          expect(shown(lead.moves), cards.join(' ')).toEqual(shown(expected))
          expect(lead.moves).toEqual(expected)
          expect(lead.trimmed).toBe(false)

          // Follow a move of another small hand, and one of this hand's own moves.
          const other = legalMoves(randomHand(random, 1 + random(10)), null, r, Infinity).moves
          const targets = [other[random(other.length)]!, expected[random(expected.length)]!]
          for (const target of targets) {
            const follow = legalMoves(cards, target, r, Infinity)
            expect(shown(follow.moves), `${cards.join(' ')} on ${show(target)}`).toEqual(
              shown(bruteForce(readingsBySubset, target)),
            )
          }
        }
      })
    }
  })

  describe('trimming', () => {
    // 333444555666777 and five singles: a plane on any 2 to 5 of the trios, with many choices of wings.
    const big = '3 3 3 4 4 4 5 5 5 6 6 6 7 7 7 8 9 10 J Q'

    test('trims a list longer than the limit to the lowest kickers of each type and body', () => {
      const full = legalMoves(hand(big), null, rules, Infinity)
      expect(full.moves.length).toBeGreaterThan(MOVES_LIMIT)
      expect(full.trimmed).toBe(false)
      const trimmed = legalMoves(hand(big), null, rules)
      expect(trimmed.trimmed).toBe(true)
      expect(trimmed.moves.length).toBeLessThanOrEqual(MOVES_LIMIT)

      const key = (move: Interpretation): string => `${move.type}:${move.body.join(',')}`
      // Every body is still there, once, with the first (lowest) kickers of the full list.
      const firstOfBody = new Map<string, Interpretation>()
      for (const move of full.moves) if (!firstOfBody.has(key(move))) firstOfBody.set(key(move), move)
      expect(trimmed.moves).toEqual([...firstOfBody.values()])
      expect(shown(trimmed.moves.filter((move) => move.type === 'plane_solo' && move.length === 20))).toEqual([
        'plane_solo 7: 3 3 3 4 4 4 5 5 5 6 6 6 7 7 7 8 9 10 J Q',
      ])
      expect(shown(trimmed.moves.filter((move) => move.type === 'trio_solo' && move.main === 7))).toEqual([
        'trio_solo 7: 3 7 7 7',
      ])
      expect(shown(trimmed.moves.filter((move) => move.type === 'plane_solo' && move.length === 8 && move.main === 4)))
        .toEqual(['plane_solo 4: 3 3 3 4 4 4 5 5'])
      // Moves without kickers are all kept.
      for (const type of ['single', 'pair', 'trio', 'straight', 'trio_straight', 'bomb'] as const) {
        expect(trimmed.moves.filter((move) => move.type === type)).toEqual(full.moves.filter((move) => move.type === type))
      }
    })

    test('leaves a list of the limit or fewer alone', () => {
      const full = legalMoves(hand(big), null, rules, Infinity)
      const atLimit = legalMoves(hand(big), null, rules, full.moves.length)
      expect(atLimit).toEqual({ moves: full.moves, trimmed: false })
      expect(legalMoves(hand(big), null, rules, full.moves.length - 1).trimmed).toBe(true)
    })

    test('keeps the first kickers of each body in landlord hands with many kickers', () => {
      const landlordHands = [
        big,
        '3 3 3 4 4 4 5 5 5 6 6 6 8 8 9 9 10 10 小王 大王',
        '3 3 3 3 4 4 4 4 5 5 5 5 6 6 6 6 7 8 9 10',
        '5 5 5 6 6 6 7 7 7 8 8 8 9 9 9 10 10 J J Q',
        '3 3 4 4 5 5 6 6 7 7 8 8 9 9 10 10 J J Q Q',
        '3 4 5 6 7 8 9 10 J Q K A A A A 2 2 2 小王 大王',
      ]
      for (const text of landlordHands) {
        const full = legalMoves(hand(text), null, rules, Infinity).moves
        const { moves, trimmed } = legalMoves(hand(text), null, rules)
        expect(moves.length, text).toBeLessThanOrEqual(MOVES_LIMIT)
        if (!trimmed) {
          expect(moves).toEqual(full)
          continue
        }
        const bodies = (list: readonly Interpretation[]): string[] => [
          ...new Set(list.map((move) => `${move.type}:${move.body.join(',')}`)),
        ]
        expect(bodies(moves), text).toEqual(bodies(full))
        for (const move of moves) {
          const sameBody = full.filter((m) => m.type === move.type && m.body.join() === move.body.join())
          expect(move, text).toEqual(sameBody[0])
        }
      }
    })

    /*
     * Why any hand of 20 cards or fewer trims to the limit or fewer. A trimmed list has one move per type and body. A
     * hand of 20 cards has at most 15 ranks, 10 ranks of two or more, 6 ranks of three or more and 5 ranks of four. So
     * it has at most: 15 singles; 10 pairs; 6 trios, 6 trio bodies with one and 6 with a pair; 36 straights (the runs
     * of 5 to 12 ranks from 3 to A: 8 + 7 + … + 1); 36 pair straights (runs of 3 or more among at most 10 pair ranks:
     * 8 + 7 + … + 1; 45 when two pairs make one); 15 trio straights (runs of 2 or more among at most 6 trio ranks);
     * 14 plane bodies with solo wings (2 to 5 trios: 5 + 4 + 3 + 2) and 12 with pair wings (2 to 4 trios: 5 + 4 + 3);
     * 5 bodies each of four with two singles, four with two pairs and bomb; and 1 rocket. That is 172 in all, 181 with
     * pair straights of two pairs.
     */
    const mostBodies = (r: ClassifyRules): Record<MoveType, number> => ({
      single: 15,
      pair: 10,
      trio: 6,
      trio_solo: 6,
      trio_pair: 6,
      straight: 36,
      // Runs of minPairStraight to 10 pairs among 10 ranks.
      pair_straight: Array.from({ length: 10 }, (_, i) => i + 1)
        .filter((links) => links >= r.minPairStraight)
        .reduce((sum, links) => sum + 11 - links, 0),
      trio_straight: 15,
      plane_solo: 14,
      plane_pair: 12,
      four_two_solo: 5,
      four_two_pair: 5,
      bomb: 5,
      rocket: 1,
    })
    const total = (r: ClassifyRules): number => Object.values(mostBodies(r)).reduce((a, b) => a + b, 0)

    test('any hand of 20 cards trims to the limit or fewer', () => {
      expect(total(rules)).toBe(172)
      expect(total({ ...rules, minPairStraight: 2 })).toBe(181)
      for (const [, r] of variants) expect(total(r)).toBeLessThanOrEqual(MOVES_LIMIT)

      // Check the bound per type on random hands of 20 and on the hands that push it.
      const random = seededRandomInt(20)
      const hands = Array.from({ length: 3000 }, () => randomHand(random, 20))
      hands.push(
        ranks('3 3 3 4 4 4 5 5 5 6 6 6 7 7 7 8 8 8 9 9'),
        ranks('3 3 4 4 5 5 6 6 7 7 8 8 9 9 10 10 J J Q Q'),
        ranks('3 3 3 3 4 4 4 4 5 5 5 5 6 6 6 6 7 7 7 7'),
        ranks('3 4 5 6 7 8 9 10 J Q K A 2 小王 大王 3 4 5 6 7'),
        ranks(big),
      )
      let largest = 0
      for (const cards of hands) {
        for (const [, r] of variants) {
          const most = mostBodies(r)
          const { moves } = legalMoves(cards, null, r, 0)
          largest = Math.max(largest, moves.length)
          const perType = new Map<MoveType, number>()
          for (const move of moves) perType.set(move.type, (perType.get(move.type) ?? 0) + 1)
          for (const [type, n] of perType) {
            if (n > most[type]) expect.fail(`${n} bodies of ${type} in ${cards.join(' ')}, at most ${most[type]}`)
          }
        }
      }
      expect(largest).toBeLessThanOrEqual(MOVES_LIMIT)
    })
  })

  test('takes under 20 ms for a hand of 20 cards (median of 200)', () => {
    const random = seededRandomInt(200)
    const times: number[] = []
    for (let i = 0; i < 200; i++) {
      const cards = shuffle(FULL_DECK, random).slice(0, 20)
      const start = performance.now()
      legalMoves(cards, null, rules)
      times.push(performance.now() - start)
    }
    times.sort((a, b) => a - b)
    expect(times[100]!).toBeLessThan(20)
  })
})
