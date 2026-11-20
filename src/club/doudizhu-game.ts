import type { Static } from 'typebox'
import type { Card } from './doudizhu/cards.js'
import { cryptoRandomInt, type RandomInt } from './doudizhu/deal.js'
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
  type PlayInput,
  publicTable,
  type Rules,
  type StepResult,
  turnView,
} from './doudizhu/index.js'
import type {
  AckResult,
  GameClientMessage,
  GameEmit,
  GameModule,
  GameOutput,
  GamePrivateMessage,
  GameReply,
  GameRoomEvent,
  GameSession,
  GameTable,
  SeatPlayer,
  SessionStart,
} from './game.js'
import type { ClubStatsSummary, YourTurnMessage } from '../protocol/club.js'

// Doudizhu as a `GameModule`, played by the rules engine (src/club/doudizhu/), for now without the clock: what the
// club service runs until the full game is written.
//
// What it does not do yet:
// - No clock: every `your_turn` has a deadline a fixed `turnSeconds` after it is sent and no time bank
//   (`timeBankSeconds: 0`), nothing ever times out, and `tick` does nothing. So no seat ever goes to the trustee by
//   itself; only `finish` (the club closing) hands every student seat to it and plays the game out
//   (`auto: "closing"`).
// - No game records: nothing is stored, during or after a game.
// - No stats: `stats` gives 0 for everyone.
// The full game replaces this module or fills it in: the clock, the time bank, the trustee after timeouts, the game
// records, the stats and the rankings.
//
// Bots play at once (the trustee's steps, `auto: "bot"`).

type YourTurn = Static<typeof YourTurnMessage>

export interface DoudizhuGameOptions {
  /**
   * The decks every game deals, in order: the first deal, then one for each redeal. Fewer than the rules'
   * `bidRedealLimit` are filled up with the last one. Shuffled with `random` when absent.
   */
  readonly decks?: readonly (readonly Card[])[]
  /**
   * The first bidder of a room's first game; random when absent. Each later game's is the seat after the first bidder
   * of the previous game's last deal (redeals included).
   */
  readonly firstBidder?: number
  /** Shuffles the decks and picks the first bidder; `crypto.randomInt` when absent. */
  readonly random?: RandomInt
  readonly rules?: Rules
  /** How long after a `your_turn` its deadline is; 60 seconds by default. */
  readonly turnSeconds?: number
  /** `welcome.stats`; all 0 by default. */
  readonly stats?: (studentId: number) => Static<typeof ClubStatsSummary>
}

/** The options a session is made with: the game's, with the rules in force. */
export type DoudizhuSessionOptions = DoudizhuGameOptions & { readonly rules: Rules }

/** Makes the session of one game; a subclass of `DoudizhuSession` may be made in its place. */
export type MakeDoudizhuSession = (start: SessionStart, options: DoudizhuSessionOptions, gameId: number) => DoudizhuSession

const NO_STATS: Static<typeof ClubStatsSummary> = { games: 0, wins: 0, points: { total: 0, week: 0 } }

/** Doudizhu, three seats; `make` makes each session (a plain `DoudizhuSession` when absent). */
export function doudizhuGame(options: DoudizhuGameOptions = {}, make?: MakeDoudizhuSession): GameModule {
  const rules = options.rules ?? DEFAULT_DOUDIZHU_RULES
  const sessionOptions: DoudizhuSessionOptions = { ...options, rules }
  const makeSession: MakeDoudizhuSession = make ?? ((start, o, gameId) => new DoudizhuSession(start, o, gameId))
  // Numbered within this process only: nothing is stored yet that a number would have to be unique against.
  let nextGameId = 1
  return {
    club: 'doudizhu',
    name: '斗地主社',
    seats: 3,
    reactions: { kinds: ['emoji', 'phrase'], visibility: ['room'] },
    rules: () => ({ ...rules }),
    stats: async (studentId) => options.stats?.(studentId) ?? NO_STATS,
    newSession: (start) => makeSession(start, sessionOptions, nextGameId++),
  }
}

const NOTHING: GameOutput = { emits: [], over: false }

const fail = (code: Extract<AckResult, { ok: false }>['code'], extra?: object): AckResult =>
  extra === undefined ? { ok: false, code } : { ok: false, code, extra }

/** The fields of `value` that are not `undefined`. */
const defined = <T extends object>(value: T): T =>
  Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T

