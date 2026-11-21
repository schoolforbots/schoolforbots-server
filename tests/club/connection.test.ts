import { afterEach, describe, expect, test, vi } from 'vitest'
import { DEFAULT_DOUDIZHU_RULES } from '../../src/club/doudizhu/index.js'
import { clubClosedAt } from '../../src/club/hours.js'
import { CLUB_WS_ERROR_MESSAGES } from '../../src/club/ws-errors.js'
import { captureLogs } from '../helpers/logs.js'
import { buildTestClubApp, HELLO, type TestClub, waitUntil } from './helpers/club-app.js'
import { exampleWordLists } from './helpers/parts.js'
import { T0 } from './helpers/rooms.js'

let service: TestClub | undefined
let logs: ReturnType<typeof captureLogs> | undefined

afterEach(async () => {
  await service?.destroy()
  service = undefined
  // Nothing in these tests is a server fault.
  expect(logs?.entries().filter((e) => e.level >= 50) ?? []).toEqual([])
  logs = undefined
})

async function start(options: Parameters<typeof buildTestClubApp>[0] = {}): Promise<TestClub> {
  logs = captureLogs()
  service = await buildTestClubApp({ logger: { level: 'info', stream: logs.stream }, ...options })
  return service
}

const error = (id: string, code: keyof typeof CLUB_WS_ERROR_MESSAGES) => ({
  type: 'ack',
  id,
  ok: false,
  error: { code, message: CLUB_WS_ERROR_MESSAGES[code] },
})

/** 20:10 in Beijing on the day of T0: in the evening session's window, when the club is closed. */
const IN_CLASS = new Date('2026-11-20T20:10:00+08:00')

describe('hello', () => {
  test('welcome: the student, the club, the next close, the limits, the reactions, the stats, the rules', async () => {
    const s = await start()
    expect(clubClosedAt(s.config, T0).closed).toBe(false)
    const { id, welcome } = await s.member()
    const c = s.config.club
    expect(welcome).toEqual({
      type: 'welcome',
      student: {
        studentId: id,
        displayName: expect.stringMatching(new RegExp(`#${String(id).padStart(4, '0')}$`)),
        bot: false,
        className: '初中部·晚班·3 班',
      },
      club: { id: 'doudizhu', name: '斗地主社' },
      closesAt: s.club.rooms.closesAt(T0).toISOString(),
      limits: {
        framesPerMinute: c.connection.framesPerMinute,
        timeBankSeconds: c.timeBankSeconds,
        inviteSeconds: c.inviteSeconds,
        idleMinutes: c.idleMinutes,
        idleDecideSeconds: c.idleDecideSeconds,
        maxSpectators: c.maxSpectators,
        reactMinIntervalSeconds: c.reactMinIntervalSeconds,
        reactsPerGame: c.reactsPerGame,
      },
      reactions: {
        kinds: ['emoji', 'phrase'],
        visibility: ['room'],
        emoji: exampleWordLists.emoji,
        phrases: exampleWordLists.phrases,
      },
      stats: { games: 0, wins: 0, points: { total: 0, week: 0 } },
      rules: DEFAULT_DOUDIZHU_RULES,
      room: null,
    })
    expect(new Date(welcome.closesAt).getTime()).toBeGreaterThan(T0.getTime())
    expect(s.club.online()).toEqual([id])
  })

  test('anything before hello is hello_required; a second hello is invalid_message', async () => {
    const s = await start()
    const { key } = await s.addStudent()
    const client = await s.connect(key)
    client.send({ id: 'a', type: 'lobby.list' })
    expect(await client.next()).toEqual(error('a', 'hello_required'))
    await s.hello(client)
    client.send({ id: 'h2', ...HELLO })
    expect(await client.next()).toEqual(error('h2', 'invalid_message'))
  })

  test('another protocol version is protocol_unsupported, and a hello may follow', async () => {
    const s = await start()
    const { key } = await s.addStudent()
    const client = await s.connect(key)
    client.send({ id: 'h0', ...HELLO, protocol: 'v2' })
    expect(await client.next()).toEqual(error('h0', 'protocol_unsupported'))
    await s.hello(client)
  })

  test('frames that are not valid messages are invalid_message, and the connection stays open', async () => {
    const s = await start()
    const { key } = await s.addStudent()
    const client = await s.connect(key)
    client.send('not json')
    expect(await client.next()).toEqual(error('', 'invalid_message'))
    // lastSeq without roomId
    client.send({ id: 'h0', ...HELLO, lastSeq: 3 })
    expect(await client.next()).toEqual(error('h0', 'invalid_message'))
    client.send({ id: 'x'.repeat(65), type: 'nonsense' })
    expect(await client.next()).toEqual(error('', 'invalid_message'))
    client.send(JSON.stringify({ id: 'big', type: 'lobby.list', pad: 'x'.repeat(17 * 1024) }))
    expect(await client.next()).toEqual(error('', 'invalid_message'))
    await s.hello(client)
    client.send({ id: 'r1', type: 'react', kind: 'emoji', content: '👍', visibility: 'private' })
    expect(await client.next()).toEqual(error('r1', 'invalid_message'))
  })

  test('no hello in time: service_stopping, and the connection closes', async () => {
    const s = await start({ helloTimeoutMs: 50 })
    const { key } = await s.addStudent()
    const client = await s.connect(key)
    expect(await client.next()).toEqual({ type: 'closing', reason: 'service_stopping', message: expect.any(String) })
    expect(await client.closed()).toBe(1000)
    expect(s.club.online()).toEqual([])
  })
})

