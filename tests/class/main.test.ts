import { sql } from 'kysely'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { tickIntervalMs } from '../../src/class/service.js'
import { startTicker } from '../../src/class/ticker.js'
import { assertMigrationsUpToDate } from '../../src/shared/db.js'
import { createTestDb } from '../helpers/db.js'

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
    await sql`delete from kysely_migration where name in ('0003_student_queue_time', '0004_class_service')`.execute(db)

    await expect(assertMigrationsUpToDate(db)).rejects.toThrow(
      'The database is not migrated to the latest version (pending: 0003_student_queue_time, 0004_class_service)',
    )
    // The class service never migrates: that is the registration service's job.
    expect(await executed(db)).toEqual(['0001_init', '0002_key_reset_decoys'])
  })

  test('fails on a database that was never migrated', async () => {
    const db = await migratedDb()
    await sql`drop table kysely_migration`.execute(db)

    await expect(assertMigrationsUpToDate(db)).rejects.toThrow(
      'pending: 0001_init, 0002_key_reset_decoys, 0003_student_queue_time, 0004_class_service',
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
