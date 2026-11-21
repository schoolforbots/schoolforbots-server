import { Compile, type Validator } from 'typebox/compile'
import { describe, expect, test } from 'vitest'
import { DoudizhuEvent, YourTurnMessage } from '../../../src/protocol/club.js'
import { type Card, type RankName, rankValue, ranksOf, toRank } from '../../../src/club/doudizhu/cards.js'
import type { RandomInt } from '../../../src/club/doudizhu/deal.js'
import { currentMoves } from '../../../src/club/doudizhu/game.js'
import {
  actFor,
  type Auto,
  bid,
  DEFAULT_DOUDIZHU_RULES,
  type GameEvent,
  type GameState,
  handOf,
  newGame,
  pass,
  play,
  publicTable,
  type RecordedStep,
  replay,
  type Rules,
  type StepResult,
  turnView,
  type TurnView,
} from '../../../src/club/doudizhu/index.js'
import type { Interpretation } from '../../../src/club/doudizhu/classify.js'
import { type LegalMoves, legalMoves } from '../../../src/club/doudizhu/moves.js'
import { deckOf, seededRandomInt } from './helpers.js'

// Whole games played to the end, by the trustee and by random players, with every step and every ending checked:
// the cards are all there, every move played was a legal one, `turn` counts up, the right seat acts, no view shows
// a card it should not, the scores add up and follow from the doublings, and the record replays to the same game.

const GAME_ID = 7
/** Games in each of the two random runs. */
const GAMES = 600
/** Time allowed for each random run, well above what it takes, for a slow machine running every test at once. */
const RUN_TIMEOUT = 120_000
const STUDENT = (seat: number) => ({ studentId: 50 + seat, displayName: `学生 #00${50 + seat}`, bot: false as const })
const AUTOS: readonly Exclude<Auto, null>[] = ['timeout', 'trustee', 'bot', 'closing']

const next = (seat: number) => (seat + 1) % 3
const cardKey = (card: Card) => `${card.rank}${card.suit ?? ''}`
const sorted = (cards: readonly RankName[]) => [...cards].sort((a, b) => rankValue(a) - rankValue(b))

/** `cards` without one card of each rank in `taken`. */
function without(cards: readonly RankName[], taken: readonly RankName[]): RankName[] {
  const rest = [...cards]
  for (const rank of taken) {
    const i = rest.indexOf(rank)
    if (i < 0) throw new Error(`no ${rank} to take`)
    rest.splice(i, 1)
  }
  return rest
}

const yourTurnValidator = Compile(YourTurnMessage)
const eventValidator = Compile(DoudizhuEvent)

/** Expects `value` to be valid by a compiled validator, showing the first few errors when not. */
function expectValid(validator: Validator, value: unknown): void {
  if (!validator.Check(value)) {
    expect(validator.Errors(value).slice(0, 5).map((e) => `${e.instancePath} ${e.message}`)).toEqual([])
  }
}

/** A `your_turn` as the club layer sends it: the engine's view with the time, the people and the game number. */
const asYourTurn = (view: TurnView) => ({
  type: 'your_turn',
  roomId: 'r7k2q',
  game: 'doudizhu',
  gameId: GAME_ID,
  deadline: '2026-11-20T08:01:17.000Z',
  timeBankSeconds: 60,
  closesAt: '2026-11-20T10:45:00.000Z',
  ...view,
  left: { ...view.left, player: STUDENT(view.left.seat) },
  right: { ...view.right, player: STUDENT(view.right.seat) },
  table: { ...view.table, gameId: GAME_ID, deadline: '2026-11-20T08:01:17.000Z' },
})

/** An event as the club layer sends it: the game number, the seats of `dealt`, and `ranked` in `over`. */
function asProtocolEvent(event: GameEvent): unknown {
  if (event.kind === 'dealt') return { ...event, gameId: GAME_ID, seats: [STUDENT(0), STUDENT(1), STUDENT(2)] }
  if (event.kind === 'over') return { kind: 'over', result: { gameId: GAME_ID, ...event.result, ranked: true } }
  return event
}

/** Keys of the engine's own state that must never reach a view or an event. */
const PRIVATE_KEYS = /"(suit|hands|decks|spareDecks|body|kickers|main|movesBy)"/

