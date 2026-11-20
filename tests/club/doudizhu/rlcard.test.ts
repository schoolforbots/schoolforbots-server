import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { beforeAll, describe, expect, test } from 'vitest'
import { BLACK_JOKER, MIN_RANK, RED_JOKER } from '../../../src/club/doudizhu/cards.js'
import {
  classify,
  type ClassifyRules,
  type Interpretation,
  type MoveType,
} from '../../../src/club/doudizhu/classify.js'
import { DEFAULT_DOUDIZHU_RULES } from '../../../src/club/doudizhu/rules.js'

// Differential test against RLCard's doudizhu move types (tests/fixtures/rlcard/README.md says where they come from).
//
// The fixture lists every move RLCard knows, each with its move types in our names. RLCard lists only legal moves, so
// on its own it can only show moves RLCard has and we read differently. To see the other way too (moves we take and
// RLCard does not have), the test also builds sets of cards by shape: all sets of up to 5 cards; every chain of
// singles, pairs and trios, also ones running on past the ace into the 2 and the jokers; every trio chain with any k
// kickers or with k pairs; every four with any 2 kickers or 2 pairs; where pairs are carried, also a bomb as two of
// them. Every move the rules allow is of one of those shapes, so the union of the fixture and those sets holds every
// move either side should take, plus the near misses, and each one is compared both ways. A move of some other shape
// that `classify` wrongly took (six unrelated cards, say) would not be seen here.

const FIXTURE = new URL('../../fixtures/rlcard/doudizhu-types.json.gz', import.meta.url)

/** RLCard's characters for the ranks, low to high: `RLCARD_RANKS[rank - 3]`. */
const RLCARD_RANKS = '3456789TJQKA2BR'
const ACE = 14

/**
 * The rules RLCard plays by, read off its data:
 * - `soloKickersMayPair: true`: solo kickers may be a pair (`33344455` is a plane with solo wings, `333355` a four with
 *   two solos).
 * - `soloKickersMayBeJokers: false`: no move but the rocket holds both jokers (no `2222BR`, no `333444BR`).
 * - `bareTrio: true`: it has the trio (`333`) and the trio straight (`333444`).
 * - `minPairStraight: 3`: its shortest pair straight is `334455`.
 * - `fourWithTwo: true`: it has `four_two_solo` and `four_two_pair`.
 */
const RLCARD_RULES: ClassifyRules = {
  bareTrio: true,
  minPairStraight: 3,
  soloKickersMayPair: true,
  soloKickersMayBeJokers: false,
  fourWithTwo: true,
}

/**
 * The kinds of difference we expect: the number of hands each covers under the school's default rules, an example,
 * and (in the comment) why we differ from RLCard. A hand falls in a kind when every reading of ours that RLCard does
 * not have is explained by it. Every other difference fails the test.
 */
const KNOWN_DIFFERENCES = {
  // Design 3.5.1 rule 6: `555666777888` is a trio straight and also a plane with solo wings (`666777888` with three
  // 5s, or `555666777` with three 8s). RLCard only has the trio straight.
  trio_straight_also_plane: { hands: 9, example: '555666777888' },
  // Design 3.5.1 rule 4 (and rule 6 for longer hands): the solo wings of a plane may be three or four cards of one
  // rank, even of the rank right next to the trios. RLCard takes trio wings away from the trios (`333444555777`) but
  // leaves out every plane whose cards hold a longer run of trios than the plane has, so `3334445556667778`
  // (`444555666777` with wings `333` and `8`) is no move for it at all.
  trio_wing_next_to_body: { hands: 516, example: '3334445556667778' },
  // Design 3.5.1 rules 2, 4 and 7: solo wings may share a rank (a pair, a trio), and a bomb may be split, so four
  // cards of one rank may be four of the solo wings: `333444555666` with `8888`. RLCard never carries a bomb as wings.
  bomb_wings: { hands: 515, example: '3334445556668888' },
  // Design 3.5.1 rule 3: under the school's rules the two jokers may be solo kickers (`5555` with both jokers). RLCard
  // never splits the rocket. Only under the school's default rules (`soloKickersMayBeJokers: true`).
  joker_wings: { hands: 1482, example: '5555BR' },
} as const

