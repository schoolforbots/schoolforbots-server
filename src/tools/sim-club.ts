import type { Static } from 'typebox'
import { Compile } from 'typebox/compile'
import WebSocket from 'ws'
import { ClubServerMessage, type Rank } from '../protocol/club.js'
import type { Clock } from '../shared/clock.js'
import { SIM_PLUGIN, type SeededStudent } from './dev-seed.js'

// The club simulator's bots: each one a seeded student who connects to the club service, gets a seat at a table, plays
// a few games there, leaves and finds another table, again and again, the way a careless but honest plugin would. It
// only uses what the protocol gives it: a bid is picked from the `bids` of a `your_turn`, a move from its `moves`.
//
// - Tables are formed three ways (`TableMode`): a group of three bots of this process, the first of which opens a room
//   by invitation and invites the other two, who accept; quick join (`room.quick`); or a public room with bots in the
//   free seats (`bots: true`). After `games` games at a table a bot leaves it and forms another a few seconds later;
//   so does it when it is asked out of the room, when the room closes, when the invitations of its group expire, and
//   at an idle prompt (where a bot that plays with bots asks for bots instead).
// - At every `your_turn` it thinks for a while and answers; now and then, on purpose, it takes the paths a real plugin
//   takes by mistake: it lets the step time out (`timeoutRate`), first sends cards it does not hold and then a legal
//   step with the `retry` of the refusal (`illegalRate`), drops its connection after a live room event and comes back
//   one to four seconds later with `roomId` and `lastSeq` (`dropRate`), and sends a reaction at the table, from the
//   emoji and phrases of `welcome`, within its limits (`reactRate`). Once in trusteeship it takes its seat back at its
//   next `your_turn`, half of the time with a legal step and half with `trustee.off`.
// - `closing`: when the club is closed it comes back at `reopensAt`; maintenance and the service stopping are expected
//   (it comes back a few seconds later, until it is stopped); `replaced` is expected and ends it. A connection closed
//   with no `closing` and not by the bot is an unexpected disconnect. Every message received is checked against the
//   protocol's `ClubServerMessage`; one that does not follow it counts as invalid and is otherwise ignored.
// - What it sees and does is counted in its `tally`; the delays go to a `ClubSampler`: the ack of each game action
//   (sent to acked), and each hand-off (the `at` of the live game event that came before a `your_turn`, to the moment
//   that `your_turn` arrived; nothing that was replayed after a reconnect).
//
// Every random choice comes from the bot's own `random`; `createClubBots` seeds one per bot, so the same seed makes the
// same choices given the same messages from the service. Time is read from `clock` and waited with `timers`, both
// given from outside, as is the WebSocket.

/** How a bot gets a seat at a table. */
export type TableMode = 'invite' | 'quick' | 'bots'

export interface ClubSimOptions {
  /** The club service's WebSocket address, e.g. ws://localhost:8082/v1/club. */
  url: string
  /** How many games a bot plays at one table before it leaves it. */
  games: number
  /** How long a bot thinks before each step, at random within this range (ms). */
  thinkMs: readonly [number, number]
  /** The chance that a bot passes when it may. */
  passRate: number
  /** The chance that a bot lets a step time out. */
  timeoutRate: number
  /** The chance that a bot first plays cards it does not hold, then a legal step. */
  illegalRate: number
  /** The chance that a bot drops its connection after a live room event. */
  dropRate: number
  /** The chance that a bot sends a reaction after a live room event, within the club's limits. */
  reactRate: number
}

/** How long a bot waits for things (ms); the defaults are for a real run, a test may make them shorter. */
export interface ClubSimTiming {
  /** How long a bot stays away after dropping its connection, at random within this range. */
  awayMs: readonly [number, number]
  /** How long a bot waits to connect again after being sent away (maintenance, the service stopping) or failing. */
  retryMs: number
  /** How long after `reopensAt` a bot comes back at most, at random, so that they do not all come at once. */
  reopenSpreadMs: number
  /** How long a bot waits for a club whose `reopensAt` is not known. */
  closedRetryMs: number
  /** How long a bot waits before forming another table after leaving one, at random within this range. */
  reformMs: readonly [number, number]
  /** How long the first of an invitation group waits before looking again for the other two to be free. */
  groupWaitMs: number
  /** How long a bot sits at a table with no game before it gives up on it and forms another. */
  seatWaitMs: number
}

export const DEFAULT_TIMING: ClubSimTiming = {
  awayMs: [1000, 4000],
  retryMs: 3000,
  reopenSpreadMs: 5000,
  closedRetryMs: 60_000,
  reformMs: [2000, 5000],
  groupWaitMs: 1000,
  seatWaitMs: 60_000,
}