// ---- The players ------------------------------------------------------------------------------------------------

/** A player: makes one step for the seat to act. Whatever it tries on the way must leave the state as it was. */
type Player = (state: GameState, random: RandomInt) => StepResult

/** Every seat in trusteeship. */
const trustee: Player = (state, random) => actFor(state, AUTOS[random(AUTOS.length)]!)

/** The trustee once the bidding is over; a random bid before (the trustee never bids, so its games never start). */
const trusteeAfterBids: Player = (state, random) =>
  state.phase === 'bidding' ? randomBid(state, random) : trustee(state, random)

/** Expects `attempt` to be refused with `problem` and to leave `state` untouched. */
function expectRefused(state: GameState, attempt: () => StepResult, problem: string): void {
  const before = JSON.stringify(state)
  const result = attempt()
  expect(result.ok ? 'accepted' : result.error.problem).toBe(problem)
  expect(JSON.stringify(state)).toBe(before)
}

/** A random bid among those allowed, mostly 0 so that redeals happen too; now and then a bid too low first. */
function randomBid(state: GameState, random: RandomInt): StepResult {
  const seat = state.toAct!
  const highest = Math.max(0, ...state.bids.map((b) => b.bid))
  if (highest > 0 && random(10) === 0) expectRefused(state, () => bid(state, seat, highest), 'bid_too_low')
  const allowed = [0, ...[1, 2, 3].filter((b) => b > highest)]
  return bid(state, seat, random(2) === 0 ? allowed[random(allowed.length)]! : 0)
}

/** A rank the seat holds none of, or `null` when it holds every rank. */
function rankNotHeld(state: GameState, seat: number): RankName | null {
  const held = new Set(state.hands[seat]!.map((card) => card.rank))
  for (let rank = 3; rank <= 17; rank++) if (!held.has(rank)) return toRank(rank)
  return null
}

/**
 * A random player: random bids, a pass now and then, and a random listed move sent one of three ways: by `moveId`, as
 * the cards with `as`, or as the cards alone (and with `as` when the cards alone are read as another move that does not
 * beat). Now and then it first tries something illegal: a pass on the lead, an unknown `moveId`, or a card it lacks.
 */
const randomPlayer: Player = (state, random) => {
  if (state.phase === 'bidding') return randomBid(state, random)
  const seat = state.toAct!
  const leads = state.trick!.last === null
  const moves = currentMoves(state).moves

  if (random(20) === 0) {
    if (leads) expectRefused(state, () => pass(state, seat), 'must_play')
    expectRefused(state, () => play(state, seat, { moveId: moves.length + 1 }), 'unknown_move')
    const missing = rankNotHeld(state, seat)
    if (missing !== null) expectRefused(state, () => play(state, seat, { cards: [missing] }), 'not_in_hand')
  }

  if (!leads && (moves.length === 0 || random(4) === 0)) return pass(state, seat)
  const i = random(moves.length)
  const move = moves[i]!
  const cards = move.cards.map(toRank)
  const how = random(3)
  if (how === 0) return play(state, seat, { moveId: i + 1 })
  if (how === 1) return play(state, seat, { cards, as: move.type })
  const alone = play(state, seat, { cards })
  if (alone.ok) return alone
  // The first reading of the cards may not beat; nothing else may stop a listed move.
  expect(alone.error.problem).toBe('cannot_beat')
  return play(state, seat, { cards, as: move.type })
}

// ---- The checks -------------------------------------------------------------------------------------------------

/**
 * `expect(actual).toEqual(expected)`, cheap when they agree. The checks run on every step of thousands of games, and
 * only a mismatch needs the matcher and its diff.
 */
function expectSame(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) expect(actual).toEqual(expected)
}

/** What the checks keep track of in a deal: the cards played so far. */
interface Deal {
  played: Card[]
}

// Each check gathers what it looks at into one object and compares it whole: a failure shows every field that is off.

/** The 54 cards of the deal, each once: in the hands, the bottom (until the landlord takes it) and played. */
function expectAllCards(state: GameState, deal: Deal): void {
  const cards = [...state.hands.flat(), ...(state.landlord === null ? state.bottom : []), ...deal.played]
  expectSame(cards.map(cardKey).sort().join(), state.decks.at(-1)!.map(cardKey).sort().join())
}

