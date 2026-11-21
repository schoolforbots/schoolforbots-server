import type { Kysely } from 'kysely'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { ranksOf } from '../../src/club/doudizhu/cards.js'
import { deal } from '../../src/club/doudizhu/deal.js'
import type { DoudizhuGameEntry } from '../../src/club/doudizhu-record.js'
import type { DoudizhuGameOptions } from '../../src/club/doudizhu-game.js'
import type { GameClientMessage, SeatPlayer } from '../../src/club/game.js'
import { botPerson, studentPerson } from '../../src/club/people.js'
import { createRecorder, nextGameId, RETRY_DELAYS_MS, writeGame } from '../../src/club/recorder.js'
import type { Database } from '../../src/shared/schema.js'
import { createTestClock } from '../helpers/clock.js'
import { createTestDb } from '../helpers/db.js'
import { insertStudent } from '../helpers/factories.js'
import { fakeGame, type FakeSession, QUICK_DECK } from './helpers/fake-game.js'

// The recorder (src/club/recorder.ts) on a fresh database: what a finished game stores, the retries, giving up, the
// drain, and the game numbers going on from the largest stored. The games are real ones, played on the fake game.

const T0 = new Date('2026-11-20T08:00:00.000Z')
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000)
const ADDRESSES = ['10.0.0.1', '10.0.0.2', null]

let t: Awaited<ReturnType<typeof createTestDb>>
let players: SeatPlayer[]
beforeEach(async () => {
  t = await createTestDb()
  players = []
  for (const name of ['阿杰', '小红', 'Tom']) {
    const { id } = await insertStudent(t.db, { status: 'active', ownerName: name })
    players.push(studentPerson({ id, ownerName: name, aiName: '小鱼' }))
  }
})
afterEach(async () => {
  await t.destroy()
})

/**
 * Plays one game on the fake game dealing `QUICK_DECK`: seat 0 bids 3 and plays out at once. With `redeal`, a first
 * deal nobody bids on comes before it. Gives the entry it handed on.
 */
function playGame(p: { seats?: SeatPlayer[]; redeal?: boolean; options?: DoudizhuGameOptions } = {}): DoudizhuGameEntry {
  const entries: DoudizhuGameEntry[] = []
  const game = fakeGame({
    decks: [QUICK_DECK, QUICK_DECK],
    // With a redeal, the first deal's first bidder is seat 2 and the second's seat 0.
    firstBidder: p.redeal ? 2 : 0,
    onGameOver: (entry) => entries.push(entry),
    ...p.options,
  })
  const seats = p.seats ?? players
  const s = game.newSession({ roomId: 'rrec01', players: seats, addresses: ADDRESSES, carry: null, closesAt: () => at(3600), now: T0 }) as FakeSession
  s.start(T0)
  let n = 1
  const bid = (seat: number, value: number) =>
    expect(s.handle(seat, { id: 'b', type: 'bid', game: 'doudizhu', turn: s.state.turn, bid: value }, at(n++)).ack.ok).toBe(true)
  if (p.redeal) for (const seat of [2, 0, 1]) bid(seat, 0)
  bid(0, 3)
  const cards = '3 3 4 4 5 5 6 6 7 7 8 8 9 9 10 10 J J Q Q'.split(' ')
  expect(s.handle(0, { id: 'p', type: 'play', game: 'doudizhu', turn: s.state.turn, cards, as: 'pair_straight' } as GameClientMessage, at(n++)).ack.ok).toBe(true)
  expect(s.over).toBe(true)
  expect(entries).toHaveLength(1)
  return entries[0]!
}

/** A sleep that resolves at once, noting what it was asked to wait. */
function noteSleeps() {
  const waits: number[] = []
  return { waits, sleep: async (ms: number) => void waits.push(ms) }
}

/** The test database, its `transaction` failing (as a database that is down) the first `failures` times. */
function failing(db: Kysely<Database>, failures: number): Kysely<Database> & { attempts: number } {
  let attempts = 0
  return new Proxy(db, {
    get(target, key) {
      if (key === 'attempts') return attempts
      if (key === 'transaction') {
        return () => {
          attempts++
          if (attempts <= failures) {
            return { execute: () => Promise.reject(Object.assign(new Error('connect ECONNREFUSED 10.9.8.7:5432'), { code: 'ECONNREFUSED' })) }
          }
          return target.transaction()
        }
      }
      const value = Reflect.get(target, key)
      return typeof value === 'function' ? value.bind(target) : value
    },
  }) as Kysely<Database> & { attempts: number }
}

function logs() {
  const entries: Record<string, any>[] = []
  return { entries, error: (obj: unknown) => void entries.push(obj as Record<string, any>) }
}

const stored = async () => ({
  games: await t.db.selectFrom('doudizhuGames').selectAll().orderBy('gameId').execute(),
  players: await t.db.selectFrom('doudizhuGamePlayers').selectAll().orderBy('gameId').orderBy('seat').execute(),
})

const opsEvents = () => t.db.selectFrom('opsEvents').select(['service', 'kind']).execute()