describe('the upgrade', () => {
  test('no key, or a wrong one, is 401 before the WebSocket opens', async () => {
    const s = await start()
    await expect(s.connect(null)).rejects.toThrow(/401/)
    await expect(s.connect('not-a-key')).rejects.toThrow(/401/)
  })

  test('/healthz answers while the database does', async () => {
    const s = await start()
    const res = await s.app.inject({ method: 'GET', url: '/healthz' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
  })
})

describe('the upgrades of an address', () => {
  const refused = (p: Promise<unknown>) => expect(p).rejects.toThrow('Unexpected server response: 429')
  /** How many times the upgrades have looked a key up. */
  const lookups = (s: TestClub) => {
    const spy = vi.spyOn(s.db, 'selectFrom')
    return () => spy.mock.calls.filter(([table]) => table === 'students').length
  }

  test('past upgradesPerIpPerMinute: 429 before the key is looked up; another address and /healthz go on', async () => {
    const s = await start({ wsHandshake: { upgradesPerIpPerMinute: 3, authFailuresPerIpPerMinute: 2 } })
    const { key } = await s.addStudent()
    const looked = lookups(s)

    for (let i = 0; i < 3; i++) await s.connect(key, { remoteAddress: '10.0.0.1' })
    expect(looked()).toBe(3)
    await refused(s.connect(key, { remoteAddress: '10.0.0.1' }))
    const res = await s.app.inject({ method: 'GET', url: '/v1/club', remoteAddress: '10.0.0.1' })
    expect(res.statusCode).toBe(429)
    expect(res.json()).toEqual({ error: { code: 'rate_limited', message: '请求太频繁了，请稍后再试。' } })
    expect(looked()).toBe(3)

    await s.connect(key, { remoteAddress: '10.0.0.2' })
    expect((await s.app.inject({ method: 'GET', url: '/healthz', remoteAddress: '10.0.0.1' })).statusCode).toBe(200)
  })

  test('after authFailuresPerIpPerMinute missing or unknown keys, even a valid key from the address is 429, unlooked', async () => {
    const s = await start({ wsHandshake: { upgradesPerIpPerMinute: 100, authFailuresPerIpPerMinute: 2 } })
    const { key } = await s.addStudent()
    const looked = lookups(s)

    await expect(s.connect(null, { remoteAddress: '10.0.0.1' })).rejects.toThrow(/401/)
    await expect(s.connect('not-a-key', { remoteAddress: '10.0.0.1' })).rejects.toThrow(/401/)
    expect(looked()).toBe(1)
    await refused(s.connect(key, { remoteAddress: '10.0.0.1' }))
    await refused(s.connect('not-a-key', { remoteAddress: '10.0.0.1' }))
    expect(looked()).toBe(1)

    await s.connect(key, { remoteAddress: '10.0.0.2' })
    expect(looked()).toBe(2)
  })

  test('once the window has passed, the address comes in again', async () => {
    const s = await start({
      wsHandshake: { upgradesPerIpPerMinute: 2, authFailuresPerIpPerMinute: 1 },
      handshakeWindowMs: 200,
    })
    const { key } = await s.addStudent()
    const from = { remoteAddress: '10.0.0.1' }

    await expect(s.connect('not-a-key', from)).rejects.toThrow(/401/)
    await refused(s.connect(key, from))
    await new Promise((resolve) => setTimeout(resolve, 250))
    await s.connect(key, from)
    await s.connect(key, from)
    await refused(s.connect(key, from))
    await new Promise((resolve) => setTimeout(resolve, 250))
    await s.connect(key, from)
  })
})

describe('at the door', () => {
  /** Connects the student and sends hello; returns the closing they got, after checking the connection closed. */
  async function refused(s: TestClub, key: string) {
    const client = await s.connect(key)
    client.send({ id: 'h1', ...HELLO })
    const closing = await client.next()
    expect(closing.type).toBe('closing')
    expect(await client.closed()).toBe(1000)
    expect(s.club.online()).toEqual([])
    return closing
  }

  test('a student who is not a member, or not in good standing, is not_member', async () => {
    const s = await start()
    const notJoined = await s.addStudent({ member: false })
    expect(await refused(s, notJoined.key)).toEqual({
      type: 'closing',
      reason: 'not_member',
      message: '你还不是斗地主社的社员，请主人打开社团的开关入社以后再来。',
    })
    for (const status of ['pending', 'waitlisted', 'dropped'] as const) {
      const other = await s.addStudent({ status, inClass: false })
      const closing = await refused(s, other.key)
      expect(closing.reason).toBe('not_member')
    }
    // A member whose class is gone (pending again, say) is not let in either.
    const noClass = await s.addStudent({ inClass: false })
    expect((await refused(s, noClass.key)).reason).toBe('not_member')
  })

  test('suspended and expelled students are told so', async () => {
    const s = await start()
    const suspended = await s.addStudent({ status: 'suspended', suspendedUntil: new Date(T0.getTime() + 86_400_000) })
    expect(await refused(s, suspended.key)).toEqual({
      type: 'closing',
      reason: 'suspended',
      message: '你正在停课，11月21日 11:00 以后才能回来社团。',
    })
    const expelled = await s.addStudent({ status: 'expelled' })
    expect(await refused(s, expelled.key)).toEqual({
      type: 'closing',
      reason: 'expelled',
      message: '你已经被开除，不能再来社团了。',
    })
    // A suspension that has ended does not keep a member out.
    const over = await s.addStudent({ status: 'suspended', suspendedUntil: new Date(T0.getTime() - 1000) })
    await s.hello(await s.connect(over.key))
  })

  test('while the club is closed: club_closed with reopensAt', async () => {
    const s = await start({ now: IN_CLASS })
    const closed = clubClosedAt(s.config, IN_CLASS)
    if (!closed.closed) throw new Error('the club should be closed then')
    const { key } = await s.addStudent()
    expect(await refused(s, key)).toEqual({
      type: 'closing',
      reason: 'club_closed',
      message: expect.stringContaining('社团现在关门了'),
      reopensAt: closed.reopensAt.toISOString(),
    })
  })

  test('while the clubs are switched off: club_closed with no reopensAt', async () => {
    const s = await start()
    s.setEnabled(false)
    const { key } = await s.addStudent()
    expect(await refused(s, key)).toEqual({ type: 'closing', reason: 'club_closed', message: expect.any(String) })
  })

  test('under maintenance: maintenance with expectedBackAt', async () => {
    const s = await start()
    const back = new Date(T0.getTime() + 3_600_000)
    s.setMaintenance({ message: '升级数据库，一小时后回来。', since: T0, expectedBackAt: back })
    const { key } = await s.addStudent()
    expect(await refused(s, key)).toEqual({
      type: 'closing',
      reason: 'maintenance',
      message: '升级数据库，一小时后回来。',
      expectedBackAt: back.toISOString(),
    })
    s.setMaintenance({ message: '维护中。', since: T0, expectedBackAt: null })
    expect((await refused(s, key)).expectedBackAt).toBeNull()
  })

  test('the club closed comes before maintenance, and maintenance before the student', async () => {
    const s = await start({ now: IN_CLASS })
    s.setMaintenance({ message: '维护中。', since: T0, expectedBackAt: null })
    const expelled = await s.addStudent({ status: 'expelled' })
    expect((await refused(s, expelled.key)).reason).toBe('club_closed')
    s.clock.set(T0)
    expect((await refused(s, expelled.key)).reason).toBe('maintenance')
    s.setMaintenance(null)
    expect((await refused(s, expelled.key)).reason).toBe('expelled')
  })

  test('while the service stops: service_stopping', async () => {
    const s = await start()
    s.setStopping(true)
    const { key } = await s.addStudent()
    expect(await refused(s, key)).toEqual({ type: 'closing', reason: 'service_stopping', message: expect.any(String) })
  })

  test('a message while the club is closed is club_closed', async () => {
    const s = await start()
    const { client } = await s.member()
    s.setMaintenance({ message: '维护中。', since: T0, expectedBackAt: null })
    expect(await client.request({ id: 'q', type: 'room.quick' })).toEqual(error('q', 'club_closed'))
    s.setMaintenance(null)
    s.clock.set(IN_CLASS)
    expect(await client.request({ id: 'q2', type: 'room.quick' })).toEqual(error('q2', 'club_closed'))
    s.clock.set(T0)
    expect((await client.request({ id: 'q3', type: 'room.quick' })).ok).toBe(true)
  })
})

describe('the connection', () => {
  test('a new connection of the same student replaces the old one, which is not taken for gone', async () => {
    const s = await start()
    const a = await s.member()
    const ack = await a.client.request({ type: 'room.create', visibility: 'public', bots: false })
    const roomId = ack.result.room.roomId as string

    const again = await s.connect(a.key)
    const welcome = await s.hello(again)
    expect(await a.client.next()).toEqual({ type: 'closing', reason: 'replaced', message: expect.any(String) })
    expect(await a.client.closed()).toBe(1000)
    expect(welcome.room.roomId).toBe(roomId)
    expect(welcome.room.seats[0].online).toBe(true)
    // Long after the grace, the seat is still theirs: they never went.
    s.advance(s.config.club.disconnectGraceSeconds + 5)
    expect(s.club.rooms.roomOf(a.id)).toBe(roomId)
    expect(s.club.rooms.state(roomId, s.clock.now())!.seats[0]!.online).toBe(true)
    expect(s.club.online()).toEqual([a.id])
    // The new connection works.
    expect((await again.request({ type: 'lobby.list' })).ok).toBe(true)
  })

  test('a disconnected student is marked offline and put out of the room after the grace', async () => {
    const s = await start()
    const a = await s.member()
    const b = await s.member()
    const created = await a.client.request({ type: 'room.create', visibility: 'public', bots: false })
    const roomId = created.result.room.roomId as string
    await b.client.request({ type: 'room.join', roomId })
    b.client.ws.terminate()
    await waitUntil(() => s.club.online().length === 1, 'the disconnect')
    expect(s.club.rooms.state(roomId, s.clock.now())!.seats[1]!.online).toBe(false)
    s.advance(s.config.club.disconnectGraceSeconds)
    expect(s.club.rooms.roomOf(b.id)).toBeNull()
    const events = (await a.client.sync()).filter((m) => m.type === 'room.event').map((m) => m.event)
    expect(events.at(-1)).toMatchObject({ kind: 'left', seat: 1, reason: 'disconnected_idle' })
  })

  test('a room filled while its host is away starts when they come back, after their welcome and replay', async () => {
    const s = await start()
    const a = await s.member()
    const created = await a.client.request({ type: 'room.create', visibility: 'public', bots: false })
    const roomId = created.result.room.roomId as string
    a.client.ws.terminate()
    await waitUntil(() => s.club.online().length === 0, 'the disconnect')
    const b = await s.member()
    const c = await s.member()
    await b.client.request({ type: 'room.join', roomId })
    await c.client.request({ type: 'room.join', roomId })
    expect(s.club.rooms.state(roomId, s.clock.now())!.game).toBeNull()

    const again = await s.connect(a.key)
    const welcome = await s.hello(again, { roomId, lastSeq: 1 })
    // The welcome is the room as it was when A came back: everyone there, no game yet.
    expect(welcome.room.game).toBeNull()
    expect(welcome.room.seats.map((seat: { online: boolean }) => seat.online)).toEqual([true, true, true])
    const after = await again.sync()
    const seqs = after.filter((m) => m.type === 'room.event').map((m) => m.seq as number)
    // B's and C's joins replayed, then the game's events, each once and in order.
    expect(seqs[0]).toBe(2)
    expect(seqs).toEqual([...new Set(seqs)].sort((x, y) => x - y))
    expect(seqs.at(-1)).toBe(s.club.rooms.state(roomId, s.clock.now())!.lastSeq)
    expect(after.filter((m) => m.type === 'hand')).toHaveLength(1)
    expect(s.club.rooms.state(roomId, s.clock.now())!.game).toMatchObject({ phase: 'bidding' })
    expect((await b.client.sync()).filter((m) => m.type === 'hand')).toHaveLength(1)
  })

  test('frames past the rate are rate_limited, and not handled', async () => {
    const s = await start({ club: { connection: { framesPerMinute: 2, maxQueuedFrames: 20, maxSendBufferKiB: 1024 } } })
    const { client } = await s.member()
    // hello was the first of 2
    client.send({ id: 'a', type: 'lobby.list' })
    client.send({ id: 'b', type: 'lobby.list' })
    client.send({ id: 'c', type: 'lobby.list' })
    const got = await client.take(4)
    expect(got.map((m) => [m.type, m.id ?? null])).toEqual([
      ['ack', 'a'],
      ['lobby', null],
      ['ack', 'b'],
      ['ack', 'c'],
    ])
    expect(got[2]).toEqual(error('b', 'rate_limited'))
    expect(got[3]).toEqual(error('c', 'rate_limited'))
  })

  test('the rate is the student’s, across connections: a reconnection does not start it again; others have their own', async () => {
    const s = await start({
      rateWindowMs: 1000,
      club: { connection: { framesPerMinute: 2, maxQueuedFrames: 20, maxSendBufferKiB: 1024 } },
    })
    const { id, key, client } = await s.member() // hello: 1
    expect((await client.request({ id: 'a', type: 'room.leave' })).error.code).toBe('not_in_room') // 2
    client.ws.terminate()
    await waitUntil(() => s.club.online().length === 0, 'the disconnect')

    // A new connection of the same student: the window is the one the old connection filled.
    const again = await s.connect(key)
    again.send({ id: 'h1', ...HELLO })
    expect(await again.next()).toEqual(error('h1', 'rate_limited'))

    // Another student is not held back by it.
    const other = await s.member()
    expect(other.id).not.toBe(id)

    // A window later the student may send again, on the new connection.
    await new Promise((resolve) => setTimeout(resolve, 1100))
    await s.hello(again)
  })

  test('the rate window passes', async () => {
    const s = await start({
      rateWindowMs: 100,
      club: { connection: { framesPerMinute: 2, maxQueuedFrames: 20, maxSendBufferKiB: 1024 } },
    })
    const { client } = await s.member()
    expect((await client.request({ id: 'a', type: 'room.leave' })).error.code).toBe('not_in_room')
    expect((await client.request({ id: 'b', type: 'room.leave' })).error.code).toBe('rate_limited')
    await new Promise((resolve) => setTimeout(resolve, 120))
    expect((await client.request({ id: 'c', type: 'room.leave' })).error.code).toBe('not_in_room')
  })
})