type Category = keyof typeof KNOWN_DIFFERENCES

interface Difference {
  readonly cards: string
  /** Types RLCard has and we do not. */
  readonly missing: readonly string[]
  /** Types we have and RLCard does not. */
  readonly extra: readonly MoveType[]
}

const toRanks = (cards: string): number[] => [...cards].map((c) => RLCARD_RANKS.indexOf(c) + MIN_RANK)
const cap = (rank: number): number => (rank >= BLACK_JOKER ? 1 : 4)

/** The cards string of a count per rank (`counts[rank - 3]`), low to high. */
const toCards = (counts: readonly number[]): string => counts.map((n, i) => RLCARD_RANKS[i]!.repeat(n)).join('')

/** Every set of cards of the shapes `classify` takes (see the top of this file), as cards strings. */
function candidates(): Set<string> {
  const found = new Set<string>()
  const counts = new Array<number>(15).fill(0)
  // Adds every way of putting `size` more cards on top of `counts`, from rank index `from` up.
  const extend = (size: number, from = 0): void => {
    if (size === 0) {
      found.add(toCards(counts))
      return
    }
    for (let i = from; i < 15; i++) {
      if (counts[i]! >= cap(i + MIN_RANK)) continue
      counts[i]!++
      extend(size - 1, i)
      counts[i]!--
    }
  }
  // Adds every way of putting `pairs` more pairs on top of `counts`, of ranks not in it yet, from `from` up. Two of
  // the pairs may be one rank (a bomb), so `33334444` and `3334445555` are built and both sides are asked about them.
  const extendPairs = (pairs: number, from = 0): void => {
    if (pairs === 0) {
      found.add(toCards(counts))
      return
    }
    for (let i = from; i < 13; i++) {
      if (counts[i] !== 0) continue
      counts[i] = 2
      extendPairs(pairs - 1, i + 1)
      if (pairs >= 2) {
        counts[i] = 4
        extendPairs(pairs - 2, i + 1)
      }
      counts[i] = 0
    }
  }
  for (let size = 1; size <= 5; size++) extend(size)
  for (let n = 1; n <= 3; n++) {
    for (let k = 2; k * n <= 20; k++) {
      // Chains may run on past the ace into the 2 and the jokers (as far as the deck has the cards), so that a
      // chain or plane we wrongly took there would show up as a difference.
      for (let low = 0; low + k <= 15; low++) {
        const ranksOfChain = Array.from({ length: k }, (_, i) => low + i)
        if (ranksOfChain.some((i) => n > cap(i + MIN_RANK))) continue
        for (const i of ranksOfChain) counts[i] = n
        found.add(toCards(counts))
        if (n === 3 && 4 * k <= 20) extend(k)
        if (n === 3 && 5 * k <= 20) extendPairs(k)
        counts.fill(0)
      }
    }
  }
  for (let i = 0; i < 13; i++) {
    counts[i] = 4
    extend(2)
    extendPairs(2)
    counts[i] = 0
  }
  return found
}

/**
 * Why RLCard does not have this reading of ours, or `null` if nothing in the table explains it. Readings that carry
 * both jokers come under `joker_wings` whatever else they carry: RLCard's rules turn all of them down.
 */
function explain(cards: string, reading: Interpretation, rules: ClassifyRules): Category | null {
  if (reading.type !== 'plane_solo' && reading.type !== 'four_two_solo') return null
  if (reading.type === 'plane_solo') {
    // The trios of a plane must run on, low to high, and stop at the ace; no kind of the table covers anything else.
    const trios = [...new Set(reading.body)]
    if (reading.main > ACE || trios.some((rank, i) => rank !== trios[0]! + i)) return null
  }
  const kickers = reading.kickers
  const bothJokers = kickers.includes(BLACK_JOKER) && kickers.includes(RED_JOKER)
  if (rules.soloKickersMayBeJokers && bothJokers) return 'joker_wings'
  if (reading.type !== 'plane_solo') return null
  const count = (rank: number): number => kickers.filter((k) => k === rank).length
  const next = [reading.body[0]! - 1, reading.main + 1].filter((rank) => rank >= MIN_RANK && rank <= ACE)
  if (next.some((rank) => count(rank) >= 3)) {
    return cards.length === 12 && classify(toRanks(cards), rules).some((r) => r.type === 'trio_straight')
      ? 'trio_straight_also_plane'
      : 'trio_wing_next_to_body'
  }
  if (kickers.some((rank) => count(rank) === 4)) return 'bomb_wings'
  return null
}