describe('a finished game', () => {
  test('is stored in both tables: the game with its record, and a row for each student seat', async () => {
    const recorder = createRecorder({ db: t.db, clock: createTestClock(T0), log: logs() })
    const entry = playGame()
    recorder.enqueue(entry)
    expect(recorder.pending()).toBe(1)
    await recorder.drain(10_000)
    expect(recorder.pending()).toBe(0)

    const { games, players: rows } = await stored()
    expect(games).toEqual([
      { gameId: 1, roomId: 'rrec01', startedAt: T0, endedAt: entry.endedAt, ranked: true, record: JSON.parse(JSON.stringify(entry.stored)) },
    ])
    expect(rows).toEqual(entry.players.map((row) => ({ ...row })))
    expect(rows.map((r) => [r.seat, r.studentId, r.role, r.won, r.score, r.spring, r.ip])).toEqual([
      [0, players[0]!.studentId, 'landlord', true, 12, true, '10.0.0.1'],
      [1, players[1]!.studentId, 'farmer', false, -6, false, '10.0.0.2'],
      [2, players[2]!.studentId, 'farmer', false, -6, false, null],
    ])
    expect(games[0]!.record).toMatchObject({ rules: expect.objectContaining({ cap: expect.any(Number) }) })
    expect(games[0]!.record).not.toHaveProperty('gameId')
  })

  test('dealt again: the last deal is what is stored', async () => {
    const recorder = createRecorder({ db: t.db, clock: createTestClock(T0), log: logs() })
    recorder.enqueue(playGame({ redeal: true }))
    await recorder.drain(10_000)
    const { games } = await stored()
    const record = games[0]!.record as any
    expect(record.dealt).toEqual(deal(QUICK_DECK).hands.map((h) => ranksOf(h)))
    expect(record.actions.map((a: any) => a.turn)).toEqual([4, 5])
    expect(record.actions[0]).toMatchObject({ seat: 0, action: 'bid', bid: 3 })
  })

  test('with bots: unranked, and rows for the students only', async () => {
    const recorder = createRecorder({ db: t.db, clock: createTestClock(T0), log: logs() })
    recorder.enqueue(playGame({ seats: [players[0]!, botPerson('陪练小一'), botPerson('陪练小二')] }))
    await recorder.drain(10_000)
    const { games, players: rows } = await stored()
    expect(games.map((g) => g.ranked)).toEqual([false])
    expect(rows.map((r) => [r.seat, r.ranked])).toEqual([[0, false]])
  })

  test('is written in one transaction: a row that fails stores nothing of the game', async () => {
    const entry = playGame()
    const broken: DoudizhuGameEntry = { ...entry, players: [...entry.players.slice(0, 2), { ...entry.players[2]!, studentId: 999_999 }] }
    await expect(writeGame(t.db, broken)).rejects.toThrow(/foreign key/)
    expect(await stored()).toEqual({ games: [], players: [] })
  })

  test('stored already (a retry after a commit whose answer was lost): done; another game under the number: an error', async () => {
    const entry = playGame()
    await writeGame(t.db, entry)
    await writeGame(t.db, entry)
    expect((await stored()).players).toHaveLength(3)
    await expect(writeGame(t.db, { ...entry, roomId: 'other1' })).rejects.toThrow(/stored already/)
  })

  test('enqueue returns at once and never throws, whatever the database does', () => {
    const db = new Proxy(t.db, {
      get: () => {
        throw new Error('broken')
      },
    })
    const recorder = createRecorder({ db, clock: createTestClock(T0), log: logs(), sleep: () => new Promise(() => {}) })
    expect(() => recorder.enqueue(playGame())).not.toThrow()
  })
})

