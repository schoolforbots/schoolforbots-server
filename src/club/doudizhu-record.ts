import type { Static } from 'typebox'
import { ranksOf } from './doudizhu/cards.js'
import { deal } from './doudizhu/deal.js'
import { springOf } from './doudizhu/scoring.js'
import type { GameState, Rules } from './doudizhu/index.js'
import type { DoudizhuGameRecord } from '../protocol/club-http.js'
import type { DoudizhuResult } from '../protocol/club.js'
import type { SeatPlayer } from './game.js'
import type { KeptReaction, SeatCounts } from './doudizhu-game.js'

// The record of one finished game of doudizhu, put together from what its session kept: the whole game as the
// protocol's `DoudizhuGameRecord` (what the students who played it may look up), the part of it that is stored with
// the game (`StoredDoudizhuRecord`), and one row of details for each student seat (`DoudizhuPlayerRow`; bots have
// none). Pure: nothing here touches a database or a clock.
//
// A game may be dealt again (`redeal`) before anyone bids: the record keeps only the last deal, the one `result` is
// of. `dealt` and `bottom` are that deal's cards, and `actions` its steps, by turn. The engine keeps every deck it
// dealt (`GameState.decks`), so the last deal's hands are dealt again here from the last deck.
//
// A record holds every hand: it is only ever made once the game is over, and never sent to anyone but the three
// students who played it.

type GameRecord = Static<typeof DoudizhuGameRecord>
type Result = Static<typeof DoudizhuResult>

/** What the record of a finished game is made from: what its session kept. */
export interface FinishedDoudizhuGame {
  readonly gameId: number
  readonly roomId: string
  /** When the game started (the session's `start`). */
  readonly startedAt: Date
  /** When it was over. */
  readonly endedAt: Date
  /** Who sat where, by seat. */
  readonly players: readonly SeatPlayer[]
  /** The engine's state at the end: `phase` is `"over"`. */
  readonly state: GameState
  /** The reactions sent to the whole table during the game, oldest first. */
  readonly reactions: readonly KeptReaction[]
  /** The address of each student seat (null for a bot, or when not known), by seat. */
  readonly addresses: readonly (string | null)[]
  /** By seat (see `SeatCounts`). */
  readonly seatCounts: readonly Readonly<SeatCounts>[]
}

/**
 * The record as it is stored with the game: the `DoudizhuGameRecord` without what the game's own columns hold
 * (`gameId`, `startedAt`, `endedAt`), with the rules the game was played by.
 */
export type StoredDoudizhuRecord = Omit<GameRecord, 'gameId' | 'startedAt' | 'endedAt'> & { readonly rules: Rules }

/** The details of one student seat in one game, as stored. */
export interface DoudizhuPlayerRow {
  readonly gameId: number
  readonly seat: number
  readonly studentId: number
  /** Null in a game with no landlord. */
  readonly role: 'landlord' | 'farmer' | null
  /** False in a game with no landlord. */
  readonly won: boolean
  /** The seat's score (0 with no landlord). */
  readonly score: number
  /** The game's multiplier, after the cap. */
  readonly multiplier: number
  readonly ranked: boolean
  readonly endedAt: Date
  /** The bombs and rockets the seat played. */
  readonly bombs: number
  readonly rockets: number
  /**
   * Whether the seat won with a spring (it was the landlord) or an anti-spring (a farmer), whether or not the rules
   * double it.
   */
  readonly spring: boolean
  readonly antiSpring: boolean
  /** As the session counted them (see `SeatCounts`). */
  readonly timeouts: number
  readonly trusteeMoves: number
  readonly illegalMoves: number
  /** The address the seat played from (its last connection's); null when not known. Stored only, never shown. */
  readonly ip: string | null
}

/** Everything a finished game hands its recorder (`DoudizhuGameOptions.onGameOver`). */
export interface DoudizhuGameEntry {
  readonly gameId: number
  readonly roomId: string
  readonly startedAt: Date
  readonly endedAt: Date
  readonly ranked: boolean
  /** The whole game, as the students who played it may look it up. */
  readonly record: GameRecord
  /** What is stored with the game (`StoredDoudizhuRecord`). */
  readonly stored: StoredDoudizhuRecord
  /** One row for each student seat, by seat; none for the bots. */
  readonly players: readonly DoudizhuPlayerRow[]
}

/** Whether a game counts on the leaderboards: only games without bots do. */
export const isRanked = (players: readonly SeatPlayer[]): boolean => players.every((p) => !p.bot)

