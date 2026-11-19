import type { Static } from 'typebox'
import type { DoudizhuEvent, DoudizhuResult, TableAction } from '../../protocol/club.js'
import { type Card, FULL_DECK, ranksOf, sortCards } from './cards.js'
import { cryptoRandomInt, deal, DECK_SIZE, type RandomInt, shuffle } from './deal.js'
import { type LegalMoves, legalMoves, toMove } from './moves.js'
import type { Rules } from './rules.js'
import { type Doubling, rawMultiplier, settle, springOf } from './scoring.js'
import { checkBid, checkPass, checkPlay, type IllegalMove, type PlayInput, type ToBeat } from './validate.js'

// One game as a state machine: deal, bidding (with redeals), the landlord taking the bottom cards, play, and the end.
// The state is a plain, immutable object: every step returns a new state and the events the step made, in the
// protocol's terms. Time, the players and the game number are not the engine's business: the club layer adds them.

type ProtocolEvent = Static<typeof DoudizhuEvent>
type ProtocolResult = Static<typeof DoudizhuResult>

/** A step of the table's history, as the protocol has it. */
export type HistoryStep = Static<typeof TableAction>

/** Who made a step for the seat, if not the seat itself: the protocol's `auto`. */
export type Auto = HistoryStep['auto']

/** How a game ended, as far as the engine knows: the protocol's `DoudizhuResult` without `gameId` and `ranked`. */
export type GameOutcome = Omit<ProtocolResult, 'gameId' | 'ranked'>

/**
 * An event of the game: the protocol's `DoudizhuEvent`, except that `dealt` has no `seats` and `over` has a
 * `GameOutcome`. `gameId` is 0 here; the club layer puts in the game's number, the seats and `ranked`.
 */
export type GameEvent =
  | Omit<Extract<ProtocolEvent, { kind: 'dealt' }>, 'seats'>
  | Extract<ProtocolEvent, { kind: 'bid' | 'redeal' | 'landlord' | 'play' | 'pass' }>
  | { kind: 'over'; result: GameOutcome }

export type Phase = 'bidding' | 'playing' | 'over'

/** The trick being played. */
export interface Trick {
  /** The seat that led it. */
  readonly leader: number
  /** The move to beat and who played it; `null` until the leader plays. */
  readonly last: ToBeat | null
  /** How many seats in a row have passed on `last`. */
  readonly passes: number
}

export interface GameState {
  readonly rules: Rules
  readonly phase: Phase
  /**
   * The `turn` of the step awaited; once the game is over, one past the last step. It never goes back, not even on a
   * redeal.
   */
  readonly turn: number
  /** Every deck dealt in this game, in order, each in its shuffled order: what the game record keeps. */
  readonly decks: readonly (readonly Card[])[]
  /** Decks shuffled ahead for redeals, used in order. Never shown to anyone and not part of the record. */
  readonly spareDecks: readonly (readonly Card[])[]
  /** The seat that bid first in this deal. */
  readonly firstBidder: number
  /** The cards of each seat, by seat, low to high. */
  readonly hands: readonly [readonly Card[], readonly Card[], readonly Card[]]
  /** The bottom cards of this deal, low to high; the landlord has them too once decided. */
  readonly bottom: readonly Card[]
  /** The bids of this deal, in order. */
  readonly bids: readonly { readonly seat: number; readonly bid: number }[]
  readonly landlord: number | null
  /** The winning bid; `null` until the landlord is decided. */
  readonly base: number | null
  /** The seat to act; `null` once the game is over. */
  readonly toAct: number | null
  /** The trick being played; `null` outside play. */
  readonly trick: Trick | null
  /** Every step of this deal, by `turn`. */
  readonly history: readonly HistoryStep[]
  /** The doublings so far, in the order they happened; a spring or anti-spring comes last. */
  readonly doublings: readonly Doubling[]
  /** How many moves each seat has played in this deal, by seat. */
  readonly movesBy: readonly [number, number, number]
  /** How the game ended; `null` until it is over. */
  readonly outcome: GameOutcome | null
}

export type StepResult =
  | { readonly ok: true; readonly state: GameState; readonly events: GameEvent[] }
  | { readonly ok: false; readonly error: IllegalMove }

export interface NewGameOptions {
  readonly rules: Rules
  /** The seat that bids first in the first deal. */
  readonly firstBidder: number
  /**
   * The decks to deal, in order: the first deal, then one for each redeal. When absent, `rules.bidRedealLimit` decks
   * are shuffled with `random`. A game that needs a redeal beyond the decks given throws.
   */
  readonly decks?: readonly (readonly Card[])[]
  /** The source of randomness for shuffling when `decks` is absent; `crypto.randomInt` by default. */
  readonly random?: RandomInt
}

const next = (seat: number): number => (seat + 1) % 3

function assertSeat(seat: number): void {
  if (!Number.isInteger(seat) || seat < 0 || seat > 2) throw new RangeError(`not a seat: ${seat}`)
}

const cardKey = (card: Card): string => `${card.rank}${card.suit ?? ''}`
const DECK_KEYS: ReadonlySet<string> = new Set(FULL_DECK.map(cardKey))

