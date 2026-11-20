import { afterEach, describe, expect, test, vi } from 'vitest'
import { SERVICE_STOPPING } from '../../src/club/club.js'
import { clubClosures } from '../../src/club/hours.js'
import { join, leave } from '../../src/club/members.js'
import { createClubService, type ClubService } from '../../src/club/service.js'
import type { SchoolConfig } from '../../src/shared/config.js'
import type { Maintenance, MaintenanceWatch } from '../../src/shared/maintenance.js'
import type { StudentStatus } from '../../src/shared/schema.js'
import { createTestClock } from '../helpers/clock.js'
import { createTestDb } from '../helpers/db.js'
import { insertClass, insertStudent } from '../helpers/factories.js'
import { captureLogs } from '../helpers/logs.js'
import { type Client, HELLO, type Received, track } from './helpers/club-app.js'
import { fakeGame, type FakeGame, QUICK_DECK } from './helpers/fake-game.js'
import { exampleWordLists } from './helpers/parts.js'
import { exampleConfig, T0 } from './helpers/rooms.js'

// The club service (src/club/service.ts) on a fresh database, with a clock that moves only when a test moves it and
// ticks only when a test calls `tick()`: closing and opening by the timetable, maintenance, the clubs switched off,
// the rounds of the students online, stopping, and /healthz.

/** A maintenance switch the test turns, calling the listeners after the value has changed, as the real watch does. */
function maintenanceSwitch(): MaintenanceWatch & { set(m: Maintenance | null): void } {
  let value: Maintenance | null = null
  const listeners: ((now: Maintenance | null) => void)[] = []
  return {
    current: () => value,
    refresh: async () => {},
    onChange: (listener) => void listeners.push(listener),
    stop: () => {},
    set(m) {
      value = m
      for (const listener of listeners) listener(m)
    },
  }
}

// The tests here send far more frames than a plugin would (a `sync` is one), so the rate is out of the way.
const UNLIMITED = { connection: { framesPerMinute: 100_000, maxQueuedFrames: 20, maxSendBufferKiB: 1024 } }

interface Harness {
  service: ClubService
  config: SchoolConfig
  clock: ReturnType<typeof createTestClock>
  game: FakeGame
  maintenance: ReturnType<typeof maintenanceSwitch>
  internalErrors: number
  logs: ReturnType<typeof captureLogs>
  destroy(): Promise<void>
}

let h: Harness | undefined
let errorsExpected = false
const sockets: { terminate(): void }[] = []

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.terminate()
  if (h !== undefined) {
    if (!errorsExpected) expect(h.logs.entries().filter((e) => e.level >= 50)).toEqual([])
    await h.destroy()
  }
  h = undefined
  errorsExpected = false
})

async function start(p: { club?: Partial<SchoolConfig['club']>; now?: Date } = {}): Promise<Harness> {
  const logs = captureLogs()
  const { db, destroy } = await createTestDb()
  dbHandle = db
  const config: SchoolConfig = { ...exampleConfig, club: { ...exampleConfig.club, ...UNLIMITED, ...p.club } }
  const clock = createTestClock(p.now ?? T0)
  const game = fakeGame({ decks: [QUICK_DECK], firstBidder: 0 })
  const maintenance = maintenanceSwitch()
  const harness: Harness = {
    service: undefined as never,
    config,
    clock,
    game,
    maintenance,
    internalErrors: 0,
    logs,
    async destroy() {
      await harness.service.app.close()
      await destroy()
    },
  }
  harness.service = createClubService({
    db,
    config,
    clock,
    game,
    wordLists: exampleWordLists,
    maintenance,
    logger: { level: 'info', stream: logs.stream },
    onInternalError: () => void harness.internalErrors++,
  })
  await harness.service.app.ready()
  h = harness
  return harness
}

/** The database of the service running. */
let dbHandle: Awaited<ReturnType<typeof createTestDb>>['db'] | undefined

