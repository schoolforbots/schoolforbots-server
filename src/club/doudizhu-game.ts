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
  GameReaction,
  GameReply,
  GameRoomEvent,
  GameSession,
  GameTable,
  SeatPlayer,
  SessionStart,
} from './game.js'
import type { ClubStatsSummary, YourTurnMessage } from '../protocol/club.js'
import { bankLeftAt, deadlineOf, dueAt, shownSeconds, stepLimitMs } from './doudizhu-clock.js'

// Doudizhu as a `GameModule`, played by the rules engine (src/club/doudizhu/), with the clock of each step, the time
// bank and the trustee after timeouts. What it does not do yet: no game records (nothing is stored, so `drain` has
// nothing to wait for), and no stats (`stats` gives 0 for everyone). A session keeps what a record will need that the
// engine does not: the reactions at the table (`reactions`), the address of each student seat (`addresses`), and how
// often each seat timed out, was played by the trustee or made an illegal step (`seatCounts`).
//
// The clock (`clock: true`, the default; the pure arithmetic is in doudizhu-clock.ts):
// - A student asked to act gets a `your_turn` whose `deadline` is the rules' `bidSeconds` (a bid) or `playSeconds` (a
//   play or a pass) after the step was asked. Each seat has a time bank of `timeBankSeconds` for the whole game, the
//   redeals included. Past the deadline the bank is spent: a step made then costs the time past the deadline, to the
//   millisecond; a step not made by `deadline + bank` times out: the bank is emptied and the trustee makes the step
//   (`auto: "timeout"`). `your_turn.timeBankSeconds` and `retry.timeBankSeconds` show the bank at that moment, in
//   whole seconds rounded down; a refused step (`illegal_move`) keeps the turn and its deadline.
// - Two timeouts in a row among a seat's own steps put the seat in trusteeship (room event `trustee`, `reason:
//   "timeouts"`, right after the second of them). A step of the student's own, or taking the seat back, starts the
//   count again from 0. Bots and the club closing never count.
// - A seat in trusteeship is still asked: its `your_turn` has a deadline `trusteeDelaySeconds` after the step was
//   asked and shows the bank as it is; at that deadline the trustee makes the step (`auto: "trustee"`), and the bank is
//   not spent. A valid step of the student's before it takes the seat back (`trustee` off, `reason: "off"`) and is the
//   student's step; an illegal one does not. `trustee.off` while the seat is asked gives it a new `your_turn` for the
//   same turn, with the deadline the step would have had out of trusteeship (or now, if that is past).
// - A step is due at the moment its time runs out; a step of the student's at that very moment is too late. Steps are
//   made only when a call comes: `tick` (about once a second), and `handle` and `trusteeOff`, which first make every
//   step due by their `now`, so whether a late step counts never depends on when the last tick was. One call may make
//   several steps in a row (a timeout, then bots, then a seat in trusteeship whose own deadline is also past). Each
//   step due is made as at the moment it was due, so the next seat's step is asked from that moment, not from the
//   call's `now`: how late a tick comes changes nothing but when the steps are sent. A seat whose step is already due
//   when it is asked is not sent a `your_turn` for it.
// - Bots play at once (`auto: "bot"`). `finish` (the club closing) hands every student seat to the trustee and plays
//   the game out at once (`auto: "closing"`).
//
// Without the clock (`clock: false`, for the club layer's tests): every `your_turn` has a deadline a fixed
// `turnSeconds` after it is sent and no time bank (`timeBankSeconds: 0`), nothing ever times out and `tick` does
// nothing. A seat in trusteeship (only a test puts one there) is not asked: the trustee plays its steps at once.

type YourTurn = Static<typeof YourTurnMessage>

export interface DoudizhuGameOptions {
  /**
   * The decks every game deals, in order: the first deal, then one for each redeal. Fewer than the rules'
   * `bidRedealLimit` are filled up with the last one. Shuffled with `random` when absent.
   */
  readonly decks?: readonly (readonly Card[])[]
  /**
   * The first bidder of a room's first game; random when absent. Each later game's is the seat after the first bidder
   * of the previous game's last deal (redeals included), which is what a session hands on (`DoudizhuCarry`).
   */
  readonly firstBidder?: number
  /** Shuffles the decks and picks the first bidder; `crypto.randomInt` when absent. */
  readonly random?: RandomInt
  readonly rules?: Rules
  /**
   * Whether the steps are timed (see the top of this file); true by default. False is the game without the clock, for
   * the club layer's tests: a fixed `turnSeconds`, no time bank, no timeouts.
   */
  readonly clock?: boolean
  /** Each seat's time bank for a whole game (`club.timeBankSeconds`); 120 by default. Only with the clock. */
  readonly timeBankSeconds?: number
  /** How long a seat in trusteeship is given before the trustee acts (`club.trusteeDelaySeconds`); 2 by default. */
  readonly trusteeDelaySeconds?: number
  /** Without the clock: how long after a `your_turn` its deadline is; 60 seconds by default. */
  readonly turnSeconds?: number
  /** `welcome.stats`; all 0 by default. */
  readonly stats?: (studentId: number) => Static<typeof ClubStatsSummary>
}

