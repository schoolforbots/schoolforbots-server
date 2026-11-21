import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Static } from 'typebox'
import { Compile, type Validator } from 'typebox/compile'
import type { Card } from '../../../src/club/doudizhu/cards.js'
import {
  type DoudizhuGameOptions,
  doudizhuGame,
  DoudizhuSession,
  type DoudizhuSessionOptions,
} from '../../../src/club/doudizhu-game.js'
import type {
  AckResult,
  GameClientMessage,
  GameEmit,
  GameModule,
  GameOutput,
  GamePrivateMessage,
  GameRoomEvent,
  SessionStart,
} from '../../../src/club/game.js'
import type { YourTurnMessage } from '../../../src/protocol/club.js'
import { CLUB_WS_ERROR_MESSAGES } from '../../../src/club/ws-errors.js'
import { deckOf } from '../doudizhu/helpers.js'

// A game for the club layer's tests: the doudizhu the club service runs (src/club/doudizhu-game.ts: the rules engine,
// without the clock), with what only tests need on top. A test may give the decks to deal, so a game can end in two
// steps (`QUICK_DECK`), put a seat in trusteeship (`FakeSession.trusteeOn`), and look at every session started
// (`FakeGame.sessions`).
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

/** The fake game's options are the real one's (`DoudizhuGameOptions`), without the clock unless `clock: true`. */
export type FakeGameOptions = DoudizhuGameOptions

/** The fake game, with every session it started, oldest first, for a test to look at. */
export interface FakeGame extends GameModule {
  readonly sessions: readonly FakeSession[]
}

/** The doudizhu game of src/club/doudizhu-game.ts, its sessions checked against the protocol and kept. */
export function fakeGame(options: FakeGameOptions = {}): FakeGame {
  const sessions: FakeSession[] = []
  const game = doudizhuGame({ clock: false, ...options }, (start, o, gameId) => {
    const session = new FakeSession(start, o, gameId)
    sessions.push(session)
    return session
  })
  return { ...game, sessions }
}

/** A session of the real game whose every output is checked against the published schema, and `trusteeOn`. */
export class FakeSession extends DoudizhuSession {
  constructor(start: SessionStart, options: DoudizhuSessionOptions, gameId: number) {
    super(start, options, gameId)
  }

  /**
   * For tests: puts a student seat in trusteeship, as timeouts would (`reason: "timeouts"`). Without the clock the
   * trustee plays its steps at once (`auto: "trustee"`), so the seat is never asked and only `trusteeOff` gives it
   * back. With the clock (`clock: true`) the seat is asked as the real game asks a seat in trusteeship, with the short
   * deadline, and a step of its own takes it back too (see the top of src/club/doudizhu-game.ts).
   */
  trusteeOn(seat: number, now: Date): GameOutput {
    this.assertStarted()
    if (this.over || this.players[seat]!.bot || this.trustees[seat]) return this.idle()
    this.trustees[seat] = true
    const emits: GameEmit[] = [{ to: 'room', event: { kind: 'trustee', seat, on: true, reason: 'timeouts' } }]
    if (this.state.toAct === seat) this.deadline = null
    return this.advance(emits, now, null)
  }

  protected override checkOutput(output: GameOutput, now: Date): void {
    checkOutput(this.roomId, output, now)
  }

  protected override checkPrivate(messages: readonly GamePrivateMessage[]): void {
    messages.forEach((message) => checkProtocol('ClubServerMessage', message))
  }
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
