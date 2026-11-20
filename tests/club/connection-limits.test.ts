import { afterEach, describe, expect, test } from 'vitest'
import { clubClosedClosing, REPLACED } from '../../src/club/club.js'
import type { HubConnection } from '../../src/club/hub.js'
import { captureLogs } from '../helpers/logs.js'
import { fakeGame, type FakeGame, QUICK_DECK } from './helpers/fake-game.js'
import { buildTestClubApp, HELLO, type Received, type TestClub, waitUntil } from './helpers/club-app.js'
import { exampleConfig } from './helpers/rooms.js'

// What a connection does when things happen in the middle of handling something (the lookups a message or a hello
// awaits), and the bounds on what a connection may cost: the send buffer, the frames waiting, a handler that throws,
// pings that go unanswered.

let service: TestClub | undefined
let logs: ReturnType<typeof captureLogs> | undefined
/** Error logs a test expects (a handler that throws). */
let errorsExpected = 0

afterEach(async () => {
  await service?.destroy()
  service = undefined
  expect(logs?.entries().filter((e) => e.level >= 50).length ?? 0).toBe(errorsExpected)
  logs = undefined
  errorsExpected = 0
})

async function start(options: Parameters<typeof buildTestClubApp>[0] = {}): Promise<TestClub> {
  logs = captureLogs()
  service = await buildTestClubApp({ logger: { level: 'info', stream: logs.stream }, ...options })
  return service
}

const connectionLimits = (p: Partial<typeof exampleConfig.club.connection>) => ({
  connection: { ...exampleConfig.club.connection, ...p },
})

/** Lets whatever the server has to do (the lookups, the closes) happen. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 100))

describe('while a message waits for the invitees to be looked up', () => {
  /**
   * A sends `room.create` inviting B, and `during` happens after the lookup has started and before it is answered:
   * `targetsOf` is called right before the lookup is awaited, with nothing awaited in between.
   */
  async function createDuring(during: (s: TestClub, a: { id: number }) => void) {
    const s = await start()
    const a = await s.member()
    const b = await s.member()
    const targetsOf = s.club.targetsOf.bind(s.club)
    s.club.targetsOf = (message) => {
      const ids = targetsOf(message)
      if (ids.length > 0) during(s, a)
      return ids
    }
    a.client.send({ id: 'c1', type: 'room.create', visibility: 'invite', bots: false, invite: [b.id] })
    await settle()
    // Nothing was done: no room, no invitation, and the message was not answered.
    expect(s.club.rooms.roomOf(a.id)).toBeNull()
    expect(s.club.rooms.size).toBe(0)
    expect(s.club.invites.size).toBe(0)
    expect(b.client.received.filter((m) => m.type === 'invite')).toEqual([])
    expect(a.client.received.some((m) => m.type === 'ack' && m.id === 'c1')).toBe(false)
    return { s, a, b }
  }

  test('the connection is disconnected', async () => {
    const { s, a } = await createDuring((s, a) => s.club.disconnect(a.id, REPLACED))
    expect(await a.client.closed()).toBe(1000)
    expect(s.club.online()).not.toContain(a.id)
  })

  test('the connection is replaced by a newer one', async () => {
    let newer: HubConnection | undefined
    const { s, a } = await createDuring((s, a) => {
      // What a newer connection's hello does: it takes the hub, and the older one is told and closed.
      newer = { studentId: a.id, send() {}, close() {} }
      s.club.hub.add(newer)?.close(REPLACED)
    })
    expect(await a.client.closed()).toBe(1000)
    // The newer one is the student's, and the older one's close took nothing from it.
    expect(s.club.online()).toContain(a.id)
  })

  test('the doors close', async () => {
    const { s, a } = await createDuring((s) => s.club.closeDoors(clubClosedClosing(null, s.config), s.clock.now()))
    expect(await a.client.closed()).toBe(1000)
    expect(s.club.online()).toEqual([])
  })

  test('the club closes without the connections being closed yet: club_closed', async () => {
    const s = await start()
    const a = await s.member()
    const b = await s.member()
    const targetsOf = s.club.targetsOf.bind(s.club)
    s.club.targetsOf = (message) => {
      const ids = targetsOf(message)
      s.setMaintenance({ message: '维护中。', since: s.clock.now(), expectedBackAt: null })
      return ids
    }
    const create = { id: 'c1', type: 'room.create', visibility: 'invite', bots: false, invite: [b.id] }
    const ack = await a.client.request(create)
    expect(ack.error.code).toBe('club_closed')
    expect(s.club.rooms.size).toBe(0)
    expect(s.club.invites.size).toBe(0)
  })
})