/** What each seat sees: the table, its own hand, and for the seat to act its turn, holding nothing it should not. */
function expectViews(state: GameState, deal: Deal): void {
  const seat = state.toAct!
  const table = publicTable(state)
  const view = turnView(state, seat)
  expectValid(yourTurnValidator, asYourTurn(view))
  const role = (s: number) => (state.landlord === null ? null : state.landlord === s ? 'landlord' : 'farmer')
  const neighbour = (s: number) => ({ seat: s, role: role(s), cardsLeft: state.hands[s]!.length })
  // Unseen: the deck less the seat's own hand and the cards played.
  const unseen = without(without(ranksOf(state.decks.at(-1)!), ranksOf(state.hands[seat]!)), ranksOf(deal.played))
  expectSame({
    bottom: table.bottom,
    cardsLeft: table.cardsLeft,
    hands: [0, 1, 2].map((s) => handOf(state, s)),
    tableInView: JSON.stringify(view.table) === JSON.stringify(table),
    privateKeys: PRIVATE_KEYS.test(JSON.stringify(view)),
    me: view.me.hand,
    left: view.left,
    right: view.right,
    unseen: view.unseen,
  }, {
    bottom: state.landlord === null ? null : ranksOf(state.bottom),
    cardsLeft: state.hands.map((h) => h.length),
    hands: state.hands.map(ranksOf),
    tableInView: true,
    privateKeys: false,
    me: ranksOf(state.hands[seat]!),
    left: neighbour((seat + 2) % 3),
    right: neighbour(next(seat)),
    unseen: sorted(unseen),
  })
}

/** The events of a step: valid in the protocol, and the cards in them only where they are public. */
function expectEvents(events: readonly GameEvent[]): void {
  for (const event of events) {
    expectValid(eventValidator, asProtocolEvent(event))
    if (event.kind === 'over') continue
    const text = JSON.stringify(event)
    const showsCards = event.kind === 'play' || event.kind === 'landlord'
    if (PRIVATE_KEYS.test(text) || (!showsCards && /"(cards|bottom|hand)"/.test(text))) {
      expect(text).toBe('an event without private keys or cards')
    }
  }
}

const sameMove = (a: Interpretation, b: Interpretation) =>
  a.type === b.type && a.main === b.main && a.cards.join() === b.cards.join() && a.kickers.join() === b.kickers.join()

/**
 * One accepted step from `before` to `after`: its `turn`, the seat that made it, the move played (one of the legal
 * moves of the hand, untrimmed, and the very cards that left the hand) and who acts next. `listed` is the list of moves
 * of the turn, while playing.
 */