/** A student in a class, a club member unless `member` is false. */
async function addStudent(p: { status?: StudentStatus; member?: boolean } = {}) {
  const db = dbHandle!
  const classId =
    (await db.selectFrom('classes').select('id').executeTakeFirst())?.id ?? (await insertClass(db, { classNo: 3 }))
  const student = await insertStudent(db, {
    status: p.status ?? 'active',
    classId,
    createdAt: new Date(T0.getTime() - 86_400_000),
  })
  if (p.member !== false) await join(db, student.id, 'doudizhu', new Date(T0.getTime() - 3_600_000))
  return student
}

async function connect(key: string): Promise<Client> {
  let client: Client | undefined
  const ws = await h!.service.app.injectWS(
    '/v1/club',
    { headers: { authorization: `Bearer ${key}` } },
    {
      onInit(socket) {
        client = track(socket)
      },
    },
  )
  sockets.push(ws)
  return client!
}

/** Says hello and gives the first message after the ack, or the `closing` sent in its place. */
async function hello(client: Client): Promise<Received> {
  client.send({ id: 'h1', ...HELLO })
  const first = await client.next()
  if (first.type !== 'ack') return first
  expect(first).toEqual({ type: 'ack', id: 'h1', ok: true })
  return client.next()
}

async function member(p: { status?: StudentStatus } = {}) {
  const student = await addStudent(p)
  const client = await connect(student.key)
  const welcome = await hello(client)
  expect(welcome.type).toBe('welcome')
  return { ...student, client }
}

/** Reads the client's messages up to and including its `closing`. */
async function untilClosing(client: Client): Promise<Received[]> {
  const got: Received[] = []
  for (;;) {
    const m = await client.next()
    got.push(m)
    if (m.type === 'closing') return got
  }
}

async function exchange(client: Client, message: Record<string, unknown>) {
  const ack = await client.request(message)
  return { ack, after: await client.sync() }
}

const CLOSURE = clubClosures(exampleConfig, T0)[0]!

describe('closing by the timetable', () => {
  test('at the moment it closes: the game is played out, the room closes, everyone is sent away until it reopens', async () => {
    const s = await start()
    const a = await member()
    // A room with bots: the game starts at once, and the student has the first bid.
    const created = await exchange(a.client, { type: 'room.create', visibility: 'public', bots: true })
    expect(created.ack.ok).toBe(true)
    expect(s.game.sessions).toHaveLength(1)
    expect(s.game.sessions[0]!.over).toBe(false)

    // A second before the close nothing happens.
    s.clock.set(new Date(CLOSURE.startsAt.getTime() - 1000))
    await s.service.tick()
    expect(await a.client.sync()).toEqual([])

    s.clock.set(CLOSURE.startsAt)
    await s.service.tick()
    const got = await untilClosing(a.client)
    expect(s.game.sessions[0]!.over).toBe(true)
    const events = got.filter((m) => m.type === 'room.event').map((m) => m.event)
    expect(events).toContainEqual({ kind: 'trustee', seat: 0, on: true, reason: 'closing' })
    expect(events.at(-1)).toEqual({ kind: 'closed', reason: 'club_closed' })
    expect(got.at(-1)).toEqual({
      type: 'closing',
      reason: 'club_closed',
      message: expect.stringContaining('以后再来'),
      reopensAt: CLOSURE.endsAt.toISOString(),
    })
    expect(await a.client.closed()).toBe(1000)
    expect(s.service.club.rooms.size).toBe(0)
    expect(s.service.club.online()).toEqual([])
  })

  test('while it is closed nobody comes in, and once it reopens they do', async () => {
    const s = await start()
    const student = await addStudent()

    s.clock.set(new Date(CLOSURE.startsAt.getTime() + 60_000))
    await s.service.tick()
    const refused = await connect(student.key)
    expect(await hello(refused)).toEqual({
      type: 'closing',
      reason: 'club_closed',
      message: expect.any(String),
      reopensAt: CLOSURE.endsAt.toISOString(),
    })
    expect(await refused.closed()).toBe(1000)

    s.clock.set(CLOSURE.endsAt)
    await s.service.tick()
    const back = await connect(student.key)
    expect((await hello(back)).type).toBe('welcome')
    expect(s.logs.entries().map((e) => e.msg)).toEqual(expect.arrayContaining(['club closed', 'club open']))
  })

  test('the close comes before the next tick for whoever says hello: the door is shut at the moment itself', async () => {
    const s = await start()
    const student = await addStudent()
    s.clock.set(CLOSURE.startsAt)
    // No tick yet.
    const client = await connect(student.key)
    expect(await hello(client)).toMatchObject({ type: 'closing', reason: 'club_closed', reopensAt: CLOSURE.endsAt.toISOString() })
  })

  test('with the clubs switched off, the service runs and lets nobody in, with no time to come back', async () => {
    const s = await start({ club: { enabled: false } })
    await s.service.tick()
    const student = await addStudent()
    const client = await connect(student.key)
    expect(await hello(client)).toEqual({ type: 'closing', reason: 'club_closed', message: '社团暂时关闭了，什么时候开放另行通知。' })
  })
})

