import { afterEach, describe, expect, test, vi } from 'vitest'
import { isWeeklyReviewDay, nextDailyRun, startDailyJob, startPeriodicJob } from '../../src/registration/scheduler.js'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

test('the next run is the coming local midnight', () => {
  expect(nextDailyRun(new Date('2026-11-02T15:59:00Z'), 'Asia/Shanghai').toISOString()).toBe('2026-11-02T16:00:00.000Z')
  expect(nextDailyRun(new Date('2026-11-02T16:00:01Z'), 'Asia/Shanghai').toISOString()).toBe('2026-11-03T16:00:00.000Z')
})

test('the weekly review follows the midnight job of a Monday, by the local date', () => {
  // Monday 2 November 2026 starts at 16:00 UTC the day before in Shanghai.
  expect(isWeeklyReviewDay(new Date('2026-11-01T16:00:00Z'), 'Asia/Shanghai')).toBe(true)
  expect(isWeeklyReviewDay(new Date('2026-11-02T15:59:59Z'), 'Asia/Shanghai')).toBe(true)
  expect(isWeeklyReviewDay(new Date('2026-11-01T15:59:59Z'), 'Asia/Shanghai')).toBe(false)
  expect(isWeeklyReviewDay(new Date('2026-11-02T16:00:00Z'), 'Asia/Shanghai')).toBe(false)
})

test('the daily job fires at local midnight and not before', async () => {
  vi.useFakeTimers({ now: new Date('2026-11-02T15:59:00Z') })
  const run = vi.fn(async () => undefined)
  const job = startDailyJob(run, 'Asia/Shanghai')

  await vi.advanceTimersByTimeAsync(59_000)
  expect(run).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(2_000)
  expect(run).toHaveBeenCalledTimes(1)

  job.stop()
  await vi.advanceTimersByTimeAsync(2 * 24 * 60 * 60_000)
  expect(run).toHaveBeenCalledTimes(1)
})

test('a failing run is logged and the next night still runs', async () => {
  vi.useFakeTimers({ now: new Date('2026-11-02T15:59:00Z') })
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  const boom = new Error('database down')
  const run = vi.fn(async () => {
    throw boom
  })
  const job = startDailyJob(run, 'Asia/Shanghai')

  await vi.advanceTimersByTimeAsync(61_000)
  expect(run).toHaveBeenCalledTimes(1)
  expect(error).toHaveBeenCalledWith(expect.any(String), boom)

  await vi.advanceTimersByTimeAsync(24 * 60 * 60_000)
  expect(run).toHaveBeenCalledTimes(2)
  job.stop()
})

test('a synchronous throw is logged too', async () => {
  vi.useFakeTimers({ now: new Date('2026-11-02T15:59:00Z') })
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  const job = startDailyJob(() => {
    throw new Error('sync failure')
  }, 'Asia/Shanghai')

  await vi.advanceTimersByTimeAsync(61_000)
  expect(error).toHaveBeenCalledTimes(1)
  job.stop()
})

describe('the periodic job', () => {
  test('runs every so many minutes, counted from the end of the last run', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-02T10:00:00Z') })
    const run = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5 * 60_000))
    })
    const job = startPeriodicJob(run, 60, () => undefined)

    await vi.advanceTimersByTimeAsync(60 * 60_000 - 1)
    expect(run).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(run).toHaveBeenCalledTimes(1)
    // The run takes 5 minutes; the next one starts 60 minutes after it ended.
    await vi.advanceTimersByTimeAsync(64 * 60_000)
    expect(run).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(run).toHaveBeenCalledTimes(2)

    job.stop()
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000)
    expect(run).toHaveBeenCalledTimes(2)
  })

  test('runNow runs at once, and the next run comes that many minutes after it', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-02T10:00:00Z') })
    const run = vi.fn(async () => undefined)
    const job = startPeriodicJob(run, 60, () => undefined)

    await vi.advanceTimersByTimeAsync(30 * 60_000)
    await job.runNow()
    expect(run).toHaveBeenCalledTimes(1)
    // Not at minute 60 from the start: at 60 minutes after the run.
    await vi.advanceTimersByTimeAsync(60 * 60_000 - 1)
    expect(run).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(run).toHaveBeenCalledTimes(2)
    job.stop()
  })

  test('a failing run is reported and the next one still runs', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-02T10:00:00Z') })
    const boom = new Error('database down')
    const run = vi.fn(async () => {
      throw boom
    })
    const onError = vi.fn()
    const job = startPeriodicJob(run, 10, onError)

    await expect(job.runNow()).resolves.toBeUndefined()
    expect(onError).toHaveBeenCalledWith(boom)
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(run).toHaveBeenCalledTimes(2)
    expect(onError).toHaveBeenCalledTimes(2)
    job.stop()
  })

  test('a run started by runNow after stop does not start the timer again', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-02T10:00:00Z') })
    const run = vi.fn(async () => undefined)
    const job = startPeriodicJob(run, 10, () => undefined)
    job.stop()
    await job.runNow()
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    expect(run).toHaveBeenCalledTimes(1)
  })
})
