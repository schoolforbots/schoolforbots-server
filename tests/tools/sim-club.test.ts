import { EventEmitter } from 'node:events'
import type { AddressInfo } from 'node:net'
import { Value } from 'typebox/value'
import { afterEach, describe, expect, test } from 'vitest'
import WebSocket, { WebSocketServer } from 'ws'
import { DEFAULT_DOUDIZHU_RULES } from '../../src/club/doudizhu/index.js'
import { doudizhuGame } from '../../src/club/doudizhu-game.js'
import { clubClosedAt } from '../../src/club/hours.js'
import { type ClubService, createClubService, startClubService } from '../../src/club/service.js'
import type { Ticker } from '../../src/class/ticker.js'
import { ClubClientMessage, ClubServerMessage } from '../../src/protocol/club.js'
import type { Clock } from '../../src/shared/clock.js'
import type { SchoolConfig } from '../../src/shared/config.js'
import type { Maintenance, MaintenanceWatch } from '../../src/shared/maintenance.js'
import { type SeededStudent, seedClass } from '../../src/tools/dev-seed.js'
import {
  cardsNotInHand,
  type ClubBot,
  type ClubBotTally,
  type ClubSimOptions,
  type ClubSimTiming,
  createClubBot,
  createClubBots,
  createClubSampler,
  seededRandom,
  splitByMix,
  type TableMode,
  type Timers,
} from '../../src/tools/sim-club.js'
import { createTestDb } from '../helpers/db.js'
import { exampleWordLists } from '../club/helpers/parts.js'
import { exampleConfig, T0 } from '../club/helpers/rooms.js'

// The club simulator's bots against the real club service, in this process, on a database of their own. Time runs
// `SCALE` times as fast for the service and the bots alike: the clock they share reads that much ahead, and the bots'
// waits are that much shorter in real time. A step is 3 seconds of that time and the time bank is 0, so a timeout costs
// a tenth of a second of real time, and a test's games are over in a few seconds.

const SCALE = 25

const scaledTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms / SCALE),
  clear: (handle) => clearTimeout(handle as NodeJS.Timeout | undefined),
}

/** A clock from `start` that runs `SCALE` times as fast as real time. */
function scaledClock(start: Date): Clock {
  const origin = performance.now()
  return { now: () => new Date(start.getTime() + (performance.now() - origin) * SCALE) }
}

const QUIET: ClubSimOptions = {
  url: '',
  games: 2,
  thinkMs: [100, 300],
  passRate: 0.3,
  timeoutRate: 0,
  illegalRate: 0,
  dropRate: 0,
  reactRate: 0,
}

const TIMING: Partial<ClubSimTiming> = { reformMs: [300, 800], groupWaitMs: 500, reopenSpreadMs: 500, seatWaitMs: 30_000 }

let cleanups: (() => Promise<void> | void)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  cleanups = []
})

async function waitUntil(check: () => boolean, what: string, timeoutMs = 8000): Promise<void> {
  const until = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > until) throw new Error(`Timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

interface Club {
  service: ClubService
  clock: Clock
  url: string
  config: SchoolConfig
  students: SeededStudent[]
}

/** The club service with the real game, `n` seeded club members, and a ticker every 20 ms (half a second of its time). */
async function startClub(n: number, options: { start?: Date; maintenance?: MaintenanceWatch } = {}): Promise<Club> {
  const { db, destroy } = await createTestDb()
  cleanups.push(destroy)
  const clock = scaledClock(options.start ?? T0)
  const config: SchoolConfig = {
    ...exampleConfig,
    club: {
      ...exampleConfig.club,
      // The frames a minute are counted on real time, which runs slower here than the bots' minute.
      connection: { ...exampleConfig.club.connection, framesPerMinute: 100_000, maxQueuedFrames: 100 },
      timeBankSeconds: 0,
      trusteeDelaySeconds: 1,
    },
  }
  const service = createClubService({
    db,
    config,
    clock,
    game: doudizhuGame({
      rules: { ...DEFAULT_DOUDIZHU_RULES, bidSeconds: 3, playSeconds: 3 },
      timeBankSeconds: 0,
      trusteeDelaySeconds: 1,
    }),
    wordLists: exampleWordLists,
    ...(options.maintenance === undefined ? {} : { maintenance: options.maintenance }),
  })
  const ticker: Ticker = await startClubService({ app: service.app, tick: service.tick, intervalMs: 20 }, { port: 0, host: '127.0.0.1' })
  cleanups.push(() => service.app.close())
  cleanups.push(() => ticker.stop())
  const { students } = await seedClass(db, config, { division: 'junior', slot: 'evening', students: n, club: true, clock })
  const url = `ws://127.0.0.1:${(service.app.server.address() as AddressInfo).port}/v1/club`
  return { service, clock, url, config, students }
}