/** What one bot saw and did. */
export interface ClubBotTally {
  /** Connections opened, and how many of them were welcomed. */
  connects: number
  welcomes: number
  /** Connection tries that never got in: refused, or an error on the way. */
  connectFailures: number
  /** Connections closed with no `closing` that the bot did not close: there should be none. */
  unexpectedDisconnects: number
  /** Drops on purpose, and welcomes after one back in the same room. */
  drops: number
  reconnects: number
  /** `closing` received, by reason. */
  closings: Record<string, number>
  /** Messages that do not follow the protocol: there should be none. */
  invalid: number
  /** Refused messages, by error code (`illegal_move` included). */
  refusals: Record<string, number>
  /** Seats taken, by how the table was formed. */
  seated: Record<TableMode, number>
  /**
   * Tables left to form another, by why: `games` played, `invite_expired`, `idle`, `waited` (no game started within
   * the wait), and the reasons of a `room.left` the bot did not ask for (`not_ready`, `closed`).
   */
  reforms: Record<string, number>
  /** Idle prompts answered with `room.bots`. */
  botsAsked: number
  /** `your_turn` received, and the steps the bot answered. */
  turns: number
  steps: number
  /** Steps let time out on purpose. */
  timeoutsLeft: number
  /** Steps of the bot's seat the service made: on a timeout, in trusteeship, and as the club closed or service stopped. */
  timeoutSteps: number
  trusteeSteps: number
  closingSteps: number
  /** Trusteeship of the bot's seat: on after timeouts, on as the club closed, and off. */
  trusteeOn: number
  trusteeOnClosing: number
  trusteeOff: number
  /** Seats taken back from the trustee, acked: by a legal step, or by `trustee.off`. */
  takeBackByStep: number
  takeBackByOff: number
  /** Plays of cards not in hand sent on purpose, their `illegal_move` refusals, and the legal steps sent again after. */
  illegalSent: number
  illegalRefused: number
  retries: number
  /** Reactions sent, and refused. */
  reactsSent: number
  reactsRefused: number
  /** Frames held back for a moment to stay within `framesPerMinute`, and steps among them dropped past their deadline. */
  framesHeld: number
  framesDropped: number
  /** Reconnects to learn the room the service says the bot sits in, after an `in_room` it did not expect. */
  resyncs: number
  /** Games seen to the end (`over`), and how many of them were played out as the club closed or the service stopped. */
  gamesOver: number
  gamesClosing: number
  /** The games seen to the end, by number: their records should be found for this student. */
  gameIds: Set<number>
  /** Of those, the games played out as the club closed or the service stopped. */
  closingGameIds: Set<number>
  /** Why the bot stopped; null while it is going. */
  ended: string | null
}

/** The delays the bots of one process measure together (ms). */
export interface ClubSampler {
  /** From sending a game action (`bid`, `play`, `pass`) to its ack. */
  ackMs: number[]
  /**
   * From the `at` of the live game event before a `your_turn` (the step before it, or the `dealt` or `landlord` that
   * starts the bidding or the play) to receiving that `your_turn`. `at` is read on the service's clock and the receipt
   * on the bot's: against a remote service the difference of the two clocks is in it.
   */
  turnMs: number[]
}

export function createClubSampler(): ClubSampler {
  return { ackMs: [], turnMs: [] }
}

/** Waits on time; `setTimeout` by default, a test may give its own. */
export interface Timers {
  set(fn: () => void, ms: number): unknown
  clear(handle: unknown): void
}

export const realTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as NodeJS.Timeout | undefined),
}

/** Opens a WebSocket to `url` as the student with `key`. */
export type ConnectSocket = (url: string, key: string) => WebSocket

export const connectSocket: ConnectSocket = (url, key) =>
  new WebSocket(url, { headers: { authorization: `Bearer ${key}` } })

export interface ClubBotDeps {
  clock: Clock
  random: () => number
  /** Writes one line of the console. */
  print: (line: string) => void
  sampler?: ClubSampler
  timers?: Timers
  connect?: ConnectSocket
  timing?: Partial<ClubSimTiming>
  /** The invitation group of a bot of mode `invite`; its first member opens the room and invites the others. */
  group?: InviteGroup
  /** Called once when the bot stops by itself (`replaced`, a key the service does not know, ...). */
  onEnded?: () => void
}

export interface ClubBot {
  readonly student: SeededStudent
  readonly mode: TableMode
  readonly tally: ClubBotTally
  start(): void
  /** Stops the bot where it is: no reconnect, no timer left. */
  stop(): void
  /** Whether the bot is connected, welcomed and in no room, and so may be invited. */
  isFree(): boolean
  /** Ends the bot as if it stopped by itself, for `reason` (another of its invitation group has stopped). */
  endWith(reason: string): void
  /** Handles a message as if it came over the connection (for tests). */
  receive(message: object): void
}

