import type { FastifyServerOptions } from 'fastify'
import { expect } from 'vitest'
import WebSocket from 'ws'
import { buildClubApp, type ClubDeps } from '../../../src/club/app.js'
import { Club } from '../../../src/club/club.js'
import { join } from '../../../src/club/members.js'
import type { SchoolConfig } from '../../../src/shared/config.js'
import type { Maintenance } from '../../../src/shared/maintenance.js'
import type { StudentStatus } from '../../../src/shared/schema.js'
import { createTestClock } from '../../helpers/clock.js'
import { createTestDb } from '../../helpers/db.js'
import { insertClass, insertStudent } from '../../helpers/factories.js'
import { checkProtocol, fakeGame, type FakeGame, QUICK_DECK } from './fake-game.js'
import { exampleWordLists } from './parts.js'
import { exampleConfig, T0 } from './rooms.js'

// A club service on a fresh database: the example config (with `club` overrides), the fake game dealing `QUICK_DECK`
// with seat 0 bidding first, the example word lists, and a clock that moves only when a test moves it. The club's
// tick runs only when a test calls `tick()`. Maintenance, the service stopping and the clubs' switch are set by the
// test (`setMaintenance`, `setStopping`, `setEnabled`).
//
// Connections are injected (`app.injectWS`); every message a client gets is checked against the published
// `protocol/club.schema.json` as it is read.

// A server message as the test reads it.
export type Received = Record<string, any>

export interface Client {
  readonly ws: WebSocket
  readonly received: Received[]
  send(message: unknown): void
  /** The next message not read yet, waiting for it to arrive. */
  next(): Promise<Received>
  /** Reads `n` messages. */
  take(n: number): Promise<Received[]>
  /** Waits for the server to close the connection and returns the close code. */
  closed(): Promise<number>
  /** Sends a frame the server cannot parse and reads up to its ack: every message sent before it, in order. */
  sync(): Promise<Received[]>
  /** Sends a message and reads up to its ack (included): what came before, the ack, and nothing after. */
  request(message: Record<string, unknown>): Promise<Received>
}

export async function waitUntil(check: () => boolean, what: string): Promise<void> {
  for (let waited = 0; !check(); waited += 5) {
    if (waited > 5000) throw new Error(`Timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

let idCounter = 0

/** Reads what the server sends `ws`. Called before the socket opens, so nothing is missed. */
export function track(ws: WebSocket): Client {
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
      checkProtocol('ClubServerMessage', message)
      return message
    },
    async take(n) {
      const out: Received[] = []
      for (let i = 0; i < n; i++) out.push(await client.next())
      return out
    },
    async closed() {
      await waitUntil(() => closeCode !== null, 'the close')
      return closeCode ?? 0
    },
    async sync() {
      client.send('sync')
      const out: Received[] = []
      for (;;) {
        const m = await client.next()
        if (m.type === 'ack' && m.id === '' && m.ok === false) return out
        out.push(m)
      }
    },
    async request(message) {
      const id = typeof message.id === 'string' ? message.id : `m${++idCounter}`
      client.send({ ...message, id })
      for (;;) {
        const m = await client.next()
        if (m.type === 'ack' && m.id === id) return m
      }
    },
  }
  return client
}

export const HELLO = { type: 'hello', protocol: 'v1', plugin: { type: 'openclaw', version: '1.2.3' }, club: 'doudizhu' }

/** A student `addStudent` makes. */
export interface StudentOptions {
  readonly status?: StudentStatus
  /** False: not a club member. */
  readonly member?: boolean
  readonly email?: string
  readonly suspendedUntil?: Date | null
  /** False: in no class. */
  readonly inClass?: boolean
}

export interface ClubAppOptions {
  readonly club?: Partial<SchoolConfig['club']>
  readonly now?: Date
  readonly game?: FakeGame
  readonly logger?: FastifyServerOptions['logger']
  readonly helloTimeoutMs?: number
  readonly rateWindowMs?: number
  readonly onInternalError?: () => void
}

export async function buildTestClubApp(options: ClubAppOptions = {}) {
  const { db, destroy: destroyDb } = await createTestDb()
  const config: SchoolConfig = { ...exampleConfig, club: { ...exampleConfig.club, ...options.club } }
  const clock = createTestClock(options.now ?? T0)
  const game = options.game ?? fakeGame({ decks: [QUICK_DECK], firstBidder: 0 })
  const club = new Club({ config, game, wordLists: exampleWordLists })
  let maintenance: Maintenance | null = null
  let stopping = false
  let enabled = config.club.enabled
  const deps: ClubDeps = {
    db,
    config,
    clock,
    club,
    maintenance: () => maintenance,
    stopping: () => stopping,
    clubEnabled: () => enabled,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    ...(options.helloTimeoutMs === undefined ? {} : { helloTimeoutMs: options.helloTimeoutMs }),
    ...(options.rateWindowMs === undefined ? {} : { rateWindowMs: options.rateWindowMs }),
    ...(options.onInternalError === undefined ? {} : { onInternalError: options.onInternalError }),
  }
  const app = buildClubApp(deps)
  await app.ready()
  const sockets: WebSocket[] = []
  let classId: number | null = null

  const service = {
    app,
    db,
    config,
    clock,
    club,
    game,
    setMaintenance(m: Maintenance | null) {
      maintenance = m
    },
    setStopping(value: boolean) {
      stopping = value
    },
    setEnabled(value: boolean) {
      enabled = value
    },
    /** Moves the clock on by `seconds` and ticks the club. */
    advance(seconds: number) {
      clock.advance(seconds * 1000)
      club.tick(clock.now())
    },

    /**
     * A student in an evening junior class, a club member unless `member` is false, of their own owner unless `email`
     * says otherwise.
     */
    async addStudent(p: StudentOptions = {}): Promise<{ id: number; key: string }> {
      classId ??= await insertClass(db, { classNo: 3 })
      const student = await insertStudent(db, {
        status: p.status ?? 'active',
        classId: p.inClass === false ? null : classId,
        createdAt: new Date(T0.getTime() - 86_400_000),
        ...(p.email === undefined ? {} : { email: p.email }),
        ...(p.suspendedUntil === undefined ? {} : { suspendedUntil: p.suspendedUntil }),
      })
      if (p.member !== false) await join(db, student.id, 'doudizhu', new Date(T0.getTime() - 3_600_000))
      return student
    },

    /** Opens a connection with `key` (none when null). Listeners are attached before the upgrade. */
    async connect(key: string | null): Promise<Client> {
      let client: Client | undefined
      const ws = await app.injectWS(
        '/v1/club',
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
    },

    /** Sends hello and returns the welcome, after the ack that comes first. */
    async hello(client: Client, extra: Record<string, unknown> = {}): Promise<Received> {
      client.send({ id: 'h1', ...HELLO, ...extra })
      expect(await client.next()).toEqual({ type: 'ack', id: 'h1', ok: true })
      const welcome = await client.next()
      expect(welcome.type).toBe('welcome')
      return welcome
    },

    /** A member connected and past hello. */
    async member(p: StudentOptions = {}): Promise<{ id: number; key: string; client: Client; welcome: Received }> {
      const student = await service.addStudent(p)
      const client = await service.connect(student.key)
      const welcome = await service.hello(client)
      return { ...student, client, welcome }
    },

    async destroy() {
      for (const ws of sockets.splice(0)) ws.terminate()
      await app.close()
      await destroyDb()
    },
  }
  return service
}

export type TestClub = Awaited<ReturnType<typeof buildTestClubApp>>
