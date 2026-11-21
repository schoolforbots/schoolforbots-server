import { afterEach, describe, expect, test, vi } from 'vitest'
import { clubClosedClosing, SERVICE_STOPPING } from '../../src/club/club.js'
import { captureLogs } from '../helpers/logs.js'
import { answer, fakeGame, QUICK_DECK } from './helpers/fake-game.js'
import { buildTestClubApp, type Client, type Received, type TestClub, waitUntil } from './helpers/club-app.js'
import { exampleWordLists } from './helpers/parts.js'

// The club over real WebSockets: rooms, a game played through, reconnects, reactions, watching, invitations, and the
// entries the service closes the club through.

let service: TestClub | undefined
let logs: ReturnType<typeof captureLogs> | undefined

afterEach(async () => {
  await service?.destroy()
  service = undefined
  expect(logs?.entries().filter((e) => e.level >= 50) ?? []).toEqual([])
  logs = undefined
})

// The tests here send far more frames than a plugin would (a `sync` is one), so the rate is out of the way.
const UNLIMITED = { connection: { framesPerMinute: 100_000, maxQueuedFrames: 20, maxSendBufferKiB: 1024 } }

async function start(options: Parameters<typeof buildTestClubApp>[0] = {}): Promise<TestClub> {
  logs = captureLogs()
  service = await buildTestClubApp({ logger: { level: 'info', stream: logs.stream }, club: UNLIMITED, ...options })
  return service
}

/** The fake game, allowing private reactions too. */
const privateReactions = () => {
  const game = fakeGame({ decks: [QUICK_DECK], firstBidder: 0 })
  return { ...game, reactions: { kinds: ['emoji', 'phrase'], visibility: ['room', 'private'] } } as typeof game
}

const EMOJI = exampleWordLists.emoji[0]!

const isOver = (m: Received) => m.type === 'room.event' && m.event.kind === 'game' && m.event.event.kind === 'over'
const events = (ms: Received[]) => ms.filter((m) => m.type === 'room.event')
const maxSeq = (ms: Received[]) => Math.max(0, ...events(ms).map((m) => m.seq as number))

/** Sends `message` and reads everything up to its ack: the messages before the ack, the ack, the messages after. */
async function exchange(client: Client, message: Record<string, unknown>) {
  const id = (message.id as string | undefined) ?? 'x'
  client.send({ ...message, id })
  const all = await client.sync()
  const at = all.findIndex((m) => m.type === 'ack' && m.id === id)
  if (at < 0) throw new Error(`no ack for ${id}`)
  return { before: all.slice(0, at), ack: all[at]!, after: all.slice(at + 1) }
}

/** Plays the game in the room to its end: each client answers its `your_turn`. Gives what each client got. */
async function playOut(clients: Client[]): Promise<Received[][]> {
  const got: Received[][] = clients.map(() => [])
  for (let round = 0; round < 100; round++) {
    let over = false
    let acted = false
    for (const [i, client] of clients.entries()) {
      let ms = await client.sync()
      for (;;) {
        got[i]!.push(...ms)
        const turn = ms.filter((m) => m.type === 'your_turn').at(-1)
        if (turn === undefined) break
        const reply = await exchange(client, answer(turn as never) as never)
        expect(reply.ack).toMatchObject({ ok: true })
        expect(reply.ack.result).toEqual({ turn: turn.turn })
        ms = reply.after
        acted = true
      }
      if (got[i]!.some(isOver)) over = true
    }
    if (over && !acted) return got
  }
  throw new Error('the game did not end')
}

/** Opens a public room with the client's student as its host. */
async function openRoom(client: Client): Promise<string> {
  return (await exchange(client, { type: 'room.create', visibility: 'public', bots: false })).ack.result.room.roomId
}

/** Three members at one table, A the host in seat 0, the game dealt and A to bid. */
async function table(s: TestClub) {
  const a = await s.member()
  const b = await s.member()
  const c = await s.member()
  const created = await exchange(a.client, { type: 'room.create', visibility: 'public', bots: false })
  const roomId = created.ack.result.room.roomId as string
  await exchange(b.client, { type: 'room.join', roomId })
  const third = await exchange(c.client, { type: 'room.join', roomId })
  return { a, b, c, roomId, third }
}

