import { once } from 'node:events'
import { sql } from 'kysely'
import Value from 'typebox/value'
import { afterEach, describe, expect, test } from 'vitest'
import WebSocket from 'ws'
import { markAttendance } from '../../src/class/attendance.js'
import type { AckResult, MessageHandlers, Participant } from '../../src/class/connection.js'
import { WS_ERROR_MESSAGES } from '../../src/class/ws-errors.js'
import { ServerMessage } from '../../src/protocol/ws.js'
import type { StudentStatus } from '../../src/shared/schema.js'
import { buildTestClassApp } from '../helpers/class-app.js'
import { insertClass, insertLesson, insertSession, insertStudent } from '../helpers/factories.js'
import { captureLogs } from '../helpers/logs.js'

const MON = '2026-11-02'
/** A wall-clock time in Beijing (the example config's timezone), `HH:MM` or `HH:MM:SS`, on `date`. */
const at = (time: string, date = MON) => new Date(`${date}T${time.length === 5 ? `${time}:00` : time}+08:00`)

const SEGMENTS = [1, 2, 3, 4, 5].map((i) => ({ text: `光的折射第${i}段`, gist: `要点${i}` }))

// A server message as the test reads it; every one is also checked against the published ServerMessage schema.
type Received = Record<string, any>

type Service = Awaited<ReturnType<typeof buildTestClassApp>>

let service: Service | undefined
let logs: ReturnType<typeof captureLogs> | undefined
const sockets: WebSocket[] = []

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.terminate()
  await service?.destroy()
  service = undefined
  // Nothing in these tests is a server fault.
  expect(logs?.entries().filter((e) => e.level >= 50) ?? []).toEqual([])
  logs = undefined
})

/** A class service whose `onDisconnect` hook writes into `disconnects`, logging into `logs`. */
async function start(overrides: Parameters<typeof buildTestClassApp>[0] = {}) {
  const disconnects: number[] = []
  logs = captureLogs()
  service = await buildTestClassApp({
    logger: { level: 'info', stream: logs.stream },
    ...overrides,
    hooks: { onDisconnect: (studentId) => void disconnects.push(studentId), ...overrides.hooks },
  })
  return { ...service, disconnects, logs }
}

async function waitUntil(check: () => boolean, what: string): Promise<void> {
  await waitUntilAsync(async () => check(), what)
}

async function waitUntilAsync(check: () => Promise<boolean>, what: string): Promise<void> {
  for (let waited = 0; !(await check()); waited += 5) {
    if (waited > 5000) throw new Error(`Timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

interface Client {
  ws: WebSocket
  received: Received[]
  send(message: unknown): void
  /** The next message not read yet, waiting for it to arrive. */
  next(): Promise<Received>
  /** Waits for the server to close the connection and returns the close code. */
  closed(): Promise<number>
  /** Sends a frame the server cannot parse and waits for its ack: every message sent before it has arrived by then. */
  sync(): Promise<void>
}

/** Reads what the server sends `ws`. Called before the socket opens, so nothing is missed. */
function track(ws: WebSocket): Client {
  const received: Received[] = []
  let cursor = 0
  let closeCode: number | null = null
  ws.on('message', (data) => void received.push(JSON.parse(String(data))))
  ws.on('close', (code) => {
    closeCode = code
  })
  const client: Client = {
    ws,
    received,
    send: (message) => ws.send(typeof message === 'string' ? message : JSON.stringify(message)),
    async next() {
      await waitUntil(() => cursor < received.length || closeCode !== null, 'a message')
      const message = received[cursor]
      if (message === undefined) throw new Error(`The connection closed (${closeCode}) with no more messages`)
      cursor++
      expect(Value.Check(ServerMessage, message), JSON.stringify(message)).toBe(true)
      return message
    },
    async closed() {
      await waitUntil(() => closeCode !== null, 'the close')
      return closeCode ?? 0
    },
    async sync() {
      client.send('sync')
      for (;;) {
        const m = await client.next()
        if (m.type === 'ack' && m.id === '' && m.ok === false) return
      }
    },
  }
  return client
}

/** Opens a connection with `key` (none when null). Listeners are attached before the upgrade, so nothing is missed. */
async function connect(key: string | null): Promise<Client> {
  if (service === undefined) throw new Error('start() first')
  let client: Client | undefined
  const ws = await service.app.injectWS(
    '/v1/class',
    { headers: key === null ? {} : { authorization: `Bearer ${key}` } },
    {
      onInit(socket) {
        client = track(socket)
      },
    },
  )
  sockets.push(ws)
  if (client === undefined) throw new Error('The connection was never set up')
  return client
}

/**
 * Opens a connection over TCP to the service listening on a port of its own, for what an injected connection does
 * not do: answer pings (unless `autoPong` is false), and close the way a real client does.
 */
async function connectOverTcp(key: string, options: { autoPong?: boolean } = {}): Promise<Client> {
  if (service === undefined) throw new Error('start() first')
  const { app } = service
  if (!app.server.listening) await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  if (address === null || typeof address === 'string') throw new Error('The service is not listening on a port')
  const ws = new WebSocket(`ws://127.0.0.1:${address.port}/v1/class`, {
    headers: { authorization: `Bearer ${key}` },
    autoPong: options.autoPong ?? true,
  })
  // A connection the server drops may end with a reset: that is the point, not a failure of the test.
  ws.on('error', () => {})
  const client = track(ws)
  sockets.push(ws)
  await once(ws, 'open')
  return client
}

