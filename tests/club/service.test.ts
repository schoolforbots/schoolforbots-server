import type { Kysely } from 'kysely'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { SERVICE_STOPPING } from '../../src/club/club.js'
import { clubClosures } from '../../src/club/hours.js'
import { join, leave } from '../../src/club/members.js'
import { createRecorder, type Recorder, storedDoudizhuOptions } from '../../src/club/recorder.js'
import { createClubService, type ClubService } from '../../src/club/service.js'
import type { SchoolConfig } from '../../src/shared/config.js'
import type { Maintenance, MaintenanceWatch } from '../../src/shared/maintenance.js'
import type { Database, StudentStatus } from '../../src/shared/schema.js'
import { createTestClock } from '../helpers/clock.js'
import { createTestDb } from '../helpers/db.js'
import { insertClass, insertStudent } from '../helpers/factories.js'
import { captureLogs } from '../helpers/logs.js'
import { type Client, HELLO, type Received, track } from './helpers/club-app.js'
import { fakeGame, type FakeGame, type FakeGameOptions, QUICK_DECK } from './helpers/fake-game.js'
import { exampleWordLists } from './helpers/parts.js'
import { exampleConfig, student, T0 } from './helpers/rooms.js'

// The rounds' query, held back while `hold` is set, and counted.
const query = vi.hoisted(() => ({ hold: null as Promise<void> | null, calls: 0 }))
vi.mock('../../src/club/members.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/club/members.js')>()
  return {
    ...real,
    standingsAmong: async (...args: Parameters<typeof real.standingsAmong>) => {
      query.calls++
      if (query.hold !== null) await query.hold
      return real.standingsAmong(...args)
    },
  }
})

/** Holds the rounds' query back until the function it gives is called, and counts its calls from now. */
function holdQuery(): () => void {
  // Every hello asks it too (the door judges as the rounds do); only the calls from here are counted.
  query.calls = 0
  let release!: () => void
  query.hold = new Promise((resolve) => {
    release = resolve
  })
  return () => {
    query.hold = null
    release()
  }
}

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
  query.hold = null
  query.calls = 0
  for (const ws of sockets.splice(0)) ws.terminate()
  if (h !== undefined) {
    if (!errorsExpected) expect(h.logs.entries().filter((e) => e.level >= 50)).toEqual([])
    await h.destroy()
  }
  h = undefined
  errorsExpected = false
})