function expectStep(
  before: GameState,
  after: GameState,
  events: readonly GameEvent[],
  deal: Deal,
  listed: LegalMoves | null,
): void {
  const seat = before.toAct!
  const step = events.find((e) => e.kind === 'bid' || e.kind === 'play' || e.kind === 'pass')!
  const redeal = events.find((e) => e.kind === 'redeal')
  const landlord = events.find((e) => e.kind === 'landlord')
  // A redeal starts the history of the new deal afresh.
  const kept = redeal === undefined ? after.history.at(-1)! : { turn: before.turn, seat, action: step.kind }
  expectSame({ turn: step.turn, seat: step.seat, next: after.turn, kept: [kept.turn, kept.seat, kept.action] }, {
    turn: before.turn,
    seat,
    next: before.turn + 1,
    kept: [before.turn, seat, step.kind],
  })

  if (step.kind === 'play') {
    // The list of the turn, or when it was trimmed, the whole list.
    const toBeat = before.trick!.last?.move ?? null
    const legal = listed!.trimmed
      ? legalMoves(before.hands[seat]!, toBeat, before.rules, Infinity).moves
      : listed!.moves
    const left = new Set(after.hands[seat]!.map(cardKey))
    const taken = before.hands[seat]!.filter((card) => !left.has(cardKey(card)))
    deal.played.push(...taken)
    const going = after.phase !== 'over'
    const multiplier = 2 ** after.doublings.length
    expectSame({
      // In the untrimmed list: while the game goes on, the very reading played; once it is over the trick is gone,
      // and the type and cards of the event are what is left to look up.
      legal: going
        ? legal.some((m) => sameMove(m, after.trick!.last!.move))
        : legal.some((m) => m.type === step.move.type && m.cards.map(toRank).join() === step.move.cards.join()),
      taken: ranksOf(taken),
      cardsLeft: after.hands[seat]!.length,
      multiplier: going ? [step.multiplier, publicTable(after).multiplier] : null,
    }, {
      legal: true,
      taken: step.move.cards,
      cardsLeft: before.hands[seat]!.length - taken.length,
      multiplier: going ? [multiplier, multiplier] : null,
    })
  }

  if (after.phase === 'over') {
    expectSame(after.toAct, null)
  } else if (redeal !== undefined) {
    deal.played = []
    expectSame({
      count: redeal.count,
      belowLimit: redeal.count < after.rules.bidRedealLimit,
      firstBidder: after.firstBidder,
      toAct: after.toAct,
      bids: after.bids,
      history: after.history,
    }, {
      count: after.decks.length - 1,
      belowLimit: true,
      firstBidder: next(before.firstBidder),
      toAct: next(before.firstBidder),
      bids: [],
      history: [],
    })
  } else if (landlord !== undefined) {
    const highest = after.bids.reduce((best, b) => (b.bid > best.bid ? b : best))
    expectSame({
      biddingOver: step.kind === 'bid' && (step.bid === 3 || after.bids.length === 3),
      landlord: [landlord.seat, landlord.base],
      toAct: after.toAct,
      cards: after.hands[landlord.seat]!.length,
    }, { biddingOver: true, landlord: [highest.seat, highest.bid], toAct: highest.seat, cards: 20 })
  } else if (step.kind === 'pass' && before.trick!.passes === 1) {
    // Two passes in a row: the seat that played last leads a new trick.
    const last = before.trick!.last!.seat
    expectSame({ toAct: after.toAct, trick: after.trick }, {
      toAct: last,
      trick: { leader: last, last: null, passes: 0 },
    })
  } else {
    expectSame(after.toAct, next(seat))
  }
}

/** The end of a game: the doublings follow from the history, the multiplier and its cap, the scores adding up to 0. */
function expectEnding(state: GameState): void {
  const result = state.outcome!
  expectSame(result.scores.reduce((a, b) => a + b, 0), 0)
  expectSame(result.hands, state.hands.map(ranksOf))
  if (result.outcome === 'no_landlord') {
    expectSame(result.scores, [0, 0, 0])
    expectSame(state.decks.length, state.rules.bidRedealLimit)
    return
  }
  const landlord = state.landlord!
  const landlordWon = result.outcome === 'landlord_won'
  const winner = state.hands.findIndex((h) => h.length === 0)
  expectSame(winner === landlord, landlordWon)

  const plays = state.history.flatMap((h) => (h.action === 'play' ? [h] : []))
  const playsBy = [0, 1, 2].map((seat) => plays.filter((h) => h.seat === seat).length)
  const farmers = [0, 1, 2].filter((seat) => seat !== landlord)
  const spring =
    landlordWon && farmers.every((s) => playsBy[s] === 0)
      ? 'spring'
      : !landlordWon && playsBy[landlord] === 1
        ? 'anti_spring'
        : null
  const doublings = [
    ...plays
      .filter((h) => h.move.type === 'bomb' || h.move.type === 'rocket')
      .map((h) => ({ kind: h.move.type, seat: h.seat })),
    ...(spring !== null && state.rules.springDoubles ? [{ kind: spring, seat: null }] : []),
  ]
  expectSame(result.doublings, doublings)
  const raw = 2 ** doublings.length
  expectSame(result.multiplier, Math.min(raw, state.rules.cap))
  expectSame(result.capped, raw > state.rules.cap)
  const score = result.base! * result.multiplier
  const sign = landlordWon ? 1 : -1
  expectSame(result.scores, [0, 1, 2].map((seat) => sign * (seat === landlord ? 2 * score : -score)))
}