/** One game of doudizhu in one room, from the deal to the end (see the top of this file for what it leaves out). */
export class DoudizhuSession implements GameSession {
  readonly gameId: number
  /** The first bidder of the first deal; `state.firstBidder` is that of the deal now. */
  readonly firstBidder: number
  protected readonly roomId: string
  protected readonly players: readonly SeatPlayer[]
  private readonly closesAt: (now: Date) => Date
  private readonly turnMillis: number
  protected readonly trustees: boolean[]
  private current: GameState
  private started = false
  /** The deadline of the `your_turn` out now; null when nobody is asked. */
  protected deadline: Date | null = null

  constructor(start: SessionStart, options: DoudizhuSessionOptions, gameId: number) {
    if (start.players.length !== 3) throw new Error(`doudizhu has 3 seats, not ${start.players.length}`)
    if (start.players.every((p) => p.bot)) throw new Error('a game needs a student')
    this.gameId = gameId
    this.roomId = start.roomId
    this.players = [...start.players]
    this.closesAt = start.closesAt
    this.turnMillis = (options.turnSeconds ?? 60) * 1000
    this.trustees = [false, false, false]
    const random = options.random
    this.firstBidder =
      start.previous instanceof DoudizhuSession
        ? (start.previous.state.firstBidder + 1) % 3
        : (options.firstBidder ?? (random ?? cryptoRandomInt)(3))
    let decks = options.decks
    if (decks !== undefined && decks.length > 0) {
      const last = decks[decks.length - 1]!
      decks = [...decks, ...Array<readonly Card[]>(Math.max(0, options.rules.bidRedealLimit - decks.length)).fill(last)]
    }
    this.current = newGame({
      rules: options.rules,
      firstBidder: this.firstBidder,
      ...(decks === undefined ? {} : { decks }),
      ...(random === undefined ? {} : { random }),
    }).state
  }

  /** The engine's state. */
  get state(): GameState {
    return this.current
  }

  get over(): boolean {
    return this.current.phase === 'over'
  }

  start(now: Date): GameOutput {
    if (this.started) throw new Error('a session starts once')
    this.started = true
    const emits: GameEmit[] = []
    // `newGame` dealt already; its `dealt` event is told here.
    this.tell(emits, [{ kind: 'dealt', gameId: 0, firstBidder: this.current.firstBidder }], true)
    return this.advance(emits, now, null)
  }

  handle(seat: number, message: GameClientMessage, now: Date): GameReply {
    this.assertStarted()
    const state = this.current
    if (state.phase === 'over' || message.turn !== state.turn) return { ack: fail('stale_turn'), output: this.idle() }
    if (state.toAct !== seat) return { ack: fail('not_your_turn'), output: NOTHING }
    let step: StepResult
    if (message.type === 'bid' && state.phase === 'bidding') step = bid(state, seat, message.bid)
    else if (message.type === 'pass' && state.phase === 'playing') step = pass(state, seat)
    else if (message.type === 'play' && state.phase === 'playing') step = play(state, seat, playInput(message))
    else return { ack: fail('invalid_message'), output: NOTHING }

    if (!step.ok) {
      const retry = { turn: state.turn, deadline: this.deadline!.toISOString(), timeBankSeconds: 0 }
      return { ack: fail('illegal_move', { ...defined(step.error), retry }), output: NOTHING }
    }
    const emits: GameEmit[] = []
    if (this.trustees[seat]) {
      this.trustees[seat] = false
      emits.push({ to: 'room', event: { kind: 'trustee', seat, on: false, reason: 'off' } })
    }
    this.current = step.state
    this.deadline = null
    this.tell(emits, step.events, true)
    return { ack: { ok: true, result: { turn: message.turn } }, output: this.advance(emits, now, null) }
  }

  trusteeOff(seat: number, now: Date): GameReply {
    this.assertStarted()
    if (this.over || !this.trustees[seat]) return { ack: fail('not_trustee'), output: this.idle() }
    this.trustees[seat] = false
    const emits: GameEmit[] = [{ to: 'room', event: { kind: 'trustee', seat, on: false, reason: 'off' } }]
    return { ack: { ok: true }, output: this.advance(emits, now, null) }
  }

  tick(_now: Date): GameOutput {
    return this.idle()
  }

  finish(now: Date): GameOutput {
    this.assertStarted()
    if (this.over) return this.idle()
    const emits: GameEmit[] = []
    this.players.forEach((player, seat) => {
      if (player.bot || this.trustees[seat]) return
      this.trustees[seat] = true
      emits.push({ to: 'room', event: { kind: 'trustee', seat, on: true, reason: 'closing' } })
    })
    this.deadline = null
    return this.advance(emits, now, 'closing')
  }