/** The kind of a difference: `joker_wings` if every reading is explained by it, else the first other kind found. */
function kindOf(cards: string, readings: readonly Interpretation[], rules: ClassifyRules): Category | null {
  const kinds = readings.map((reading) => explain(cards, reading, rules))
  if (kinds.includes(null)) return null
  const others = kinds.filter((kind) => kind !== 'joker_wings')
  return others.length === 0 ? 'joker_wings' : others[0]!
}

interface Comparison {
  readonly byCategory: ReadonlyMap<Category, readonly Difference[]>
  /** The differences nothing in the table explains. */
  readonly unexplained: readonly Difference[]
}

/** Every hand of `space` where our types and RLCard's differ, by category. */
function compare(
  space: Iterable<string>,
  rlcard: ReadonlyMap<string, readonly string[]>,
  rules: ClassifyRules,
): Comparison {
  const byCategory = new Map<Category, Difference[]>()
  const unexplained: Difference[] = []
  for (const cards of space) {
    const readings = classify(toRanks(cards), rules)
    const ours = new Set(readings.map((r) => r.type))
    const theirs = new Set(rlcard.get(cards) ?? [])
    const missing = [...theirs].filter((type) => !ours.has(type as MoveType))
    const extra = [...ours].filter((type) => !theirs.has(type))
    if (missing.length === 0 && extra.length === 0) continue
    const difference = { cards, missing, extra }
    // Every reading of an extra type must be explained.
    const category = kindOf(cards, readings.filter((r) => extra.includes(r.type)), rules)
    if (missing.length > 0 || category === null) {
      unexplained.push(difference)
      continue
    }
    if (!byCategory.has(category)) byCategory.set(category, [])
    byCategory.get(category)!.push(difference)
  }
  return { byCategory, unexplained }
}

const counts = (comparison: Comparison): Record<string, number> =>
  Object.fromEntries([...comparison.byCategory].map(([category, list]) => [category, list.length]))
const handsOf = (comparison: Comparison, category: Category): string[] =>
  (comparison.byCategory.get(category) ?? []).map((d) => d.cards)

/** A move of the fixture as RLCard reads it: our type, RLCard's name (with the chain length) and its strength. */
interface RlcardReading {
  readonly cards: string
  readonly type: MoveType
  readonly name: string
  readonly strength: number
}

let rlcard: Map<string, readonly string[]>
let rlcardReadings: RlcardReading[]
let space: string[]
let underRlcard: Comparison
let underSchool: Comparison

beforeAll(() => {
  const rows = JSON.parse(gunzipSync(readFileSync(FIXTURE)).toString('utf8')) as [
    string,
    [MoveType, string, number][],
  ][]
  rlcard = new Map(rows.map(([cards, readings]) => [cards, [...new Set(readings.map(([type]) => type))]]))
  rlcardReadings = rows.flatMap(([cards, readings]) =>
    readings.map(([type, name, strength]) => ({ cards, type, name, strength })),
  )
  space = [...new Set([...rlcard.keys(), ...candidates()])]
  underRlcard = compare(space, rlcard, RLCARD_RULES)
  underSchool = compare(space, rlcard, DEFAULT_DOUDIZHU_RULES)
})