describe('maintenance', () => {
  const m: Maintenance = { message: '系统升级，大约一小时。', since: T0, expectedBackAt: new Date(T0.getTime() + 3_600_000) }

  test('switched on: the room closes and everyone is sent away at once; while on nobody comes in; off, they do', async () => {
    const s = await start()
    const a = await member()
    await exchange(a.client, { type: 'room.create', visibility: 'public', bots: true })

    s.maintenance.set(m)
    const got = await untilClosing(a.client)
    expect(s.game.sessions[0]!.over).toBe(true)
    expect(got.filter((x) => x.type === 'room.event').at(-1)!.event).toEqual({ kind: 'closed', reason: 'maintenance' })
    expect(got.at(-1)).toEqual({
      type: 'closing',
      reason: 'maintenance',
      message: m.message,
      expectedBackAt: m.expectedBackAt!.toISOString(),
    })

    // The tick that follows finds it closed already, and has nothing more to do.
    await s.service.tick()
    const refused = await connect(a.key)
    expect(await hello(refused)).toMatchObject({ type: 'closing', reason: 'maintenance', expectedBackAt: m.expectedBackAt!.toISOString() })

    s.maintenance.set(null)
    await s.service.tick()
    const back = await connect(a.key)
    expect((await hello(back)).type).toBe('welcome')
  })
})

describe('the rounds of the students online', () => {
  /** Two members at a table without a game: `a` and `b`. */
  async function twoAtATable(s: Harness) {
    const a = await member()
    const b = await member()
    const created = await exchange(a.client, { type: 'room.create', visibility: 'public', bots: false })
    const roomId = created.ack.result.room.roomId as string
    await exchange(b.client, { type: 'room.join', roomId })
    await a.client.sync()
    return { a, b, roomId }
  }

  /** Moves the clock to the next round and waits for it. */
  async function nextRound(s: Harness) {
    s.clock.advance(s.config.switchRefreshSeconds * 1000)
    await s.service.tick()
    await s.service.roundsDone()
  }

  test('a member in good standing stays, and a round comes only every switchRefreshSeconds', async () => {
    const s = await start()
    const { a, roomId } = await twoAtATable(s)
    const status = async (value: StudentStatus) =>
      void (await dbHandle!.updateTable('students').set({ status: value }).where('id', '=', a.id).execute())

    // Short of the interval, a change is not seen yet.
    await status('suspended')
    s.clock.advance(s.config.switchRefreshSeconds * 1000 - 1000)
    await s.service.tick()
    await s.service.roundsDone()
    expect(s.service.club.online()).toContain(a.id)

    await status('active')
    await nextRound(s)
    expect(s.service.club.online()).toHaveLength(2)
    expect(s.service.club.online()).toContain(a.id)
    expect(s.service.club.rooms.state(roomId, s.clock.now())!.seats[0]!.online).toBe(true)
  })

  test.each([
    ['suspended', async (id: number) => {
      await dbHandle!.updateTable('students').set({ status: 'suspended', suspendedUntil: null }).where('id', '=', id).execute()
    }],
    ['expelled', async (id: number) => {
      await dbHandle!.updateTable('students').set({ status: 'expelled' }).where('id', '=', id).execute()
    }],
    ['not_member', async (id: number) => {
      await leave(dbHandle!, id, 'doudizhu')
    }],
  ] as const)('%s: sent away, and the seat waits out its grace as after any disconnect', async (reason, change) => {
    const s = await start()
    const { a, b, roomId } = await twoAtATable(s)
    await change(a.id)
    await nextRound(s)

    expect(await a.client.next()).toEqual({ type: 'closing', reason, message: expect.any(String) })
    expect(await a.client.closed()).toBe(1000)
    expect(s.service.club.online()).toEqual([b.id])
    // The seat is kept for the grace, then given up.
    expect(s.service.club.rooms.state(roomId, s.clock.now())!.seats[0]!.online).toBe(false)
    s.clock.advance(s.config.club.disconnectGraceSeconds * 1000)
    await s.service.tick()
    const toB = await b.client.sync()
    expect(toB.filter((m) => m.type === 'room.event').map((m) => m.event)).toContainEqual(
      expect.objectContaining({ kind: 'left', reason: 'disconnected_idle' }),
    )
    expect(s.service.club.rooms.roomOf(a.id)).toBeNull()
    // And they cannot come back.
    const again = await connect(a.key)
    expect(await hello(again)).toMatchObject({ type: 'closing', reason })
  })

  test('a round that fails is logged and counted, and the next one happens', async () => {
    const s = await start()
    errorsExpected = true
    await member()
    const db = dbHandle!
    const real = db.selectFrom.bind(db)
    const spy = vi.spyOn(db, 'selectFrom').mockImplementationOnce(() => {
      throw new Error('the database is down')
    })
    await nextRound(s)
    expect(s.internalErrors).toBe(1)
    expect(s.logs.entries().filter((e) => e.msg === 'club rounds failed')).toEqual([
      expect.objectContaining({ err: 'Error' }),
    ])
    spy.mockImplementation(real as never)
    await nextRound(s)
    expect(s.internalErrors).toBe(1)
  })
})