const HELLO = { type: 'hello', protocol: 'v1', plugin: { type: 'openclaw', version: '1.2.3' }, maxRounds: 4 }

/** Sends hello and returns the welcome, after the ack that comes first. */
async function hello(client: Client, extra: Record<string, unknown> = {}): Promise<Received> {
  client.send({ id: 'h1', ...HELLO, ...extra })
  expect(await client.next()).toEqual({ type: 'ack', id: 'h1', ok: true })
  const welcome = await client.next()
  expect(welcome.type).toBe('welcome')
  return welcome
}

/** Reads `n` messages. */
async function take(client: Client, n: number): Promise<Received[]> {
  const out: Received[] = []
  for (let i = 0; i < n; i++) out.push(await client.next())
  return out
}

let nameCounter = 0

/** An evening junior class taught by 林老师, with today's lesson and `members` active students. */
async function seedClass(s: Service, members = 2) {
  await insertLesson(s.db, { date: MON, subject: '科学', title: '光的折射', segments: SEGMENTS })
  const classId = await insertClass(s.db, { classNo: 1, teacherPersonaId: 'lin-laoshi' })
  const students = []
  for (let i = 0; i < members; i++) students.push(await addStudent(s, classId))
  return { classId, students }
}

async function addStudent(
  s: Service,
  classId: number | null,
  p: { status?: StudentStatus; suspendedUntil?: Date | null } = {},
) {
  const n = ++nameCounter
  const ownerName = `阿${n}`
  const aiName = `小鱼${n}`
  const { id, key } = await insertStudent(s.db, {
    classId,
    status: p.status ?? 'active',
    ownerName,
    aiName,
    suspendedUntil: p.suspendedUntil ?? null,
  })
  return { id, key, displayName: `${ownerName}家的${aiName}` }
}

/** Sets the clock and runs the lesson runtime once. */
async function tickAt(s: Service, time: Date) {
  s.clock.set(time)
  await s.runtime.tick()
}

const sessionIdOf = (s: Service, classId: number) => {
  const session = s.runtime.currentSession(classId)
  if (session === null) throw new Error('No session')
  return session.sessionId
}

const studentRow = (s: Service, id: number) =>
  s.db
    .selectFrom('students')
    .select(['lessonsAttended', 'lastAttendedAt'])
    .where('id', '=', id)
    .executeTakeFirstOrThrow()

const attendanceRows = (s: Service) =>
  s.db.selectFrom('attendance').select(['sessionId', 'studentId', 'firstSeenAt']).orderBy('studentId').execute()

describe('the upgrade', () => {
  test('is refused with 401 without a key, with a malformed header or with an unknown key', async () => {
    const s = await start()
    await addStudent(s, null)

    for (const headers of [{}, { authorization: 'Basic abc' }, { authorization: 'Bearer ais_unknown' }]) {
      await expect(s.app.injectWS('/v1/class', { headers })).rejects.toThrow('Unexpected server response: 401')
    }
  })
})