describe('a table', () => {
  test('three students open a room, play a game through, get ready and start the next', async () => {
    const s = await start()
    const a = await s.member()
    const b = await s.member()
    const c = await s.member()

    const created = await exchange(a.client, { type: 'room.create', visibility: 'public', bots: false })
    const room = created.ack.result.room
    expect(room.host).toBe(a.id)
    expect(room.seats.map((seat: Received) => seat.player?.studentId ?? null)).toEqual([a.id, null, null])
    expect(created.after).toEqual([])

    const lobby = await exchange(b.client, { type: 'lobby.list' })
    expect(lobby.ack).toEqual({ type: 'ack', id: 'x', ok: true })
    expect(lobby.after).toEqual([
      { type: 'lobby', rooms: [expect.objectContaining({ roomId: room.roomId, seatsFree: 2 })] },
    ])

    const joined = await exchange(b.client, { type: 'room.join', roomId: room.roomId })
    expect(joined.ack.result.room.seats[1].player.studentId).toBe(b.id)
    expect((await a.client.sync()).map((m) => m.event)).toEqual([
      expect.objectContaining({ kind: 'joined', seat: 1 }),
    ])

    // The third fills the room: the ack (with the state as they sat down) comes first, then the deal.
    const third = await exchange(c.client, { type: 'room.join', roomId: room.roomId })
    expect(third.before).toEqual([])
    expect(third.ack.result.room.game).toBeNull()
    expect(third.after[0]).toMatchObject({ type: 'room.event', event: { kind: 'game', event: { kind: 'dealt' } } })
    expect(third.after.some((m) => m.type === 'hand')).toBe(true)
    expect(third.after[0]!.seq).toBe(third.ack.result.room.lastSeq + 1)

    const got = await playOut([a.client, b.client, c.client])
    for (const ms of got) expect(ms.some(isOver)).toBe(true)

    // Everyone gets ready again; the third ready starts the next game.
    await exchange(a.client, { type: 'room.ready' })
    await exchange(b.client, { type: 'room.ready' })
    const ready = await exchange(c.client, { type: 'room.ready' })
    expect(ready.ack).toEqual({ type: 'ack', id: 'x', ok: true })
    expect(ready.after.map((m) => m.event?.kind ?? m.type)).toEqual(expect.arrayContaining(['ready', 'game', 'hand']))
    expect(s.game.sessions).toHaveLength(2)
    await playOut([a.client, b.client, c.client])
    expect(s.game.sessions[1]!.over).toBe(true)
    expect(s.club.rooms.state(room.roomId, s.clock.now())!.gamesPlayed).toBe(2)
  })

  test('seq goes up by one for everyone at the table', async () => {
    const s = await start()
    const { a, b, c } = await table(s)
    const seqs = await Promise.all([a, b, c].map(async (x) => events(await x.client.sync()).map((m) => m.seq)))
    for (const list of seqs) for (let i = 1; i < list.length; i++) expect(list[i]).toBe(list[i - 1] + 1)
  })
})

describe('coming back', () => {
  test('with roomId and lastSeq: the room, the events missed (private ones as sent), the hand, the turn', async () => {
    const s = await start({ game: privateReactions() })
    const { a, b, c, roomId, third } = await table(s)
    const seenA = [...third.after, ...(await a.client.sync())]
    const seenB = await b.client.sync()
    const seenC = [...third.after, ...(await c.client.sync())]
    const lastB = maxSeq(seenB)
    const lastC = maxSeq(seenC)
    expect(seenA.some((m) => m.type === 'your_turn')).toBe(true)

    b.client.ws.terminate()
    c.client.ws.terminate()
    await waitUntil(() => s.club.online().length === 1, 'the disconnects')

    const whisper = { type: 'react', kind: 'emoji', content: EMOJI, to: b.id, visibility: 'private' }
    const secret = await exchange(a.client, whisper)
    expect(secret.ack.ok).toBe(true)
    s.advance(s.config.club.reactMinIntervalSeconds)
    const open = await exchange(a.client, { type: 'react', kind: 'emoji', content: EMOJI })
    expect(open.ack.ok).toBe(true)
    const [privateSeq, publicSeq] = [secret.after[0]!.seq as number, open.after[0]!.seq as number]
    expect(publicSeq).toBe(privateSeq + 1)

    // B was the one the private reaction was for.
    const b2 = await s.connect(b.key)
    const welcomeB = await s.hello(b2, { roomId, lastSeq: lastB })
    expect(welcomeB.room).toMatchObject({ roomId, lastSeq: publicSeq })
    expect(welcomeB.room.seats[1]).toMatchObject({ online: true })
    const backB = await b2.sync()
    const replayB = events(backB)
    expect(replayB.every((m) => m.replayed === true)).toBe(true)
    expect(replayB.map((m) => m.seq)).toEqual([privateSeq, publicSeq])
    expect(replayB[0]!.event).toMatchObject({ kind: 'react', visibility: 'private' })
    expect(backB.slice(replayB.length).map((m) => m.type)).toEqual(['hand'])
    expect(backB.at(-1)!.roomId).toBe(roomId)

    // C sees a gap where it was.
    const c2 = await s.connect(c.key)
    await s.hello(c2, { roomId, lastSeq: lastC })
    const backC = await c2.sync()
    expect(events(backC).map((m) => m.seq)).toEqual([publicSeq])
    expect(backC.map((m) => m.type)).toEqual(['room.event', 'hand'])

    // A, back with no roomId: the room and what A is owed (the hand, the turn), no events replayed.
    const a2 = await s.connect(a.key)
    const welcomeA = await s.hello(a2)
    expect(welcomeA.room.roomId).toBe(roomId)
    const backA = await a2.sync()
    expect(backA.map((m) => m.type)).toEqual(['hand', 'your_turn'])
    expect(backA[1]!.turn).toBe(seenA.filter((m) => m.type === 'your_turn').at(-1)!.turn)
  })

  test('no longer seated: welcome.room is null, and nothing is replayed', async () => {
    const s = await start()
    const a = await s.member()
    const created = await exchange(a.client, { type: 'room.create', visibility: 'public', bots: false })
    const roomId = created.ack.result.room.roomId as string
    a.client.ws.terminate()
    await waitUntil(() => s.club.online().length === 0, 'the disconnect')
    s.advance(s.config.club.disconnectGraceSeconds)
    expect(s.club.rooms.roomOf(a.id)).toBeNull()

    const again = await s.connect(a.key)
    const welcome = await s.hello(again, { roomId, lastSeq: 1 })
    expect(welcome.room).toBeNull()
    expect(await again.sync()).toEqual([])
  })

  test('a lastSeq past the room’s last event replays what is kept of it', async () => {
    const s = await start()
    const a = await s.member()
    const roomId = await openRoom(a.client)
    const b = await s.member()
    await exchange(b.client, { type: 'room.join', roomId })
    const again = await s.connect(a.key)
    await s.hello(again, { roomId, lastSeq: 99 })
    const back = await again.sync()
    expect(back.map((m) => m.event?.kind)).toEqual(['joined', 'joined'])
  })
})

