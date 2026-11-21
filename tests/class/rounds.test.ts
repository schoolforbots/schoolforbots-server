import type { FastifyInstance } from 'fastify'
import Value from 'typebox/value'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type WebSocket from 'ws'
import { ServerMessage } from '../../src/protocol/ws.js'
import type { StudentStatus } from '../../src/shared/schema.js'
import { buildTestClassApp } from '../helpers/class-app.js'
import { insertClass, insertLesson, insertStudent } from '../helpers/factories.js'
import { captureLogs } from '../helpers/logs.js'

// The class service's rounds of the students online (src/class/service.ts): every `switchRefreshSeconds`, one query
// for the standing of everyone connected; whoever may no longer be in class (suspended, expelled, withdrawn) is sent
// the `closing` saying so and disconnected, the rest as after any disconnect.

// The rounds' query, held back while `hold` is set, failing once while `fail` is set, and counted.
const query = vi.hoisted(() => ({ hold: null as Promise<void> | null, fail: false, calls: 0 }))
vi.mock('../../src/class/standing.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/class/standing.js')>()
  return {
    ...real,
    standingsOf: async (...args: Parameters<typeof real.standingsOf>) => {
      query.calls++
      if (query.hold !== null) await query.hold
      if (query.fail) {
        query.fail = false
        throw new Error('the database is down')
      }
      return real.standingsOf(...args)
    },
  }
})

