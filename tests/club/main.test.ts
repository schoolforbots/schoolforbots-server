import { type ChildProcess, spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer, type AddressInfo } from 'node:net'
import { afterEach, describe, expect, test, vi } from 'vitest'
import WebSocket from 'ws'
import { doudizhuGame } from '../../src/club/doudizhu-game.js'
import { join } from '../../src/club/members.js'
import { createRecorder, nextGameId, storedDoudizhuOptions } from '../../src/club/recorder.js'
import { CLUB_TICK_MS, type ClubService, createClubService, startClubService } from '../../src/club/service.js'
import type { Ticker } from '../../src/class/ticker.js'
import { createTestClock } from '../helpers/clock.js'
import { createTestDb } from '../helpers/db.js'
import { insertClass, insertStudent } from '../helpers/factories.js'
import { HELLO, track } from './helpers/club-app.js'
import { fakeGame, QUICK_DECK } from './helpers/fake-game.js'
import { exampleWordLists } from './helpers/parts.js'
import { exampleConfig, T0 } from './helpers/rooms.js'

// Starting the club service: `startClubService`, as the entry point (src/club/main.ts) does it, and the entry point
// itself, run as its own process against a test database.

describe('starting the club service', () => {
  let service: ClubService | undefined
  let destroyDb: (() => Promise<void>) | undefined
  let ticker: Ticker | undefined
  const sockets: WebSocket[] = []

  afterEach(async () => {
    await ticker?.stop()
    ticker = undefined
    for (const ws of sockets.splice(0)) ws.terminate()
    await service?.app.close()
    service = undefined
    await destroyDb?.()
    destroyDb = undefined
  })

  async function build() {
    const t = await createTestDb()
    destroyDb = t.destroy
    // The real game, on a clock stopped at a time the club is open.
    service = createClubService({ db: t.db, config: exampleConfig, clock: createTestClock(T0), game: doudizhuGame(), wordLists: exampleWordLists })
    return { db: t.db, service }
  }

  test('ticks before it listens, then on every interval, and is healthy once a tick of the ticker has finished', async () => {
    const { service: s } = await build()
    let ticks = 0
    const tick = s.tick
    s.tick = async () => {
      ticks++
      await tick()
    }
    expect((await s.app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(503)

    ticker = await startClubService(s, { port: 0, host: '127.0.0.1' })
    expect(ticks).toBe(1)
    expect(s.app.server.listening).toBe(true)
    await vi.waitFor(
      async () => expect((await s.app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200),
      { timeout: CLUB_TICK_MS * 10, interval: 50 },
    )
    expect(ticks).toBeGreaterThanOrEqual(2)
  })

  test('a member who connects over TCP gets in', async () => {
    const { db, service: s } = await build()
    const classId = await insertClass(db, { classNo: 1 })
    const { id, key } = await insertStudent(db, { classId, status: 'active', createdAt: new Date(T0.getTime() - 86_400_000) })
    await join(db, id, 'doudizhu', new Date(T0.getTime() - 60_000))
    ticker = await startClubService(s, { port: 0, host: '127.0.0.1' })

    const { port } = s.app.server.address() as AddressInfo
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/club`, { headers: { authorization: `Bearer ${key}` } })
    sockets.push(ws)
    const client = track(ws)
    await once(ws, 'open')
    client.send({ id: 'h', ...HELLO })
    expect(await client.next()).toEqual({ type: 'ack', id: 'h', ok: true })
    expect(await client.next()).toMatchObject({ type: 'welcome', club: { id: 'doudizhu', name: '斗地主社' }, room: null })
  })

  test('a game played over WebSocket is stored, and the next welcome shows it in the stats', async () => {
    const t = await createTestDb()
    destroyDb = t.destroy
    const clock = createTestClock(T0)
    const log = { error: vi.fn() }
    const recorder = createRecorder({ db: t.db, clock, log })
    const game = fakeGame({
      decks: [QUICK_DECK],
      firstBidder: 0,
      ...storedDoudizhuOptions({ db: t.db, clock, timeZone: exampleConfig.timezone, recorder, firstGameId: await nextGameId(t.db), log }),
    })
    service = createClubService({ db: t.db, config: exampleConfig, clock, game, wordLists: exampleWordLists })
    ticker = await startClubService(service, { port: 0, host: '127.0.0.1' })
    const { port } = service.app.server.address() as AddressInfo
    const classId = await insertClass(t.db, { classNo: 1 })

    async function connectAs(key: string) {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/club`, { headers: { authorization: `Bearer ${key}` } })
      sockets.push(ws)
      const client = track(ws)
      await once(ws, 'open')
      client.send({ id: 'h', ...HELLO })
      expect(await client.next()).toEqual({ type: 'ack', id: 'h', ok: true })
      const welcome = await client.next()
      expect(welcome.type).toBe('welcome')
      return { ws, client, welcome }
    }
    const students = []
    for (let i = 0; i < 3; i++) {
      const s = await insertStudent(t.db, { classId, status: 'active', createdAt: new Date(T0.getTime() - 86_400_000) })
      await join(t.db, s.id, 'doudizhu', new Date(T0.getTime() - 60_000))
      students.push(s)
    }
    const [a, b, c] = await Promise.all(students.map((s) => connectAs(s.key)))
    for (const x of [a!, b!, c!]) expect(x.welcome.stats).toEqual({ games: 0, wins: 0, points: { total: 0, week: 0 } })

    // Three students at a table: seat 0 (who opened the room) bids 3 and plays out, a landlord's spring.
    const created = await a!.client.request({ type: 'room.create', visibility: 'public', bots: false })
    const roomId = created.result.room.roomId as string
    expect((await b!.client.request({ type: 'room.join', roomId })).ok).toBe(true)
    expect((await c!.client.request({ type: 'room.join', roomId })).ok).toBe(true)
    const turnOf = async () => {
      for (;;) {
        const m = await a!.client.next()
        if (m.type === 'your_turn') return m
      }
    }
    expect((await a!.client.request({ type: 'bid', game: 'doudizhu', turn: (await turnOf()).turn, bid: 3 })).ok).toBe(true)
    const cards = '3 3 4 4 5 5 6 6 7 7 8 8 9 9 10 10 J J Q Q'.split(' ')
    const play = await a!.client.request({ type: 'play', game: 'doudizhu', turn: (await turnOf()).turn, cards, as: 'pair_straight' })
    expect(play.ok).toBe(true)
    await recorder.drain(10_000)

    a!.ws.close()
    b!.ws.close()
    await Promise.all([once(a!.ws, 'close'), once(b!.ws, 'close')])
    expect((await connectAs(students[0]!.key)).welcome.stats).toEqual({ games: 1, wins: 1, points: { total: 12, week: 12 } })
    expect((await connectAs(students[1]!.key)).welcome.stats).toEqual({ games: 1, wins: 0, points: { total: -6, week: -6 } })
    expect(log.error).not.toHaveBeenCalled()
  })

  test('a first tick that fails fails the start, and nothing listens', async () => {
    const { service: s } = await build()
    const failure = new Error('broken')
    await expect(
      startClubService({ app: s.app, tick: () => Promise.reject(failure), intervalMs: 1000 }, { port: 0, host: '127.0.0.1' }),
    ).rejects.toBe(failure)
    expect(s.app.server.listening).toBe(false)
  })

  test('a later tick that fails is reported to onTickFailure, and the next one still happens', async () => {
    const { service: s } = await build()
    let calls = 0
    const onTickFailure = vi.fn()
    const tick = async () => {
      calls++
      if (calls === 2) throw new Error('the tick broke')
    }
    ticker = await startClubService({ app: s.app, tick, intervalMs: 20 }, { port: 0, host: '127.0.0.1', onTickFailure })
    await vi.waitFor(() => expect(calls).toBeGreaterThanOrEqual(3), { timeout: 5000, interval: 10 })
    expect(onTickFailure).toHaveBeenCalledTimes(1)
  })
})

describe('the entry point', () => {
  let child: ChildProcess | undefined
  let destroyDb: (() => Promise<void>) | undefined

  afterEach(async () => {
    if (child !== undefined && child.exitCode === null) {
      const exited = once(child, 'exit')
      child.kill()
      await exited
    }
    child = undefined
    await destroyDb?.()
    destroyDb = undefined
  })

  async function freePort(): Promise<number> {
    const server = createServer()
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const { port } = server.address() as AddressInfo
    server.close()
    await once(server, 'close')
    return port
  }

  /** Runs src/club/main.ts with `env`; gives what it printed, as it prints it. */
  function run(env: Record<string, string>) {
    const output: string[] = []
    child = spawn(process.execPath, ['--import', 'tsx', 'src/club/main.ts'], {
      env: { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout!.on('data', (d) => void output.push(String(d)))
    child.stderr!.on('data', (d) => void output.push(String(d)))
    return { output, child }
  }

  test('starts on a migrated database with the example config and word lists, records its start, and is healthy', async () => {
    const t = await createTestDb()
    destroyDb = t.destroy
    const port = await freePort()
    const { output } = run({ DATABASE_URL: t.url, SCHOOL_CONFIG: 'config/school.example.json', CLUB_PORT: String(port) })

    await vi.waitFor(
      async () => {
        if (child!.exitCode !== null) throw new Error(`the service exited ${child!.exitCode}:\n${output.join('')}`)
        const res = await fetch(`http://127.0.0.1:${port}/healthz`).catch(() => null)
        expect(res?.status).toBe(200)
      },
      { timeout: 30_000, interval: 200 },
    )
    const starts = await t.db.selectFrom('serviceStarts').select('service').execute()
    expect(starts).toEqual([{ service: 'club' }])
  }, 40_000)

  test('does not start on a database not migrated to the latest version, and migrates nothing', async () => {
    const t = await createTestDb({ migrate: false })
    destroyDb = t.destroy
    const port = await freePort()
    const { output, child: c } = run({ DATABASE_URL: t.url, SCHOOL_CONFIG: 'config/school.example.json', CLUB_PORT: String(port) })
    const [code] = (await once(c, 'exit')) as [number]
    expect(code).toBe(1)
    expect(output.join('')).toContain('not migrated to the latest version')
  }, 40_000)
})