describe('a write that fails', () => {
  test('is tried again 1 s, 5 s and 30 s later, and stored when one goes through', async () => {
    const db = failing(t.db, 2)
    const { waits, sleep } = noteSleeps()
    const log = logs()
    const recorder = createRecorder({ db, clock: createTestClock(T0), log, sleep })
    recorder.enqueue(playGame())
    await vi.waitFor(() => expect(recorder.pending()).toBe(0))
    expect(waits).toEqual([1000, 5000])
    expect(db.attempts).toBe(3)
    expect((await stored()).games).toHaveLength(1)
    expect(log.entries).toEqual([])
    expect(await opsEvents()).toEqual([])
    expect(RETRY_DELAYS_MS).toEqual([1000, 5000, 30_000])
  })

  test('that never goes through: an internal_error, and the whole record in the error log, without the addresses', async () => {
    const db = failing(t.db, Infinity)
    const { waits, sleep } = noteSleeps()
    const log = logs()
    const recorder = createRecorder({ db, clock: createTestClock(T0), log, sleep })
    const entry = playGame()
    recorder.enqueue(entry)
    await vi.waitFor(() => expect(recorder.pending()).toBe(0))
    expect(waits).toEqual([1000, 5000, 30_000])
    expect(db.attempts).toBe(4)
    expect((await stored()).games).toEqual([])
    await vi.waitFor(async () => expect(await opsEvents()).toEqual([{ service: 'club', kind: 'internal_error' }]))

    expect(log.entries).toHaveLength(1)
    const [logged] = log.entries
    expect(logged).toMatchObject({ why: 'failed', err: { name: 'Error', code: 'ECONNREFUSED' } })
    expect(logged).not.toHaveProperty('mayStillLand')
    expect(logged!.game).toEqual(
      JSON.parse(
        JSON.stringify({
          gameId: entry.gameId,
          roomId: entry.roomId,
          startedAt: entry.startedAt,
          endedAt: entry.endedAt,
          ranked: entry.ranked,
          rules: entry.stored.rules,
          record: entry.record,
          players: entry.players.map(({ ip: _ip, ...row }) => row),
        }),
      ),
    )
    const text = JSON.stringify(logged)
    // Every hand is there (the game is over); the addresses, and the error's message, are not.
    expect(text).toContain('"hands"')
    expect(text).not.toContain('10.0.0.1')
    expect(text).not.toContain('10.0.0.2')
    expect(text).not.toContain('10.9.8.7')
    expect(text).not.toContain('"ip"')
  })

  test('one game that keeps failing does not hold back the others', async () => {
    const recorder = createRecorder({ db: t.db, clock: createTestClock(T0), log: logs(), sleep: () => new Promise(() => {}) })
    const first = playGame()
    // Another game under the same number, but from another room: it can never be stored.
    recorder.enqueue(first)
    await vi.waitFor(() => expect(recorder.pending()).toBe(0))
    recorder.enqueue({ ...first, roomId: 'other1' })
    const second = playGame({ options: { firstGameId: 2 } })
    recorder.enqueue(second)
    await vi.waitFor(async () => expect((await stored()).games.map((g) => g.gameId)).toEqual([1, 2]))
    expect(recorder.pending()).toBe(1)
  })
})

describe('drain', () => {
  test('resolves at once with nothing to store', async () => {
    const recorder = createRecorder({ db: t.db, clock: createTestClock(T0), log: logs(), sleep: () => new Promise(() => {}) })
    await recorder.drain(10_000)
  })

  test('waits for the retries too', async () => {
    const db = failing(t.db, 1)
    let wake!: () => void
    const sleeps: number[] = []
    const sleep = (ms: number) => {
      sleeps.push(ms)
      // The retry's wait is released by the test; the drain's timeout never comes.
      return ms === 1000 ? new Promise<void>((resolve) => (wake = resolve)) : new Promise<void>(() => {})
    }
    const recorder = createRecorder({ db, clock: createTestClock(T0), log: logs(), sleep })
    recorder.enqueue(playGame())
    let drained = false
    const drain = recorder.drain(10_000).then(() => void (drained = true))
    await vi.waitFor(() => expect(sleeps).toContain(1000))
    expect(drained).toBe(false)
    wake()
    await drain
    expect((await stored()).games).toHaveLength(1)
  })

  test('past its timeout gives up what is not stored: logged in full and noted, and its retries stop', async () => {
    const db = failing(t.db, 1)
    let wake!: () => void
    let timeUp!: () => void
    const sleep = (ms: number) =>
      new Promise<void>((resolve) => {
        if (ms === 1000) wake = resolve
        else timeUp = resolve
      })
    const log = logs()
    const recorder = createRecorder({ db, clock: createTestClock(T0), log, sleep })
    recorder.enqueue(playGame())
    const drain = recorder.drain(50)
    await vi.waitFor(() => expect(wake).toBeDefined())
    timeUp()
    await drain
    expect(recorder.pending()).toBe(0)
    expect(log.entries).toEqual([
      expect.objectContaining({ why: 'drain_timeout', mayStillLand: true, game: expect.objectContaining({ gameId: 1 }) }),
    ])
    expect(log.entries[0]).not.toHaveProperty('err')
    await vi.waitFor(async () => expect(await opsEvents()).toEqual([{ service: 'club', kind: 'internal_error' }]))
    // The retry's wait ends: it is not tried again, nor logged again.
    wake()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(db.attempts).toBe(1)
    expect(log.entries).toHaveLength(1)
    expect((await stored()).games).toEqual([])
  })
})

describe('the game numbers', () => {
  test('go on from the largest stored, after a restart too', async () => {
    expect(await nextGameId(t.db)).toBe(1)
    const recorder = createRecorder({ db: t.db, clock: createTestClock(T0), log: logs() })
    recorder.enqueue(playGame({ options: { firstGameId: await nextGameId(t.db) } }))
    await recorder.drain(10_000)
    // Game 7 stored (after a gap: games lost to a crash).
    recorder.enqueue(playGame({ options: { firstGameId: 7 } }))
    await recorder.drain(10_000)
    expect(await nextGameId(t.db)).toBe(8)

    // A restart: a new game module numbered from there.
    const restarted = createRecorder({ db: t.db, clock: createTestClock(T0), log: logs() })
    const entry = playGame({ options: { firstGameId: await nextGameId(t.db) } })
    expect(entry.gameId).toBe(8)
    restarted.enqueue(entry)
    await restarted.drain(10_000)
    expect((await stored()).games.map((g) => g.gameId)).toEqual([1, 7, 8])
  })
})