/** The steps of a game as its record keeps them, with their `turn`, from its events. */
function recordOf(events: readonly GameEvent[]): RecordedStep[] {
  return events.flatMap((e): RecordedStep[] => {
    if (e.kind === 'bid') return [{ turn: e.turn, seat: e.seat, action: 'bid', bid: e.bid, auto: e.auto }]
    if (e.kind === 'play') return [{ turn: e.turn, seat: e.seat, action: 'play', move: e.move, auto: e.auto }]
    if (e.kind === 'pass') return [{ turn: e.turn, seat: e.seat, action: 'pass', auto: e.auto }]
    return []
  })
}

/** A state without the decks shuffled ahead and never dealt: those are not part of the record. */
const recorded = ({ spareDecks: _, ...rest }: GameState) => rest

// ---- Playing a game ---------------------------------------------------------------------------------------------

interface GameSetup {
  readonly rules: Rules
  readonly firstBidder: number
  readonly random: RandomInt
  /** The decks to deal; shuffled with `random` when absent. */
  readonly decks?: readonly (readonly Card[])[]
}

/** What a game did, for the counts the tests check that every case was met. */
interface Played {
  state: GameState
  events: GameEvent[]
  trimmedTurns: number
}

/** Plays a game to the end with `player` at every seat, checking every step, the ending, and the replay. */
function playGame(setup: GameSetup, player: Player): Played {
  const start = newGame(setup)
  expectEvents(start.events)
  let state = start.state
  const events = [...start.events]
  const deal: Deal = { played: [] }
  let trimmedTurns = 0
  while (state.phase !== 'over') {
    if (state.turn >= 500) throw new Error('the game does not end')
    expectAllCards(state, deal)
    expectViews(state, deal)
    const listed = state.phase === 'playing' ? currentMoves(state) : null
    if (listed?.trimmed === true) trimmedTurns++
    const result = player(state, setup.random)
    if (!result.ok) throw new Error(`a legal step was refused: ${result.error.reason}`)
    expectEvents(result.events)
    expectStep(state, result.state, result.events, deal, listed)
    state = result.state
    events.push(...result.events)
  }
  expectAllCards(state, deal)
  expectSame(events.at(-1), { kind: 'over', result: state.outcome })
  expectEnding(state)

  const again = replay(state.rules, start.state.firstBidder, state.decks, recordOf(events))
  expectSame(recorded(again.state), recorded(state))
  expectSame(again.events, events)
  return { state, events, trimmedTurns }
}

/** The default rules, or for some games the switches set at random. */
function rulesFor(random: RandomInt): Rules {
  if (random(2) === 0) return DEFAULT_DOUDIZHU_RULES
  const flip = () => random(2) === 0
  return {
    ...DEFAULT_DOUDIZHU_RULES,
    bidRedealLimit: 1 + random(3),
    bareTrio: flip(),
    minPairStraight: 2 + random(2),
    soloKickersMayPair: flip(),
    soloKickersMayBeJokers: flip(),
    fourWithTwo: flip(),
    springDoubles: flip(),
    cap: [2, 4, 8, 64][random(4)]!,
  }
}

/** Plays `games` seeded games with `player` and tallies how they went. */
function playMany(games: number, seedBase: number, player: (seed: number) => Player) {
  const tally = { outcomes: new Map<string, number>(), redeals: 0, bombs: 0, springs: 0, capped: 0, trimmedTurns: 0 }
  for (let i = 1; i <= games; i++) {
    const seed = seedBase + i
    const random = seededRandomInt(seed)
    let played: Played
    try {
      played = playGame({ rules: rulesFor(random), firstBidder: random(3), random }, player(seed))
    } catch (error) {
      throw new Error(`seed ${seed}: ${(error as Error).message}`, { cause: error })
    }
    const result = played.state.outcome!
    tally.outcomes.set(result.outcome, (tally.outcomes.get(result.outcome) ?? 0) + 1)
    tally.redeals += played.events.filter((e) => e.kind === 'redeal').length
    tally.bombs += result.doublings.filter((d) => d.kind === 'bomb' || d.kind === 'rocket').length
    tally.springs += result.doublings.filter((d) => d.kind === 'spring' || d.kind === 'anti_spring').length
    tally.capped += result.capped ? 1 : 0
    tally.trimmedTurns += played.trimmedTurns
  }
  return tally
}

