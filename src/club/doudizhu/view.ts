import type { Static } from 'typebox'
import type { DoudizhuTable, YourTurnMessage } from '../../protocol/club.js'
import { type Card, type RankName, ranksOf } from './cards.js'
import { currentMoves, type GameState } from './game.js'
import { toMove } from './moves.js'
import { rawMultiplier } from './scoring.js'

// What each seat may see. The public table holds no hand, only how many cards each seat has, and the bottom cards only
// once the landlord has taken them. A seat's own view adds its hand, the cards it has not seen, and what it may do.
// Time and the people at the table are the club layer's to add.

/** The protocol's `DoudizhuTable`. The engine leaves `gameId` 0 and `deadline` null for the club layer to fill. */
export type TableView = Static<typeof DoudizhuTable>

type YourTurn = Static<typeof YourTurnMessage>
type Neighbour = Omit<YourTurn['left'], 'player'>

/**
 * The engine's part of `your_turn`: everything but `type`, `roomId`, `game`, `gameId`, `deadline`, `timeBankSeconds`,
 * `closesAt` and the `player` of `left` and `right`.
 */
export type TurnView = Pick<
  YourTurn,
  'turn' | 'phase' | 'me' | 'table' | 'unseen' | 'bids' | 'moves' | 'canPass' | 'movesTrimmed'
> & { left: Neighbour; right: Neighbour }

const NO_TRUSTEES: readonly [boolean, boolean, boolean] = [false, false, false]

function checkTrustee(trustee: readonly boolean[]): void {
  if (trustee.length !== 3) throw new Error(`trustee needs one flag per seat, got ${trustee.length}`)
}

/**
 * The public state of the game, for everyone at the table and the spectators. `trustee` is who is in trusteeship, by
 * seat, which the club layer knows; nobody by default. `multiplier` is before the cap.
 */
export function publicTable(state: GameState, trustee: readonly boolean[] = NO_TRUSTEES): TableView {
  checkTrustee(trustee)
  const last = state.trick?.last ?? null
  return {
    game: 'doudizhu',
    gameId: 0,
    phase: state.phase,
    firstBidder: state.firstBidder,
    bids: state.bids.map(({ seat, bid }) => ({ seat, bid })),
    landlord: state.landlord,
    base: state.base,
    bottom: state.landlord === null ? null : ranksOf(state.bottom),
    cardsLeft: state.hands.map((hand) => hand.length),
    multiplier: rawMultiplier(state.doublings),
    trick:
      state.phase === 'playing' && state.trick !== null
        ? { leader: state.trick.leader, last: last === null ? null : { seat: last.seat, move: toMove(last.move) } }
        : null,
    history: [...state.history],
    trustee: [...trustee],
    toAct: state.toAct,
    deadline: null,
  }
}

const roleOf = (state: GameState, seat: number): Neighbour['role'] =>
  state.landlord === null ? null : state.landlord === seat ? 'landlord' : 'farmer'

const neighbour = (state: GameState, seat: number): Neighbour => ({
  seat,
  role: roleOf(state, seat),
  cardsLeft: state.hands[seat]!.length,
})

/**
 * The cards a seat has not seen: neither in its hand nor played. While bidding that is the other two hands and the
 * bottom; once the landlord has the bottom cards, the other two hands. Low to high.
 */
function unseenBy(state: GameState, seat: number): RankName[] {
  const cards: Card[] = []
  for (let other = 0; other < 3; other++) if (other !== seat) cards.push(...state.hands[other]!)
  if (state.landlord === null) cards.push(...state.bottom)
  return ranksOf(cards)
}

/**
 * The seat to act's view, the engine's part of its `your_turn`. While bidding: the bids it may make (0 and every bid
 * above the highest so far), no moves, no pass. While playing: its moves (the list a `moveId` is looked up in, numbered
 * from 1), no bids, and a pass unless it leads. Throws when `seat` is not to act.
 */
export function turnView(state: GameState, seat: number, trustee: readonly boolean[] = NO_TRUSTEES): TurnView {
  checkTrustee(trustee)
  if (state.toAct !== seat) throw new Error(`seat ${seat} is not to act`)
  const bidding = state.phase === 'bidding'
  let bids: number[] | null = null
  let moves: TurnView['moves'] = null
  let movesTrimmed = false
  if (bidding) {
    const highest = Math.max(0, ...state.bids.map((b) => b.bid))
    bids = [0, ...[1, 2, 3].filter((b) => b > highest)]
  } else {
    const listed = currentMoves(state)
    moves = listed.moves.map((move, i) => ({ id: i + 1, ...toMove(move) }))
    movesTrimmed = listed.trimmed
  }
  return {
    turn: state.turn,
    phase: bidding ? 'bid' : 'play',
    me: { seat, role: roleOf(state, seat), hand: handOf(state, seat) },
    left: neighbour(state, (seat + 2) % 3),
    right: neighbour(state, (seat + 1) % 3),
    table: publicTable(state, trustee),
    unseen: unseenBy(state, seat),
    bids,
    moves,
    canPass: !bidding && (state.trick?.last ?? null) !== null,
    movesTrimmed,
  }
}

/** A seat's cards for its `hand` message, low to high. */
export function handOf(state: GameState, seat: number): RankName[] {
  if (!Number.isInteger(seat) || seat < 0 || seat > 2) throw new RangeError(`not a seat: ${seat}`)
  return ranksOf(state.hands[seat]!)
}
