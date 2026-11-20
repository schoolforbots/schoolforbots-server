import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Static } from 'typebox'
import { Compile, type Validator } from 'typebox/compile'
import type { Card } from '../../../src/club/doudizhu/cards.js'
import type { RandomInt } from '../../../src/club/doudizhu/deal.js'
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
} from '../../../src/club/doudizhu/index.js'
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
} from '../../../src/club/game.js'
import type { ClubStatsSummary, YourTurnMessage } from '../../../src/protocol/club.js'
import { CLUB_WS_ERROR_MESSAGES } from '../../../src/club/ws-errors.js'
import { deckOf } from '../doudizhu/helpers.js'

// A game for the club layer's tests: real doudizhu, played by the rules engine, without the clock. Every `your_turn`
// has a deadline a fixed `turnSeconds` after it is sent and no time bank, nothing ever times out and `tick` does
// nothing. Bots play at once (the trustee's steps, `auto: "bot"`); `finish` puts every student seat in trusteeship and
// plays the game out (`auto: "closing"`). A test may give the decks to deal, so a game can end in two steps
// (`QUICK_DECK`).
//
// Every message the fake game sends is checked against the published `protocol/club.schema.json` as it is made, and a
// message that is not valid throws, so a test that plays through the fake game checks the room events, hands and
// turns of every game it plays.

// ---- The published schemas ----

const SCHEMA_FILE = fileURLToPath(new URL('../../../protocol/club.schema.json', import.meta.url))
const DEFS = (JSON.parse(readFileSync(SCHEMA_FILE, 'utf8')) as { $defs: Record<string, object> }).$defs
const validators = new Map<string, Validator>()

/** Throws unless `value` is valid by the definition `name` of `protocol/club.schema.json`. */
export function checkProtocol(name: string, value: unknown): void {
  let validator = validators.get(name)
  if (validator === undefined) {
    const schema = DEFS[name]
    if (schema === undefined) throw new Error(`protocol/club.schema.json has no definition ${name}`)
    validator = Compile(schema as never)
    validators.set(name, validator)
  }
  if (!validator.Check(value)) {
    const errors = validator.Errors(value).slice(0, 5).map((e) => `${e.instancePath} ${e.message}`)
    throw new Error(`not a valid ${name}: ${errors.join('; ')}\n${JSON.stringify(value)}`)
  }
}

/** Throws unless `event` makes a valid `room.event` (with any `seq`, `at` and `replayed`). */
export function checkRoomEvent(roomId: string, event: GameRoomEvent, at: Date): void {
  checkProtocol('RoomEventMessage', { type: 'room.event', roomId, seq: 1, replayed: false, at: at.toISOString(), event })
}

/** Throws unless every emit of `output` is valid on the wire. */
export function checkOutput(roomId: string, output: GameOutput, at: Date): void {
  for (const emit of output.emits) checkEmit(roomId, emit, at)
}

function checkEmit(roomId: string, emit: GameEmit, at: Date): void {
  if (emit.to === 'room') checkRoomEvent(roomId, emit.event, at)
  else checkProtocol('ClubServerMessage', emit.message)
}

/** The `ack` the club layer would send for `ack`, as the published `ClubAckMessage` checks it. */
export function ackFrame(id: string, ack: AckResult): unknown {
  if (ack.ok) {
    return ack.result === undefined ? { type: 'ack', id, ok: true } : { type: 'ack', id, ok: true, result: ack.result }
  }
  const error = { ...ack.extra, code: ack.code, message: CLUB_WS_ERROR_MESSAGES[ack.code] }
  return { type: 'ack', id, ok: false, error }
}

// ---- Decks ----

/**
 * A deck where seat 0, bidding 3 and taking the bottom cards J Q Q, holds the pair straight 33 44 … QQ, 20 cards in
 * one move: seat 0 bids 3 (turn 1) and plays it (turn 2), and the game is over, a landlord's spring.
 */
export const QUICK_DECK: readonly Card[] = deckOf(
  '3 3 4 4 5 5 6 6 7 7 8 8 9 9 10 10 J',
  '3 3 4 4 5 5 6 6 7 7 K K K K A A 小王',
  '8 8 9 9 10 10 J A A 2 2 2 2 大王 Q Q J',
  'J Q Q',
)

// ---- The game ----

type YourTurn = Static<typeof YourTurnMessage>