describe('stopping', () => {
  test('everyone is sent service_stopping, no room is closed, and nobody comes in after', async () => {
    const s = await start()
    const a = await member()
    const b = await member()
    await exchange(a.client, { type: 'room.create', visibility: 'public', bots: true })

    s.service.disconnectAll()
    for (const x of [a, b]) {
      const got = await untilClosing(x.client)
      expect(got.at(-1)).toEqual(SERVICE_STOPPING)
      expect(got.some((m) => m.type === 'room.event' && m.event.kind === 'closed')).toBe(false)
      expect(await x.client.closed()).toBe(1000)
    }
    expect(s.game.sessions[0]!.over).toBe(false)
    const late = await connect(a.key)
    expect(await hello(late)).toEqual(SERVICE_STOPPING)
    // A tick after it changes nothing: no close of the doors on top of it, no round.
    s.clock.set(CLOSURE.startsAt)
    await s.service.tick()
    expect(s.service.club.rooms.size).toBe(1)
  })
})

describe('a room that fails', () => {
  test('is logged and counted, and the other rooms go on', async () => {
    const s = await start()
    errorsExpected = true
    const a = await member()
    await exchange(a.client, { type: 'room.create', visibility: 'public', bots: true })
    s.game.sessions[0]!.tick = () => {
      throw new Error('the game broke')
    }
    await s.service.tick()
    expect(s.internalErrors).toBe(1)
    expect(s.logs.entries().filter((e) => e.msg === 'club room failed')).toHaveLength(1)
  })
})

describe('/healthz', () => {
  const healthz = async () => (await h!.service.app.inject({ method: 'GET', url: '/healthz' })).statusCode

  test('fails until a ticker is handed over, passes while it ticks, and fails when it is stuck', async () => {
    const s = await start()
    expect(await healthz()).toBe(503)

    let finishedAt: number | null = null
    s.service.watchTicker({ lastFinishedAt: () => finishedAt }, 1000)
    expect(await healthz()).toBe(503)
    finishedAt = Date.now()
    expect(await healthz()).toBe(200)
    // Stuck: no tick has finished for longer than 30 seconds.
    finishedAt = Date.now() - 31_000
    expect(await healthz()).toBe(503)
    // A longer interval allows longer: three of them.
    s.service.watchTicker({ lastFinishedAt: () => finishedAt }, 20_000)
    expect(await healthz()).toBe(200)
  })
})