/** The options a session is made with: the game's, with the rules in force. */
export type DoudizhuSessionOptions = DoudizhuGameOptions & { readonly rules: Rules }

/** Makes the session of one game; a subclass of `DoudizhuSession` may be made in its place. */
export type MakeDoudizhuSession = (start: SessionStart, options: DoudizhuSessionOptions, gameId: number) => DoudizhuSession

const NO_STATS: Static<typeof ClubStatsSummary> = { games: 0, wins: 0, points: { total: 0, week: 0 } }

/** What a game of doudizhu hands on to the room's next (`GameSession.carry`). */
export interface DoudizhuCarry {
  /** The first bidder of the game's last deal (after its redeals, if any). */
  readonly firstBidder: number
}

/** The first bidder a carry names, or null when it is not a doudizhu carry. */
function carriedFirstBidder(carry: unknown): number | null {
  if (typeof carry !== 'object' || carry === null) return null
  const firstBidder = (carry as { firstBidder?: unknown }).firstBidder
  return typeof firstBidder === 'number' && Number.isInteger(firstBidder) && firstBidder >= 0 && firstBidder < 3
    ? firstBidder
    : null
}

/** How often a seat's steps were not its own, or were refused, in one game: for its record. */
export interface SeatCounts {
  /** Steps that timed out (`auto: "timeout"`). */
  timeouts: number
  /** Steps the trustee made while the seat was in trusteeship (`auto: "trustee"`); not those as the club closed. */
  trusteeMoves: number
  /** Steps refused with `illegal_move`. */
  illegalMoves: number
}

