import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, test } from 'vitest'
import WebSocket from 'ws'
import { DEFAULT_DOUDIZHU_RULES } from '../../src/club/doudizhu/index.js'
import { doudizhuGame } from '../../src/club/doudizhu-game.js'
import { createRecorder, nextGameId, storedDoudizhuOptions } from '../../src/club/recorder.js'
import { type ClubService, createClubService, startClubService } from '../../src/club/service.js'
import { buildRegistrationApp } from '../../src/registration/app.js'
import { MemoryMailer } from '../../src/registration/mailer.js'
import type { Clock } from '../../src/shared/clock.js'
import type { SchoolConfig } from '../../src/shared/config.js'
import type { Maintenance, MaintenanceWatch } from '../../src/shared/maintenance.js'
import { loadSchoolRules } from '../../src/shared/school-rules.js'
import { seedClass } from '../../src/tools/dev-seed.js'
import {
  type ClubBot,
  createClubBots,
  createClubSampler,
  type Timers,
  verifyRecords,
} from '../../src/tools/sim-club.js'
import { exampleConfig as registrationConfig, exampleModerator } from '../helpers/app.js'
import { createTestDb } from '../helpers/db.js'
import { exampleWordLists } from './helpers/parts.js'
import { exampleConfig, T0 } from './helpers/rooms.js'

// The moment many tables are sent away at once: the club service (its games recorded as the entry point records them)
// and the registration service on one database, and `TABLES` tables of the simulator's bots, three students each,
// playing on a clock that runs `SCALE` times as fast. Halfway through their games the school goes under maintenance
// (or the service stops): every game is played out and its `over` sent before anyone is sent away, every game is
// stored, the ones being played with the steps of the club closing, and nobody is disconnected unexpectedly. When the
// service stops, the records are all written before the first `closing`.

/** The tables: a constant, to be raised by hand for a heavier run on a machine of one's own. */
const TABLES = 30
const SCALE = 25

const scaledTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms / SCALE),
  clear: (handle) => clearTimeout(handle as NodeJS.Timeout | undefined),
}

let cleanups: (() => Promise<void> | void)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  cleanups = []
})