export interface FakeGameOptions {
  /**
   * The decks every game deals, in order: the first deal, then one for each redeal. Fewer than the rules'
   * `bidRedealLimit` are filled up with the last one. Shuffled with `random` when absent.
   */
  readonly decks?: readonly (readonly Card[])[]
  /** The first bidder of a room's first game; random when absent. Each later game's goes one seat on. */
  readonly firstBidder?: number
  /** Shuffles the decks and picks the first bidder; `crypto.randomInt` when absent. */
  readonly random?: RandomInt
  readonly rules?: Rules
  /** How long after a `your_turn` its deadline is; 60 seconds by default. */
  readonly turnSeconds?: number
  /** `welcome.stats`; all 0 by default. */
  readonly stats?: (studentId: number) => Static<typeof ClubStatsSummary>
}

/** The fake game, with every session it started, oldest first, for a test to look at. */
export interface FakeGame extends GameModule {
  readonly sessions: readonly FakeSession[]
}

const NO_STATS: Static<typeof ClubStatsSummary> = { games: 0, wins: 0, points: { total: 0, week: 0 } }

export function fakeGame(options: FakeGameOptions = {}): FakeGame {
  const rules = options.rules ?? DEFAULT_DOUDIZHU_RULES
  const sessions: FakeSession[] = []
  let nextGameId = 1
  return {
    club: 'doudizhu',
    name: '斗地主社',
    seats: 3,
    reactions: { kinds: ['emoji', 'phrase'], visibility: ['room'] },
    rules: () => ({ ...rules }),
    stats: async (studentId) => options.stats?.(studentId) ?? NO_STATS,
    sessions,
    newSession(start) {
      const session = new FakeSession(start, { ...options, rules }, nextGameId++)
      sessions.push(session)
      return session
    },
  }
}

const NOTHING: GameOutput = { emits: [], over: false }

const fail = (code: Extract<AckResult, { ok: false }>['code'], extra?: object): AckResult =>
  extra === undefined ? { ok: false, code } : { ok: false, code, extra }

/** The fields of `value` that are not `undefined`. */
const defined = <T extends object>(value: T): T =>
  Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T

export class FakeSession implements GameSession {
  readonly gameId: number
  /** The first bidder of the first deal. */
  readonly firstBidder: number
  private readonly roomId: string
  private readonly players: readonly SeatPlayer[]
  private readonly closesAt: (now: Date) => Date
  private readonly turnMillis: number
  private readonly trustees: boolean[]
  private current: GameState
  private started = false
  /** The deadline of the `your_turn` out now; null when nobody is asked. */
  private deadline: Date | null = null

  constructor(start: SessionStart, options: FakeGameOptions & { rules: Rules }, gameId: number) {
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
      start.previous instanceof FakeSession
        ? (start.previous.firstBidder + 1) % 3
        : (options.firstBidder ?? (random ?? ((n: number) => Math.floor(Math.random() * n)))(3))
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

  /** The engine's state, for a test to look at. */
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

  /**
   * For tests: puts a student seat in trusteeship, as timeouts would (`reason: "timeouts"`). The trustee plays its
   * steps at once (`auto: "trustee"`) until `trusteeOff` or a step of its own.
   */
  trusteeOn(seat: number, now: Date): GameOutput {
    this.assertStarted()
    if (this.over || this.players[seat]!.bot || this.trustees[seat]) return this.idle()
    this.trustees[seat] = true
    const emits: GameEmit[] = [{ to: 'room', event: { kind: 'trustee', seat, on: true, reason: 'timeouts' } }]
    if (this.current.toAct === seat) this.deadline = null
    return this.advance(emits, now, null)
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
    messages.forEach((message) => checkProtocol('ClubServerMessage', message))
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

  private assertStarted(): void {
    if (!this.started) throw new Error('the session has not started')
  }

  private idle(): GameOutput {
    return { emits: [], over: this.over }
  }

  /**
   * Plays every step that is not a student's to make (bots, seats in trusteeship, and every seat when `closing`), then
   * asks the student to act, if any, with a `your_turn`. Checks what it sends and gives it.
   */
  private advance(emits: GameEmit[], now: Date, closing: 'closing' | null): GameOutput {
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
    checkOutput(this.roomId, output, now)
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

/**
 * A plain answer to a `your_turn`, for tests that only need a game to go on: the highest bid allowed, the first move
 * of the list, or a pass when there is none.
 */
export function answer(turn: YourTurn): GameClientMessage {
  if (turn.phase === 'bid') {
    return { id: `t${turn.turn}`, type: 'bid', game: 'doudizhu', turn: turn.turn, bid: Math.max(...turn.bids!) }
  }
  const move = turn.moves![0]
  if (move === undefined) return { id: `t${turn.turn}`, type: 'pass', game: 'doudizhu', turn: turn.turn }
  return { id: `t${turn.turn}`, type: 'play', game: 'doudizhu', turn: turn.turn, moveId: move.id }
}