describe('a student who may not come in', () => {
  test('a suspended student is told until when and disconnected', async () => {
    const s = await start()
    const { classId } = await seedClass(s, 1)
    const suspended = await addStudent(s, classId, { status: 'suspended', suspendedUntil: at('20:31', '2026-11-05') })
    await tickAt(s, at('19:50'))

    const client = await connect(suspended.key)
    expect(await client.next()).toEqual({
      type: 'closing',
      reason: 'suspended',
      message: '你正在停课，11月5日 20:31 以后才能回来上课。',
    })
    expect(await client.closed()).toBe(1000)
    expect(await attendanceRows(s)).toEqual([])
  })

  test('a suspended student whose suspension has run out comes in', async () => {
    const s = await start()
    const { classId } = await seedClass(s, 1)
    const back = await addStudent(s, classId, { status: 'suspended', suspendedUntil: at('19:00') })
    await tickAt(s, at('19:50'))

    const client = await connect(back.key)
    await hello(client)
  })

  test.each<[StudentStatus, string]>([
    ['pending', '你还没有分班，分到班级后才能来上课。'],
    ['waitlisted', '你还没有分班，分到班级后才能来上课。'],
    ['dropped', '你已经退学，不在任何班级里了，重新报名分班后才能来上课。'],
    ['expelled', '你已经被开除，不在任何班级里了。'],
  ])('a %s student without a class is told so and disconnected', async (status, message) => {
    const s = await start()
    await seedClass(s, 1)
    await tickAt(s, at('19:50'))
    const outsider = await addStudent(s, null, { status })

    const client = await connect(outsider.key)
    expect(await client.next()).toEqual({ type: 'closing', reason: 'session_over', message })
    expect(await client.closed()).toBe(1000)
  })

  test('before the doors, the student is told when the lesson starts', async () => {
    const s = await start()
    const { students } = await seedClass(s, 1)
    await tickAt(s, at('19:44'))

    const client = await connect(students[0]!.key)
    expect(await client.next()).toEqual({
      type: 'closing',
      reason: 'session_over',
      message: '现在不在上课时间，下一节课在 11月2日 20:00 开始。',
    })
    expect(await client.closed()).toBe(1000)
  })

  test('after the close, the student is told when the next lesson starts', async () => {
    const s = await start()
    const { students } = await seedClass(s, 1)
    await tickAt(s, at('19:45'))
    await tickAt(s, at('20:31'))

    const client = await connect(students[0]!.key)
    expect(await client.next()).toEqual({
      type: 'closing',
      reason: 'session_over',
      message: '现在不在上课时间，下一节课在 11月3日 20:00 开始。',
    })
    expect(await client.closed()).toBe(1000)
  })

  test('a hello during which the session closes registers nothing and is answered the same way', async () => {
    const s = await start()
    const { classId, students } = await seedClass(s, 1)
    await tickAt(s, at('19:50'))
    const client = await connect(students[0]!.key)

    // Hold the hello inside its attendance write, close the session meanwhile, then let the hello go on.
    await s.db.transaction().execute(async (trx) => {
      await sql`lock table attendance in share mode`.execute(trx)
      client.send({ id: 'h1', ...HELLO })
      await waitUntilAsync(async () => {
        const { rows } = await sql<{ n: number }>`
          select count(*)::int as n from pg_locks l join pg_class c on c.oid = l.relation
          where c.relname = 'attendance' and not l.granted`.execute(s.db)
        return rows[0]!.n > 0
      }, 'the hello to wait on the attendance table')
      await tickAt(s, at('20:31')) // the close step runs while nobody is registered
      expect(s.runtime.currentSession(classId)).toBeNull()
    })

    expect(await client.next()).toEqual({
      type: 'closing',
      reason: 'session_over',
      message: '现在不在上课时间，下一节课在 11月3日 20:00 开始。',
    })
    expect(await client.closed()).toBe(1000)
    expect(client.received.map((m) => m.type)).toEqual(['closing'])
    expect(s.hub.online(classId)).toEqual([])
    expect(s.disconnects).toEqual([])
  })

  test('a hello that comes after the session closed is answered the same way', async () => {
    const s = await start()
    const { students } = await seedClass(s, 1)
    await tickAt(s, at('19:45'))
    await tickAt(s, at('20:30:30'))
    const client = await connect(students[0]!.key)

    s.clock.set(at('20:31'))
    client.send({ id: 'h1', ...HELLO })
    expect(await client.next()).toEqual({
      type: 'closing',
      reason: 'session_over',
      message: '现在不在上课时间，下一节课在 11月3日 20:00 开始。',
    })
    expect(await client.closed()).toBe(1000)
    expect(await attendanceRows(s)).toEqual([])
  })
})