async function waitUntil(check: () => boolean | Promise<boolean>, what: string, timeoutMs = 8000): Promise<void> {
  const until = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() > until) throw new Error(`Timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

async function burst() {
  const { db, destroy } = await createTestDb()
  cleanups.push(destroy)
  const origin = performance.now()
  const clock: Clock = { now: () => new Date(T0.getTime() + (performance.now() - origin) * SCALE) }
  const config: SchoolConfig = {
    ...exampleConfig,
    club: {
      ...exampleConfig.club,
      // Counted on real time, which runs slower here than the bots' minute.
      connection: { ...exampleConfig.club.connection, framesPerMinute: 100_000, maxQueuedFrames: 100 },
      timeBankSeconds: 0,
      trusteeDelaySeconds: 1,
    },
  }

  let maintenance: Maintenance | null = null
  const listeners: ((m: Maintenance | null) => void)[] = []
  const watch: MaintenanceWatch = {
    current: () => maintenance,
    refresh: async () => {},
    onChange: (listener) => void listeners.push(listener),
    stop: () => {},
  }

  const recorderErrors: unknown[] = []
  const log = { error: (...args: unknown[]) => void recorderErrors.push(args) }
  const recorder = createRecorder({ db, clock, log })
  cleanups.push(() => expect(recorderErrors).toEqual([]))
  cleanups.push(() => recorder.drain(5000))
  const stored = storedDoudizhuOptions({ db, clock, timeZone: config.timezone, recorder, firstGameId: await nextGameId(db), log })
  /** Whether the service's wait for the records has ended. */
  let drained = false
  const service: ClubService = createClubService({
    db,
    config,
    clock,
    game: doudizhuGame({
      rules: { ...DEFAULT_DOUDIZHU_RULES, bidSeconds: 3, playSeconds: 3 },
      timeBankSeconds: 0,
      trusteeDelaySeconds: 1,
      ...stored,
      drain: async (timeoutMs) => {
        await stored.drain!(timeoutMs)
        drained = true
      },
    }),
    wordLists: exampleWordLists,
    maintenance: watch,
  })
  const ticker = await startClubService(
    { app: service.app, tick: service.tick, intervalMs: 20, watchTicker: service.watchTicker },
    { port: 0, host: '127.0.0.1' },
  )
  cleanups.push(() => service.app.close())
  cleanups.push(() => ticker.stop())
  const url = `ws://127.0.0.1:${(service.app.server.address() as AddressInfo).port}/v1/club`

  const registration = buildRegistrationApp({
    db,
    config: registrationConfig(),
    moderator: exampleModerator(),
    mailer: new MemoryMailer(),
    clock,
    maintenance: { current: () => null, refresh: async () => {}, onChange: () => {}, stop: () => {} },
    schoolRules: loadSchoolRules(fileURLToPath(new URL('../../school-rules', import.meta.url))),
    trustProxy: false,
  })
  await registration.listen({ port: 0, host: '127.0.0.1' })
  cleanups.push(() => registration.close())
  const api = `http://127.0.0.1:${(registration.server.address() as AddressInfo).port}`

  // Classes of at most 120: as many as the tables need.
  const students = []
  for (let left = TABLES * 3; left > 0; left -= 120) {
    const seeded = await seedClass(db, config, { division: 'junior', slot: 'evening', students: Math.min(120, left), club: true, clock })
    students.push(...seeded.students)
  }

  /** For each bot, whether the records were all written when its `closing` came. */
  const drainedAtClosing: boolean[] = []
  const bots: ClubBot[] = createClubBots(
    students,
    {
      url,
      games: 1000,
      thinkMs: [100, 300],
      passRate: 0.3,
      timeoutRate: 0.02,
      illegalRate: 0.02,
      dropRate: 0,
      reactRate: 0.05,
      mix: { invite: 100, quick: 0, bots: 0 },
    },
    {
      seed: 11,
      clock,
      timers: scaledTimers,
      timing: { reformMs: [300, 800], groupWaitMs: 500 },
      print: () => {},
      sampler: createClubSampler(),
      connect: (to, key) => {
        const ws = new WebSocket(to, { headers: { authorization: `Bearer ${key}` } })
        // Listening first, before the bot does: the moment the closing arrives.
        ws.on('message', (data) => {
          if (String(data).includes('"type":"closing"')) drainedAtClosing.push(drained)
        })
        return ws
      },
    },
  )
  // Twenty at a time: a few hundred connections in the same moment overflow the listening socket's queue on some
  // systems, refused before the service sees them.
  const starts = bots.map((bot, i) => setTimeout(() => bot.start(), Math.floor(i / 20) * 50))
  cleanups.push(() => starts.forEach((t) => clearTimeout(t)))
  cleanups.push(() => bots.forEach((b) => b.stop()))

  /** Waits for most tables to be in the middle of a game. */
  async function midGame(): Promise<void> {
    const steps = () => bots.reduce((n, b) => n + b.tally.steps, 0)
    await waitUntil(() => bots.every((b) => b.tally.seated.invite >= 1), 'every table')
    const at = steps()
    await waitUntil(() => steps() >= at + TABLES * 3 * 3, 'some steps at every table')
  }

  function setMaintenance(m: Maintenance | null): void {
    maintenance = m
    for (const listener of listeners) listener(m)
  }

  /** The checks after the bots were sent away with `reason`. */
  async function check(reason: string): Promise<void> {
    await waitUntil(() => bots.every((b) => (b.tally.closings[reason] ?? 0) >= 1), `every closing ${reason}`)
    for (const { tally } of bots) {
      expect(tally).toMatchObject({ unexpectedDisconnects: 0, invalid: 0, closingWithoutOver: 0, connectFailures: 0, ended: null })
      expect([...tally.closingGameIds].every((id) => tally.gameIds.has(id))).toBe(true)
    }
    const seen = new Set(bots.flatMap((b) => [...b.tally.gameIds]))
    const closing = new Set(bots.flatMap((b) => [...b.tally.closingGameIds]))
    // Most tables were in the middle of a game, and were played out.
    expect(closing.size).toBeGreaterThanOrEqual(TABLES / 2)

    // Every game seen to the end is stored; the ones played out with the steps of the closing.
    const rows = async () =>
      db.selectFrom('doudizhuGames').select(['gameId', 'record']).where('gameId', 'in', [...seen]).execute()
    await waitUntil(async () => (await rows()).length === seen.size, 'every game stored')
    for (const row of await rows()) {
      const actions = (row.record as { actions: { auto: string | null }[] }).actions
      expect(actions.some((a) => a.auto === 'closing'), `game ${row.gameId}`).toBe(closing.has(row.gameId))
    }

    // And a few students find them in their records.
    const sample = bots.filter((b) => b.tally.closingGameIds.size > 0).slice(0, 3)
    const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
    const verification = await verifyRecords(api, sample, { fetch, sleep, paceMs: 0, retryWaitMs: 200, retries: 3 })
    expect(verification).toMatchObject({ bots: 3, missing: [], failedBots: 0, complete: true })
  }

  return { service, bots, midGame, setMaintenance, check, drainedAtClosing, clock }
}

test(`maintenance comes on with ${TABLES} tables playing: every game is played out, sent and stored`, async () => {
  const b = await burst()
  await b.midGame()
  b.setMaintenance({ message: '维护', since: b.clock.now(), expectedBackAt: null })
  await b.check('maintenance')
}, 10_000)

test(`the service stops with ${TABLES} tables playing: every game is played out and stored before anyone is sent away`, async () => {
  const b = await burst()
  await b.midGame()
  await b.service.stop(5000)
  await b.check('service_stopping')
  // Every closing came once the records were all written.
  expect(b.drainedAtClosing.length).toBeGreaterThanOrEqual(b.bots.length)
  expect(b.drainedAtClosing.every((d) => d)).toBe(true)
}, 10_000)