describe('watching', () => {
  test('a spectator gets the public events only, and stops watching when disconnected', async () => {
    const s = await start({ game: privateReactions() })
    const { a, b, roomId } = await table(s)
    const d = await s.member()
    const watch = await exchange(d.client, { type: 'watch', roomId })
    expect(watch.ack.result.room).toMatchObject({ roomId, spectators: 1 })

    await exchange(a.client, { type: 'react', kind: 'emoji', content: EMOJI, to: b.id, visibility: 'private' })
    s.advance(s.config.club.reactMinIntervalSeconds)
    await exchange(a.client, { type: 'react', kind: 'emoji', content: EMOJI })
    const seen = await d.client.sync()
    expect(seen.map((m) => [m.type, m.event?.visibility])).toEqual([['room.event', 'room']])

    d.client.ws.terminate()
    await waitUntil(() => s.club.watchers.watchedBy(d.id) === null, 'the spectator to stop watching')
    expect(s.club.rooms.state(roomId, s.clock.now())!.spectators).toBe(0)
  })
})

describe('invitations', () => {
  test('one invited while offline gets the invitation after welcome, and joining the room accepts it', async () => {
    const s = await start()
    const a = await s.member()
    const e = await s.addStudent()
    const outsider = await s.addStudent({ member: false })

    const refused = await exchange(a.client, {
      type: 'room.create',
      visibility: 'invite',
      bots: false,
      invite: [outsider.id],
    })
    expect(refused.ack.error.code).toBe('not_member_target')

    const created = await exchange(a.client, { type: 'room.create', visibility: 'invite', bots: false, invite: [e.id] })
    const roomId = created.ack.result.room.roomId as string

    const client = await s.connect(e.key)
    await s.hello(client)
    const [invite] = await client.sync()
    expect(invite).toMatchObject({ type: 'invite', roomId, from: { studentId: a.id } })

    const joined = await exchange(client, { type: 'room.join', roomId })
    expect(joined.ack.result.room.roomId).toBe(roomId)
    const toA = await a.client.sync()
    expect(toA).toEqual(
      expect.arrayContaining([{ type: 'invite.ended', inviteId: invite!.inviteId, reason: 'accepted' }]),
    )

    const invited = await exchange(a.client, { type: 'room.invite', to: outsider.id })
    expect(invited.ack.error.code).toBe('not_member_target')
  })
})

