import { describe, expect, test } from 'vitest'
import { FULL_DECK, toRank } from '../../../src/club/doudizhu/cards.js'
import { classify, type MoveType } from '../../../src/club/doudizhu/classify.js'
import { shuffle } from '../../../src/club/doudizhu/deal.js'
import { bid, type GameEvent, type GameState, newGame } from '../../../src/club/doudizhu/game.js'
import { legalMoves } from '../../../src/club/doudizhu/moves.js'
import { DEFAULT_DOUDIZHU_RULES } from '../../../src/club/doudizhu/rules.js'
import { actFor, type TrusteeStep, trusteeAction } from '../../../src/club/doudizhu/trustee.js'
import { hand, ranks, seededRandomInt } from './helpers.js'

const rules = DEFAULT_DOUDIZHU_RULES

const deckFrom = (seed: number) => shuffle(FULL_DECK, seededRandomInt(seed))

/**
 * A position in play: the hands by seat, the landlord, the seat to act, and the move to beat with the seat that played
 * it (none when the seat leads).
 */
function position(
  hands: [string, string, string],
  landlord: number,
  toAct: number,
  last: { seat: number; cards: string; type?: MoveType } | null = null,
  r = rules,
): GameState {
  const base = newGame({ rules: r, firstBidder: 0, decks: [deckFrom(1)] }).state
  const readings = last === null ? [] : classify(ranks(last.cards), r)
  const move = last === null ? null : readings.find((m) => last.type === undefined || m.type === last.type)!
  return {
    ...base,
    phase: 'playing',
    hands: [hand(hands[0]), hand(hands[1]), hand(hands[2])],
    landlord,
    base: 1,
    toAct,
    trick: { leader: last?.seat ?? toAct, last: last === null ? null : { seat: last.seat, move: move! }, passes: 0 },
  }
}

/** A step as text: `bid 0`, `pass`, or the move type and cards. */
function text(step: TrusteeStep): string {
  if ('bid' in step) return `bid ${step.bid}`
  if ('pass' in step) return 'pass'
  return `${step.play.type} ${step.play.cards.map(toRank).join(' ')}`
}

const leadOf = (cards: string, r = rules) => text(trusteeAction(position([cards, '3', '3'], 0, 0, null, r), 0))