function runBots(
  club: Club,
  opts: Partial<ClubSimOptions> & { mix: Record<TableMode, number> },
  seed = 1,
  sampler = createClubSampler(),
): ClubBot[] {
  const bots = createClubBots(
    club.students,
    { ...QUIET, ...opts, url: club.url },
    { seed, clock: club.clock, timers: scaledTimers, timing: TIMING, print: () => {}, sampler },
  )
  for (const bot of bots) bot.start()
  // Stopped before the service closes, so that its going away is not taken for a disconnect.
  cleanups.push(() => {
    for (const bot of bots) bot.stop()
  })
  return bots
}

const sum = (bots: readonly ClubBot[], count: (t: ClubBotTally) => number) =>
  bots.reduce((n, b) => n + count(b.tally), 0)

function expectNothingWrong(bots: readonly ClubBot[]): void {
  for (const { tally } of bots) {
    expect(tally).toMatchObject({ unexpectedDisconnects: 0, connectFailures: 0, invalid: 0, ended: null })
  }
}

describe('against the club service', () => {
  test('nine bots form tables all three ways, play their games, leave, and form tables again', async () => {
    const club = await startClub(9)
    const sampler = createClubSampler()
    const bots = runBots(club, { mix: { invite: 34, quick: 33, bots: 33 }, games: 2 }, 1, sampler)
    expect(bots.map((b) => b.mode)).toEqual(['invite', 'invite', 'invite', 'quick', 'quick', 'quick', 'bots', 'bots', 'bots'])

    // Each bot has played its games at one table, left it, and sat down at another in the same way.
    await waitUntil(() => bots.every((b) => b.tally.seated[b.mode] >= 2 && b.tally.gamesOver >= 2), 'two tables each')
    for (const { tally } of bots) {
      expect(tally.reforms.games).toBeGreaterThanOrEqual(1)
      expect(tally.gameIds.size).toBe(tally.gamesOver)
      expect(tally.steps).toBeGreaterThan(0)
    }
    // The three of a group sat at the same tables, and so did the three that quick join: the same games.
    const games = (b: ClubBot) => [...b.tally.gameIds].slice(0, 2)
    expect(games(bots[1]!)).toEqual(games(bots[0]!))
    expect(games(bots[2]!)).toEqual(games(bots[0]!))
    expect(games(bots[4]!)).toEqual(games(bots[3]!))
    expect(games(bots[5]!)).toEqual(games(bots[3]!))
    expectNothingWrong(bots)
    expect(sum(bots, (t) => t.timeoutsLeft + t.illegalSent + t.drops + t.reactsSent)).toBe(0)
    // Every step was acked and measured; the hand-offs too, all of them live.
    // (A step may still be on its way when the test looks: one a bot at most.)
    expect(sampler.ackMs.length).toBeLessThanOrEqual(sum(bots, (t) => t.steps))
    expect(sampler.ackMs.length).toBeGreaterThanOrEqual(sum(bots, (t) => t.steps) - bots.length)
    expect(sampler.turnMs.length).toBeGreaterThan(0)
    expect(sampler.turnMs.length).toBeLessThanOrEqual(sum(bots, (t) => t.turns))
  }, 10_000)

  test('timeouts, trusteeship taken back both ways, illegal steps sent again, drops and reactions all happen', async () => {
    const club = await startClub(6)
    const bots = runBots(
      club,
      { mix: { invite: 50, quick: 50, bots: 0 }, games: 3, timeoutRate: 0.35, illegalRate: 0.3, dropRate: 0.02, reactRate: 0.3 },
      7,
    )
    const all = (count: (t: ClubBotTally) => number) => sum(bots, count) > 0
    await waitUntil(
      () =>
        all((t) => t.timeoutSteps) &&
        all((t) => t.trusteeOn) &&
        all((t) => t.takeBackByStep) &&
        all((t) => t.takeBackByOff) &&
        all((t) => t.retries) &&
        all((t) => t.reconnects) &&
        all((t) => t.reactsSent),
      'every path',
    )
    expect(sum(bots, (t) => t.timeoutsLeft)).toBeGreaterThan(0)
    expect(sum(bots, (t) => t.trusteeOff)).toBeGreaterThan(0)
    expect(sum(bots, (t) => t.illegalRefused)).toBe(sum(bots, (t) => t.refusals.illegal_move ?? 0))
    expect(sum(bots, (t) => t.drops)).toBeGreaterThanOrEqual(sum(bots, (t) => t.reconnects))
    expectNothingWrong(bots)
  }, 10_000)

  test('a bot turned away while the club is closed comes back at reopensAt', async () => {
    // 10:30:40 in Beijing on a school day: closed for the morning lessons until a little after 10:31.
    const start = new Date('2026-11-20T10:30:40+08:00')
    const closed = clubClosedAt(exampleConfig, start)
    expect(closed.closed).toBe(true)
    const reopensAt = (closed as { reopensAt: Date }).reopensAt.getTime()
    const club = await startClub(1, { start })
    const tries: number[] = []
    const bot = createClubBot(club.students[0]!, 'bots', { ...QUIET, url: club.url }, {
      clock: club.clock,
      random: seededRandom(1),
      timers: scaledTimers,
      timing: TIMING,
      print: () => {},
      connect: (url, key) => {
        tries.push(club.clock.now().getTime())
        return new WebSocket(url, { headers: { authorization: `Bearer ${key}` } })
      },
    })
    bot.start()
    cleanups.push(() => bot.stop())
    await waitUntil(() => bot.tally.welcomes === 1, 'the welcome')
    expect(bot.tally.closings).toEqual({ club_closed: 1 })
    expect(tries).toHaveLength(2)
    expect(tries[1]!).toBeGreaterThanOrEqual(reopensAt)
    expectNothingWrong([bot])
  }, 10_000)

  test('maintenance and the service stopping send the bots away, which is no unexpected disconnect', async () => {
    let maintenance: Maintenance | null = null
    const listeners: ((m: Maintenance | null) => void)[] = []
    const watch: MaintenanceWatch = {
      current: () => maintenance,
      refresh: async () => {},
      onChange: (listener) => void listeners.push(listener),
      stop: () => {},
    }
    const setMaintenance = (m: Maintenance | null) => {
      maintenance = m
      for (const listener of listeners) listener(m)
    }
    const club = await startClub(3, { maintenance: watch })
    const bots = runBots(club, { mix: { invite: 0, quick: 0, bots: 100 }, games: 100 })

    // In the middle of their games, the school goes under maintenance: the games are played out, the bots sent away.
    await waitUntil(() => bots.every((b) => b.tally.steps >= 3), 'some steps')
    setMaintenance({ message: '维护', since: club.clock.now(), expectedBackAt: null })
    await waitUntil(() => bots.every((b) => (b.tally.closings.maintenance ?? 0) >= 1), 'the maintenance closing')
    expect(sum(bots, (t) => t.gamesClosing)).toBeGreaterThan(0)
    for (const { tally } of bots) expect([...tally.closingGameIds].every((id) => tally.gameIds.has(id))).toBe(true)

    // Back again: they come in and play.
    setMaintenance(null)
    const seated = bots.map((b) => b.tally.seated.bots)
    await waitUntil(() => bots.every((b, i) => b.tally.seated.bots > seated[i]!), 'a table after the maintenance')

    // The service stops: the games are played out and the bots sent away again.
    const steps = bots.map((b) => b.tally.steps)
    await waitUntil(() => bots.every((b, i) => b.tally.steps > steps[i]!), 'a step after the maintenance')
    await club.service.stop(1000)
    await waitUntil(() => bots.every((b) => (b.tally.closings.service_stopping ?? 0) >= 1), 'the service stopping')
    expectNothingWrong(bots)
  }, 10_000)
})