/** Throws unless the deck is the 54 cards, each once. */
function assertDeck(deck: readonly Card[]): void {
  const keys = new Set(deck.map(cardKey))
  if (deck.length !== DECK_SIZE || keys.size !== DECK_SIZE || ![...keys].every((key) => DECK_KEYS.has(key))) {
    throw new RangeError('a deck must be the 54 cards, each once')
  }
}

/** The state and event of dealing `deck` with `firstBidder` to bid first; the rest of the deal starts over. */
function dealDeck(
  base: Omit<GameState, 'hands' | 'bottom' | 'firstBidder' | 'toAct' | 'bids' | 'history'>,
  deck: readonly Card[],
  firstBidder: number,
): { state: GameState; event: GameEvent } {
  const dealt = deal(deck)
  const state: GameState = {
    ...base,
    hands: dealt.hands,
    bottom: dealt.bottom,
    firstBidder,
    toAct: firstBidder,
    bids: [],
    history: [],
  }
  return { state, event: { kind: 'dealt', gameId: 0, firstBidder } }
}

/** Starts a game: deals the first deck. Gives the state and the `dealt` event. */
export function newGame(options: NewGameOptions): { state: GameState; events: GameEvent[] } {
  const { rules, firstBidder } = options
  assertSeat(firstBidder)
  const random = options.random ?? cryptoRandomInt
  const decks = options.decks ?? Array.from({ length: rules.bidRedealLimit }, () => shuffle(FULL_DECK, random))
  if (decks.length === 0) throw new RangeError('a game needs a deck')
  decks.forEach(assertDeck)
  const first = decks[0]!
  const { state, event } = dealDeck(
    {
      rules,
      phase: 'bidding',
      turn: 1,
      decks: [first],
      spareDecks: decks.slice(1),
      landlord: null,
      base: null,
      trick: null,
      doublings: [],
      movesBy: [0, 0, 0],
      outcome: null,
    },
    first,
    firstBidder,
  )
  return { state, events: [event] }
}

/** Throws unless `seat` is to act in `phase`. Whose turn it is is checked before the engine is called. */
function assertToAct(state: GameState, seat: number, phase: Phase): void {
  assertSeat(seat)
  if (state.phase !== phase) throw new Error(`the game is ${state.phase}, not ${phase}`)
  if (state.toAct !== seat) throw new Error(`seat ${seat} is not to act; seat ${String(state.toAct)} is`)
}

/** The cards each seat holds, by seat, as protocol ranks. */
const handsText = (state: GameState) => state.hands.map(ranksOf)

/** Ends the game with no landlord: nobody bid on the last deal allowed. */
function noLandlord(state: GameState): GameState {
  const outcome: GameOutcome = {
    outcome: 'no_landlord',
    landlord: null,
    base: null,
    doublings: [],
    multiplier: 1,
    capped: false,
    scores: [0, 0, 0],
    hands: handsText(state),
    bottom: ranksOf(state.bottom),
  }
  return { ...state, phase: 'over', toAct: null, trick: null, outcome }
}

/** The landlord takes the bottom cards and leads. */
function decideLandlord(state: GameState, landlord: number, base: number): { state: GameState; event: GameEvent } {
  const hands = [...state.hands] as [readonly Card[], readonly Card[], readonly Card[]]
  hands[landlord] = sortCards([...hands[landlord]!, ...state.bottom])
  return {
    state: {
      ...state,
      phase: 'playing',
      hands,
      landlord,
      base,
      toAct: landlord,
      trick: { leader: landlord, last: null, passes: 0 },
    },
    event: { kind: 'landlord', seat: landlord, base, bottom: ranksOf(state.bottom) },
  }
}

/**
 * A bid: 1 to 3 points, or 0 for no bid. Refused with `bid_too_low` when it is not above the bids before it. A bid of 3
 * ends the bidding at once; otherwise the highest bid wins once every seat has bid. When nobody bids, the cards are
 * dealt again with the next seat bidding first, or, on the last deal `bidRedealLimit` allows, the game is over with no
 * landlord. Throws when the seat is not to bid.
 */
export function bid(state: GameState, seat: number, value: number, auto: Auto = null): StepResult {
  assertToAct(state, seat, 'bidding')
  const error = checkBid(value, state.bids.map((b) => b.bid))
  if (error !== null) return { ok: false, error }

  const turn = state.turn
  const events: GameEvent[] = [{ kind: 'bid', turn, seat, bid: value, auto }]
  let after: GameState = {
    ...state,
    turn: turn + 1,
    bids: [...state.bids, { seat, bid: value }],
    history: [...state.history, { turn, seat, action: 'bid', bid: value, auto }],
    toAct: next(seat),
  }

  const highest = after.bids.reduce((best, b) => (b.bid > best.bid ? b : best), { seat: -1, bid: 0 })
  if (value === 3 || (after.bids.length === 3 && highest.bid > 0)) {
    const decided = decideLandlord(after, highest.seat, highest.bid)
    return { ok: true, state: decided.state, events: [...events, decided.event] }
  }
  if (after.bids.length < 3) return { ok: true, state: after, events }

  // Nobody bid.
  const dealsSoFar = after.decks.length
  if (dealsSoFar >= after.rules.bidRedealLimit) {
    after = noLandlord(after)
    return { ok: true, state: after, events: [...events, { kind: 'over', result: after.outcome! }] }
  }
  const deck = after.spareDecks[0]
  if (deck === undefined) throw new Error('no deck left for a redeal')
  const redealt = dealDeck(
    { ...after, decks: [...after.decks, deck], spareDecks: after.spareDecks.slice(1) },
    deck,
    next(after.firstBidder),
  )
  return { ok: true, state: redealt.state, events: [...events, { kind: 'redeal', count: dealsSoFar }, redealt.event] }
}