/** Three bots that sit at the same table: the first opens the room and invites the other two. */
export interface InviteGroup {
  members: ClubBot[]
}

type Message = Static<typeof ClubServerMessage>
type Of<T extends Message['type']> = Extract<Message, { type: T }>
type RoomEvent = Of<'room.event'>['event']
type Card = Static<typeof Rank>
type Room = NonNullable<Of<'welcome'>['room']>

/** Every rank, with how many of it a deck has. */
const RANK_COUNTS: readonly (readonly [Card, number])[] = [
  ['3', 4],
  ['4', 4],
  ['5', 4],
  ['6', 4],
  ['7', 4],
  ['8', 4],
  ['9', 4],
  ['10', 4],
  ['J', 4],
  ['Q', 4],
  ['K', 4],
  ['A', 4],
  ['2', 4],
  ['小王', 1],
  ['大王', 1],
]

const MINUTE_MS = 60_000

/**
 * The protocol's check of a server message, compiled once: checked by interpreting the schema, a `your_turn` with a
 * long list of moves takes milliseconds, which with hundreds of bots in one process would show in the delays measured.
 */
const checkServerMessage = Compile(ClubServerMessage)

/** How long past `inviteSeconds` a bot at a table it formed by invitation waits before it gives up on it (ms). */
const INVITE_MARGIN_MS = 5000

/** A play the bot cannot make: one card more of a rank than its hand holds (there is always such a rank). */
export function cardsNotInHand(hand: readonly Card[]): Card[] {
  for (const [rank, inDeck] of RANK_COUNTS) {
    const held = hand.filter((c) => c === rank).length
    if (held < inDeck) return Array.from({ length: held + 1 }, () => rank)
  }
  return ['3']
}

/** A small seeded random number generator (mulberry32): the same seed gives the same numbers. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function newTally(): ClubBotTally {
  return {
    connects: 0,
    welcomes: 0,
    connectFailures: 0,
    unexpectedDisconnects: 0,
    drops: 0,
    reconnects: 0,
    closings: {},
    invalid: 0,
    refusals: {},
    seated: { invite: 0, quick: 0, bots: 0 },
    reforms: {},
    botsAsked: 0,
    turns: 0,
    steps: 0,
    timeoutsLeft: 0,
    timeoutSteps: 0,
    trusteeSteps: 0,
    closingSteps: 0,
    trusteeOn: 0,
    trusteeOnClosing: 0,
    trusteeOff: 0,
    takeBackByStep: 0,
    takeBackByOff: 0,
    illegalSent: 0,
    illegalRefused: 0,
    retries: 0,
    reactsSent: 0,
    reactsRefused: 0,
    framesHeld: 0,
    framesDropped: 0,
    resyncs: 0,
    gamesOver: 0,
    gamesClosing: 0,
    gameIds: new Set(),
    closingGameIds: new Set(),
    ended: null,
  }
}

const bump = (counts: Record<string, number>, key: string) => {
  counts[key] = (counts[key] ?? 0) + 1
}

/** What a frame sent and not yet acked was, for its ack. */
interface Pending {
  type: string
  sentAt: number
  /** A play of cards not in hand: the legal step to send with the refusal's `retry`. */
  legal?: Record<string, unknown>
  /** A step or `trustee.off` sent to take the seat back from the trustee. */
  takeBack?: boolean
  /** A frame held back until this moment is dropped instead: the turn it is for is over. */
  deadline?: number | undefined
  /** Counts the frame, once it is written. */
  counted?: () => void
}

/** Why a bot ends when another of its invitation group has. */
export const GROUP_STOPPED = '同组的机器人已停止'