describe('classify against RLCard', () => {
  test('the fixture is all of RLCard', () => {
    expect(rlcard.size).toBe(27471)
    expect(rlcard.get('555666777888')).toEqual(['trio_straight'])
    expect(rlcard.get('BR')).toEqual(['rocket'])
    // What the rules of RLCARD_RULES and KNOWN_DIFFERENCES are read from.
    expect(rlcard.get('33344455')).toEqual(['plane_solo'])
    expect(rlcard.get('333355')).toEqual(['four_two_solo'])
    expect(rlcard.get('333444555777')).toEqual(['plane_solo'])
    expect([...rlcard.keys()].filter((cards) => cards.includes('BR'))).toEqual(['BR'])
    expect(rlcard.has('334455')).toBe(true)
    expect(rlcard.has('3344')).toBe(false)
    // The built sets reach past RLCard: the moves only we take are compared too.
    expect(space.length).toBeGreaterThan(rlcard.size)
  })

  test('under the rules of RLCard, differs only in the known ways', () => {
    expect(underRlcard.unexplained.slice(0, 20)).toEqual([])
    const { joker_wings: _, ...others } = KNOWN_DIFFERENCES
    expect(counts(underRlcard)).toEqual(
      Object.fromEntries(Object.entries(others).map(([category, { hands }]) => [category, hands])),
    )
    for (const [category, list] of underRlcard.byCategory) {
      expect(list.map((d) => d.cards)).toContain(KNOWN_DIFFERENCES[category].example)
      // Always moves RLCard does not take, never ones it reads otherwise or ones we do not take.
      expect(list.every((d) => d.missing.length === 0 && d.extra.join() === 'plane_solo')).toBe(true)
    }
  })

  test('under the school rules, differs from RLCard also where we let the jokers be solo kickers', () => {
    // The school rules differ from RLCard's only in `soloKickersMayBeJokers`.
    const { bareTrio, minPairStraight, soloKickersMayPair, soloKickersMayBeJokers, fourWithTwo } =
      DEFAULT_DOUDIZHU_RULES
    expect({ bareTrio, minPairStraight, soloKickersMayPair, soloKickersMayBeJokers, fourWithTwo }).toEqual({
      ...RLCARD_RULES,
      soloKickersMayBeJokers: true,
    })
    expect(underSchool.unexplained.slice(0, 20)).toEqual([])
    expect(counts(underSchool)).toEqual(
      Object.fromEntries(Object.entries(KNOWN_DIFFERENCES).map(([category, { hands }]) => [category, hands])),
    )
    // The other kinds are the very same hands as under RLCard's rules.
    for (const category of ['trio_straight_also_plane', 'trio_wing_next_to_body', 'bomb_wings'] as const) {
      expect(handsOf(underSchool, category)).toEqual(handsOf(underRlcard, category))
    }
    const jokers = underSchool.byCategory.get('joker_wings')!
    expect(handsOf(underSchool, 'joker_wings')).toContain(KNOWN_DIFFERENCES.joker_wings.example)
    expect(jokers.every((d) => d.cards.endsWith('BR') && d.missing.length === 0 && !rlcard.has(d.cards))).toBe(true)
    expect(new Set(jokers.flatMap((d) => d.extra))).toEqual(new Set(['plane_solo', 'four_two_solo']))
  })

  test('orders the moves of each RLCard type as RLCard does', () => {
    // Within one RLCard type (`trio_solo_chain_3` and so on: one of our types at one length), RLCard numbers the
    // moves by strength, not always from 0. Our main rank must give the same order: the same strength the same main,
    // a higher strength a higher main. Where we have more than one reading of the type, the first (strongest) counts.
    const byName = new Map<string, RlcardReading[]>()
    for (const reading of rlcardReadings) {
      if (!byName.has(reading.name)) byName.set(reading.name, [])
      byName.get(reading.name)!.push(reading)
    }
    expect(byName.size).toBe(37)
    const wrong: string[] = []
    for (const [name, readings] of byName) {
      const mainOf = new Map<number, number>()
      for (const { cards, type, strength } of readings) {
        const main = classify(toRanks(cards), RLCARD_RULES).find((r) => r.type === type)!.main
        if ((mainOf.get(strength) ?? main) !== main) wrong.push(`${name} ${strength}: ${cards}`)
        mainOf.set(strength, main)
      }
      const ordered = [...mainOf].sort(([a], [b]) => a - b).map(([, main]) => main)
      if (ordered.some((main, i) => i > 0 && main <= ordered[i - 1]!)) wrong.push(`${name}: mains ${ordered.join(' ')}`)
    }
    expect(wrong.slice(0, 20)).toEqual([])
  })
})