async function start(
  p: { club?: Partial<SchoolConfig['club']>; now?: Date; game?: (db: Kysely<Database>) => FakeGameOptions } = {},
): Promise<Harness> {
  const logs = captureLogs()
  const { db, destroy } = await createTestDb()
  dbHandle = db
  const config: SchoolConfig = { ...exampleConfig, club: { ...exampleConfig.club, ...UNLIMITED, ...p.club } }
  const clock = createTestClock(p.now ?? T0)
  const game = fakeGame({ decks: [QUICK_DECK], firstBidder: 0, ...p.game?.(db) })
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

  test('a room whose game fails as it is played out is closed all the same, and everyone is still sent away', async () => {
    const s = await start()
    errorsExpected = true
    const a = await member()
    const b = await member()
    await exchange(a.client, { type: 'room.create', visibility: 'public', bots: true })
    await exchange(b.client, { type: 'room.create', visibility: 'public', bots: true })
    s.game.sessions[0]!.finish = () => {
      throw new Error('the game broke')
    }

    s.clock.set(CLOSURE.startsAt)
    await s.service.tick()
    for (const x of [a, b]) {
      expect((await untilClosing(x.client)).at(-1)).toMatchObject({ type: 'closing', reason: 'club_closed' })
    }
    // The other room was played out and closed as usual.
    expect(s.game.sessions[1]!.over).toBe(true)
    expect(s.service.club.rooms.size).toBe(0)
    expect(s.service.club.rooms.roomOf(a.id)).toBeNull()
    expect(s.internalErrors).toBe(1)
    expect(s.logs.entries().filter((e) => e.msg === 'club room failed')).toHaveLength(1)
  })

  test('a room left behind while it is closed is closed at the next tick', async () => {
    const s = await start()
    s.clock.set(CLOSURE.startsAt)
    await s.service.tick()

    // A room left behind (as by a close that went wrong), with nobody connected.
    const create = { id: 'c', type: 'room.create', visibility: 'public', bots: false } as const
    expect(s.service.club.handle(student(4242), create, () => null, s.clock.now()).ok).toBe(true)
    expect(s.service.club.rooms.size).toBe(1)

    s.clock.advance(1000)
    await s.service.tick()
    expect(s.service.club.rooms.size).toBe(0)
  })

  test('a connection that got in while it is closed is sent away at the next tick', async () => {
    const s = await start()
    s.clock.set(CLOSURE.startsAt)
    await s.service.tick()
    const close = vi.fn()
    s.service.club.hub.add({ studentId: 4343, send: () => {}, close })

    s.clock.advance(1000)
    await s.service.tick()
    expect(close).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ type: 'closing', reason: 'club_closed', reopensAt: CLOSURE.endsAt.toISOString() }),
    )
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

  test('a student no longer on the students table is sent away as not a member', async () => {
    const s = await start()
    const { a, b } = await twoAtATable(s)
    await dbHandle!.deleteFrom('clubMembers').where('studentId', '=', a.id).execute()
    await dbHandle!.deleteFrom('students').where('id', '=', a.id).execute()
    await nextRound(s)
    expect(await a.client.next()).toEqual({ type: 'closing', reason: 'not_member', message: expect.any(String) })
    expect(s.service.club.online()).toEqual([b.id])
  })

  test('a round whose query is still going when the service stops sends nobody away after it', async () => {
    const s = await start()
    const { a } = await twoAtATable(s)
    await dbHandle!.updateTable('students').set({ status: 'suspended', suspendedUntil: null }).where('id', '=', a.id).execute()
    const release = holdQuery()
    s.clock.advance(s.config.switchRefreshSeconds * 1000)
    await s.service.tick()
    expect(query.calls).toBe(1)

    s.service.disconnectAll()
    expect((await untilClosing(a.client)).at(-1)).toEqual(SERVICE_STOPPING)
    const disconnect = vi.spyOn(s.service.club, 'disconnect')
    release()
    await s.service.roundsDone()
    expect(disconnect).not.toHaveBeenCalled()
  })

  test('a tick while a round is still going starts no second one', async () => {
    const s = await start()
    await twoAtATable(s)
    const release = holdQuery()
    s.clock.advance(s.config.switchRefreshSeconds * 1000)
    await s.service.tick()
    s.clock.advance(s.config.switchRefreshSeconds * 1000)
    await s.service.tick()
    expect(query.calls).toBe(1)
    release()
    await s.service.roundsDone()
    // The next one, once it is due, runs.
    await nextRound(s)
    expect(query.calls).toBe(2)
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

describe('stopping with the games stored', () => {
  /** A service whose game stores its records with a recorder on the test database (`db` is the one the recorder uses). */
  async function startStored(p: { db?: (db: Kysely<Database>) => Kysely<Database>; sleep?: (ms: number) => Promise<void> } = {}) {
    const recorderLog: Record<string, any>[] = []
    let recorder!: Recorder
    const s = await start({
      game: (db) => {
        const log = { error: (obj: unknown) => void recorderLog.push(obj as Record<string, any>) }
        const used = p.db?.(db) ?? db
        recorder = createRecorder({ db: used, clock: createTestClock(T0), log, ...(p.sleep ? { sleep: p.sleep } : {}) })
        return storedDoudizhuOptions({ db: used, clock: createTestClock(T0), timeZone: exampleConfig.timezone, recorder, firstGameId: 1, log })
      },
    })
    return { s, recorder, recorderLog }
  }

  test('a game being played is played out, its events sent and its record stored, and only then is everyone sent away', async () => {
    const { s, recorder } = await startStored()
    const a = await member()
    const b = await member()
    await exchange(a.client, { type: 'room.create', visibility: 'public', bots: true })
    expect(s.game.sessions[0]!.over).toBe(false)
    const pendingAtDisconnect: number[] = []
    const club = s.service.club
    const real = club.disconnectAll.bind(club)
    vi.spyOn(club, 'disconnectAll').mockImplementation((closing) => {
      pendingAtDisconnect.push(recorder.pending())
      real(closing)
    })

    await s.service.stop(10_000)
    expect(pendingAtDisconnect).toEqual([0])
    expect(s.game.sessions[0]!.over).toBe(true)
    const got = await untilClosing(a.client)
    const events = got.filter((m) => m.type === 'room.event').map((m) => m.event)
    expect(events).toContainEqual({ kind: 'trustee', seat: 0, on: true, reason: 'closing' })
    expect(events).toContainEqual(expect.objectContaining({ kind: 'game', event: expect.objectContaining({ kind: 'over' }) }))
    expect(events.some((e) => e.kind === 'closed')).toBe(false)
    expect(got.at(-1)).toEqual(SERVICE_STOPPING)
    expect((await untilClosing(b.client)).at(-1)).toEqual(SERVICE_STOPPING)

    const games = await dbHandle!.selectFrom('doudizhuGames').select(['gameId', 'ranked']).execute()
    expect(games).toEqual([{ gameId: 1, ranked: false }])
    const rows = await dbHandle!.selectFrom('doudizhuGamePlayers').select(['seat', 'studentId']).execute()
    expect(rows).toEqual([{ seat: 0, studentId: a.id }])
    const stored = await dbHandle!.selectFrom('doudizhuGames').select('record').executeTakeFirstOrThrow()
    expect((stored.record as any).actions.some((step: any) => step.auto === 'closing')).toBe(true)
    // The rooms stay as they were.
    expect(s.service.club.rooms.size).toBe(1)
  })

  test('no game starts while the records are waited for', async () => {
    let release!: () => void
    const s = await start({
      game: () => ({ drain: () => new Promise<void>((resolve) => (release = resolve)) }),
    })
    const a = await member()
    await exchange(a.client, { type: 'room.create', visibility: 'public', bots: true })
    const stopped = s.service.stop(10_000)
    await vi.waitFor(() => expect(release).toBeDefined())
    // The game is over; the student, ready again, still gets no new game.
    expect(s.game.sessions[0]!.over).toBe(true)
    const ready = await exchange(a.client, { type: 'room.ready' })
    expect(ready.ack.ok).toBe(true)
    expect(s.game.sessions).toHaveLength(1)
    expect(s.service.club.online()).toEqual([a.id])
    release()
    await stopped
    expect((await untilClosing(a.client)).at(-1)).toEqual(SERVICE_STOPPING)
  })

  test('a drain that times out still sends everyone away, and logs the record not stored', async () => {
    // Every write hangs; the drain's timeout passes at once.
    const { s, recorderLog } = await startStored({
      db: (db) =>
        new Proxy(db, {
          get: (target, key) => {
            if (key === 'transaction') return () => ({ execute: () => new Promise(() => {}) })
            const value = Reflect.get(target, key)
            return typeof value === 'function' ? value.bind(target) : value
          },
        }),
      sleep: async () => {},
    })
    const a = await member()
    await exchange(a.client, { type: 'room.create', visibility: 'public', bots: true })
    await s.service.stop(10)
    expect((await untilClosing(a.client)).at(-1)).toEqual(SERVICE_STOPPING)
    expect(recorderLog).toEqual([expect.objectContaining({ why: 'drain_timeout', game: expect.objectContaining({ gameId: 1 }) })])
    expect(await dbHandle!.selectFrom('doudizhuGames').selectAll().execute()).toEqual([])
    await vi.waitFor(async () =>
      expect(await dbHandle!.selectFrom('opsEvents').select(['service', 'kind']).execute()).toEqual([
        { service: 'club', kind: 'internal_error' },
      ]),
    )
  })
})

describe('a room that fails', () => {
  test('is logged and counted, and the other rooms go on', async () => {
    const s = await start()
    errorsExpected = true
    const a = await member()
    const b = await member()
    await exchange(a.client, { type: 'room.create', visibility: 'public', bots: true })
    await exchange(b.client, { type: 'room.create', visibility: 'public', bots: true })
    const [first, second] = [s.game.sessions[0]!, s.game.sessions[1]!]
    first.tick = () => {
      throw new Error('the game broke')
    }
    const ticked = vi.spyOn(second, 'tick')
    await s.service.tick()
    // Whichever room comes first in the tick, the other is ticked all the same.
    expect(ticked).toHaveBeenCalledTimes(1)
    expect(s.internalErrors).toBe(1)
    expect(s.logs.entries().filter((e) => e.msg === 'club room failed')).toHaveLength(1)

    // The room that failed is closed: its game played out, its student out of it, with no `closed` event (the
    // protocol has no reason for it); the other room goes on.
    expect(first.over).toBe(true)
    expect(s.service.club.rooms.size).toBe(1)
    expect(s.service.club.rooms.roomOf(a.id)).toBeNull()
    expect(s.service.club.rooms.roomOf(b.id)).not.toBeNull()
    const toA = await a.client.sync()
    expect(toA.at(-1)).toMatchObject({ type: 'room.left', reason: 'closed' })
    expect(toA.some((m) => m.type === 'room.event' && m.event.kind === 'closed')).toBe(false)
    // So it does not fail again at every tick; the student may open another room.
    s.clock.advance(1000)
    await s.service.tick()
    expect(s.internalErrors).toBe(1)
    expect((await exchange(a.client, { type: 'room.create', visibility: 'public', bots: true })).ack.ok).toBe(true)
  })

  test('whose game fails again as it is played out is forgotten all the same, its spectators no longer watching', async () => {
    const s = await start()
    errorsExpected = true
    const a = await member()
    const watcher = await member()
    const created = await exchange(a.client, { type: 'room.create', visibility: 'public', bots: true })
    const roomId = created.ack.result.room.roomId as string
    expect((await exchange(watcher.client, { type: 'watch', roomId })).ack.ok).toBe(true)
    const session = s.game.sessions[0]!
    session.tick = () => {
      throw new Error('the game broke')
    }
    session.finish = () => {
      throw new Error('and broke again')
    }
    await s.service.tick()
    expect(s.internalErrors).toBe(2)
    expect(s.service.club.rooms.size).toBe(0)
    expect(s.service.club.rooms.roomOf(a.id)).toBeNull()
    expect(s.service.club.watchers.watchedBy(watcher.id)).toBeNull()
    expect((await a.client.sync()).at(-1)).toMatchObject({ type: 'room.left', roomId, reason: 'closed' })
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