  resend(seat: number, now: Date): GamePrivateMessage[] {
    this.assertStarted()
    if (this.over || this.players[seat]?.bot !== false) return []
    const messages: GamePrivateMessage[] = []
    const hand = this.handMessage(seat)
    if (hand !== null) messages.push(hand)
    if (this.current.toAct === seat && this.deadline !== null) messages.push(this.yourTurn(seat, now))
    this.checkPrivate(messages)
    return messages
  }

  table(): GameTable {
    return {
      ...publicTable(this.current, this.trustees),
      gameId: this.gameId,
      deadline: this.deadline?.toISOString() ?? null,
    }
  }

  trustee(seat: number): boolean {
    return this.trustees[seat] ?? false
  }

  // ---- For a subclass (the tests' fake game) ----

  /** Looks at an output before it is given; nothing here. */
  protected checkOutput(_output: GameOutput, _now: Date): void {}

  /** Looks at what `resend` gives before it is given; nothing here. */
  protected checkPrivate(_messages: readonly GamePrivateMessage[]): void {}

  protected assertStarted(): void {
    if (!this.started) throw new Error('the session has not started')
  }

  protected idle(): GameOutput {
    return { emits: [], over: this.over }
  }

  /**
   * Plays every step that is not a student's to make (bots, seats in trusteeship, and every seat when `closing`), then
   * asks the student to act, if any, with a `your_turn`. Gives what it sends, after `checkOutput`.
   */
  protected advance(emits: GameEmit[], now: Date, closing: 'closing' | null): GameOutput {
    for (;;) {
      const seat = this.current.toAct
      if (seat === null) break
      const auto: Exclude<Auto, null> | null = this.players[seat]!.bot
        ? 'bot'
        : closing ?? (this.trustees[seat] ? 'trustee' : null)
      if (auto === null) {
        if (this.deadline === null) {
          this.deadline = new Date(now.getTime() + this.turnMillis)
          emits.push({ to: 'seat', seat, message: this.yourTurn(seat, now) })
        }
        break
      }
      const step = actFor(this.current, auto)
      this.current = step.state
      this.tell(emits, step.events, closing === null)
    }
    const output: GameOutput = { emits, over: this.over }
    this.checkOutput(output, now)
    return output
  }

  /** The engine's events as room events, with the hands after a deal and after the landlord takes the bottom. */
  private tell(emits: GameEmit[], events: readonly GameEvent[], hands: boolean): void {
    for (const event of events) {
      emits.push({ to: 'room', event: { kind: 'game', game: 'doudizhu', event: this.protocolEvent(event) } })
      if (!hands) continue
      if (event.kind === 'dealt') {
        this.players.forEach((_, seat) => {
          const hand = this.handMessage(seat)
          if (hand !== null) emits.push({ to: 'seat', seat, message: hand })
        })
      } else if (event.kind === 'landlord') {
        const hand = this.handMessage(event.seat)
        if (hand !== null) emits.push({ to: 'seat', seat: event.seat, message: hand })
      }
    }
  }

  private protocolEvent(event: GameEvent): Extract<GameRoomEvent, { kind: 'game' }>['event'] {
    if (event.kind === 'dealt') return { ...event, gameId: this.gameId, seats: [...this.players] }
    if (event.kind === 'over') {
      return { kind: 'over', result: { gameId: this.gameId, ...event.result, ranked: this.players.every((p) => !p.bot) } }
    }
    return event
  }

  /** A student seat's `hand` while the game goes on; null for a bot, an empty hand, or a game over. */
  private handMessage(seat: number): Extract<GamePrivateMessage, { type: 'hand' }> | null {
    if (this.players[seat]!.bot || this.over) return null
    const cards = handOf(this.current, seat)
    if (cards.length === 0) return null
    return { type: 'hand', roomId: this.roomId, game: 'doudizhu', gameId: this.gameId, cards }
  }

  private yourTurn(seat: number, now: Date): YourTurn {
    const view = turnView(this.current, seat, this.trustees)
    const deadline = this.deadline!.toISOString()
    return {
      type: 'your_turn',
      roomId: this.roomId,
      game: 'doudizhu',
      gameId: this.gameId,
      deadline,
      timeBankSeconds: 0,
      closesAt: this.closesAt(now).toISOString(),
      ...view,
      left: { ...view.left, player: this.players[view.left.seat]! },
      right: { ...view.right, player: this.players[view.right.seat]! },
      table: { ...view.table, gameId: this.gameId, deadline },
    } as YourTurn
  }
}

function playInput(message: Extract<GameClientMessage, { type: 'play' }>): PlayInput {
  if ('moveId' in message) return { moveId: message.moveId }
  return message.as === undefined ? { cards: message.cards } : { cards: message.cards, as: message.as }
}