describe('frames before hello', () => {
  test('anything but hello needs hello first; bad frames and other protocols are refused', async () => {
    const s = await start()
    const { students } = await seedClass(s, 1)
    await tickAt(s, at('19:50'))
    const client = await connect(students[0]!.key)

    const error = (id: string, code: keyof typeof WS_ERROR_MESSAGES) => ({
      type: 'ack',
      id,
      ok: false,
      error: { code, message: WS_ERROR_MESSAGES[code] },
    })

    client.send({ id: 'q1', type: 'question', text: '为什么天是蓝的？' })
    expect(await client.next()).toEqual(error('q1', 'hello_required'))

    client.send({ id: 'h0', ...HELLO, protocol: 'v2' })
    expect(await client.next()).toEqual(error('h0', 'protocol_unsupported'))

    client.send('{not json')
    expect(await client.next()).toEqual(error('', 'invalid_message'))

    client.send({ id: 'h2', ...HELLO, maxRounds: 0 })
    expect(await client.next()).toEqual(error('h2', 'invalid_message'))

    client.send({ id: 7, type: 'question', text: 'hi' }) // a numeric id is not echoed
    expect(await client.next()).toEqual(error('', 'invalid_message'))

    client.send([1, 2])
    expect(await client.next()).toEqual(error('', 'invalid_message'))

    // Still open: a correct hello gets in.
    await hello(client)
  })

  test('a frame over 16 KiB is refused and the connection stays usable', async () => {
    const s = await start()
    const { students } = await seedClass(s, 1)
    await tickAt(s, at('19:50'))
    const client = await connect(students[0]!.key)

    // Counted in bytes: 5,600 CJK characters are 16,800 bytes of UTF-8 (the limit is 16,384).
    client.send({ id: 'q1', type: 'question', text: '字'.repeat(5600) })
    expect(await client.next()).toEqual({
      type: 'ack',
      id: '',
      ok: false,
      error: { code: 'invalid_message', message: WS_ERROR_MESSAGES.invalid_message },
    })
    client.send({ id: 'h1', ...HELLO, padding: 'x'.repeat(17 * 1024) })
    expect((await client.next()).error.code).toBe('invalid_message')

    await hello(client)
  })

  test('a frame over 64 KiB closes the connection', async () => {
    const s = await start()
    const { students } = await seedClass(s, 1)
    await tickAt(s, at('19:50'))
    const client = await connect(students[0]!.key)

    client.send({ id: 'q1', type: 'question', text: 'x'.repeat(64 * 1024) })
    expect(await client.closed()).toBe(1009)
  })
})

describe('the transport', () => {
  const HELLO_TIMEOUT = { type: 'closing', reason: 'session_over', message: '连上以后没有及时收到 hello，连接已经断开。' }

  test('a connection that sends no valid hello in time is told so and closed', async () => {
    const s = await start({ helloTimeoutMs: 500 })
    const { students } = await seedClass(s, 1)
    await tickAt(s, at('19:50'))

    const client = await connectOverTcp(students[0]!.key)
    // Neither another protocol's hello nor anything else counts.
    client.send({ id: 'h0', ...HELLO, protocol: 'v2' })
    expect(await client.next()).toMatchObject({ type: 'ack', id: 'h0', ok: false, error: { code: 'protocol_unsupported' } })
    expect(await client.next()).toEqual(HELLO_TIMEOUT)
    expect(await client.closed()).toBe(1000)
    expect(await attendanceRows(s)).toEqual([])
  })

  test('the deadline does not close a connection whose hello came in time, however long the hello takes', async () => {
    const s = await start({
      helloTimeoutMs: 500,
      handlers: {
        // The welcome waits for this, long past the deadline.
        join: async () => {
          await new Promise((resolve) => setTimeout(resolve, 1000))
          return { initiationsLeft: 3 }
        },
      },
    })
    const { students } = await seedClass(s, 1)
    await tickAt(s, at('19:50'))

    const client = await connectOverTcp(students[0]!.key)
    await hello(client)
    await new Promise((resolve) => setTimeout(resolve, 600))
    await client.sync()
    expect(client.received.filter((m) => m.type === 'closing')).toEqual([])
  })

  test('a client that stops answering pings is dropped, and its classmates see it leave', async () => {
    const s = await start({ pingIntervalMs: 500 })
    const { classId, students } = await seedClass(s, 2)
    const [a, b] = students
    await tickAt(s, at('19:50'))

    const ca = await connectOverTcp(a!.key)
    await hello(ca)
    const cb = await connectOverTcp(b!.key, { autoPong: false })
    await hello(cb)
    expect(await ca.next()).toEqual({ type: 'presence', joined: { studentId: b!.id, displayName: b!.displayName } })

    // Dropped without a close frame: the connection is torn down.
    expect(await cb.closed()).toBe(1006)
    expect(await ca.next()).toEqual({ type: 'presence', left: { studentId: b!.id, displayName: b!.displayName } })
    expect(s.disconnects).toEqual([b!.id])
    expect(s.hub.online(classId)).toEqual([a!.id])
    expect(s.logs.entries().filter((e) => e.msg === 'class connection stopped answering pings')).toMatchObject([
      { studentId: b!.id },
    ])

    // The one that answers stays, ping after ping.
    await new Promise((resolve) => setTimeout(resolve, 1500))
    await ca.sync()
    expect(ca.received.filter((m) => m.type === 'closing')).toEqual([])
  })
})