/** A welcome as the club service sends it, for the fake schools. */
const welcome = {
  type: 'welcome',
  student: { studentId: 1, displayName: '小鱼 #0001', bot: false, className: '初中部·晚班·1 班' },
  club: { id: 'doudizhu', name: '斗地主社' },
  closesAt: '2026-11-20T11:45:00.000Z',
  limits: {
    framesPerMinute: 60,
    timeBankSeconds: 0,
    inviteSeconds: 180,
    idleMinutes: 10,
    idleDecideSeconds: 180,
    maxSpectators: 20,
    reactMinIntervalSeconds: 5,
    reactsPerGame: 3,
  },
  reactions: { kinds: ['emoji', 'phrase'], visibility: ['room'], emoji: ['👍', '😄'], phrases: [{ id: 'nice', text: '打得好' }] },
  stats: { games: 0, wins: 0, points: { total: 0, week: 0 } },
  rules: { ...DEFAULT_DOUDIZHU_RULES, bidSeconds: 3, playSeconds: 3 },
  room: null,
}

describe('against a fake school', () => {

  test('a connection closed with no closing is an unexpected disconnect, and a message off the protocol is invalid', async () => {
    expect(Value.Check(ClubServerMessage, welcome)).toBe(true)
    const server = new WebSocketServer({ port: 0, host: '127.0.0.1' })
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
    server.on('connection', (ws) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(String(data)) as { id: string; type: string }
        if (msg.type !== 'hello') return
        ws.send(JSON.stringify({ type: 'ack', id: msg.id, ok: true }))
        ws.send(JSON.stringify(welcome))
        ws.send(JSON.stringify({ type: 'room.event', roomId: 'r1', seq: 1 }))
        setTimeout(() => ws.terminate(), 50)
      })
    })
    await new Promise((resolve) => server.once('listening', resolve))
    const { port } = server.address() as AddressInfo
    const bot = createClubBot({ studentId: 1, key: 'k', displayName: '小鱼' }, 'quick', { ...QUIET, url: `ws://127.0.0.1:${port}` }, {
      clock: { now: () => new Date() },
      random: seededRandom(1),
      // Never forms a table nor comes back while the test looks.
      timing: { retryMs: 60_000, reformMs: [60_000, 60_000] },
      print: () => {},
    })
    cleanups.push(() => bot.stop())
    bot.start()
    await waitUntil(() => bot.tally.unexpectedDisconnects === 1, 'the disconnect')
    expect(bot.tally).toMatchObject({ connects: 1, welcomes: 1, invalid: 1, unexpectedDisconnects: 1, connectFailures: 0 })
  })
})