describe('random games', () => {
  test(`${GAMES} games with every seat in trusteeship`, () => {
    // One game in ten all by the trustee, which never bids; the rest with random bids so that there is play.
    const tally = playMany(GAMES, 10_000, (seed) => (seed % 10 === 0 ? trustee : trusteeAfterBids))
    expect(tally.outcomes.get('no_landlord')).toBeGreaterThanOrEqual(GAMES / 10)
    expect(tally.outcomes.get('landlord_won')).toBeGreaterThan(0)
    expect(tally.outcomes.get('farmers_won')).toBeGreaterThan(0)
    expect(tally.redeals).toBeGreaterThan(0)
    expect(tally.bombs).toBeGreaterThan(0)
  }, RUN_TIMEOUT)

  test(`${GAMES} games of random legal steps, sent every way, with illegal ones refused on the way`, () => {
    const tally = playMany(GAMES, 20_000, () => randomPlayer)
    expect(tally.outcomes.get('landlord_won')).toBeGreaterThan(0)
    expect(tally.outcomes.get('farmers_won')).toBeGreaterThan(0)
    expect(tally.outcomes.get('no_landlord')).toBeGreaterThan(0)
    expect(tally.redeals).toBeGreaterThan(0)
    expect(tally.bombs).toBeGreaterThan(0)
    expect(tally.capped).toBeGreaterThan(0)
  }, RUN_TIMEOUT)
})

describe('games with fixed decks', () => {
  /** Seat 0 bids 3 and becomes the landlord; then `player` plays. */
  const landlordZero =
    (player: Player): Player =>
    (state, random) =>
      state.phase === 'bidding' ? bid(state, state.toAct!, state.toAct === 0 ? 3 : 0) : player(state, random)

  test('a landlord with more moves than the list holds: trimmed lists, and a move left out still goes', () => {
    const deck = deckOf(
      '3 3 3 4 4 4 5 5 5 6 6 6 7 8 9 10 J',
      '3 4 5 6 7 7 7 8 8 8 9 9 9 10 10 10 J',
      'J J Q Q Q Q K K K K A A A A 2 2 2',
      '2 小王 大王',
    )
    const setup = { rules: DEFAULT_DOUDIZHU_RULES, firstBidder: 0, random: seededRandomInt(5), decks: [deck] }

    // The landlord's first list is trimmed; a plane with other wings than the listed ones is still accepted.
    const lead = bid(newGame(setup).state, 0, 3)
    if (!lead.ok) throw new Error(lead.error.reason)
    const listed = currentMoves(lead.state)
    expect(listed.trimmed).toBe(true)
    expect(listed.moves.length).toBeLessThanOrEqual(300)
    const all = legalMoves(lead.state.hands[0]!, null, DEFAULT_DOUDIZHU_RULES, Infinity).moves
    const left = all.find((m) => !listed.moves.some((l) => l.type === m.type && l.cards.join() === m.cards.join()))!
    expect(left).toBeDefined()
    const played = play(lead.state, 0, { cards: left.cards.map(toRank), as: left.type })
    expect(played.ok && played.state.trick!.last!.move).toEqual(left)

    const game = playGame(setup, landlordZero(randomPlayer))
    expect(game.trimmedTurns).toBeGreaterThan(0)
  })

  test('a landlord no farmer can answer without a bomb: a spring', () => {
    const deck = deckOf(
      '大王 小王 2 2 2 2 A A A A K K K K Q Q Q',
      '3 3 3 3 4 4 4 4 5 5 5 5 6 6 6 6 J',
      '7 7 7 7 8 8 8 8 9 9 9 9 10 10 10 10 J',
      'Q J J',
    )
    const setup = { rules: DEFAULT_DOUDIZHU_RULES, firstBidder: 0, random: seededRandomInt(6), decks: [deck] }
    const { state } = playGame(setup, landlordZero(trustee))
    const result = state.outcome!
    expect(result.outcome).toBe('landlord_won')
    expect(state.movesBy[1] + state.movesBy[2]).toBe(0)
    expect(result.doublings.at(-1)).toEqual({ kind: 'spring', seat: null })
    const score = 3 * result.multiplier
    expect(result.scores).toEqual([2 * score, -score, -score])
  })
})