describe('joining the class', () => {
  test('welcome, then every event since the opening replayed, then the live ones', async () => {
    const s = await start()
    const { classId, students } = await seedClass(s, 1)
    const [a] = students
    await tickAt(s, at('19:45'))
    await tickAt(s, at('20:06'))
    const sessionId = sessionIdOf(s, classId)

    const client = await connect(a!.key)
    const welcome = await hello(client)
    expect(welcome).toEqual({
      type: 'welcome',
      student: { studentId: a!.id, displayName: a!.displayName },
      class: { classId, className: '初中部·晚班·1 班', teacher: { name: '林老师' } },
      session: {
        sessionId,
        kind: 'lesson',
        startsAt: at('20:00').toISOString(),
        endsAt: at('20:30').toISOString(),
        subject: '科学',
        title: '光的折射',
      },
      online: [],
      limits: {
        maxInitiationsPerLesson: 3,
        initiationsLeft: 3,
        maxRoundsPerConversation: 5,
        maxMessageChars: 300,
        maxQuestionsPerLesson: 3,
        closingGraceSeconds: 60,
      },
      probation: true,
    })

    expect(await take(client, 2)).toEqual([
      {
        type: 'class.event',
        seq: 1,
        replayed: true,
        at: at('20:06').toISOString(),
        event: { kind: 'teacher', text: '同学们好，我是林老师。今天我们上科学课，题目是《光的折射》。' },
      },
      {
        type: 'class.event',
        seq: 2,
        replayed: true,
        at: at('20:06').toISOString(),
        event: { kind: 'segment', index: 1, text: '光的折射第1段' },
      },
    ])

    await tickAt(s, at('20:10'))
    expect(await take(client, 2)).toEqual([
      {
        type: 'class.event',
        seq: 3,
        replayed: false,
        at: at('20:10').toISOString(),
        event: { kind: 'teacher', text: '我们继续，下面是第 2 段。' },
      },
      {
        type: 'class.event',
        seq: 4,
        replayed: false,
        at: at('20:10').toISOString(),
        event: { kind: 'segment', index: 2, text: '光的折射第2段' },
      },
    ])
  })

  test('lastSeq replays only the events after it', async () => {
    const s = await start()
    const { students } = await seedClass(s, 2)
    const [a, b] = students
    await tickAt(s, at('19:45'))
    await tickAt(s, at('20:10'))

    const first = await connect(a!.key)
    await hello(first, { lastSeq: 2 })
    expect((await take(first, 2)).map((m) => [m.seq, m.replayed])).toEqual([
      [3, true],
      [4, true],
    ])

    // Caught up: nothing is replayed, so the next thing to arrive is the answer to the next frame.
    const second = await connect(b!.key)
    await hello(second, { lastSeq: 4 })
    second.send('sync')
    expect(await second.next()).toMatchObject({ type: 'ack', id: '', ok: false })
  })

  test('a study hall has no subject or title', async () => {
    const s = await start()
    const classId = await insertClass(s.db, { classNo: 1 })
    const a = await addStudent(s, classId)
    await tickAt(s, at('19:50'))

    const welcome = await hello(await connect(a.key))
    expect(welcome.session).toMatchObject({ kind: 'study', subject: null, title: null })
    expect(welcome.class.teacher).toEqual({ name: '老周' })
  })

  test('the closing grace in the welcome follows the timeline speed', async () => {
    const s = await start({ speed: 60 })
    const { students } = await seedClass(s, 1)
    await tickAt(s, at('19:59:50')) // the doors open 15 seconds before the start at speed 60

    const welcome = await hello(await connect(students[0]!.key))
    expect(welcome.limits.closingGraceSeconds).toBe(1)
  })

  test('the attendance is recorded at the hello, before the lesson starts too', async () => {
    const s = await start()
    const { classId, students } = await seedClass(s, 2)
    const [a] = students
    await tickAt(s, at('19:45'))
    s.clock.set(at('19:50'))

    await hello(await connect(a!.key))

    expect(await attendanceRows(s)).toEqual([
      { sessionId: sessionIdOf(s, classId), studentId: a!.id, firstSeenAt: at('19:50') },
    ])
    expect(await studentRow(s, a!.id)).toEqual({ lessonsAttended: 1, lastAttendedAt: at('19:50') })
  })

  test('probation counts the lessons attended before this one, after a reconnect too', async () => {
    const s = await start()
    const { students } = await seedClass(s, 2)
    const [newcomer, regular] = students
    // The example config has 3 probation lessons: two attended means this is the third.
    await s.db.updateTable('students').set({ lessonsAttended: 2 }).where('id', '=', newcomer!.id).execute()
    await s.db.updateTable('students').set({ lessonsAttended: 3 }).where('id', '=', regular!.id).execute()
    await tickAt(s, at('19:50'))

    const first = await connect(newcomer!.key)
    expect((await hello(first)).probation).toBe(true)
    expect((await studentRow(s, newcomer!.id)).lessonsAttended).toBe(3)

    s.clock.set(at('20:05'))
    const again = await connect(newcomer!.key)
    expect((await hello(again)).probation).toBe(true)

    expect((await hello(await connect(regular!.key))).probation).toBe(false)
  })
})

