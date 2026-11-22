import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import type { TSchema } from 'typebox'
import { Value } from 'typebox/value'
import { afterEach, expect, test, vi } from 'vitest'
import WebSocket from 'ws'
import { doudizhuGame } from '../../src/club/doudizhu-game.js'
import { createRecorder, nextGameId, storedDoudizhuOptions } from '../../src/club/recorder.js'
import { type ClubService, createClubService } from '../../src/club/service.js'
import { ClubGameList, ClubLeaderboard, ClubMembership, DoudizhuGameRecord, DoudizhuStats } from '../../src/protocol/club-http.js'
import { buildRegistrationApp } from '../../src/registration/app.js'
import { MemoryMailer } from '../../src/registration/mailer.js'
import { loadSchoolRules } from '../../src/shared/school-rules.js'
import { exampleConfig as registrationConfig, exampleModerator } from '../helpers/app.js'
import { createTestClock } from '../helpers/clock.js'
import { createTestDb } from '../helpers/db.js'
import { insertClass, insertStudent } from '../helpers/factories.js'
import { type Client, HELLO, type Received, track, waitUntil } from './helpers/club-app.js'
import { checkProtocol, QUICK_DECK } from './helpers/fake-game.js'
import { exampleWordLists } from './helpers/parts.js'
import { exampleConfig, T0 } from './helpers/rooms.js'

// The doudizhu club end to end, as plugins see it: the registration service and the club service on real ports, one
// database, one clock that moves only when the test moves it, and three students with real WebSocket and HTTP
// clients. They join over HTTP, connect, open a room and play: a game with a step made on the time bank, two timeouts
// in a row into trusteeship, a step of the trustee's and the seat taken back with a valid step; then a second game;
// then they look up their records, the leaderboards, their games and a game's whole record over HTTP; then the
// service stops in the middle of a third game, which is played out and stored before anyone is disconnected.
//
// The game is the real one with its clock, the way the entry point (src/club/main.ts) builds it, dealing `QUICK_DECK`
// with seat 0 bidding first. Nothing sleeps: time passes by moving the clock and calling the service's tick.

const fromRoot = (relative: string) => fileURLToPath(new URL(`../../${relative}`, import.meta.url))

let cleanups: (() => Promise<void> | void)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  cleanups = []
})

interface Player {
  readonly name: string
  readonly id: number
  readonly key: string
  readonly ws: WebSocket
  readonly client: Client
  readonly welcome: Received
  /** How far `client.received` has been looked through for `your_turn`. */
  seen: number
}

