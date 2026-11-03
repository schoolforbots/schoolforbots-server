import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { sql } from 'kysely'
import { afterEach, describe, expect, test, vi } from 'vitest'
import WebSocket from 'ws'
import { startClassService, tickIntervalMs } from '../../src/class/service.js'
import { startTicker, type Ticker } from '../../src/class/ticker.js'
import { assertMigrationsUpToDate } from '../../src/shared/db.js'
import { buildTestClassApp } from '../helpers/class-app.js'
import { createTestDb } from '../helpers/db.js'
import { insertClass, insertLesson, insertStudent } from '../helpers/factories.js'

// The parts of the class service's entry point (src/class/main.ts) that can be tested without starting it.

describe('the startup check of the migrations', () => {
  let destroy: (() => Promise<void>) | undefined

  afterEach(async () => {
    await destroy?.()
    destroy = undefined
  })

  async function migratedDb() {
    const test = await createTestDb()
    destroy = test.destroy
    return test.db
  }

  const executed = async (db: Awaited<ReturnType<typeof migratedDb>>) =>
    (await sql<{ name: string }>`select name from kysely_migration order by name`.execute(db)).rows.map((r) => r.name)

  test('passes on a database migrated to the latest version', async () => {
    const db = await migratedDb()
    await expect(assertMigrationsUpToDate(db)).resolves.toBeUndefined()
  })

  test('fails naming the migrations still to run, and runs none of them', async () => {
    const db = await migratedDb()
    await sql`
      delete from kysely_migration
      where name in ('0003_student_queue_time', '0004_class_service', '0005_school_rules_agreement', '0006_ai_id')`.execute(db)

    await expect(assertMigrationsUpToDate(db)).rejects.toThrow(
      'The database is not migrated to the latest version ' +
        '(pending: 0003_student_queue_time, 0004_class_service, 0005_school_rules_agreement, 0006_ai_id)',
    )
    // The class service never migrates: that is the registration service's job.
    expect(await executed(db)).toEqual(['0001_init', '0002_key_reset_decoys'])
  })

  test('fails on a database that was never migrated', async () => {
    const db = await migratedDb()
    await sql`drop table kysely_migration`.execute(db)

    await expect(assertMigrationsUpToDate(db)).rejects.toThrow(
      'pending: 0001_init, 0002_key_reset_decoys, 0003_student_queue_time, 0004_class_service, ' +
        '0005_school_rules_agreement',
    )
  })
})