describe('who is online', () => {
  test('classmates see who comes and goes; the hook hears of the disconnect', async () => {
    const s = await start()
    const { classId, students } = await seedClass(s, 3)
    const [a, b] = students
    await tickAt(s, at('19:50'))
    const classmate = (x: typeof a) => ({ studentId: x!.id, displayName: x!.displayName })

    const ca = await connect(a!.key)
    expect((await hello(ca)).online).toEqual([])

    const cb = await connect(b!.key)
    expect((await hello(cb)).online).toEqual([classmate(a)])
    expect(await ca.next()).toEqual({ type: 'presence', joined: classmate(b) })

    // The client vanishes (injectWS only tells the server of a close that tears the stream down).
    cb.ws.terminate()
    expect(await ca.next()).toEqual({ type: 'presence', left: classmate(b) })
    expect(s.disconnects).toEqual([b!.id])
    expect(s.hub.online(classId)).toEqual([a!.id])
  })

  test('the close of the session disconnects everyone with session_over and tells the hook', async () => {
    const s = await start()
    const { classId, students } = await seedClass(s, 2)
    await tickAt(s, at('19:50'))
    const clients = []
    for (const x of students) {
      const client = await connect(x.key)
      await hello(client)
      clients.push(client)
    }

    await tickAt(s, at('20:31'))
    for (const client of clients) {
      const rest: Received[] = []
      while (rest.at(-1)?.type !== 'closing') rest.push(await client.next())
      expect(rest.at(-1)).toEqual({ type: 'closing', reason: 'session_over', message: '这节课已经下课了，下次上课再见。' })
      expect(await client.closed()).toBe(1000)
    }
    // Everyone goes at once: nobody is told that a classmate left.
    expect(clients[0]!.received.filter((m) => m.type === 'presence')).toEqual([
      { type: 'presence', joined: { studentId: students[1]!.id, displayName: students[1]!.displayName } },
    ])
    expect(clients[1]!.received.filter((m) => m.type === 'presence')).toEqual([])
    expect(s.disconnects).toEqual(students.map((x) => x.id))
    expect(s.hub.online(classId)).toEqual([])
  })

  test('shutting the service down tells everyone it is under maintenance, and nobody that a classmate left', async () => {
    const s = await start()
    const { classId, students } = await seedClass(s, 2)
    await tickAt(s, at('19:50'))
    const clients = []
    for (const x of students) {
      const client = await connect(x.key)
      await hello(client)
      clients.push(client)
    }
    expect(await clients[0]!.next()).toMatchObject({ type: 'presence', joined: { studentId: students[1]!.id } })

    s.disconnectAll()
    for (const client of clients) {
      expect(await client.next()).toEqual({ type: 'closing', reason: 'session_over', message: '学校正在维护，请稍后重连。' })
      expect(await client.closed()).toBe(1000)
    }
    expect(clients.flatMap((c) => c.received.filter((m) => m.type === 'presence' && 'left' in m))).toEqual([])
    expect(s.disconnects.sort((x, y) => x - y)).toEqual(students.map((x) => x.id))
    expect(s.hub.online(classId)).toEqual([])
  })

  test('what the hub pushes while a student joins waits for the welcome and the replay, without doubles', async () => {
    const s = await start()
    const { classId, students } = await seedClass(s, 1)
    await tickAt(s, at('19:45'))
    await tickAt(s, at('20:06')) // the opening (1) and segment 1 (2)
    const [stored] = await s.db.selectFrom('classEvents').selectAll().where('seq', '=', 2).execute()
    const event = (seq: number, payload: object) =>
      ({ type: 'class.event', seq, replayed: false, at: at('20:06').toISOString(), event: payload })
    const presence = { type: 'presence', joined: { studentId: 999, displayName: '某某家的小鱼' } }

    // The moment the connection is registered, before the welcome is written: the runtime pushes event 2 (committed
    // before the replay is read, so the replay has it too), a classmate arrives, and event 3 is pushed.
    const add = s.hub.add.bind(s.hub)
    s.hub.add = (connection) => {
      const replaced = add(connection)
      s.hub.broadcast(classId, event(stored!.seq, stored!.payload))
      s.hub.broadcast(classId, presence)
      s.hub.broadcast(classId, event(3, { kind: 'dismissal' }))
      return replaced
    }

    const client = await connect(students[0]!.key)
    await hello(client)
    expect((await take(client, 4)).map((m) => (m.type === 'class.event' ? `${m.seq} ${m.replayed}` : m.type))).toEqual([
      '1 true',
      '2 true',
      'presence',
      '3 false',
    ])
    client.send('sync')
    expect(await client.next()).toMatchObject({ type: 'ack', id: '' })
  })
})