/** A bot for one seeded student. Nothing happens until `start`. */
export function createClubBot(
  student: SeededStudent,
  mode: TableMode,
  opts: ClubSimOptions,
  deps: ClubBotDeps,
): ClubBot {
  const { clock, random } = deps
  const timers = deps.timers ?? realTimers
  const connectTo = deps.connect ?? connectSocket
  const timing: ClubSimTiming = { ...DEFAULT_TIMING, ...deps.timing }
  const sampler = deps.sampler ?? createClubSampler()
  const tally = newTally()
  const me = student.studentId
  const say = (what: string) => deps.print(`${student.displayName} ${what}`)
  const now = () => clock.now().getTime()
  const between = ([lo, hi]: readonly [number, number]) => lo + random() * (hi - lo)
  const pick = <T>(list: readonly T[]): T => list[Math.min(Math.floor(random() * list.length), list.length - 1)]!

  // Kept across connections: the room the bot sits in and the last of its events it has.
  let roomId: string | null = null
  let lastSeq = 0
  /** Games the bot has seen to the end at this table. */
  let gamesHere = 0
  /** Whether the table is formed by asking for bots (an idle prompt there is answered with `room.bots`). */
  let botsRoom = false
  /** A room being opened or joined: its ack has not come yet. */
  let joining = false
  /** A `room.leave` sent and not answered yet. */
  let leaving = false
  /** How long the bot waits at a table with no game: longer than an invitation lasts. */
  let seatWaitMs = timing.seatWaitMs
  /** When the bot sat down or the last game ended, while no game is on: for `seatWaitMs`. */
  let waitingSince: number | null = null
  let gameOn = false

  let socket: WebSocket | null = null
  let opened = false
  let closingSeen = false
  let dropping = false
  let reconnectTimer: unknown
  let formTimer: unknown
  /** How long to wait after the `closing` of this connection. */
  let closingRetry = timing.retryMs
  let nextId = 0

  // One connection's: reset when it closes.
  let welcomed = false
  let framesPerMinute = Number.POSITIVE_INFINITY
  let reactInterval = 0
  let reactsPerGame = 0
  let reactKinds: ('emoji' | 'phrase')[] = []
  let emoji: string[] = []
  let phrases: string[] = []
  const pending = new Map<string, Pending>()
  /** The times the frames of the last minute went out, and the frames waiting for room in it. */
  const sentTimes: number[] = []
  const held: { id: string; frame: object; entry: Pending }[] = []
  let flushTimer: unknown
  /** Timers of this connection: thinking, getting ready. */
  const connTimers = new Set<unknown>()
  /** The `at` of the last live game event, until a `your_turn` takes it as its start. */
  let lastGameEventAt: number | null = null

  // Of the game being played: reset at each deal.
  let mySeat: number | null = null
  let inTrustee = false
  let takeBackSent = false
  let closingInGame = false
  let reactsThisGame = 0
  let lastReactAt = Number.NEGATIVE_INFINITY

  const ended = () => tally.ended !== null

  function later(fn: () => void, ms: number): void {
    const handle = timers.set(() => {
      connTimers.delete(handle)
      fn()
    }, Math.max(0, ms))
    connTimers.add(handle)
  }

  function resetConnection(): void {
    welcomed = false
    pending.clear()
    sentTimes.length = 0
    held.length = 0
    timers.clear(flushTimer)
    flushTimer = undefined
    for (const handle of connTimers) timers.clear(handle)
    connTimers.clear()
    lastGameEventAt = null
    joining = false
    takeBackSent = false
  }

  function end(reason: string): void {
    if (ended()) return
    tally.ended = reason
    timers.clear(reconnectTimer)
    timers.clear(formTimer)
    say(`结束：${reason}`)
    deps.onEnded?.()
    // The others of an invitation group could only wait for it: they end too.
    for (const other of deps.group?.members ?? []) if (other !== bot) other.endWith(GROUP_STOPPED)
  }

  // ---- Sending, within the frames a minute allows ----

  function isOpen(): boolean {
    return socket !== null && socket.readyState === WebSocket.OPEN
  }

  /** Room in the last minute for one more frame. */
  function room(): boolean {
    const t = now()
    while (sentTimes.length > 0 && t - sentTimes[0]! >= MINUTE_MS) sentTimes.shift()
    return sentTimes.length < framesPerMinute
  }

  function write(id: string, frame: object, entry: Pending): void {
    entry.sentAt = now()
    sentTimes.push(entry.sentAt)
    pending.set(id, entry)
    socket!.send(JSON.stringify(frame))
    entry.counted?.()
  }

  function flush(): void {
    flushTimer = undefined
    while (held.length > 0 && isOpen() && room()) {
      const next = held.shift()!
      if (next.entry.deadline !== undefined && now() >= next.entry.deadline) {
        tally.framesDropped++
        if (next.entry.takeBack === true) takeBackSent = false
        continue
      }
      write(next.id, next.frame, next.entry)
    }
    if (held.length > 0 && isOpen()) {
      flushTimer = timers.set(flush, sentTimes[0]! + MINUTE_MS - now())
    }
  }

  /** Sends a frame, or holds it until the minute has room; null when the connection is not open. */
  function send(type: string, body: object = {}, extra: Partial<Pending> = {}): string | null {
    if (!isOpen()) return null
    const id = `${type}-${++nextId}`
    const frame = { id, type, ...body }
    const entry: Pending = { type, sentAt: 0, ...extra }
    if (held.length === 0 && room()) {
      write(id, frame, entry)
    } else {
      tally.framesHeld++
      held.push({ id, frame, entry })
      if (flushTimer === undefined) flushTimer = timers.set(flush, sentTimes[0]! + MINUTE_MS - now())
    }
    return id
  }

  // ---- The connection ----

  function connect(): void {
    reconnectTimer = undefined
    if (ended()) return
    const ws = connectTo(opts.url, student.key)
    socket = ws
    opened = false
    closingSeen = false
    dropping = false
    let failed = false
    let retryIn = timing.retryMs
    const connectFailed = () => {
      if (failed) return
      failed = true
      tally.connectFailures++
    }
    ws.on('open', () => {
      opened = true
      tally.connects++
      const resume = roomId === null ? {} : { roomId, lastSeq }
      send('hello', { protocol: 'v1', plugin: SIM_PLUGIN, club: 'doudizhu', ...resume })
    })
    ws.on('message', (data) => onMessage(String(data)))
    ws.on('unexpected-response', (_request, response) => {
      say(`连接被拒 HTTP ${response.statusCode}`)
      connectFailed()
      if (response.statusCode === 401) end('钥匙不对')
      ws.terminate()
    })
    ws.on('error', (err: NodeJS.ErrnoException) => {
      // Stopping a connection still on its way errs too: that is no failure.
      if (!opened && !ended()) connectFailed()
      if (!ended()) say(`连接出错 ${err.code ?? err.message}`)
    })
    ws.on('close', () => {
      if (socket !== ws) return
      socket = null
      if (opened && !closingSeen && !dropping && !ended()) {
        tally.unexpectedDisconnects++
        say('连接被意外断开')
      }
      if (dropping) retryIn = between(timing.awayMs)
      else if (closingSeen) retryIn = closingRetry
      resetConnection()
      if (!ended()) reconnectTimer = timers.set(connect, retryIn)
    })
  }

  function drop(): void {
    tally.drops++
    dropping = true
    say('断线，过一会儿重连')
    socket?.terminate()
  }

  // ---- Forming a table ----

  function isFree(): boolean {
    return welcomed && isOpen() && roomId === null && !joining
  }

  function formSoon(ms: number): void {
    if (ended()) return
    timers.clear(formTimer)
    formTimer = timers.set(form, ms)
  }

  function form(): void {
    formTimer = undefined
    if (ended() || !isFree()) return
    if (mode === 'quick') {
      joining = true
      send('room.quick')
    } else if (mode === 'bots') {
      joining = true
      send('room.create', { visibility: 'public', bots: true })
    } else {
      const group = deps.group?.members ?? []
      if (group.some((b) => b.tally.ended !== null)) {
        end(GROUP_STOPPED)
        return
      }
      // The others of the group wait for the invitation of the first.
      if (group[0] !== bot) return
      const others = group.slice(1)
      if (!others.every((b) => b.isFree())) {
        formSoon(timing.groupWaitMs)
        return
      }
      joining = true
      send('room.create', { visibility: 'invite', bots: false, invite: others.map((b) => b.student.studentId) })
    }
  }

  function seated(state: Room, how: TableMode): void {
    joining = false
    roomId = state.roomId
    lastSeq = state.lastSeq
    gamesHere = 0
    botsRoom = how === 'bots'
    tally.seated[how]++
    gameOn = state.game !== null && state.game.phase !== 'over'
    waitingSince = gameOn ? null : now()
    if (!gameOn) watchSeat()
    say(`入座 ${state.roomId}（${how}）`)
  }

  /** Leaves the table to form another; `why` is counted. */
  function leaveTable(why: string): void {
    if (roomId === null || leaving) return
    if (send('room.leave') === null) return
    leaving = true
    bump(tally.reforms, why)
  }

  /** Back in the lobby: forms another table a few seconds later. */
  function outOfRoom(): void {
    leaving = false
    roomId = null
    lastSeq = 0
    gameOn = false
    waitingSince = null
    mySeat = null
    inTrustee = false
    formSoon(between(timing.reformMs))
  }

  /** Gives up on a table where no game starts for `seatWaitMs`. */
  function watchSeat(): void {
    const since = waitingSince
    later(() => {
      if (roomId !== null && !gameOn && waitingSince === since && since !== null) leaveTable('waited')
    }, seatWaitMs)
  }

  /** After a game: ready for the next one, or off to another table after `games` games. */
  function afterGame(): void {
    later(() => {
      if (roomId === null || gameOn || leaving) return
      if (gamesHere >= opts.games) leaveTable('games')
      else send('room.ready')
    }, between(opts.thinkMs))
  }

  // ---- Playing ----

  function legalStep(t: Of<'your_turn'>): Record<string, unknown> {
    const base = { game: 'doudizhu', turn: t.turn }
    if (t.phase === 'bid') return { type: 'bid', ...base, bid: pick(t.bids ?? [0]) }
    const moves = t.moves ?? []
    if (t.canPass && (moves.length === 0 || random() < opts.passRate)) return { type: 'pass', ...base }
    return { type: 'play', ...base, moveId: pick(moves).id }
  }

  /** The deadline of the turn being answered: a step held back past it is not sent. */
  let turnDeadline: number | undefined

  function sendStep(step: Record<string, unknown>, extra: Partial<Pending> = {}): void {
    const { type, ...body } = step
    send(type as string, body, { deadline: turnDeadline, counted: () => tally.steps++, ...extra })
  }

  let turnTimer: unknown

  function onYourTurn(t: Of<'your_turn'>): void {
    tally.turns++
    if (lastGameEventAt !== null) sampler.turnMs.push(now() - lastGameEventAt)
    lastGameEventAt = null
    mySeat = t.me.seat
    turnDeadline = Date.parse(t.deadline)
    timers.clear(turnTimer)
    connTimers.delete(turnTimer)
    // Never longer than half the time left, so that a step meant to count does.
    const think = Math.min(between(opts.thinkMs), Math.max(0, (Date.parse(t.deadline) - now()) / 2))
    const act = (fn: () => void) => {
      turnTimer = timers.set(() => {
        connTimers.delete(turnTimer)
        fn()
      }, think)
      connTimers.add(turnTimer)
    }
    if (inTrustee && !takeBackSent && !closingInGame) {
      takeBackSent = true
      const byOff = random() < 0.5
      const step = legalStep(t)
      act(() =>
        byOff ? send('trustee.off', {}, { takeBack: true, deadline: turnDeadline }) : sendStep(step, { takeBack: true }),
      )
      return
    }
    if (inTrustee) {
      // Back from `trustee.off`, or the seat is the trustee's as the club closes: a step all the same.
      const step = legalStep(t)
      act(() => sendStep(step))
      return
    }
    if (random() < opts.timeoutRate) {
      tally.timeoutsLeft++
      return
    }
    const illegal = t.phase === 'play' && random() < opts.illegalRate
    const step = legalStep(t)
    if (illegal) {
      const cards = cardsNotInHand(t.me.hand)
      act(() => {
        const counted = () => tally.illegalSent++
        send('play', { game: 'doudizhu', turn: t.turn, cards }, { legal: step, deadline: turnDeadline, counted })
      })
      return
    }
    act(() => sendStep(step))
  }

  function onAck(msg: Of<'ack'>): void {
    const entry = pending.get(msg.id)
    pending.delete(msg.id)
    if (entry === undefined) return
    const game = entry.type === 'bid' || entry.type === 'play' || entry.type === 'pass'
    if (game) sampler.ackMs.push(now() - entry.sentAt)
    if (msg.ok) {
      const result = msg.result as { room?: Room; created?: boolean } | undefined
      if (entry.type === 'room.quick' && result?.room !== undefined) seated(result.room, 'quick')
      else if (entry.type === 'room.create' && result?.room !== undefined) seated(result.room, mode === 'bots' ? 'bots' : 'invite')
      else if (entry.type === 'room.accept' && result?.room !== undefined) seated(result.room, 'invite')
      if (entry.takeBack === true) {
        if (entry.type === 'trustee.off') tally.takeBackByOff++
        else tally.takeBackByStep++
      }
      return
    }
    const { error } = msg
    // The plain codes' union is built from a list, which the static type does not follow: read as a string.
    const code: string = error.code
    bump(tally.refusals, code)
    if (entry.type === 'room.quick' || entry.type === 'room.create' || entry.type === 'room.accept') {
      joining = false
      if (roomId === null && code === 'in_room') {
        // The service has the bot in a room it does not know of: connecting again, the welcome names it.
        tally.resyncs++
        dropping = true
        socket?.terminate()
      } else if (roomId === null) {
        // A refused room: try again a little later.
        formSoon(between(timing.reformMs))
      }
    }
    if (entry.type === 'room.leave') leaving = false
    if (entry.type === 'react') tally.reactsRefused++
    if (entry.takeBack === true) takeBackSent = false
    if (error.code === 'illegal_move') {
      tally.illegalRefused++
      if (entry.legal !== undefined) {
        tally.retries++
        turnDeadline = Date.parse(error.retry.deadline)
        sendStep({ ...entry.legal, turn: error.retry.turn })
      }
    }
    say(`ack ${entry.type} 被拒 ${code}`)
  }

  function maybeReact(): void {
    if (!gameOn || reactKinds.length === 0 || random() >= opts.reactRate) return
    if (reactsThisGame >= reactsPerGame || now() - lastReactAt < reactInterval) return
    // Reactions leave room for the steps: never more than half the frames of a minute.
    room()
    if (sentTimes.length + held.length >= framesPerMinute / 2) return
    const kind = pick(reactKinds)
    const content = kind === 'emoji' ? pick(emoji) : pick(phrases)
    if (send('react', { kind, content }) === null) return
    reactsThisGame++
    lastReactAt = now()
    tally.reactsSent++
  }

  function onGameEvent(event: Extract<RoomEvent, { kind: 'game' }>['event']): void {
    switch (event.kind) {
      case 'dealt':
        gameOn = true
        waitingSince = null
        mySeat = event.seats.findIndex((p) => p.studentId === me)
        inTrustee = false
        takeBackSent = false
        closingInGame = false
        reactsThisGame = 0
        return
      case 'bid':
      case 'play':
      case 'pass':
        if (event.seat !== mySeat) return
        if (event.auto === 'timeout') tally.timeoutSteps++
        else if (event.auto === 'trustee') tally.trusteeSteps++
        else if (event.auto === 'closing') {
          tally.closingSteps++
          closingInGame = true
        }
        return
      case 'over': {
        gameOn = false
        waitingSince = now()
        const { gameId } = event.result
        if (!tally.gameIds.has(gameId)) {
          tally.gameIds.add(gameId)
          tally.gamesOver++
          gamesHere++
          if (closingInGame) {
            tally.closingGameIds.add(gameId)
            tally.gamesClosing++
          }
        }
        timers.clear(turnTimer)
        connTimers.delete(turnTimer)
        inTrustee = false
        // As the club closes or the service stops the room goes too: nothing to get ready for.
        if (!closingInGame) {
          afterGame()
          watchSeat()
        }
        return
      }
      default:
        return
    }
  }

  function onRoomEvent(msg: Of<'room.event'>): void {
    if (msg.roomId !== roomId) return
    if (msg.seq <= lastSeq) return
    lastSeq = msg.seq
    const live = !msg.replayed
    const { event } = msg
    if (event.kind === 'game') {
      lastGameEventAt = live ? Date.parse(msg.at) : null
      onGameEvent(event.event)
    } else if (event.kind === 'trustee' && event.seat === mySeat) {
      if (event.on) {
        if (event.reason === 'closing') {
          tally.trusteeOnClosing++
          closingInGame = true
        } else {
          tally.trusteeOn++
        }
        inTrustee = true
        takeBackSent = false
      } else {
        tally.trusteeOff++
        inTrustee = false
        takeBackSent = false
      }
    } else if (event.kind === 'idle' && live) {
      if (botsRoom) {
        tally.botsAsked++
        send('room.bots')
      } else {
        leaveTable('idle')
      }
    }
    if (!live) return
    maybeReact()
    if (random() < opts.dropRate && isOpen() && !closingSeen) drop()
  }

  function onWelcome(msg: Of<'welcome'>): void {
    welcomed = true
    tally.welcomes++
    framesPerMinute = msg.limits.framesPerMinute
    seatWaitMs = Math.max(timing.seatWaitMs, msg.limits.inviteSeconds * 1000 + INVITE_MARGIN_MS)
    reactInterval = msg.limits.reactMinIntervalSeconds * 1000
    reactsPerGame = msg.limits.reactsPerGame
    const kinds = msg.reactions.kinds
    emoji = [...msg.reactions.emoji]
    phrases = msg.reactions.phrases.map((p) => p.id)
    reactKinds = []
    if (kinds.includes('emoji') && emoji.length > 0) reactKinds.push('emoji')
    if (kinds.includes('phrase') && phrases.length > 0) reactKinds.push('phrase')
    const state = msg.room
    if (state === null) {
      if (roomId !== null) outOfRoom()
      else formSoon(between(timing.reformMs))
      return
    }
    // Back in the room it sat in: the events missed follow; or a room it did not know it was in.
    if (state.roomId === roomId) tally.reconnects++
    else {
      roomId = state.roomId
      lastSeq = state.lastSeq
      gamesHere = 0
    }
    const seat = state.seats.find((s) => s.player?.studentId === me)
    mySeat = seat?.seat ?? null
    inTrustee = seat?.trustee ?? false
    gameOn = state.game !== null && state.game.phase !== 'over'
    if (gameOn) return
    waitingSince ??= now()
    watchSeat()
    if (seat !== undefined && !seat.ready) afterGame()
  }

  function onClosing(msg: Of<'closing'>): void {
    closingSeen = true
    bump(tally.closings, msg.reason)
    say(`closing ${msg.reason}`)
    switch (msg.reason) {
      case 'club_closed': {
        const reopensAt = msg.reopensAt === undefined ? null : Date.parse(msg.reopensAt)
        closingRetry =
          reopensAt === null ? timing.closedRetryMs : Math.max(0, reopensAt - now()) + random() * timing.reopenSpreadMs
        return
      }
      case 'maintenance':
      case 'service_stopping':
        closingRetry = timing.retryMs
        return
      default:
        end({ replaced: '学号在别处连上了', suspended: '停课', expelled: '开除', not_member: '不是社员' }[msg.reason])
    }
  }

  function onMessage(text: string): void {
    let msg: unknown
    try {
      msg = JSON.parse(text)
    } catch {
      msg = undefined
    }
    if (!checkServerMessage.Check(msg)) {
      tally.invalid++
      say('收到一条不合协议的消息')
      return
    }
    switch (msg.type) {
      case 'ack':
        return onAck(msg)
      case 'welcome':
        return onWelcome(msg)
      case 'room.event':
        return onRoomEvent(msg)
      case 'room.left':
        if (msg.roomId !== roomId) return
        if (msg.reason !== 'left') bump(tally.reforms, msg.reason)
        return outOfRoom()
      case 'invite': {
        const leader = deps.group?.members[0]
        if (mode === 'invite' && leader !== undefined && msg.from.studentId === leader.student.studentId && roomId === null) {
          joining = true
          send('room.accept', { inviteId: msg.inviteId })
        } else {
          send('room.decline', { inviteId: msg.inviteId })
        }
        return
      }
      case 'invite.ended':
        // An invitation of the group's first that nobody took: the table will not fill, so it forms another.
        if (msg.reason !== 'accepted' && roomId !== null && !gameOn) leaveTable('invite_expired')
        return
      case 'your_turn':
        if (msg.roomId === roomId) onYourTurn(msg)
        return
      case 'closing':
        return onClosing(msg)
      case 'hand':
      case 'lobby':
        return
    }
  }

  const bot: ClubBot = {
    student,
    mode,
    tally,
    start() {
      connect()
    },
    stop() {
      tally.ended ??= '中途停止'
      timers.clear(reconnectTimer)
      timers.clear(formTimer)
      timers.clear(turnTimer)
      timers.clear(flushTimer)
      for (const handle of connTimers) timers.clear(handle)
      connTimers.clear()
      socket?.terminate()
    },
    isFree,
    endWith(reason) {
      if (ended()) return
      end(reason)
      timers.clear(turnTimer)
      timers.clear(flushTimer)
      for (const handle of connTimers) timers.clear(handle)
      connTimers.clear()
      socket?.terminate()
    },
    receive(message) {
      onMessage(JSON.stringify(message))
    },
  }
  return bot
}