describe('trusteeAction', () => {
  test('never bids', () => {
    const state = newGame({ rules, firstBidder: 1, decks: [deckFrom(2)] }).state
    expect(trusteeAction(state, 1)).toEqual({ bid: 0 })
    const after = bid(state, 1, 2)
    if (!after.ok) throw new Error('refused')
    expect(trusteeAction(after.state, 2)).toEqual({ bid: 0 })
  })

  describe('leading', () => {
    test('plays the whole hand when it is one move, as its first reading', () => {
      expect(leadOf('3 3 3 4')).toBe('trio_solo 3 3 3 4')
      expect(leadOf('5 5 5 6 6 6 7 7 7 8 8 8')).toBe('trio_straight 5 5 5 6 6 6 7 7 7 8 8 8')
      expect(leadOf('3 4 5 6 7 8')).toBe('straight 3 4 5 6 7 8')
      expect(leadOf('9 9 9 9 3 J')).toBe('four_two_solo 3 9 9 9 9 J')
      expect(leadOf('7 7 7 7')).toBe('bomb 7 7 7 7')
      expect(leadOf('2')).toBe('single 2')
    })

    test('plays the rocket when that is all it has left', () => {
      expect(leadOf('小王 大王')).toBe('rocket 小王 大王')
    })

    test('plays one lowest card as a single and two as a pair', () => {
      expect(leadOf('3 5 9')).toBe('single 3')
      expect(leadOf('4 4 5 9')).toBe('pair 4 4')
      expect(leadOf('5 5 5 5 6 6 6 6')).toBe('single 5')
    })

    test('plays three lowest cards as a trio when bareTrio is on', () => {
      expect(leadOf('3 3 3 5 9')).toBe('trio 3 3 3')
    })

    test('with bareTrio off, carries the lowest other card, or plays a single when there is none', () => {
      const off = { ...rules, bareTrio: false }
      expect(leadOf('3 3 3 5 9', off)).toBe('trio_solo 3 3 3 5')
      expect(leadOf('3 3 3 9 9 J', off)).toBe('trio_solo 3 3 3 9')
      expect(leadOf('4 4 4', off)).toBe('single 4')
    })

    test('plays one of four lowest cards as a single, never the bomb', () => {
      expect(leadOf('3 3 3 3 5 9 J')).toBe('single 3')
    })
  })

  describe('following', () => {
    const hands: [string, string, string] = ['3 4 5 6 7 8 9 10 J Q K A 2 小王 大王', '5 9 K', '6 10 A']

    test('does not beat its partner', () => {
      expect(text(trusteeAction(position(hands, 0, 2, { seat: 1, cards: '5' }), 2))).toBe('pass')
      expect(text(trusteeAction(position(hands, 1, 0, { seat: 2, cards: '6' }), 0))).toBe('pass')
    })

    test('beats the landlord with the lowest move that beats', () => {
      expect(text(trusteeAction(position(hands, 0, 1, { seat: 0, cards: '6' }), 1))).toBe('single 9')
      expect(text(trusteeAction(position(hands, 0, 2, { seat: 0, cards: '6' }), 2))).toBe('single 10')
    })

    test('as the landlord, beats either farmer', () => {
      expect(text(trusteeAction(position(hands, 0, 0, { seat: 2, cards: '10' }), 0))).toBe('single J')
      expect(text(trusteeAction(position(hands, 0, 0, { seat: 1, cards: '2' }), 0))).toBe('single 小王')
    })

    test('takes the lowest main rank, then the lowest kickers', () => {
      const h: [string, string, string] = ['3 4 4 4 9', '5 5 5 7 7 7 6 8 J', '3']
      expect(text(trusteeAction(position(h, 0, 1, { seat: 0, cards: '4 4 4 9' }), 1))).toBe('trio_solo 5 5 5 6')
      const pairs: [string, string, string] = ['3 3 4 4 5 5', '6 6 7 7 8 8 9 9 10 10 Q Q', '3']
      expect(text(trusteeAction(position(pairs, 0, 1, { seat: 0, cards: '3 3 4 4 5 5' }), 1))).toBe(
        'pair_straight 6 6 7 7 8 8',
      )
    })

    test('keeps to the same number of cards', () => {
      const h: [string, string, string] = ['3', '4 5 6 7 8 9 10', '3']
      expect(text(trusteeAction(position(h, 0, 1, { seat: 0, cards: '3 4 5 6 7' }), 1))).toBe('straight 4 5 6 7 8')
    })

    test('never uses a bomb or the rocket, so passes when only they beat', () => {
      const h: [string, string, string] = ['3', '5 5 5 5 小王 大王 3', '3']
      expect(text(trusteeAction(position(h, 0, 1, { seat: 0, cards: 'K K' }), 1))).toBe('pass')
      expect(text(trusteeAction(position(h, 0, 1, { seat: 0, cards: '4 4 4 4' }), 1))).toBe('pass')
      expect(text(trusteeAction(position(h, 0, 1, { seat: 0, cards: '2' }), 1))).toBe('single 小王')
    })

    test('passes when nothing beats', () => {
      const h: [string, string, string] = ['3', '4 5 6', '3']
      expect(text(trusteeAction(position(h, 0, 1, { seat: 0, cards: 'A' }), 1))).toBe('pass')
      expect(text(trusteeAction(position(h, 0, 1, { seat: 0, cards: '3 3' }), 1))).toBe('pass')
    })
  })

  test('makes the same step in the same position, every time', () => {
    const hands: [string, string, string] = ['3 3 4 4 5 5 6 6 7 7 8 8 9 9', '5 5 5 7 7 7 6 8 J', '3']
    const state = position(hands, 0, 1, { seat: 0, cards: '3 3' })
    const first = trusteeAction(state, 1)
    for (let i = 0; i < 5; i++) expect(trusteeAction(structuredClone(state), 1)).toEqual(first)
  })

  test('throws when the seat is not to act', () => {
    const state = newGame({ rules, firstBidder: 1, decks: [deckFrom(3)] }).state
    expect(() => trusteeAction(state, 0)).toThrow()
  })
})

