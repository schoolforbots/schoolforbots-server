import type { FastifyInstance } from 'fastify'
import { sql } from 'kysely'
import Value from 'typebox/value'
import { afterEach, describe, expect, test } from 'vitest'
import type WebSocket from 'ws'
import { disciplineRecorder } from '../../src/class/discipline.js'
import { noopHooks } from '../../src/class/hooks.js'
import { RecordingHub } from '../../src/class/hub.js'
import { createClassRuntime } from '../../src/class/runtime.js'
import { createClassService } from '../../src/class/service.js'
import { SummariesResult } from '../../src/protocol/http.js'
import { ClosingMessage, ServerMessage } from '../../src/protocol/ws.js'
import { setMaintenance, startMaintenanceWatch, type MaintenanceWatch } from '../../src/shared/maintenance.js'
import { buildTestApp, exampleModerator } from '../helpers/app.js'
import { buildTestClassApp } from '../helpers/class-app.js'
import { insertClass, insertLesson, insertSession, insertStudent } from '../helpers/factories.js'
import { captureLogs } from '../helpers/logs.js'

// The class service's side of the maintenance switch: while it is on, nobody comes in; when it comes on, everyone
// online is sent home and the lesson going on ends at once, as a close does; and a slot whose doors-to-close it
// overlapped is not held that day.

const MON = '2026-11-02'
const TUE = '2026-11-03'
/** A wall-clock time in Beijing (the example config's timezone), `HH:MM` or `HH:MM:SS`, on `date`. */
const at = (time: string, date = MON) => new Date(`${date}T${time.length === 5 ? `${time}:00` : time}+08:00`)

const SEGMENTS = [1, 2, 3, 4, 5].map((i) => ({ text: `光的折射第${i}段`, gist: `要点${i}` }))
const NOTICE = '升级数据库，预计晚上 10 点恢复'
const ON = { message: NOTICE, expectedBackAt: at('22:00') }
/** What a plugin is told while the school is under maintenance `ON`. */
const SENT_HOME = { type: 'closing', reason: 'maintenance', message: NOTICE, expectedBackAt: at('22:00').toISOString() }

// A server message as the test reads it; every one is also checked against the published ServerMessage schema.
type Received = Record<string, any>
type Service = Awaited<ReturnType<typeof buildTestClassApp>>
type Restarted = ReturnType<typeof createClassService> & { maintenance: MaintenanceWatch }

let service: Service | undefined
let logs: ReturnType<typeof captureLogs> | undefined
const sockets: WebSocket[] = []
/** What else a test started, stopped before the service (whose database they may share). */
const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.terminate()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  await service?.destroy()
  service = undefined
  // Nothing in these tests is a server fault.
  expect(logs?.entries().filter((e) => e.level >= 50) ?? []).toEqual([])
  logs = undefined
})

async function start(): Promise<Service> {
  logs = captureLogs()
  service = await buildTestClassApp({ logger: { level: 'info', stream: logs.stream } })
  return service
}

/** The service started again on the same database and clock: a new runtime, hub and app, and a new watch. */
async function restart(s: Service): Promise<Restarted> {
  const maintenance = await startMaintenanceWatch({ db: s.db, config: s.config }, { refreshMs: 3_600_000 })
  const again = createClassService({
    db: s.db,
    config: s.config,
    moderator: exampleModerator(),
    clock: s.clock,
    speed: 1,
    maintenance,
  })
  await again.app.ready()
  cleanups.push(async () => {
    maintenance.stop()
    await again.app.close()
  })
  return { ...again, maintenance }
}