/** A reaction at the table as a session keeps it: the club layer's `GameReaction`, and when it was sent. */
export interface KeptReaction extends GameReaction {
  readonly at: Date
}

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
    drain: async () => {},
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
  private readonly rules: Rules
  private readonly clocked: boolean
  private readonly turnMillis: number
  private readonly trusteeDelayMillis: number
  protected readonly trustees: boolean[]
  /**
   * Each seat's time bank in milliseconds, as it was when the seat's step out now was asked (what it spends past the
   * deadline is taken off when the step is made); always 0 without the clock.
   */
  private readonly banks: number[]
  /** Timeouts in a row among each seat's own steps. */
  private readonly timeoutsInRow: number[] = [0, 0, 0]
  private readonly counts: SeatCounts[] = [0, 1, 2].map(() => ({ timeouts: 0, trusteeMoves: 0, illegalMoves: 0 }))
  /** The address of each student seat now, or of its last connection; null for a bot or when not known. */
  private readonly seatAddresses: (string | null)[]
  /** The reactions sent to the whole table during the game, oldest first. */
  private readonly tableReactions: KeptReaction[] = []
  private current: GameState
  private started = false
  /** The deadline of the `your_turn` out now; null when nobody is asked. */
  protected deadline: Date | null = null
  /** With the clock: when the step out now is made for the seat if it has not made it (ms); null when not asked. */
  private due: number | null = null
  /** When the step out now was asked (ms). */
  private askedAt = 0
  /** Whether the step out now was asked of a seat in trusteeship (the short deadline, the bank not spent). */
  private askedInTrusteeship = false

  constructor(start: SessionStart, options: DoudizhuSessionOptions, gameId: number) {
    if (start.players.length !== 3) throw new Error(`doudizhu has 3 seats, not ${start.players.length}`)
    if (start.players.every((p) => p.bot)) throw new Error('a game needs a student')
    this.gameId = gameId
    this.roomId = start.roomId
    this.players = [...start.players]
    this.closesAt = start.closesAt
    this.rules = options.rules
    this.clocked = options.clock ?? true
    this.turnMillis = (options.turnSeconds ?? 60) * 1000
    this.trusteeDelayMillis = (options.trusteeDelaySeconds ?? 2) * 1000
    const bank = this.clocked ? (options.timeBankSeconds ?? 120) * 1000 : 0
    this.banks = [bank, bank, bank]
    this.trustees = [false, false, false]
    this.seatAddresses = this.players.map((player, seat) => (player.bot ? null : (start.addresses[seat] ?? null)))
    const random = options.random
    const carried = carriedFirstBidder(start.carry)
    this.firstBidder =
      carried !== null ? (carried + 1) % 3 : (options.firstBidder ?? (random ?? cryptoRandomInt)(3))
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
    // Whatever was due before this message came is made first: a step that comes too late finds its turn gone.
    const emits: GameEmit[] = []
    this.catchUp(emits, now)
    const state = this.current
    if (state.phase === 'over' || message.turn !== state.turn) {
      return { ack: fail('stale_turn'), output: this.output(emits, now) }
    }
    if (state.toAct !== seat) return { ack: fail('not_your_turn'), output: this.output(emits, now) }
    let step: StepResult
    if (message.type === 'bid' && state.phase === 'bidding') step = bid(state, seat, message.bid)
    else if (message.type === 'pass' && state.phase === 'playing') step = pass(state, seat)
    else if (message.type === 'play' && state.phase === 'playing') step = play(state, seat, playInput(message))
    else return { ack: fail('invalid_message'), output: this.output(emits, now) }

    if (!step.ok) {
      this.counts[seat]!.illegalMoves++
      const retry = {
        turn: state.turn,
        deadline: this.deadline!.toISOString(),
        timeBankSeconds: shownSeconds(this.bankNow(seat, now)),
      }
      return { ack: fail('illegal_move', { ...defined(step.error), retry }), output: this.output(emits, now) }
    }
    this.banks[seat] = this.bankNow(seat, now)
    this.timeoutsInRow[seat] = 0
    if (this.trustees[seat]) {
      this.trustees[seat] = false
      emits.push({ to: 'room', event: { kind: 'trustee', seat, on: false, reason: 'off' } })
    }
    this.current = step.state
    this.clearAsk()
    this.tell(emits, step.events, true)
    return { ack: { ok: true, result: { turn: message.turn } }, output: this.advance(emits, now, null) }
  }

  trusteeOff(seat: number, now: Date): GameReply {
    this.assertStarted()
    const emits: GameEmit[] = []
    this.catchUp(emits, now)
    if (this.over || !this.trustees[seat]) return { ack: fail('not_trustee'), output: this.output(emits, now) }
    this.trustees[seat] = false
    this.timeoutsInRow[seat] = 0
    emits.push({ to: 'room', event: { kind: 'trustee', seat, on: false, reason: 'off' } })
    if (this.clocked && this.current.toAct === seat && this.deadline !== null) {
      // Asked with the short deadline of trusteeship: asked again, the same turn, with the step's own deadline (from
      // when it was asked), or now if that is past.
      const deadline = Math.max(deadlineOf(this.askedAt, stepLimitMs(this.rules, this.phaseNow())), now.getTime())
      this.deadline = new Date(deadline)
      this.askedInTrusteeship = false
      this.due = dueAt(deadline, this.banks[seat]!, false)
      if (this.due > now.getTime()) emits.push({ to: 'seat', seat, message: this.yourTurn(seat, now) })
    }
    return { ack: { ok: true }, output: this.advance(emits, now, null) }
  }

  tick(now: Date): GameOutput {
    this.assertStarted()
    if (this.over || this.due === null || this.due > now.getTime()) return this.idle()
    return this.advance([], now, null)
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
    this.clearAsk()
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

  reacted(reaction: GameReaction, now: Date): void {
    if (this.over) return
    this.tableReactions.push({ ...reaction, at: now })
  }

  addressChanged(seat: number, address: string | null, _now: Date): void {
    if (this.over || this.players[seat]?.bot !== false) return
    this.seatAddresses[seat] = address
  }

  /** The first bidder of the deal now: of the last deal, once the game is over. */
  carry(): DoudizhuCarry {
    return { firstBidder: this.current.firstBidder }
  }

  /** The reactions sent to the whole table during the game, oldest first. */
  get reactions(): readonly KeptReaction[] {
    return this.tableReactions
  }

  /** The address of each student seat (null for a bot, or when not known), by seat. */
  get addresses(): readonly (string | null)[] {
    return this.seatAddresses
  }

  /** How often each seat timed out, was played by the trustee or made an illegal step so far, by seat. */
  get seatCounts(): readonly Readonly<SeatCounts>[] {
    return this.counts.map((c) => ({ ...c }))
  }

  /** The time bank of `seat` at `now`, in milliseconds: what it is left with if it acts now. */
  bankAt(seat: number, now: Date): number {
    return this.current.toAct === seat ? this.bankNow(seat, now) : this.banks[seat]!
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
   * Plays every step that is not a student's to make now (bots, every seat when `closing`, a seat in trusteeship
   * without the clock, and, with the clock, every step due by `now`, each as at the moment it was due), then asks the
   * student to act, if any, with a `your_turn`. Gives what it sends, after `checkOutput`.
   */
  protected advance(emits: GameEmit[], now: Date, closing: 'closing' | null): GameOutput {
    this.run(emits, now, closing)
    return this.output(emits, now)
  }

  private output(emits: GameEmit[], now: Date): GameOutput {
    const output: GameOutput = { emits, over: this.over }
    this.checkOutput(output, now)
    return output
  }

  /** With the clock, makes every step due by `now` (see `advance`); nothing when none is. */
  private catchUp(emits: GameEmit[], now: Date): void {
    if (!this.over && this.due !== null && this.due <= now.getTime()) this.run(emits, now, null)
  }

  private run(emits: GameEmit[], now: Date, closing: 'closing' | null): void {
    // The moment the last step was made: `now`, or when the step made here last was due.
    let at = now.getTime()
    for (;;) {
      const seat = this.current.toAct
      if (seat === null) break
      let auto: Exclude<Auto, null> | null = this.players[seat]!.bot
        ? 'bot'
        : closing ?? (!this.clocked && this.trustees[seat] ? 'trustee' : null)
      if (auto === null) {
        const asking = this.deadline === null
        if (asking) this.ask(seat, at)
        if (this.due === null || this.due > now.getTime()) {
          if (asking) emits.push({ to: 'seat', seat, message: this.yourTurn(seat, now) })
          break
        }
        // Due by now: the trustee makes the step, as at the moment it was due.
        at = this.due
        auto = this.askedInTrusteeship ? 'trustee' : 'timeout'
        if (auto === 'timeout') this.banks[seat] = 0
        this.clearAsk()
      }
      this.act(emits, seat, auto, closing === null)
      // The second timeout in a row puts the seat in trusteeship, once its step is told (unless it ended the game).
      if (auto === 'timeout' && ++this.timeoutsInRow[seat]! >= 2 && !this.over) {
        this.timeoutsInRow[seat] = 0
        this.trustees[seat] = true
        emits.push({ to: 'room', event: { kind: 'trustee', seat, on: true, reason: 'timeouts' } })
      }
    }
  }

  /** Asks the student in `seat` for its step, at `at` (ms): its deadline, and when it is made for it if it is not. */
  private ask(seat: number, at: number): void {
    const inTrusteeship = this.clocked && this.trustees[seat]!
    const limit = !this.clocked
      ? this.turnMillis
      : inTrusteeship
        ? this.trusteeDelayMillis
        : stepLimitMs(this.rules, this.phaseNow())
    const deadline = deadlineOf(at, limit)
    this.askedAt = at
    this.deadline = new Date(deadline)
    this.askedInTrusteeship = inTrusteeship
    this.due = this.clocked ? dueAt(deadline, this.banks[seat]!, inTrusteeship) : null
  }

  private clearAsk(): void {
    this.deadline = null
    this.due = null
    this.askedInTrusteeship = false
  }

  /** The bank of the seat asked to act, at `now`: not spent in trusteeship, nor before the deadline. */
  private bankNow(seat: number, now: Date): number {
    const bank = this.banks[seat]!
    if (this.deadline === null || this.askedInTrusteeship) return bank
    return bankLeftAt(bank, this.deadline.getTime(), now.getTime())
  }

  private phaseNow(): Exclude<GameState['phase'], 'over'> {
    const phase = this.current.phase
    if (phase === 'over') throw new Error('the game is over')
    return phase
  }

  /** The trustee's step for `seat`, marked `auto`, counted for the seat's record. */
  private act(emits: GameEmit[], seat: number, auto: Exclude<Auto, null>, hands: boolean): void {
    if (auto === 'timeout') this.counts[seat]!.timeouts++
    else if (auto === 'trustee') this.counts[seat]!.trusteeMoves++
    const step = actFor(this.current, auto)
    this.current = step.state
    this.tell(emits, step.events, hands)
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
      timeBankSeconds: shownSeconds(this.bankNow(seat, now)),
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