describe('while a hello waits for the database', () => {
  /** A game whose `stats`, the last thing a hello awaits, runs `during` first. */
  function gameWith(during: () => Promise<void>): FakeGame {
    const game = fakeGame({ decks: [QUICK_DECK], firstBidder: 0 })
    return {
      ...game,
      async stats(studentId) {
        await during()
        return game.stats(studentId)
      },
    }
  }

  test('the doors close: the connection is told so and never joins', async () => {
    let s!: TestClub
    s = await start({
      game: gameWith(async () => {
        s.setMaintenance({ message: '维护中。', since: s.clock.now(), expectedBackAt: null })
      }),
    })
    const { key } = await s.addStudent()
    const client = await s.connect(key)
    client.send({ id: 'h1', ...HELLO })
    expect(await client.next()).toMatchObject({ type: 'closing', reason: 'maintenance' })
    expect(await client.closed()).toBe(1000)
    expect(s.club.online()).toEqual([])
  })

  test('the client goes: the connection never joins', async () => {
    let s!: TestClub
    let gone: (() => void) | undefined
    s = await start({
      game: gameWith(async () => {
        gone?.()
        await settle()
      }),
    })
    const { key } = await s.addStudent()
    const client = await s.connect(key)
    gone = () => client.ws.terminate()
    client.send({ id: 'h1', ...HELLO })
    await settle()
    await settle()
    expect(s.club.online()).toEqual([])
    expect(s.club.hub.size).toBe(0)
  })

  test('what the club sends the student while they come in goes out after welcome and what they are owed', async () => {
    const s = await start()
    const { id, key } = await s.addStudent()
    const rejoined = s.club.rejoined.bind(s.club)
    s.club.rejoined = (studentId, hello, now) => {
      // As if the rooms told the student something as their seat came back to them.
      s.club.hub.toStudent(studentId, s.club.rooms.lobby())
      return rejoined(studentId, hello, now)
    }
    const client = await s.connect(key)
    client.send({ id: 'h1', ...HELLO })
    const got = await client.sync()
    expect(got.map((m) => m.type)).toEqual(['ack', 'welcome', 'lobby'])
    expect(s.club.online()).toEqual([id])
  })
})

describe('a replaced connection', () => {
  test('the student is not taken for gone: they still watch what they watched', async () => {
    const s = await start()
    const host = await s.member()
    const roomId = (await host.client.request({ type: 'room.create', visibility: 'public', bots: false })).result.room
      .roomId as string
    const a = await s.member()
    expect((await a.client.request({ type: 'watch', roomId })).ok).toBe(true)
    const again = await s.connect(a.key)
    await s.hello(again)
    expect(await a.client.closed()).toBe(1000)
    await settle()
    expect(s.club.watchers.watchedBy(a.id)).toBe(roomId)
    expect(s.club.rooms.state(roomId, s.clock.now())!.spectators).toBe(1)
  })
})

describe('what a connection may cost', () => {
  test('a client that stops reading is dropped once the send buffer is full', async () => {
    let internal = 0
    const s = await start({ onInternalError: () => internal++, club: connectionLimits({ maxSendBufferKiB: 64 }) })
    const { id, key } = await s.addStudent()
    const client = await s.connectTcp(key)
    await s.hello(client)
    // The client stops reading: what the server writes piles up.
    ;(client.ws as unknown as { _socket: { pause(): void } })._socket.pause()
    const lobby = s.club.rooms.lobby()
    for (let i = 0; i < 200_000 && s.club.online().length > 0; i++) {
      s.club.hub.toStudent(id, lobby)
      if (i % 1000 === 0) await new Promise((resolve) => setImmediate(resolve))
    }
    await waitUntil(() => s.club.online().length === 0, 'the drop')
    expect(internal).toBe(0)
  })

  test('more frames waiting than maxQueuedFrames: closed with 1008', async () => {
    const s = await start({ club: connectionLimits({ framesPerMinute: 1000, maxQueuedFrames: 5 }) })
    const { client } = await s.member()
    const b = await s.addStudent()
    // room.create with an invitation awaits the database, so the frames after it wait behind it.
    for (let i = 0; i < 20; i++) {
      client.send({ id: `x${i}`, type: 'room.create', visibility: 'invite', bots: false, invite: [b.id] })
    }
    expect(await client.closed()).toBe(1008)
  })

  test('a handler that throws closes the connection with 1011 and is counted', async () => {
    let internal = 0
    const s = await start({ onInternalError: () => internal++ })
    const { client } = await s.member()
    s.club.handle = () => {
      throw new Error('boom')
    }
    errorsExpected = 1
    client.send({ id: 'q', type: 'room.quick' })
    expect(await client.closed()).toBe(1011)
    expect(internal).toBe(1)
    expect(s.club.online()).toEqual([])
  })

  test('a client that does not answer pings is dropped', async () => {
    const s = await start({ pingIntervalMs: 30 })
    const { id, key } = await s.addStudent()
    const quiet = await s.connectTcp(key, { autoPong: false })
    await s.hello(quiet)
    expect(s.club.online()).toEqual([id])
    await waitUntil(() => s.club.online().length === 0, 'the drop')
    const received: Received[] = quiet.received
    expect(received.some((m) => m.type === 'closing')).toBe(false)
  })

  test('a client that answers pings stays', async () => {
    const s = await start({ pingIntervalMs: 30 })
    const { id, key } = await s.addStudent()
    const client = await s.connectTcp(key)
    await s.hello(client)
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(s.club.online()).toEqual([id])
  })
})