describe('closing', () => {
  test('closing the doors: the game is played out, the rooms close, and everyone is disconnected', async () => {
    const s = await start()
    const { a, b, c, roomId } = await table(s)
    const d = await s.member()
    await exchange(d.client, { type: 'watch', roomId })
    for (const x of [a, b, c]) await x.client.sync()
    const reopensAt = new Date(s.clock.now().getTime() + 3_600_000)
    s.club.closeDoors(clubClosedClosing(reopensAt, s.config), s.clock.now())
    for (const x of [a, b, c, d]) {
      const rest = [] as Received[]
      for (;;) {
        const m = await x.client.next()
        rest.push(m)
        if (m.type === 'closing') break
      }
      expect(rest.at(-1)).toEqual({
        type: 'closing',
        reason: 'club_closed',
        message: expect.any(String),
        reopensAt: reopensAt.toISOString(),
      })
      expect(rest.some(isOver)).toBe(true)
      expect(rest.find((m) => m.event?.kind === 'closed')?.event).toEqual({ kind: 'closed', reason: 'club_closed' })
      expect(await x.client.closed()).toBe(1000)
    }
    expect(s.club.rooms.size).toBe(0)
    expect(s.club.online()).toEqual([])
  })

  test('disconnecting one student: their seat waits as after any disconnect; disconnecting all', async () => {
    const s = await start()
    const a = await s.member()
    const b = await s.member()
    const roomId = await openRoom(a.client)
    expect(s.club.disconnect(a.id, { type: 'closing', reason: 'suspended', message: '你正在停课。' })).toBe(true)
    expect(await a.client.next()).toEqual({ type: 'closing', reason: 'suspended', message: '你正在停课。' })
    expect(s.club.rooms.state(roomId, s.clock.now())!.seats[0]!.online).toBe(false)
    expect(s.club.disconnect(a.id, SERVICE_STOPPING)).toBe(false)

    s.club.disconnectAll(SERVICE_STOPPING)
    expect(await b.client.next()).toEqual(SERVICE_STOPPING)
    expect(await b.client.closed()).toBe(1000)
    expect(s.club.online()).toEqual([])
  })
})

describe('what the game is told', () => {
  const FIRST = '198.51.100.7'
  const SECOND = '198.51.100.8'
  const forwarded = (ip: string) => ({ headers: { 'x-forwarded-for': ip } })

  test('behind a trusted proxy: the forwarded address at the start and after a reconnect, sent to nobody', async () => {
    const s = await start({ trustProxy: true })
    const a = await s.addStudent()
    const first = await s.connectTcp(a.key, forwarded(FIRST))
    await s.hello(first)
    const created = await exchange(first, { type: 'room.create', visibility: 'public', bots: true })
    const roomId = created.ack.result.room.roomId as string
    const session = s.game.sessions[0]!
    expect(session.addresses).toEqual([FIRST, null, null])

    // A reaction to the table during the game reaches the game, with the seats.
    const reacted = await exchange(first, { type: 'react', kind: 'emoji', content: EMOJI })
    expect(reacted.ack.ok).toBe(true)
    expect(session.reactions).toEqual([
      { from: 0, to: null, kind: 'emoji', content: EMOJI, text: EMOJI, at: s.clock.now() },
    ])

    const second = await s.connectTcp(a.key, forwarded(SECOND))
    await s.hello(second, { roomId, lastSeq: 0 })
    await second.sync()
    expect(session.addresses).toEqual([SECOND, null, null])

    for (const m of [...first.received, ...second.received]) expect(JSON.stringify(m)).not.toContain('198.51.100.')
  })

  test('a game failing to take the address of a reconnect does not keep the student out', async () => {
    const s = await start()
    const a = await s.addStudent()
    const first = await s.connectTcp(a.key)
    await s.hello(first)
    const created = await exchange(first, { type: 'room.create', visibility: 'public', bots: true })
    const roomId = created.ack.result.room.roomId as string
    vi.spyOn(s.game.sessions[0]!, 'addressChanged').mockImplementation(() => {
      throw new Error('addressChanged failed')
    })
    const second = await s.connect(a.key)
    const welcome = await s.hello(second, { roomId, lastSeq: 0 })
    expect(welcome.room.roomId).toBe(roomId)
    expect(welcome.room.seats[0]).toMatchObject({ online: true })
    expect((await second.sync()).some((m) => m.type === 'hand')).toBe(true)
    expect(s.club.online()).toEqual([a.id])
  })

  test('not behind a trusted proxy: X-Forwarded-For is not believed, the peer is', async () => {
    const s = await start()
    const a = await s.addStudent()
    const client = await s.connectTcp(a.key, forwarded(FIRST))
    await s.hello(client)
    await exchange(client, { type: 'room.create', visibility: 'public', bots: true })
    expect(s.game.sessions[0]!.addresses).toEqual(['127.0.0.1', null, null])
  })
})