// ---- A school played out on virtual time, for the choices the bots make ----

/** Timers on a virtual clock: `run` fires them in order of time (and of setting, at the same time). */
function virtualTime() {
  let t = Date.parse('2026-11-20T03:00:00.000Z')
  let counter = 0
  const queue = new Map<number, { at: number; order: number; fn: () => void }>()
  const timers: Timers = {
    set(fn, ms) {
      const id = ++counter
      // Whole milliseconds, as a `Date` reads them.
      queue.set(id, { at: t + Math.ceil(Math.max(0, ms)), order: id, fn })
      return id
    },
    clear(handle) {
      queue.delete(handle as number)
    },
  }
  return {
    clock: { now: () => new Date(t) } as Clock,
    timers,
    now: () => t,
    /** Fires timers until `done` or until virtual time reaches `limitMs` from now. */
    run(done: () => boolean, limitMs: number) {
      const until = t + limitMs
      while (!done()) {
        let next: [number, { at: number; order: number; fn: () => void }] | undefined
        for (const entry of queue) {
          if (next === undefined || entry[1].at < next[1].at || (entry[1].at === next[1].at && entry[1].order < next[1].order)) next = entry
        }
        if (next === undefined || next[1].at > until) return
        queue.delete(next[0])
        t = next[1].at
        next[1].fn()
      }
    },
  }
}