test('three students join, play two games with the clock and trusteeship, look them up, and the third is played out as the service stops', async () => {
  const { db, destroy: destroyDb } = await createTestDb()
  cleanups.push(destroyDb)
  const clock = createTestClock(T0)
  const log = { error: vi.fn() }

  // ---- The registration service ----
  const registration = buildRegistrationApp({
    db,
    config: registrationConfig(),
    moderator: exampleModerator(),
    mailer: new MemoryMailer(),
    clock,
    maintenance: { current: () => null, refresh: async () => {}, onChange: () => {}, stop: () => {} },
    schoolRules: loadSchoolRules(fromRoot('school-rules')),
    trustProxy: false,
  })
  await registration.listen({ port: 0, host: '127.0.0.1' })
  cleanups.push(() => registration.close())
  const httpBase = `http://127.0.0.1:${(registration.server.address() as AddressInfo).port}`

  // ---- The club service, built as the entry point builds it ----
  const recorder = createRecorder({ db, clock, log })
  const service: ClubService = createClubService({
    db,
    config: exampleConfig,
    clock,
    game: doudizhuGame({
      decks: [QUICK_DECK],
      firstBidder: 0,
      timeBankSeconds: exampleConfig.club.timeBankSeconds,
      trusteeDelaySeconds: exampleConfig.club.trusteeDelaySeconds,
      ...storedDoudizhuOptions({ db, clock, timeZone: exampleConfig.timezone, recorder, firstGameId: await nextGameId(db), log }),
    }),
    wordLists: exampleWordLists,
    // The test sends its frames far faster than a plugin would.
    rateWindowMs: 1,
  })
  // Listening without the ticker: the test ticks.
  await service.app.listen({ port: 0, host: '127.0.0.1' })
  cleanups.push(() => service.app.close())
  const clubUrl = `ws://127.0.0.1:${(service.app.server.address() as AddressInfo).port}/v1/club`
  const tick = async (ms: number) => {
    clock.advance(ms)
    await service.tick()
  }

  async function http<T>(method: string, path: string, key: string, schema: TSchema, status = 200): Promise<T> {
    const res = await fetch(`${httpBase}${path}`, { method, headers: { authorization: `Bearer ${key}` } })
    const body = (await res.json()) as T
    expect(res.status, JSON.stringify(body)).toBe(status)
    expect(Value.Check(schema, body), JSON.stringify([...Value.Errors(schema, body)])).toBe(true)
    return body
  }

  // ---- Three students join over HTTP and connect ----
  const classId = await insertClass(db, { classNo: 1 })
  const players: Player[] = []
  for (const name of ['a', 'b', 'c']) {
    const s = await insertStudent(db, { classId, status: 'active', createdAt: new Date(T0.getTime() - 86_400_000) })
    const joined = await http<{ member: boolean }>('POST', '/v1/me/clubs/doudizhu', s.key, ClubMembership)
    expect(joined.member).toBe(true)
    const ws = new WebSocket(clubUrl, { headers: { authorization: `Bearer ${s.key}` } })
    cleanups.push(() => ws.terminate())
    const client = track(ws)
    await once(ws, 'open')
    client.send({ id: 'h', ...HELLO })
    expect(await client.next()).toEqual({ type: 'ack', id: 'h', ok: true })
    const welcome = await client.next()
    expect(welcome).toMatchObject({ type: 'welcome', stats: { games: 0, wins: 0, points: { total: 0, week: 0 } } })
    players.push({ name, id: s.id, key: s.key, ws, client, welcome, seen: 0 })
  }
  const [a, b, c] = players as [Player, Player, Player]
  const { bidSeconds, playSeconds } = a.welcome.rules as { bidSeconds: number; playSeconds: number }
  const bankSeconds = a.welcome.limits.timeBankSeconds as number
  const delaySeconds = exampleConfig.club.trusteeDelaySeconds
  expect(bankSeconds).toBe(exampleConfig.club.timeBankSeconds)

  /** The next `your_turn` any of the three is sent, and who it is for. */
  async function asked(): Promise<{ p: Player; t: Received }> {
    let found: { p: Player; t: Received } | undefined
    await waitUntil(() => {
      for (const p of players) {
        while (p.seen < p.client.received.length) {
          const m = p.client.received[p.seen++]!
          if (m.type === 'your_turn') {
            found = { p, t: m }
            return true
          }
        }
      }
      return false
    }, 'a your_turn')
    return found!
  }

  /** A plugin's fallback: the highest bid; pass when it may; otherwise the first move of the list. */
  function fallback(t: Received): Record<string, unknown> {
    if (t.phase === 'bid') return { type: 'bid', game: 'doudizhu', turn: t.turn, bid: Math.max(...(t.bids as number[])) }
    if (t.canPass) return { type: 'pass', game: 'doudizhu', turn: t.turn }
    return { type: 'play', game: 'doudizhu', turn: t.turn, moveId: t.moves[0].id }
  }

  async function answer(p: Player, message: Record<string, unknown>): Promise<void> {
    const ack = await p.client.request(message)
    expect(ack, JSON.stringify(ack)).toMatchObject({ ok: true })
  }

  /** The game events and trustee events every player at the table was sent, in order (a's copy). */
  const roomEvents = (p: Player) => p.client.received.filter((m) => m.type === 'room.event').map((m) => m.event)
  const overs = (p: Player) => roomEvents(p).filter((e) => e.kind === 'game' && e.event.kind === 'over')

  /** Plays every step with the fallback until the game is over. */
  async function playOut(): Promise<void> {
    const gamesBefore = overs(a).length
    while (overs(a).length === gamesBefore) {
      const waiting = () => players.some((p) => p.client.received.slice(p.seen).some((m) => m.type === 'your_turn'))
      await waitUntil(() => overs(a).length > gamesBefore || waiting(), 'a turn or the end')
      if (overs(a).length > gamesBefore) break
      const next = await asked()
      await answer(next.p, fallback(next.t))
    }
  }

  // ---- The room ----
  const created = await a.client.request({ type: 'room.create', visibility: 'public', bots: false })
  const roomId = created.result.room.roomId as string
  await answer(b, { type: 'room.join', roomId })
  await answer(c, { type: 'room.join', roomId })

  // ---- Game 1 ----
  // Seat 0 (a) bids, past its deadline, on the time bank.
  let ask = await asked()
  expect(ask.p).toBe(a)
  expect(ask.t).toMatchObject({ phase: 'bid', timeBankSeconds: bankSeconds })
  expect(Date.parse(ask.t.deadline) - clock.now().getTime()).toBe(bidSeconds * 1000)
  const firstGameId = ask.t.table.gameId as number
  await tick(bidSeconds * 1000 + 3000)
  await answer(a, { type: 'bid', game: 'doudizhu', turn: ask.t.turn, bid: 3 })

  // Its next step shows the bank 3 seconds down. It leads a single 3.
  ask = await asked()
  expect(ask.p).toBe(a)
  expect(ask.t).toMatchObject({ phase: 'play', timeBankSeconds: bankSeconds - 3 })
  await answer(a, { type: 'play', game: 'doudizhu', turn: ask.t.turn, cards: ['3'] })

  // b lets its steps time out, twice in a row: the first spends the whole bank, the second only the step's own time.
  // a and c answer at once. Then b is in trusteeship: asked with the short deadline, it lets one step go to the
  // trustee, and takes the seat back with a valid step at the next.
  let bAsked = 0
  for (;;) {
    ask = await asked()
    if (ask.p !== b) {
      await answer(ask.p, fallback(ask.t))
      continue
    }
    bAsked++
    const left = Date.parse(ask.t.deadline) - clock.now().getTime()
    if (bAsked === 1) {
      expect(ask.t.timeBankSeconds).toBe(bankSeconds)
      expect(left).toBe(playSeconds * 1000)
      await tick(left + bankSeconds * 1000)
    } else if (bAsked === 2) {
      expect(ask.t.timeBankSeconds).toBe(0)
      expect(left).toBe(playSeconds * 1000)
      await tick(left)
    } else if (bAsked === 3) {
      expect(left).toBe(delaySeconds * 1000)
      await tick(left)
    } else {
      expect(left).toBe(delaySeconds * 1000)
      await answer(b, fallback(ask.t))
      break
    }
  }
  const bTrustee = roomEvents(a).filter((e) => e.kind === 'trustee')
  expect(bTrustee).toEqual([
    { kind: 'trustee', seat: 1, on: true, reason: 'timeouts' },
    { kind: 'trustee', seat: 1, on: false, reason: 'off' },
  ])
  const bSteps = roomEvents(a)
    .filter((e) => e.kind === 'game' && e.event.seat === 1)
    .map((e) => e.event.auto)
  expect(bSteps).toEqual(['timeout', 'timeout', 'trustee', null])
  await playOut()
  const [over1] = overs(a)
  expect(over1.event.result.gameId).toBe(firstGameId)
  expect(over1.event.result.ranked).toBe(true)

  // ---- Game 2: everyone gets ready again; a reaction at the table goes into the record ----
  for (const p of players) await answer(p, { type: 'room.ready' })
  ask = await asked()
  expect(ask.t.table.gameId).toBe(firstGameId + 1)
  const emoji = (a.welcome.reactions.emoji as string[])[0]!
  await answer(a, { type: 'react', kind: 'emoji', content: emoji })
  await answer(ask.p, fallback(ask.t))
  await playOut()
  const over2 = overs(a)[1]!
  await recorder.drain(10_000)

  // ---- Looking them up over HTTP ----
  const results = [over1.event.result, over2.event.result]
  for (const [seat, p] of players.entries()) {
    const stats = await http<Record<string, any>>('GET', '/v1/me/clubs/doudizhu/stats', p.key, DoudizhuStats)
    const points = results.reduce((sum, r) => sum + (r.scores[seat] as number), 0)
    expect(stats).toMatchObject({ games: 2, rankedGames: 2, points: { total: points, week: points } })
    expect(stats.wins).toBe(
      results.filter((r) => (r.landlord === seat) === (r.outcome === 'landlord_won') && r.outcome !== 'no_landlord').length,
    )
    expect(stats.timeouts).toBe(seat === 1 ? 2 : 0)
    expect(stats.trusteeMoves).toBe(seat === 1 ? 1 : 0)
  }

  const lb = await http<Record<string, any>>('GET', '/v1/me/clubs/doudizhu/leaderboard?board=week', c.key, ClubLeaderboard)
  expect(lb.entries.map((e: Received) => e.studentId).sort()).toEqual(players.map((p) => p.id).sort())
  expect(lb.entries.every((e: Received) => e.games === 2)).toBe(true)
  expect(lb.me).toBeNull()
  expect(lb.weekStartsOn).toBe('2026-11-16')

  const list = await http<Record<string, any>>('GET', '/v1/me/clubs/doudizhu/games', b.key, ClubGameList)
  expect(list.games.map((g: Received) => g.gameId)).toEqual([firstGameId + 1, firstGameId])
  expect(list.nextBefore).toBeNull()

  const record = await http<Record<string, any>>('GET', `/v1/me/clubs/doudizhu/games/${firstGameId}`, b.key, DoudizhuGameRecord)
  expect(record.result).toEqual(over1.event.result)
  expect(record.seats.map((s: Received) => s.studentId)).toEqual(players.map((p) => p.id))
  expect(record.actions.filter((x: Received) => x.seat === 1).map((x: Received) => x.auto).slice(0, 4)).toEqual(['timeout', 'timeout', 'trustee', null])
  expect(record.actions[0]).toMatchObject({ turn: 1, seat: 0, action: 'bid', bid: 3, auto: null })
  const record2 = await http<Record<string, any>>('GET', `/v1/me/clubs/doudizhu/games/${firstGameId + 1}`, a.key, DoudizhuGameRecord)
  expect(record2.reacts).toMatchObject([{ from: 0, to: null, kind: 'emoji', content: emoji, text: emoji }])

  // ---- Game 3: the service stops halfway through ----
  for (const p of players) await answer(p, { type: 'room.ready' })
  for (let i = 0; i < 3; i++) {
    ask = await asked()
    await answer(ask.p, fallback(ask.t))
  }
  const thirdGameId = firstGameId + 2
  // What the database holds at the moment each student is told the service is stopping.
  const storedAtClosing: Promise<number>[] = []
  for (const p of players) {
    p.ws.on('message', (data) => {
      if (JSON.parse(String(data)).type !== 'closing') return
      storedAtClosing.push(
        db
          .selectFrom('doudizhuGamePlayers')
          .where('gameId', '=', thirdGameId)
          .select((eb) => eb.fn.countAll<string>().as('n'))
          .executeTakeFirstOrThrow()
          .then((r) => Number(r.n)),
      )
    })
  }
  await service.stop(exampleConfig.club.recordDrainSeconds * 1000)
  for (const p of players) {
    expect(await p.client.closed()).toBeGreaterThan(0)
    const last = p.client.received.at(-1)!
    expect(last).toMatchObject({ type: 'closing', reason: 'service_stopping' })
    const over3 = overs(p)[2]
    expect(over3?.event.result.gameId).toBe(thirdGameId)
    // The game was over before the closing came.
    expect(p.client.received.indexOf(last)).toBeGreaterThan(p.client.received.findIndex((m) => m.event === over3))
  }
  await waitUntil(() => storedAtClosing.length === 3, 'the closings')
  expect(await Promise.all(storedAtClosing)).toEqual([3, 3, 3])
  const record3 = await http<Record<string, any>>('GET', `/v1/me/clubs/doudizhu/games/${thirdGameId}`, c.key, DoudizhuGameRecord)
  expect(record3.actions.some((x: Received) => x.auto === 'closing')).toBe(true)
  expect(roomEvents(a).filter((e) => e.kind === 'trustee').slice(2)).toEqual(
    [0, 1, 2].map((seat) => ({ kind: 'trustee', seat, on: true, reason: 'closing' })),
  )
  expect(roomEvents(a).some((e) => e.kind === 'closed')).toBe(false)

  // Every message each student was sent is one the published schema allows.
  for (const p of players) for (const m of p.client.received) checkProtocol('ClubServerMessage', m)
  expect(log.error).not.toHaveBeenCalled()
}, 60_000)