async function waitUntil(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let waited = 0; !(await check()); waited += 5) {
    if (waited > 5000) throw new Error(`Timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

interface Client {
  received: Received[]
  send(message: unknown): void
  /** The next message not read yet, waiting for it to arrive. */
  next(): Promise<Received>
  /** Waits for the server to close the connection and returns the close code. */
  closed(): Promise<number>
}

function track(ws: WebSocket): Client {
  const received: Received[] = []
  let cursor = 0
  let closeCode: number | null = null
  ws.on('message', (data) => void received.push(JSON.parse(String(data))))
  ws.on('close', (code) => {
    closeCode = code
  })
  return {
    received,
    send: (message) => ws.send(JSON.stringify(message)),
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
  }
}

async function connect(app: FastifyInstance, key: string): Promise<Client> {
  let client: Client | undefined
  const ws = await app.injectWS(
    '/v1/class',
    { headers: { authorization: `Bearer ${key}` } },
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

const HELLO = { type: 'hello', protocol: 'v1', plugin: { type: 'openclaw', version: '1.2.3' }, maxRounds: 4 }

/** Sends hello and returns the welcome, after the ack that comes first. */
async function hello(client: Client): Promise<Received> {
  client.send({ id: 'h1', ...HELLO })
  expect(await client.next()).toEqual({ type: 'ack', id: 'h1', ok: true })
  const welcome = await client.next()
  expect(welcome.type).toBe('welcome')
  return welcome
}

/** Reads on to the `closing`, waits for the server to close the connection, and returns the `closing`. */
async function untilClosing(client: Client): Promise<Received> {
  for (;;) {
    const message = await client.next()
    if (message.type !== 'closing') continue
    expect(await client.closed()).toBe(1000)
    return message
  }
}

/** Switches maintenance on (a value) or off (null) at the clock's time, and lets `watch` (`s`'s own) read it. */
async function switchMaintenance(
  s: Service,
  value: { message: string; expectedBackAt: Date | null } | null,
  watch: MaintenanceWatch = s.maintenance,
): Promise<void> {
  await setMaintenance(s.db, value, s.clock.now())
  await watch.refresh()
}

/** Sets the clock and runs what the service runs on its interval. */
async function tickAt(s: Service, time: Date): Promise<void> {
  s.clock.set(time)
  await s.tick()
}

/** An evening junior class with today's lesson and `members` active students. */
async function seedClass(s: Service, members = 2) {
  await insertLesson(s.db, { date: MON, subject: '科学', title: '光的折射', segments: SEGMENTS })
  const classId = await insertClass(s.db, { classNo: 1 })
  const students: { id: number; key: string }[] = []
  for (let i = 0; i < members; i++) students.push(await insertStudent(s.db, { classId, status: 'active' }))
  return { classId, students }
}

/** The evening's lesson going on at 20:12, in its second segment, with every student of the class in it. */
async function inTheSecondSegment(s: Service, members = 2) {
  const { classId, students } = await seedClass(s, members)
  await tickAt(s, at('19:50'))
  const sessionId = s.runtime.currentSession(classId)!.sessionId
  const clients: Client[] = []
  for (const x of students) {
    const client = await connect(s.app, x.key)
    await hello(client)
    clients.push(client)
  }
  await tickAt(s, at('20:10'))
  s.clock.set(at('20:12'))
  return { classId, students, sessionId, clients }
}

/** Every call of the service's `afterClass` hook from now on, as `[sessionId, live]`. */
function watchAfterClass(s: Pick<Service, 'hooks'>): [number, boolean][] {
  const calls: [number, boolean][] = []
  const real = s.hooks.afterClass
  s.hooks.afterClass = async (session, opts) => {
    calls.push([session.sessionId, opts.live])
    await real(session, opts)
  }
  return calls
}

/**
 * The student broke a school rule in two lessons before this one (closed long since), and in this one (`sessionId`):
 * the third brings a suspension at its close.
 */
async function thirdSchoolRuleBreak(s: Service, classId: number, studentId: number, sessionId: number): Promise<void> {
  for (const date of ['2026-10-29', '2026-10-30', MON]) {
    let lesson = sessionId
    if (date !== MON) {
      lesson = await insertSession(s.db, { classId, date, startsAt: at('20:00', date), endsAt: at('20:30', date) })
      await s.db.updateTable('classSessions').set({ dismissedAt: at('20:31', date) }).where('id', '=', lesson).execute()
    }
    await disciplineRecorder.record(s.db, {
      studentId,
      sessionId: lesson,
      kind: 'school_rule',
      detail: { category: 'sensitive', quote: `第${date}次` },
      at: at('20:08', date),
    })
  }
}

const suspensions = (s: Service) =>
  s.db.selectFrom('disciplineRecords').select('studentId').where('kind', '=', 'suspension').execute()

/** Everything the hub pushes from now on. */
function watchPushes(s: Pick<Service, 'hub'>): object[] {
  const pushed: object[] = []
  const { broadcast, send } = s.hub
  s.hub.broadcast = (classId, message) => {
    pushed.push(message)
    broadcast(classId, message)
  }
  s.hub.send = (studentId, message) => {
    pushed.push(message)
    send(studentId, message)
  }
  return pushed
}

const sessionRows = (s: Service) =>
  s.db.selectFrom('classSessions').select(['id', 'classId', 'date', 'dismissedAt']).orderBy('id').execute()

const summaryRows = (s: Service, sessionId: number) =>
  s.db
    .selectFrom('summaries')
    .select(['studentId', 'payload', 'createdAt'])
    .where('sessionId', '=', sessionId)
    .orderBy('studentId')
    .execute()

const eventRows = (s: Service, sessionId: number) =>
  s.db.selectFrom('classEvents').select(['step', 'kind', 'seq']).where('sessionId', '=', sessionId).orderBy('id').execute()

describe('while the school is under maintenance', () => {
  test('turns everyone away while on', async () => {
    const s = await start()
    const { students } = await seedClass(s, 1)
    const student = students[0]!
    s.clock.set(at('19:30'))
    await switchMaintenance(s, ON)

    s.clock.set(at('19:35'))
    const refused = await connect(s.app, student.key)
    expect(await refused.next()).toEqual(SENT_HOME)
    expect(await refused.closed()).toBe(1000)

    // With no expected time the plugin is told that none is known.
    await switchMaintenance(s, { message: '临时抢修', expectedBackAt: null })
    const again = await connect(s.app, student.key)
    expect(await again.next()).toEqual({ type: 'closing', reason: 'maintenance', message: '临时抢修', expectedBackAt: null })
    expect(await again.closed()).toBe(1000)
    expect(await s.db.selectFrom('attendance').selectAll().execute()).toEqual([])

    // Over before the doors open: the evening is held, and the same student comes in.
    s.clock.set(at('19:40'))
    await switchMaintenance(s, null)
    await tickAt(s, at('19:46'))
    const back = await connect(s.app, student.key)
    expect((await hello(back)).session).toMatchObject({ kind: 'lesson', title: '光的折射' })
  })

  test('a hello still going when it comes on registers nothing, and is sent home too', async () => {
    const s = await start()
    const { classId, students } = await seedClass(s, 1)
    await tickAt(s, at('19:50'))
    const client = await connect(s.app, students[0]!.key)

    // Hold the hello inside its attendance write, switch maintenance on meanwhile, then let the hello go on.
    await s.db.transaction().execute(async (trx) => {
      await sql`lock table attendance in share mode`.execute(trx)
      client.send({ id: 'h1', ...HELLO })
      await waitUntil(async () => {
        const { rows } = await sql<{ n: number }>`
          select count(*)::int as n from pg_locks l join pg_class c on c.oid = l.relation
          where c.relname = 'attendance' and not l.granted`.execute(s.db)
        return rows[0]!.n > 0
      }, 'the hello to wait on the attendance table')
      await switchMaintenance(s, ON)
    })

    expect(await client.next()).toEqual(SENT_HOME)
    expect(await client.closed()).toBe(1000)
    expect(client.received.map((m) => m.type)).toEqual(['closing'])
    expect(s.hub.online(classId)).toEqual([])
  })

  test('sends everyone home when it is switched on', async () => {
    const s = await start()
    const { classId, clients } = await inTheSecondSegment(s)

    await switchMaintenance(s, ON)

    for (const client of clients) expect(await untilClosing(client)).toEqual(SENT_HOME)
    expect(s.hub.online(classId)).toEqual([])
    // Everyone goes at once: nobody is told that a classmate left.
    expect(clients.flatMap((c) => c.received.filter((m) => m.type === 'presence' && 'left' in m))).toEqual([])
  })

  test('ends the lesson once, as a normal close', async () => {
    const s = await start()
    const { classId, students, sessionId, clients } = await inTheSecondSegment(s)
    const a = students[0]!
    const b = students[1]!
    await thirdSchoolRuleBreak(s, classId, a.id, sessionId)
    const afterClass = watchAfterClass(s)
    const seen = await eventRows(s, sessionId)

    await switchMaintenance(s, ON)
    for (const client of clients) await untilClosing(client)
    const pushed = watchPushes(s)
    await tickAt(s, at('20:12'))

    // Closed at once, the quiet way: the discipline and the summaries ran once, and nothing was pushed.
    expect(afterClass).toEqual([[sessionId, false]])
    expect((await sessionRows(s)).find((r) => r.id === sessionId)?.dismissedAt).toEqual(at('20:12'))
    expect(await suspensions(s)).toEqual([{ studentId: a.id }])
    const summaries = await summaryRows(s, sessionId)
    expect(summaries.map((r) => [r.studentId, r.payload.cutShort, r.createdAt])).toEqual([
      [a.id, true, at('20:12')],
      [b.id, true, at('20:12')],
    ])
    expect(summaries[0]!.payload).toMatchObject({
      lesson: { title: '光的折射' },
      criticisms: [{ kind: 'school_rule', text: expect.stringContaining(`第${MON}次`) }],
    })
    expect(pushed).toEqual([])
    expect(s.runtime.currentSession(classId)).toBeNull()

    // What the class saw stays as it was; the steps it did not get to are marked skipped, and the lesson cut short.
    const events = await eventRows(s, sessionId)
    expect(events.filter((e) => e.seq > 0)).toEqual(seen.filter((e) => e.seq > 0))
    const skipped = events.slice(seen.length)
    expect(skipped.every((e) => e.kind === 'noop' && e.seq < 0)).toBe(true)
    expect(skipped.map((e) => e.step)).toEqual(
      expect.arrayContaining(['qa-2', 'call-on-close-1', 'segment-3', 'segment-5', 'callouts-5', 'dismissal', 'cut-short']),
    )
    expect(skipped.map((e) => e.step)).not.toContain('close')

    // The ticks after it, through the time the lesson would have closed, push nothing of it and run nothing again.
    for (const time of ['20:15', '20:30', '20:31', '20:40']) await tickAt(s, at(time))
    expect(pushed).toEqual([])
    expect(afterClass).toHaveLength(1)
    expect(await summaryRows(s, sessionId)).toHaveLength(2)
    expect(await eventRows(s, sessionId)).toHaveLength(events.length)
  })

  test('does not open a slot whose doors opened during it', async () => {
    const s = await start()
    const { classId, students } = await seedClass(s, 1)
    s.clock.set(at('19:40'))
    await switchMaintenance(s, ON)
    for (const time of ['19:45', '20:00', '20:05']) await tickAt(s, at(time))
    expect(await sessionRows(s)).toEqual([])

    // Over ten minutes into the lesson: the evening is not held today.
    s.clock.set(at('20:10'))
    await switchMaintenance(s, null)
    await tickAt(s, at('20:11'))
    expect(await sessionRows(s)).toEqual([])
    // Nor by a runtime started now: the periods on record say so, not what a runtime remembers.
    const fresh = createClassRuntime({
      db: s.db,
      config: s.config,
      clock: s.clock,
      hub: new RecordingHub(),
      moderator: exampleModerator(),
      speed: 1,
      hooks: noopHooks,
    })
    await fresh.tick()
    expect(await sessionRows(s)).toEqual([])
    const client = await connect(s.app, students[0]!.key)
    expect(await client.next()).toEqual({
      type: 'closing',
      reason: 'session_over',
      message: '现在不在上课时间，下一节课在 11月3日 20:00 开始。',
    })

    // The next day is held as usual.
    await tickAt(s, at('19:45', TUE))
    expect(await sessionRows(s)).toMatchObject([{ classId, date: TUE, dismissedAt: null }])
  })

  test('keeps turning away after a restart', async () => {
    const s = await start()
    const { classId, students, sessionId, clients } = await inTheSecondSegment(s, 1)
    await switchMaintenance(s, ON)
    await untilClosing(clients[0]!)
    await tickAt(s, at('20:12'))
    const summaries = await summaryRows(s, sessionId)
    expect(summaries.map((r) => r.payload.cutShort)).toEqual([true])

    // The service restarts at 20:20, still under maintenance.
    s.clock.set(at('20:20'))
    const again = await restart(s)
    const afterClass = watchAfterClass(again)
    await again.tick()

    const refused = await connect(again.app, students[0]!.key)
    expect(await refused.next()).toEqual(SENT_HOME)
    expect(await refused.closed()).toBe(1000)
    // The lesson cut short is not closed a second time.
    expect(afterClass).toEqual([])
    expect(await summaryRows(s, sessionId)).toEqual(summaries)
    expect((await sessionRows(s)).find((r) => r.id === sessionId)?.dismissedAt).toEqual(at('20:12'))

    // Nor once maintenance is over: the lesson stays over for the day.
    s.clock.set(at('20:22'))
    await switchMaintenance(s, null, again.maintenance)
    await again.tick()
    expect(again.runtime.currentSession(classId)).toBeNull()
    const later = await connect(again.app, students[0]!.key)
    expect(await later.next()).toMatchObject({ type: 'closing', reason: 'session_over' })
    expect(afterClass).toEqual([])
  })

  test('closes a lesson it cut short at once after a restart, even when it is over by then', async () => {
    const s = await start()
    const { classId, students, sessionId, clients } = await inTheSecondSegment(s, 1)
    // The work after class fails once: the lesson is cut short, but not closed.
    const real = s.hooks.afterClass
    let failing = true
    s.hooks.afterClass = async (session, opts) => {
      if (failing) throw new Error('the database is unreachable')
      await real(session, opts)
    }
    await switchMaintenance(s, ON)
    await untilClosing(clients[0]!)
    s.clock.set(at('20:12'))
    await expect(s.runtime.tick()).rejects.toThrow()
    failing = false
    // A lesson cut short is over, closed or not.
    expect(s.runtime.currentSession(classId)).toBeNull()

    // The service restarts at 20:14, when maintenance is over.
    s.clock.set(at('20:13'))
    await switchMaintenance(s, null)
    s.clock.set(at('20:14'))
    const again = await restart(s)
    const afterClass = watchAfterClass(again)
    await again.tick()

    expect(afterClass).toEqual([[sessionId, false]])
    expect((await summaryRows(s, sessionId)).map((r) => r.payload.cutShort)).toEqual([true])
    expect((await sessionRows(s)).find((r) => r.id === sessionId)?.dismissedAt).toEqual(at('20:14'))
    const later = await connect(again.app, students[0]!.key)
    expect(await later.next()).toMatchObject({ type: 'closing', reason: 'session_over' })
  })

  test('cuts short a lesson it came and went in while the service was down, at the restart', async () => {
    const s = await start()
    const { classId, students } = await seedClass(s, 2)
    await tickAt(s, at('19:50'))
    const sessionId = s.runtime.currentSession(classId)!.sessionId
    for (const x of students) await hello(await connect(s.app, x.key))
    await thirdSchoolRuleBreak(s, classId, students[0]!.id, sessionId)
    await tickAt(s, at('20:05'))
    const taught = (await eventRows(s, sessionId)).filter((e) => e.seq > 0)

    // The service goes down after 20:05; maintenance is switched on at 20:10 and off at 20:15 meanwhile.
    s.clock.set(at('20:10'))
    await setMaintenance(s.db, ON, s.clock.now())
    s.clock.set(at('20:15'))
    await setMaintenance(s.db, null, s.clock.now())

    // It starts again at 20:20, in the lesson's time, with maintenance over.
    s.clock.set(at('20:20'))
    const again = await restart(s)
    const afterClass = watchAfterClass(again)
    const pushed = watchPushes(again)
    await again.tick()

    // Cut short as if the service had been up: closed at once, quietly, the discipline and the summaries once.
    expect(afterClass).toEqual([[sessionId, false]])
    expect((await sessionRows(s)).find((r) => r.id === sessionId)?.dismissedAt).toEqual(at('20:20'))
    expect(await suspensions(s)).toEqual([{ studentId: students[0]!.id }])
    const summaries = await summaryRows(s, sessionId)
    expect(summaries.map((r) => [r.studentId, r.payload.cutShort])).toEqual(students.map((x) => [x.id, true]))
    // Nothing missed meanwhile is taught or pushed, then or later.
    const events = await eventRows(s, sessionId)
    expect(events.filter((e) => e.seq > 0)).toEqual(taught)
    expect(events.map((e) => e.step)).toContain('cut-short')
    for (const time of ['20:25', '20:31', '20:40']) {
      s.clock.set(at(time))
      await again.tick()
    }
    expect(pushed).toEqual([])
    expect(afterClass).toHaveLength(1)
    expect(await summaryRows(s, sessionId)).toEqual(summaries)
    // The classmate who was not suspended finds the lesson over.
    const later = await connect(again.app, students[1]!.key)
    expect(await later.next()).toMatchObject({ type: 'closing', reason: 'session_over' })
  })

  test.each<[string, [string, string], string]>([
    ['ended before its doors', ['19:30', '19:40'], '20:20'],
    ['began after its dismissal', ['20:30:30', '20:40'], '20:45'],
  ])('does not cut short at a restart a lesson whose maintenance %s', async (_name, [on, off], restartAt) => {
    const s = await start()
    const { classId, students } = await seedClass(s, 1)
    const record = async (time: string, value: typeof ON | null) => {
      s.clock.set(at(time))
      await setMaintenance(s.db, value, s.clock.now())
    }
    if (on < '19:45') await record(on, ON)
    if (off < '19:45') await record(off, null)
    await tickAt(s, at('19:50'))
    const sessionId = s.runtime.currentSession(classId)!.sessionId
    await hello(await connect(s.app, students[0]!.key))
    await tickAt(s, at('20:05'))
    // The service goes down after 20:05.
    if (on > '19:45') await record(on, ON)
    if (off > '19:45') await record(off, null)

    s.clock.set(at(restartAt))
    const again = await restart(s)
    const afterClass = watchAfterClass(again)
    await again.tick()
    s.clock.set(at('20:50'))
    await again.tick()

    expect(afterClass).toHaveLength(1)
    expect((await eventRows(s, sessionId)).map((e) => e.step)).not.toContain('cut-short')
    expect((await eventRows(s, sessionId)).map((e) => e.step)).toContain('segment-5')
    expect((await summaryRows(s, sessionId)).map((r) => r.payload.cutShort)).toEqual([false])
  })

  test('does not cut short a lesson that ended before it', async () => {
    const s = await start()
    const { classId, students } = await seedClass(s, 1)
    await tickAt(s, at('19:50'))
    const sessionId = s.runtime.currentSession(classId)!.sessionId
    const client = await connect(s.app, students[0]!.key)
    await hello(client)
    await tickAt(s, at('20:30'))

    // Maintenance comes on after the dismissal, in the closing grace.
    s.clock.set(at('20:30:30'))
    await switchMaintenance(s, ON)
    expect(await untilClosing(client)).toEqual(SENT_HOME)
    await tickAt(s, at('20:30:30'))
    expect((await sessionRows(s))[0]!.dismissedAt).toBeNull()

    // The lesson closes when it was to.
    await tickAt(s, at('20:31'))
    expect((await sessionRows(s))[0]!.dismissedAt).toEqual(at('20:31'))
    const summaries = await summaryRows(s, sessionId)
    expect(summaries.map((r) => [r.payload.cutShort, r.createdAt])).toEqual([[false, at('20:31')]])
    expect((await eventRows(s, sessionId)).map((e) => e.step)).not.toContain('cut-short')
  })
})

describe('the closing message', () => {
  const closing = { type: 'closing', message: NOTICE }

  test('carries the expected time back with maintenance, and with no other reason', () => {
    for (const expectedBackAt of ['2026-11-02T14:00:00.000Z', null]) {
      const message = { ...closing, reason: 'maintenance', expectedBackAt }
      expect(Value.Check(ClosingMessage, message)).toBe(true)
      expect(Value.Check(ServerMessage, message)).toBe(true)
    }
    expect(Value.Check(ServerMessage, { ...closing, reason: 'maintenance' })).toBe(true)
    expect(Value.Check(ServerMessage, { ...closing, reason: 'maintenance', expectedBackAt: '晚上十点' })).toBe(false)
    for (const reason of ['replaced', 'session_over', 'suspended', 'expelled', 'on_break']) {
      for (const expectedBackAt of ['2026-11-02T14:00:00.000Z', null]) {
        const message = { ...closing, reason, expectedBackAt }
        expect(Value.Check(ClosingMessage, message), reason).toBe(false)
        expect(Value.Check(ServerMessage, message), reason).toBe(false)
      }
    }
  })
})

describe('GET /v1/me/summaries', () => {
  test('says cutShort false for a summary written before there was one', async () => {
    const t = await buildTestApp()
    cleanups.push(t.destroy)
    const classId = await insertClass(t.db, { classNo: 1 })
    const { id: studentId, key } = await insertStudent(t.db, { classId, status: 'active' })
    const summary = (date: string) => ({
      date,
      kind: 'study',
      className: '初中部·晚班·1 班',
      teacher: { name: '老周' },
      lesson: null,
      weekTitles: [],
      teacherAnswers: [],
      myQuestions: [],
      calledOn: null,
      chattedWith: [],
      criticisms: [],
    })
    const written = async (date: string, payload: object) => {
      const sessionId = await insertSession(t.db, {
        classId,
        date,
        kind: 'study',
        startsAt: at('20:00', date),
        endsAt: at('20:30', date),
      })
      await t.db
        .insertInto('summaries')
        .values({ sessionId, studentId, payload: JSON.stringify(payload), createdAt: at('20:31', date) })
        .execute()
      return sessionId
    }
    const before = await written('2026-10-30', summary('2026-10-30'))
    const cut = await written(MON, { ...summary(MON), cutShort: true })

    const res = await t.app.inject({ method: 'GET', url: '/v1/me/summaries', headers: { authorization: `Bearer ${key}` } })

    expect(res.statusCode).toBe(200)
    expect(Value.Check(SummariesResult, res.json())).toBe(true)
    expect(res.json().summaries.map((x: Received) => [x.sessionId, x.cutShort])).toEqual([
      [cut, true],
      [before, false],
    ])
  })
})