/**
 * One bot against a scripted school on virtual time: a room with two bots of the school's, games of `stepsPerGame` of
 * the bot's steps, a `your_turn` after the events of the others, the deadline and trusteeship of the real game (two
 * timeouts in a row; `trustee.off` asks again; a legal step takes the seat back), cards not in hand refused with a
 * retry. Gives what the bot counted and every frame it sent.
 */
function scriptedRun(seed: number, framesPerMinute = 600) {
  const v = virtualTime()
  const sent: Record<string, any>[] = []
  const out: Record<string, unknown>[] = []
  let socket: (EventEmitter & { readyState: number }) | null = null
  const push = (m: Record<string, unknown>) => {
    expect(Value.Check(ClubServerMessage, m), JSON.stringify(m)).toBe(true)
    out.push(m)
    const ws = socket
    v.timers.set(() => ws?.emit('message', Buffer.from(JSON.stringify(m))), 1)
  }
  const ROOM = 'rabcd'
  const HAND = ['3', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', '2', '2', '小王', '大王']
  const person = (seat: number) =>
    seat === 0 ? { studentId: 1, displayName: '小鱼 #0001', bot: false } : { studentId: null, displayName: `陪练小${seat}`, bot: true }
  let seq = 0
  let gameId = 0
  let turn = 0
  let steps = 0
  let timeoutsInRow = 0
  let trustee = false
  let deadlineTimer: unknown
  let inGame = false
  const event = (e: Record<string, unknown>) =>
    push({ type: 'room.event', roomId: ROOM, seq: ++seq, replayed: false, at: new Date(v.now()).toISOString(), event: e })
  const game = (e: Record<string, unknown>) => event({ kind: 'game', game: 'doudizhu', event: e })
  const STEPS = 12

  function ask(): void {
    turn++
    const phase = steps === 0 ? 'bid' : 'play'
    const deadline = v.now() + (trustee ? 1000 : 3000)
    const table = {
      game: 'doudizhu', gameId, phase: phase === 'bid' ? 'bidding' : 'playing', firstBidder: 0, bids: [], landlord: null,
      base: null, bottom: null, cardsLeft: [17, 17, 17], multiplier: 1, trick: null, history: [],
      trustee: [trustee, false, false], toAct: 0, deadline: new Date(deadline).toISOString(),
    }
    push({
      type: 'your_turn', roomId: ROOM, game: 'doudizhu', gameId, turn, phase,
      deadline: new Date(deadline).toISOString(), timeBankSeconds: 0, closesAt: '2026-11-20T11:45:00.000Z',
      me: { seat: 0, role: null, hand: HAND },
      left: { seat: 2, player: person(2), role: null, cardsLeft: 17 },
      right: { seat: 1, player: person(1), role: null, cardsLeft: 17 },
      table, unseen: [],
      bids: phase === 'bid' ? [0, 1, 2, 3] : null,
      moves: phase === 'bid' ? null : [
        { id: 1, type: 'single', name: '单牌', cards: ['3'] },
        { id: 2, type: 'pair', name: '对牌', cards: ['3', '3'] },
        { id: 3, type: 'rocket', name: '火箭', cards: ['小王', '大王'] },
      ],
      canPass: phase === 'play',
      movesTrimmed: false,
    })
    v.timers.clear(deadlineTimer)
    const asked = turn
    deadlineTimer = v.timers.set(() => {
      if (turn !== asked) return
      if (!trustee) timeoutsInRow++
      stepTaken(trustee ? 'trustee' : 'timeout')
      if (timeoutsInRow === 2 && !trustee) {
        trustee = true
        event({ kind: 'trustee', seat: 0, on: true, reason: 'timeouts' })
      }
      next()
    }, deadline - v.now())
  }

  function stepTaken(auto: string | null): void {
    steps++
    if (steps === 1) game({ kind: 'bid', turn, seat: 0, bid: 1, auto })
    else game({ kind: 'pass', turn, seat: 0, auto })
  }

  function next(): void {
    if (steps >= STEPS) {
      inGame = false
      game({ kind: 'over', result: { gameId, outcome: 'no_landlord', landlord: null, base: null, doublings: [], multiplier: 1, capped: false, scores: [0, 0, 0], hands: [[], [], []], bottom: null, ranked: false } })
      return
    }
    // The two bots of the school's: a step each, then the bot's turn.
    game({ kind: 'pass', turn: turn + 1, seat: 1, auto: 'bot' })
    game({ kind: 'pass', turn: turn + 2, seat: 2, auto: 'bot' })
    turn += 2
    ask()
  }

  function deal(): void {
    gameId++
    steps = 0
    inGame = true
    trustee = false
    timeoutsInRow = 0
    game({ kind: 'dealt', gameId, seats: [person(0), person(1), person(2)], firstBidder: 0 })
    ask()
  }

  const ack = (id: string, ok: boolean, more: Record<string, unknown> = {}) => push({ type: 'ack', id, ok, ...more })
  const room = () => ({
    roomId: ROOM, club: 'doudizhu', visibility: 'public', host: 1,
    seats: [0, 1, 2].map((seat) => ({ seat, player: person(seat), ready: true, online: true, trustee: false })),
    spectators: 0, gamesPlayed: gameId, closesAt: '2026-11-20T11:45:00.000Z', lastSeq: seq, game: null,
  })

  function receive(msg: Record<string, any>): void {
    expect(Value.Check(ClubClientMessage, msg), JSON.stringify(msg)).toBe(true)
    sent.push({ ...msg, at: v.now() })
    switch (msg.type) {
      case 'hello':
        ack(msg.id, true)
        return push({ ...welcome, limits: { ...welcome.limits, framesPerMinute } })
      case 'room.create':
        ack(msg.id, true, { result: { room: room() } })
        return deal()
      case 'room.ready':
        ack(msg.id, true)
        return deal()
      case 'room.leave':
        ack(msg.id, true)
        return push({ type: 'room.left', roomId: ROOM, reason: 'left' })
      case 'react':
        return ack(msg.id, true)
      case 'trustee.off':
        if (!trustee) return ack(msg.id, false, { error: { code: 'not_trustee', message: '…' } })
        ack(msg.id, true)
        trustee = false
        timeoutsInRow = 0
        event({ kind: 'trustee', seat: 0, on: false, reason: 'off' })
        turn--
        return ask()
      case 'bid':
      case 'play':
      case 'pass': {
        if (!inGame || msg.turn !== turn) return ack(msg.id, false, { error: { code: 'stale_turn', message: '…' } })
        if (msg.cards !== undefined) {
          return ack(msg.id, false, {
            error: {
              code: 'illegal_move', message: '…', problem: 'not_in_hand', reason: '…', missing: [msg.cards[0]],
              retry: { turn, deadline: new Date(v.now() + 1000).toISOString(), timeBankSeconds: 0 },
            },
          })
        }
        ack(msg.id, true, { result: { turn } })
        timeoutsInRow = 0
        if (trustee) {
          trustee = false
          event({ kind: 'trustee', seat: 0, on: false, reason: 'off' })
        }
        stepTaken(null)
        return next()
      }
    }
  }

  const bot = createClubBot({ studentId: 1, key: 'k', displayName: '小鱼' }, 'bots', {
    ...QUIET, url: 'ws://school', games: 3, timeoutRate: 0.3, illegalRate: 0.3, reactRate: 0.5, passRate: 0.5,
  }, {
    clock: v.clock,
    random: seededRandom(seed),
    timers: v.timers,
    print: () => {},
    connect: () => {
      const ws = Object.assign(new EventEmitter(), {
        readyState: WebSocket.CONNECTING as number,
        send: (data: string) => receive(JSON.parse(data)),
        terminate: () => {},
      })
      socket = ws
      v.timers.set(() => {
        ws.readyState = WebSocket.OPEN
        ws.emit('open')
      }, 1)
      return ws as unknown as WebSocket
    },
  })
  bot.start()
  v.run(() => bot.tally.gamesOver >= 9, 3_600_000)
  bot.stop()
  const { gameIds, closingGameIds, ...counts } = bot.tally
  return { counts, gameIds: [...gameIds], sent, out }
}

describe('the choices of a bot', () => {
  test('the same seed makes the same choices; another seed other ones', () => {
    const a = scriptedRun(42)
    const b = scriptedRun(42)
    expect(a.counts.gamesOver).toBe(9)
    expect(b).toEqual(a)
    expect(scriptedRun(43).sent).not.toEqual(a.sent)

    // Every path was taken, and each as it should be.
    const c = a.counts
    expect(c.seated.bots).toBe(3)
    expect(c.reforms.games).toBe(2)
    for (const key of ['timeoutsLeft', 'trusteeOn', 'trusteeOff', 'takeBackByStep', 'takeBackByOff', 'illegalSent', 'reactsSent'] as const) {
      expect(c[key], key).toBeGreaterThan(0)
    }
    // Each refused and sent again (but the last, when the run stops before its refusal comes).
    expect(c.illegalRefused).toBeGreaterThanOrEqual(c.illegalSent - 1)
    expect(c.retries).toBe(c.illegalRefused)
    expect(c.refusals).toEqual({ illegal_move: c.illegalRefused })
    expect(c).toMatchObject({ invalid: 0, unexpectedDisconnects: 0, reactsRefused: 0, framesHeld: 0 })

    // A reaction never comes sooner than the interval after the one before, nor past the count of a game.
    const reacts = a.sent.filter((m) => m.type === 'react')
    for (let i = 1; i < reacts.length; i++) expect(reacts[i]!.at - reacts[i - 1]!.at).toBeGreaterThanOrEqual(5000)
    expect(reacts.length).toBeLessThanOrEqual(3 * 9)
    for (const r of reacts) {
      expect(r.kind === 'emoji' ? welcome.reactions.emoji : ['nice']).toContain(r.content)
    }
    // The illegal plays are cards the bot does not hold.
    for (const m of a.sent.filter((s) => s.type === 'play' && s.cards !== undefined)) expect(m.cards).toEqual(['3', '3', '3'])
  })

  test('a bot sends no more frames in a minute than the welcome allows, holding back the rest', () => {
    const { sent, counts } = scriptedRun(5, 8)
    expect(counts.framesHeld).toBeGreaterThan(0)
    for (let i = 8; i < sent.length; i++) expect(sent[i]!.at - sent[i - 8]!.at).toBeGreaterThanOrEqual(60_000)
  })

  test('a play the bot cannot make is one card more of a rank than it holds', () => {
    expect(cardsNotInHand(['3', '3', '4'])).toEqual(['3', '3', '3'])
    expect(cardsNotInHand(['3', '3', '3', '3', '4'])).toEqual(['4', '4'])
    expect(cardsNotInHand(['3', '3', '3', '3'])).toEqual(['4'])
  })

  test('the mix makes groups of three, then quick join, then bots', () => {
    expect(splitByMix(9, { invite: 34, quick: 33, bots: 33 })).toEqual({ invite: 3, quick: 3, bots: 3 })
    expect(splitByMix(900, { invite: 80, quick: 15, bots: 5 })).toEqual({ invite: 720, quick: 135, bots: 45 })
    expect(splitByMix(10, { invite: 80, quick: 15, bots: 5 })).toEqual({ invite: 6, quick: 3, bots: 1 })
    expect(splitByMix(4, { invite: 100, quick: 0, bots: 0 })).toEqual({ invite: 3, quick: 1, bots: 0 })
  })
})