/** The move to beat for the seat to act: `null` when it leads the trick. */
const toBeatOf = (state: GameState): ToBeat | null => state.trick?.last ?? null

/**
 * The moves the seat to act may play: the one list both `your_turn` shows and `play` takes a `moveId` from. Throws
 * outside play.
 */
export function currentMoves(state: GameState): LegalMoves {
  if (state.phase !== 'playing' || state.toAct === null) throw new Error(`no moves to list: the game is ${state.phase}`)
  return legalMoves(state.hands[state.toAct]!, toBeatOf(state)?.move ?? null, state.rules)
}

/** Ends the game: `seat` has played its last card. */
function finish(state: GameState, seat: number): GameState {
  const landlord = state.landlord!
  const base = state.base!
  const landlordWon = seat === landlord
  const doublings = [...state.doublings]
  const spring = state.rules.springDoubles ? springOf(landlord, landlordWon, state.movesBy) : null
  if (spring !== null) doublings.push({ kind: spring, seat: null })
  const settled = settle(landlord, base, landlordWon, rawMultiplier(doublings), state.rules.cap)
  const ended: GameState = { ...state, doublings }
  const outcome: GameOutcome = {
    outcome: landlordWon ? 'landlord_won' : 'farmers_won',
    landlord,
    base,
    doublings,
    multiplier: settled.multiplier,
    capped: settled.capped,
    scores: settled.scores,
    hands: handsText(ended),
    bottom: ranksOf(state.bottom),
  }
  return { ...ended, phase: 'over', toAct: null, trick: null, outcome }
}

/**
 * A play: the id of a move in the list of this turn (`currentMoves`), or the cards with an optional `as`. Refused with
 * the first rule it breaks (see `checkPlay`). When the seat plays its last card the game is over. Throws when the seat
 * is not to play.
 */
export function play(state: GameState, seat: number, input: PlayInput, auto: Auto = null): StepResult {
  assertToAct(state, seat, 'playing')
  const toBeat = toBeatOf(state)
  // Only a `moveId` needs the list; cards are checked against the hand directly.
  const moves = 'moveId' in input ? currentMoves(state).moves : []
  const check = checkPlay({ seat, hand: state.hands[seat]!, moves, toBeat, rules: state.rules }, input)
  if (!check.ok) return { ok: false, error: check.error }

  const { move, rest } = check
  const turn = state.turn
  const hands = [...state.hands] as [readonly Card[], readonly Card[], readonly Card[]]
  hands[seat] = rest
  const movesBy = [...state.movesBy] as [number, number, number]
  movesBy[seat]!++
  const doublings =
    move.type === 'bomb' || move.type === 'rocket' ? [...state.doublings, { kind: move.type, seat }] : state.doublings
  const shown = toMove(move)
  let after: GameState = {
    ...state,
    turn: turn + 1,
    hands,
    movesBy,
    doublings,
    history: [...state.history, { turn, seat, action: 'play', move: shown, auto }],
    trick: { leader: state.trick!.leader, last: { seat, move }, passes: 0 },
    toAct: next(seat),
  }
  const events: GameEvent[] = [
    {
      kind: 'play',
      turn,
      seat,
      move: shown,
      cardsLeft: rest.length,
      multiplier: rawMultiplier(doublings),
      auto,
    },
  ]
  if (rest.length === 0) {
    after = finish(after, seat)
    events.push({ kind: 'over', result: after.outcome! })
  }
  return { ok: true, state: after, events }
}

/**
 * A pass. Refused with `must_play` when the seat leads the trick. After two passes in a row the seat that played last
 * leads a new trick. Throws when the seat is not to play.
 */
export function pass(state: GameState, seat: number, auto: Auto = null): StepResult {
  assertToAct(state, seat, 'playing')
  const trick = state.trick!
  const error = checkPass({ seat, toBeat: trick.last })
  if (error !== null) return { ok: false, error }

  const turn = state.turn
  const last = trick.last!
  const passes = trick.passes + 1
  const newTrick = passes >= 2
  return {
    ok: true,
    state: {
      ...state,
      turn: turn + 1,
      history: [...state.history, { turn, seat, action: 'pass', auto }],
      trick: newTrick ? { leader: last.seat, last: null, passes: 0 } : { ...trick, passes },
      toAct: newTrick ? last.seat : next(seat),
    },
    events: [{ kind: 'pass', turn, seat, auto }],
  }
}
