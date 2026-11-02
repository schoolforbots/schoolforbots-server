import { afterEach, expect, test, vi } from 'vitest'
import { nextDailyRun, startDailyJob } from '../../src/registration/scheduler.js'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

test('the next run is the coming local midnight', () => {
  expect(nextDailyRun(new Date('2026-11-02T15:59:00Z'), 'Asia/Shanghai').toISOString()).toBe('2026-11-02T16:00:00.000Z')
  expect(nextDailyRun(new Date('2026-11-02T16:00:01Z'), 'Asia/Shanghai').toISOString()).toBe('2026-11-03T16:00:00.000Z')
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