/** Plays a game to the end with the trustee for every seat, from `state`, checking each step against the list. */
function trusteeGame(state: GameState): { state: GameState; events: GameEvent[] } {
  const events: GameEvent[] = []
  for (let steps = 0; state.phase !== 'over'; steps++) {
    if (steps > 200) throw new Error('the game does not end')
    const seat = state.toAct!
    const step = trusteeAction(state, seat)
    if ('play' in step) {
      const last = state.trick!.last
      const listed = legalMoves(state.hands[seat]!, last?.move ?? null, state.rules, Infinity).moves
      const same = listed.filter((m) => m.type === step.play.type && m.cards.join() === step.play.cards.join())
      expect(same, text(step)).toHaveLength(1)
      expect(same[0]).toEqual(step.play)
    }
    const result = actFor(state, 'trustee')
    state = result.state
    events.push(...result.events)
  }
  return { state, events }
}

describe('actFor', () => {
  test('makes the trustee step and marks it with auto', () => {
    const state = newGame({ rules, firstBidder: 2, decks: [deckFrom(4)] }).state
    const { state: after, events } = actFor(state, 'timeout')
    expect(events).toEqual([{ kind: 'bid', turn: 1, seat: 2, bid: 0, auto: 'timeout' }])
    expect(after.history).toEqual([{ turn: 1, seat: 2, action: 'bid', bid: 0, auto: 'timeout' }])
  })

  test('throws once the game is over', () => {
    const { state } = trusteeGame(newGame({ rules, firstBidder: 0, random: seededRandomInt(9) }).state)
    expect(() => actFor(state, 'bot')).toThrow()
  })

  test('three trustees never bid, so the game ends with no landlord after bidRedealLimit deals', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const start = newGame({ rules, firstBidder: seed % 3, random: seededRandomInt(seed) }).state
      const { state, events } = trusteeGame(start)
      expect(state.outcome!.outcome).toBe('no_landlord')
      expect(events.filter((e) => e.kind === 'bid')).toHaveLength(3 * rules.bidRedealLimit)
      expect(events.filter((e) => e.kind === 'redeal').map((e) => (e.kind === 'redeal' ? e.count : 0))).toEqual([1, 2])
      expect(state.turn).toBe(3 * rules.bidRedealLimit + 1)
    }
  })

  test('once a seat has bid, three trustees play the game to the end, with legal moves only', () => {
    let farmersWon = 0
    for (let seed = 1; seed <= 100; seed++) {
      const start = newGame({ rules, firstBidder: seed % 3, random: seededRandomInt(seed) }).state
      const bidden = bid(start, start.toAct!, 3)
      if (!bidden.ok) throw new Error('refused')
      const { state, events } = trusteeGame(bidden.state)
      expect(state.phase).toBe('over')
      expect(state.outcome!.scores.reduce((a, b) => a + b, 0)).toBe(0)
      expect(events.every((e) => !('auto' in e) || e.auto === 'trustee')).toBe(true)
      if (state.outcome!.outcome === 'farmers_won') farmersWon++
    }
    expect(farmersWon).toBeGreaterThan(0)
  })

  test('the same game played twice by the trustees goes the same way', () => {
    const play = () => {
      const start = newGame({ rules, firstBidder: 1, random: seededRandomInt(77) }).state
      const bidden = bid(start, 1, 3)
      if (!bidden.ok) throw new Error('refused')
      return trusteeGame(bidden.state).events
    }
    expect(play()).toEqual(play())
  })
})