describe('Review Focus 1: the newest connection wins', () => {
  test('a second connection replaces the first, which is told so; attendance counts once', async () => {
    const s = await start()
    const { classId, students } = await seedClass(s, 2)
    const [a, c] = students
    await tickAt(s, at('19:45'))
    s.clock.set(at('19:50'))

    const watcher = await connect(c!.key)
    await hello(watcher)

    const first = await connect(a!.key)
    await hello(first)
    const asClassmate = { studentId: a!.id, displayName: a!.displayName }
    expect(await watcher.next()).toEqual({ type: 'presence', joined: asClassmate })

    s.clock.set(at('19:55'))
    const second = await connect(a!.key)
    const welcome = await hello(second)
    expect(welcome.online).toEqual([{ studentId: c!.id, displayName: c!.displayName }])

    expect(await first.next()).toEqual({
      type: 'closing',
      reason: 'replaced',
      message: '这个学号在别的地方连上了，这里的连接已经断开。',
    })
    expect(await first.closed()).toBe(1000)

    // The student never left: classmates hear nothing, and the chat engine is not told of a disconnect.
    await watcher.sync()
    expect(watcher.received.filter((m) => m.type === 'presence')).toHaveLength(1)
    expect(s.disconnects).toEqual([])
    expect(s.hub.online(classId)).toEqual([a!.id, c!.id])

    // Attendance: one row, first seen at the first connection; lessons_attended went up once.
    expect(await attendanceRows(s)).toEqual([
      { sessionId: sessionIdOf(s, classId), studentId: a!.id, firstSeenAt: at('19:50') },
      { sessionId: sessionIdOf(s, classId), studentId: c!.id, firstSeenAt: at('19:50') },
    ])
    expect(await studentRow(s, a!.id)).toEqual({ lessonsAttended: 1, lastAttendedAt: at('19:50') })

    // The new connection is the live one: class events reach it, and its close is the student leaving.
    await tickAt(s, at('20:00'))
    expect((await second.next()).seq).toBe(1)
    second.ws.terminate()
    for (;;) {
      const m = await watcher.next()
      if (m.type === 'presence') {
        expect(m).toEqual({ type: 'presence', left: asClassmate })
        break
      }
    }
    expect(s.disconnects).toEqual([a!.id])
    expect(s.hub.online(classId)).toEqual([c!.id])
  })
})