/** Holds the rounds' query back until the function it gives is called, and counts its calls from now. */
function holdQuery(): () => void {
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

const MON = '2026-11-02'
/** A wall-clock time in Beijing (the example config's timezone), `HH:MM` or `HH:MM:SS`, on `date`. */
const at = (time: string, date = MON) => new Date(`${date}T${time.length === 5 ? `${time}:00` : time}+08:00`)
const SEGMENTS = [1, 2, 3, 4, 5].map((i) => ({ text: `光的折射第${i}段`, gist: `要点${i}` }))

type Received = Record<string, any>
type Service = Awaited<ReturnType<typeof buildTestClassApp>>

let service: Service | undefined
let logs: ReturnType<typeof captureLogs> | undefined
let errorsExpected = false
let internalErrors = 0
const sockets: WebSocket[] = []

afterEach(async () => {
  query.hold = null
  query.fail = false
  query.calls = 0
  for (const ws of sockets.splice(0)) ws.terminate()
  await service?.destroy()
  service = undefined
  if (!errorsExpected) expect(logs?.entries().filter((e) => e.level >= 50) ?? []).toEqual([])
  logs = undefined
  errorsExpected = false
  internalErrors = 0
})

async function waitUntil(check: () => boolean, what: string): Promise<void> {
  for (let waited = 0; !check(); waited += 5) {
    if (waited > 5000) throw new Error(`Timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

interface Client {
  send(message: unknown): void
  /** The next message not read yet (of `type`, skipping the others, when given), waiting for it to arrive. */
  next(type?: string): Promise<Received>
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
  const client: Client = {
    send: (message) => ws.send(JSON.stringify(message)),
    async next(type) {
      for (;;) {
        await waitUntil(() => cursor < received.length || closeCode !== null, 'a message')
        const message = received[cursor]
        if (message === undefined) throw new Error(`The connection closed (${closeCode}) with no more messages`)
        cursor++
        expect(Value.Check(ServerMessage, message), JSON.stringify(message)).toBe(true)
        if (type === undefined || message.type === type) return message
      }
    },
    async closed() {
      await waitUntil(() => closeCode !== null, 'the close')
      return closeCode ?? 0
    },
  }
  return client
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

async function hello(client: Client): Promise<void> {
  client.send({ id: 'h1', ...HELLO })
  expect(await client.next()).toEqual({ type: 'ack', id: 'h1', ok: true })
  expect((await client.next()).type).toBe('welcome')
}

async function start(): Promise<Service> {
  logs = captureLogs()
  service = await buildTestClassApp({
    logger: { level: 'info', stream: logs.stream },
    onInternalError: () => void internalErrors++,
  })
  return service
}

/** Two classmates out of probation, `a` and `b`, in the evening's class with its doors open, both connected. */
async function twoInClass(s: Service) {
  await insertLesson(s.db, { date: MON, subject: '科学', title: '光的折射', segments: SEGMENTS })
  const classId = await insertClass(s.db, { classNo: 1 })
  const a = await insertStudent(s.db, { classId, status: 'active' })
  const b = await insertStudent(s.db, { classId, status: 'active' })
  await s.db.updateTable('students').set({ lessonsAttended: 5 }).execute()
  s.clock.set(at('19:50'))
  await s.tick()
  await s.roundsDone()
  const ca = await connect(s.app, a.key)
  await hello(ca)
  const cb = await connect(s.app, b.key)
  await hello(cb)
  return { classId, a: { ...a, client: ca }, b: { ...b, client: cb } }
}

/** Moves the clock to the next round and waits for it. */
async function nextRound(s: Service): Promise<void> {
  s.clock.advance(s.config.switchRefreshSeconds * 1000)
  await s.tick()
  await s.roundsDone()
}

const setStudent = (s: Service, id: number, set: { status: StudentStatus; suspendedUntil?: Date | null; classId?: null }) =>
  s.db.updateTable('students').set(set).where('id', '=', id).execute()

describe('the rounds of the students online', () => {
  test.each([
    ['suspended', { status: 'suspended', suspendedUntil: null }, '你正在停课，暂时不能来上课。'],
    ['session_over', { status: 'dropped', classId: null }, '你已经退学，不在任何班级里了，重新报名分班后才能来上课。'],
    ['expelled', { status: 'expelled', classId: null, suspendedUntil: null }, '你已经被开除，不在任何班级里了。'],
  ] as const)('%s: sent the closing and disconnected; the classmate is told as after any disconnect', async (reason, set, message) => {
    const s = await start()
    const { classId, a, b } = await twoInClass(s)
    // A conversation going on between them.
    a.client.send({ id: 's1', type: 'chat.start', to: b.id, text: '一起预习光的折射吗？' })
    const conversationId = (await a.client.next('ack')).result.conversationId
    await b.client.next('chat.incoming')

    await setStudent(s, a.id, set)
    await nextRound(s)

    expect(await a.client.next('closing')).toEqual({ type: 'closing', reason, message })
    expect(await a.client.closed()).toBe(1000)
    expect(s.hub.online(classId)).toEqual([b.id])
    expect(await b.client.next('chat.ended')).toEqual({ type: 'chat.ended', conversationId, reason: 'peer_offline' })
    expect(await b.client.next('presence')).toMatchObject({ left: { studentId: a.id } })
    expect(logs!.entries().filter((e) => e.msg === 'student sent out of class')).toEqual([
      expect.objectContaining({ studentId: a.id, reason }),
    ])
  })

  test('a student in good standing stays, and a round comes only every switchRefreshSeconds', async () => {
    const s = await start()
    const { classId, a, b } = await twoInClass(s)
    // Short of the interval, a change is not seen yet.
    await setStudent(s, a.id, { status: 'suspended', suspendedUntil: null })
    s.clock.advance(s.config.switchRefreshSeconds * 1000 - 1000)
    await s.tick()
    await s.roundsDone()
    expect(s.hub.online(classId)).toEqual([a.id, b.id])

    await setStudent(s, a.id, { status: 'active', suspendedUntil: null })
    await nextRound(s)
    expect(s.hub.online(classId)).toEqual([a.id, b.id])
  })

  test('a suspension that has ended, not yet put back by the night, does not send the student out', async () => {
    const s = await start()
    const { classId, a, b } = await twoInClass(s)
    await setStudent(s, a.id, { status: 'suspended', suspendedUntil: at('19:00') })
    await nextRound(s)
    expect(s.hub.online(classId)).toEqual([a.id, b.id])
  })

  test('one query a round, whoever is online, and none with nobody online', async () => {
    const s = await start()
    const { classId } = await twoInClass(s)
    query.calls = 0
    await nextRound(s)
    expect(query.calls).toBe(1)
    for (const ws of sockets.splice(0)) ws.terminate()
    await waitUntil(() => s.hub.online(classId).length === 0, 'everyone gone')
    await nextRound(s)
    expect(query.calls).toBe(1)
  })

  test('a tick while a round is still going starts no second one', async () => {
    const s = await start()
    await twoInClass(s)
    const release = holdQuery()
    s.clock.advance(s.config.switchRefreshSeconds * 1000)
    await s.tick()
    s.clock.advance(s.config.switchRefreshSeconds * 1000)
    await s.tick()
    expect(query.calls).toBe(1)
    release()
    await s.roundsDone()
    await nextRound(s)
    expect(query.calls).toBe(2)
  })

  test('a round whose query is still going when the service stops sends nobody out after it, and none starts after', async () => {
    const s = await start()
    const { a } = await twoInClass(s)
    await setStudent(s, a.id, { status: 'suspended', suspendedUntil: null })
    const release = holdQuery()
    s.clock.advance(s.config.switchRefreshSeconds * 1000)
    await s.tick()
    expect(query.calls).toBe(1)

    s.disconnectAll()
    expect(await a.client.next('closing')).toMatchObject({ reason: 'session_over' })
    const disconnect = vi.spyOn(s.hub, 'disconnect')
    release()
    await s.roundsDone()
    expect(disconnect).not.toHaveBeenCalled()
    await nextRound(s)
    expect(query.calls).toBe(1)
  })

  test('a round that fails is logged and counted, and the next one happens', async () => {
    const s = await start()
    errorsExpected = true
    const { classId, a, b } = await twoInClass(s)
    query.fail = true
    await nextRound(s)
    expect(internalErrors).toBe(1)
    expect(logs!.entries().filter((e) => e.msg === 'class rounds failed')).toEqual([
      expect.objectContaining({ level: 50, err: 'Error' }),
    ])
    expect(s.hub.online(classId)).toEqual([a.id, b.id])

    await setStudent(s, a.id, { status: 'expelled', classId: null })
    await nextRound(s)
    expect(internalErrors).toBe(1)
    expect(await a.client.next('closing')).toMatchObject({ reason: 'expelled' })
    expect(s.hub.online(classId)).toEqual([b.id])
  })
})