describe('the ticker', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  /** A run that stays in flight until the test settles it. */
  function controlledRun() {
    const settle: { resolve(): void; reject(err: Error): void }[] = []
    const run = vi.fn(
      () =>
        new Promise<void>((resolve, reject) => {
          settle.push({ resolve, reject })
        }),
    )
    return { run, settle }
  }

  test('runs on every interval, and skips a run while the one before is still going', async () => {
    vi.useFakeTimers()
    const { run, settle } = controlledRun()
    const onError = vi.fn()
    const ticker = startTicker(run, 1000, onError)

    await vi.advanceTimersByTimeAsync(999)
    expect(run).toHaveBeenCalledTimes(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(run).toHaveBeenCalledTimes(1)

    // Still going: the next two intervals are skipped, not queued.
    await vi.advanceTimersByTimeAsync(2000)
    expect(run).toHaveBeenCalledTimes(1)

    settle[0]!.resolve()
    await vi.advanceTimersByTimeAsync(1000)
    expect(run).toHaveBeenCalledTimes(2)
    settle[1]!.resolve()
    await vi.advanceTimersByTimeAsync(1000)
    expect(run).toHaveBeenCalledTimes(3)
    settle[2]!.resolve()

    expect(onError).not.toHaveBeenCalled()
    await ticker.stop()
  })

  test('reports a failed run and keeps running', async () => {
    vi.useFakeTimers()
    const { run, settle } = controlledRun()
    const onError = vi.fn()
    const ticker = startTicker(run, 1000, onError)

    await vi.advanceTimersByTimeAsync(1000)
    const failure = new Error('the database is down')
    settle[0]!.reject(failure)
    await vi.advanceTimersByTimeAsync(0)
    expect(onError).toHaveBeenCalledExactlyOnceWith(failure)

    await vi.advanceTimersByTimeAsync(1000)
    expect(run).toHaveBeenCalledTimes(2)
    settle[1]!.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(onError).toHaveBeenCalledTimes(1)
    await ticker.stop()
  })

  test('a run that throws before it returns a promise is reported the same way', async () => {
    vi.useFakeTimers()
    const failure = new Error('thrown')
    const run = vi.fn((): Promise<void> => {
      throw failure
    })
    const onError = vi.fn()
    const ticker = startTicker(run, 1000, onError)

    await vi.advanceTimersByTimeAsync(2000)
    expect(run).toHaveBeenCalledTimes(2)
    expect(onError).toHaveBeenCalledTimes(2)
    expect(onError).toHaveBeenCalledWith(failure)
    await ticker.stop()
  })

  test('stop ends the runs, and waits for the one still going', async () => {
    vi.useFakeTimers()
    const { run, settle } = controlledRun()
    const ticker = startTicker(run, 1000, () => {})
    await vi.advanceTimersByTimeAsync(1000)

    let stopped = false
    const stopping = ticker.stop().then(() => {
      stopped = true
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(stopped).toBe(false)

    settle[0]!.resolve()
    await stopping
    expect(stopped).toBe(true)
    await vi.advanceTimersByTimeAsync(5000)
    expect(run).toHaveBeenCalledTimes(1)
    // Stopping again is harmless.
    await ticker.stop()
  })
})

describe('the tick interval', () => {
  // A third of the time a late step still runs live (30 s / speed), between 20 ms and a second.
  test.each([
    [1, 1000],
    [60, 166],
    [600, 20],
  ])('at timeline speed %i is %i ms', (speed, ms) => {
    expect(tickIntervalMs(speed)).toBe(ms)
  })
})

describe('starting the class service', () => {
  let service: Awaited<ReturnType<typeof buildTestClassApp>> | undefined
  let ticker: Ticker | undefined
  const sockets: WebSocket[] = []

  afterEach(async () => {
    await ticker?.stop()
    ticker = undefined
    for (const ws of sockets.splice(0)) ws.terminate()
    await service?.destroy()
    service = undefined
  })

  /** Connects over TCP, says hello and returns the first message after the ack. */
  async function helloOverTcp(key: string): Promise<Record<string, any>> {
    const { port } = service!.app.server.address() as AddressInfo
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/class`, { headers: { authorization: `Bearer ${key}` } })
    sockets.push(ws)
    const received: Record<string, any>[] = []
    ws.on('message', (data) => void received.push(JSON.parse(String(data))))
    await once(ws, 'open')
    ws.send(JSON.stringify({ id: 'h', type: 'hello', protocol: 'v1', plugin: { type: 'openclaw', version: '1.2.3' }, maxRounds: 3 }))
    for (let waited = 0; received.length < 1 || (received[0]!.type === 'ack' && received.length < 2); waited += 5) {
      if (waited > 5000) throw new Error('Timed out waiting for the answer to hello')
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    return received[0]!.type === 'ack' ? received[1]! : received[0]!
  }

  test('ticks before it listens, so a student back right after a restart in the middle of a lesson is let in', async () => {
    // The service starts at 20:10, ten minutes into the evening lesson, as after a restart.
    service = await buildTestClassApp({ now: new Date('2026-11-02T20:10:00+08:00') })
    await insertLesson(service.db, { date: '2026-11-02', subject: '科学', title: '光的折射' })
    const classId = await insertClass(service.db, { classNo: 1 })
    const { key } = await insertStudent(service.db, { classId, status: 'active' })

    ticker = await startClassService(service, { port: 0, host: '127.0.0.1', speed: 1 })

    const welcome = await helloOverTcp(key)
    expect(welcome).toMatchObject({ type: 'welcome', session: { kind: 'lesson', title: '光的折射' } })
  })

  test('a failed first tick fails the start, and nothing listens', async () => {
    service = await buildTestClassApp()
    const failure = new Error('the database is down')

    await expect(
      startClassService({ app: service.app, tick: () => Promise.reject(failure) }, { port: 0, host: '127.0.0.1', speed: 1 }),
    ).rejects.toBe(failure)
    expect(service.app.server.listening).toBe(false)
  })
})