/** The protocol's result of a finished game. Throws unless the game is over. */
export function resultOf(game: Pick<FinishedDoudizhuGame, 'gameId' | 'players' | 'state'>): Result {
  const outcome = game.state.outcome
  if (game.state.phase !== 'over' || outcome === null) throw new Error('the game is not over')
  return {
    gameId: game.gameId,
    ...outcome,
    doublings: outcome.doublings.map((d) => ({ ...d })),
    scores: [...outcome.scores],
    hands: outcome.hands.map((h) => [...h]),
    bottom: outcome.bottom === null ? null : [...outcome.bottom],
    ranked: isRanked(game.players),
  }
}

/** The whole record of a finished game (see the top of this file). Throws unless the game is over. */
export function gameRecord(game: FinishedDoudizhuGame): GameRecord {
  const result = resultOf(game)
  const lastDeck = game.state.decks[game.state.decks.length - 1]
  if (lastDeck === undefined) throw new Error('the game has no deal')
  const dealt = deal(lastDeck)
  return {
    gameId: game.gameId,
    startedAt: game.startedAt.toISOString(),
    endedAt: game.endedAt.toISOString(),
    seats: game.players.map((p) => ({ ...p })),
    dealt: dealt.hands.map(ranksOf),
    bottom: ranksOf(dealt.bottom),
    actions: game.state.history.map((step) =>
      step.action === 'play' ? { ...step, move: { ...step.move, cards: [...step.move.cards] } } : { ...step },
    ),
    reacts: game.reactions.map((r) => ({
      at: r.at.toISOString(),
      from: r.from,
      to: r.to,
      kind: r.kind,
      content: r.content,
      text: r.text,
    })),
    result,
  }
}

/**
 * The record as it is stored with the game: without `gameId`, `startedAt` and `endedAt`, with the rules. A deep copy:
 * it shares nothing with `record`. Its `result` is the protocol's `DoudizhuResult` as it is, so it still carries
 * `gameId` and `ranked` (the same as the game's own columns).
 */
export function storedRecord(record: GameRecord, rules: Rules): StoredDoudizhuRecord {
  const { gameId: _gameId, startedAt: _startedAt, endedAt: _endedAt, ...rest } = record
  return structuredClone({ ...rest, rules: { ...rules } })
}

/** One row for each student seat of a finished game, by seat; none for the bots. Throws unless the game is over. */
export function playerRows(game: FinishedDoudizhuGame): DoudizhuPlayerRow[] {
  const result = resultOf(game)
  // A spring or anti-spring counts whether or not the rules double it (`springDoubles`), so it is worked out from the
  // moves each seat played, not from the doublings. `movesBy` counts every deal, but only the last deal is ever played
  // (a redeal comes before any play), so it is the last deal's.
  const spring =
    result.landlord === null ? null : springOf(result.landlord, result.outcome === 'landlord_won', game.state.movesBy)
  return game.players.flatMap((player, seat) => {
    if (player.bot) return []
    const role = result.landlord === null ? null : seat === result.landlord ? 'landlord' : 'farmer'
    const won =
      (result.outcome === 'landlord_won' && role === 'landlord') ||
      (result.outcome === 'farmers_won' && role === 'farmer')
    const counts = game.seatCounts[seat] ?? { timeouts: 0, trusteeMoves: 0, illegalMoves: 0 }
    const row: DoudizhuPlayerRow = {
      gameId: game.gameId,
      seat,
      studentId: player.studentId,
      role,
      won,
      score: result.scores[seat] ?? 0,
      multiplier: result.multiplier,
      ranked: result.ranked,
      endedAt: game.endedAt,
      bombs: result.doublings.filter((d) => d.kind === 'bomb' && d.seat === seat).length,
      rockets: result.doublings.filter((d) => d.kind === 'rocket' && d.seat === seat).length,
      spring: won && role === 'landlord' && spring === 'spring',
      antiSpring: won && role === 'farmer' && spring === 'anti_spring',
      timeouts: counts.timeouts,
      trusteeMoves: counts.trusteeMoves,
      illegalMoves: counts.illegalMoves,
      ip: game.addresses[seat] ?? null,
    }
    return [row]
  })
}

/** Everything a finished game hands its recorder. Throws unless the game is over. */
export function gameEntry(game: FinishedDoudizhuGame): DoudizhuGameEntry {
  const record = gameRecord(game)
  return {
    gameId: game.gameId,
    roomId: game.roomId,
    startedAt: game.startedAt,
    endedAt: game.endedAt,
    ranked: record.result.ranked,
    record,
    stored: storedRecord(record, game.state.rules),
    players: playerRows(game),
  }
}