describe('messages after hello', () => {
  test('go to their handler with the participant, and the handler result becomes the ack', async () => {
    const calls: [string, Participant, unknown][] = []
    const handler =
      (name: string, result: AckResult) =>
      async (p: Participant, msg: unknown): Promise<AckResult> => {
        calls.push([name, p, msg])
        return result
      }
    const handlers: Partial<MessageHandlers> = {
      chatStart: handler('chatStart', { ok: true, result: { conversationId: 'c-1' } }),
      question: handler('question', { ok: false, code: 'question_cap' }),
      answer: handler('answer', { ok: false, code: 'blocked', extra: { category: 'sensitive' } }),
      // The test app's chat engine would take it otherwise.
      chatReply: undefined,
    }
    const s = await start({ handlers })
    const { classId, students } = await seedClass(s, 2)
    const [a] = students
    await s.db.updateTable('students').set({ lessonsAttended: 5 }).where('id', '=', a!.id).execute()
    await tickAt(s, at('19:50'))
    const client = await connect(a!.key)
    await hello(client)

    const start1 = { id: 'm1', type: 'chat.start', to: students[1]!.id, text: '你好' }
    client.send(start1)
    expect(await client.next()).toEqual({ type: 'ack', id: 'm1', ok: true, result: { conversationId: 'c-1' } })

    client.send({ id: 'm2', type: 'question', text: '为什么？' })
    expect(await client.next()).toEqual({
      type: 'ack',
      id: 'm2',
      ok: false,
      error: { code: 'question_cap', message: WS_ERROR_MESSAGES.question_cap },
    })

    client.send({ id: 'm3', type: 'answer', callId: 1, text: '答案' })
    expect(await client.next()).toEqual({
      type: 'ack',
      id: 'm3',
      ok: false,
      error: { category: 'sensitive', code: 'blocked', message: WS_ERROR_MESSAGES.blocked },
    })

    // No handler for it (yet): the message cannot be taken.
    client.send({ id: 'm4', type: 'chat.reply', conversationId: 'c-1', text: '嗯' })
    expect(await client.next()).toEqual({
      type: 'ack',
      id: 'm4',
      ok: false,
      error: { code: 'invalid_message', message: WS_ERROR_MESSAGES.invalid_message },
    })

    // A second hello is not a thing.
    client.send({ id: 'h2', ...HELLO })
    expect((await client.next()).error.code).toBe('invalid_message')

    const participant: Participant = {
      studentId: a!.id,
      displayName: a!.displayName,
      classId,
      sessionId: sessionIdOf(s, classId),
      maxRounds: 4,
      ip: null, // injectWS has no socket address
      pluginType: 'openclaw',
      pluginVersion: '1.2.3',
      lessonsAttended: 5,
      closeAt: at('20:31'),
    }
    expect(calls).toEqual([
      ['chatStart', participant, start1],
      ['question', participant, { id: 'm2', type: 'question', text: '为什么？' }],
      ['answer', participant, { id: 'm3', type: 'answer', callId: 1, text: '答案' }],
    ])

    // The program log has who joined, never what anyone said.
    const logged = s.logs.entries()
    expect(logged.filter((e) => e.msg === 'student joined class')).toMatchObject([{ studentId: a!.id, classId }])
    for (const text of ['你好', '为什么？', '答案', '嗯']) expect(JSON.stringify(logged)).not.toContain(text)
  })

  test('are answered not_in_session once the session is over, before the close disconnects anyone', async () => {
    const calls: string[] = []
    const s = await start({
      handlers: {
        question: async () => {
          calls.push('question')
          return { ok: true }
        },
      },
    })
    const { students } = await seedClass(s, 1)
    await tickAt(s, at('19:50'))
    const client = await connect(students[0]!.key)
    await hello(client)

    s.clock.set(at('20:31')) // past the close, but the runtime has not run it yet
    client.send({ id: 'q1', type: 'question', text: '还在吗？' })
    expect(await client.next()).toEqual({
      type: 'ack',
      id: 'q1',
      ok: false,
      error: { code: 'not_in_session', message: WS_ERROR_MESSAGES.not_in_session },
    })
    expect(calls).toEqual([])
  })
})

describe('markAttendance', () => {
  test('records a session once and counts it once', async () => {
    const s = await start()
    const classId = await insertClass(s.db, { classNo: 1 })
    const a = await addStudent(s, classId)
    const session = (date: string) =>
      insertSession(s.db, { classId, date, startsAt: at('20:00', date), endsAt: at('20:30', date) })
    const monday = await session(MON)
    const tuesday = await session('2026-11-03')

    await markAttendance(s.db, { sessionId: monday, studentId: a.id, at: at('19:50') })
    await markAttendance(s.db, { sessionId: monday, studentId: a.id, at: at('20:10') })
    expect(await studentRow(s, a.id)).toEqual({ lessonsAttended: 1, lastAttendedAt: at('19:50') })

    await markAttendance(s.db, { sessionId: tuesday, studentId: a.id, at: at('20:01', '2026-11-03') })
    expect(await studentRow(s, a.id)).toEqual({ lessonsAttended: 2, lastAttendedAt: at('20:01', '2026-11-03') })
    expect(await attendanceRows(s)).toEqual([
      { sessionId: monday, studentId: a.id, firstSeenAt: at('19:50') },
      { sessionId: tuesday, studentId: a.id, firstSeenAt: at('20:01', '2026-11-03') },
    ])
  })
})