/** How many bots of each mode: invitation groups of three, then quick join, then the rest with bots. */
export function splitByMix(count: number, mix: Record<TableMode, number>): Record<TableMode, number> {
  const total = mix.invite + mix.quick + mix.bots
  if (total <= 0) return { invite: 0, quick: count, bots: 0 }
  const invite = Math.floor((count * mix.invite) / total / 3) * 3
  const bots = Math.min(count - invite, Math.round((count * mix.bots) / total))
  return { invite, quick: count - invite - bots, bots }
}

export interface ClubBotsDeps extends Omit<ClubBotDeps, 'random' | 'group'> {
  /** The seed of every bot's choices: bot `i` gets its own generator from it. */
  seed: number
}

/**
 * One bot per student: the first ones in invitation groups of three, then those that quick join, then those that play
 * with bots, as `mix` shares them out (see `splitByMix`).
 */
export function createClubBots(
  students: readonly SeededStudent[],
  opts: ClubSimOptions & { mix: Record<TableMode, number> },
  deps: ClubBotsDeps,
): ClubBot[] {
  const split = splitByMix(students.length, opts.mix)
  const bots: ClubBot[] = []
  let group: InviteGroup | undefined
  students.forEach((student, i) => {
    const mode: TableMode = i < split.invite ? 'invite' : i < split.invite + split.quick ? 'quick' : 'bots'
    if (mode === 'invite' && i % 3 === 0) group = { members: [] }
    const random = seededRandom((deps.seed ^ Math.imul(i + 1, 0x9e3779b9)) >>> 0)
    const bot = createClubBot(student, mode, opts, { ...deps, random, ...(mode === 'invite' ? { group } : {}) })
    if (mode === 'invite') group!.members.push(bot)
    bots.push(bot)
  })
  return bots
}
