import { expect } from 'vitest'
import type { Static } from 'typebox'
import type { AckResult } from '../../../src/club/game.js'
import { studentPerson } from '../../../src/club/people.js'
import { type ClubStudent, type RoomListeners, Rooms } from '../../../src/club/rooms.js'
import type { RoomState, YourTurnMessage } from '../../../src/protocol/club.js'
import { loadSchoolConfig, type SchoolConfig } from '../../../src/shared/config.js'
import { ackFrame, answer, checkProtocol, type FakeGame, fakeGame, type FakeGameOptions, QUICK_DECK } from './fake-game.js'
import { RecordingOutbox } from './outbox.js'

// The rooms with the fake game, a recording outbox and a clock that moves only when a test moves it.

export const exampleConfig = loadSchoolConfig('config/school.example.json')

export const T0 = new Date('2026-11-20T03:00:00.000Z')

/** A student of their own owner (`owner<id>@example.com`), unless `email` says otherwise. */
export function student(id: number, email = `owner${id}@example.com`): ClubStudent {
  return {
    person: { ...studentPerson({ id, ownerName: `主人${id}`, aiName: `小鱼${id}` }), className: '初中部·晚班·3 班' },
    email,
  }
}

export interface Harness {
  readonly rooms: Rooms
  readonly outbox: RecordingOutbox
  readonly game: FakeGame
  readonly config: SchoolConfig
  /** The time now. */
  now: Date
  /** Moves the clock on by `seconds` and ticks. */
  advance(seconds: number): void
}

export interface HarnessOptions {
  readonly club?: Partial<SchoolConfig['club']>
  readonly game?: FakeGameOptions
  readonly spectators?: (roomId: string) => readonly number[]
  readonly listeners?: RoomListeners
  readonly randomInt?: (max: number) => number
  readonly onError?: (roomId: string, err: unknown) => void
  readonly nextClose?: (now: Date) => Date
}

export function harness(options: HarnessOptions = {}): Harness {
  const config: SchoolConfig = { ...exampleConfig, club: { ...exampleConfig.club, ...options.club } }
  const outbox = new RecordingOutbox()
  const game = fakeGame(options.game ?? { decks: [QUICK_DECK], firstBidder: 0 })
  const rooms = new Rooms({
    config,
    game,
    outbox,
    ...(options.spectators === undefined ? {} : { spectators: options.spectators }),
    ...(options.listeners === undefined ? {} : { listeners: options.listeners }),
    ...(options.randomInt === undefined ? {} : { randomInt: options.randomInt }),
    ...(options.onError === undefined ? {} : { onError: options.onError }),
    ...(options.nextClose === undefined ? {} : { nextClose: options.nextClose }),
  })
  const h: Harness = {
    rooms,
    outbox,
    game,
    config,
    now: T0,
    advance(seconds) {
      h.now = new Date(h.now.getTime() + seconds * 1000)
      rooms.tick(h.now)
    },
  }
  return h
}

type Room = Static<typeof RoomState>

/** Checks the ack on the wire, and the result by its definition when given. */
export function checkAck(result: AckResult, definition?: 'RoomResult' | 'QuickJoinResult'): AckResult {
  checkProtocol('ClubAckMessage', ackFrame('m1', result))
  if (definition !== undefined) {
    expect(result.ok).toBe(true)
    checkProtocol(definition, (result as { result?: unknown }).result)
  }
  return result
}

/** The room of a successful `RoomResult` or `QuickJoinResult` ack. */
export function roomOf(result: AckResult): Room {
  if (!result.ok) throw new Error(`refused: ${result.code}`)
  return (result.result as { room: Room }).room
}

export function expectError(result: AckResult, code: string): void {
  checkAck(result)
  expect(result).toEqual({ ok: false, code })
}

/** Opens a room with `host` and seats `others` in it (none of them filling it). */
export function openRoom(h: Harness, host: ClubStudent, others: ClubStudent[] = [], visibility: 'public' | 'invite' = 'public'): string {
  const roomId = roomOf(checkAck(h.rooms.create(host, { visibility, bots: false }, h.now), 'RoomResult')).roomId
  for (const other of others) checkAck(h.rooms.join(other, roomId, h.now, { invited: true }), 'RoomResult')
  return roomId
}

type YourTurn = Static<typeof YourTurnMessage>

/** Plays the room's game to its end, each student answering their last `your_turn` with `answer`. */
export function playOut(h: Harness, roomId: string): void {
  for (let step = 0; step < 500; step++) {
    const state = h.rooms.state(roomId, h.now)!
    if (state.game === null || state.game.phase === 'over') return
    const turns = h.outbox.deliveries.filter((d) => d.message.type === 'your_turn')
    const last = turns[turns.length - 1]!
    const turn = last.message as YourTurn
    expect(last.studentId).toBe(state.seats[turn.me.seat]!.player!.studentId)
    const result = h.rooms.gameMessage(last.studentId, answer(turn), h.now)
    checkAck(result)
    expect(result.ok).toBe(true)
  }
  throw new Error('the game did not end')
}
