import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { startTicker, type Ticker } from '../../src/class/ticker.js'

describe('Ticker.lastFinishedAt', () => {
  let ticker: Ticker | undefined

  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(async () => {
    await ticker?.stop()
    ticker = undefined
    vi.useRealTimers()
  })

  test('is null until a run has finished', () => {
    ticker = startTicker(async () => {}, 1000, () => {})
    expect(ticker.lastFinishedAt()).toBeNull()
  })

  test('is updated by a run that succeeds and by one that fails', async () => {
    vi.setSystemTime(new Date('2026-11-02T12:00:00Z'))
    let fail = false
    ticker = startTicker(
      async () => {
        if (fail) throw new Error('x')
      },
      1000,
      () => {},
    )
    await vi.advanceTimersByTimeAsync(1000)
    const first = ticker.lastFinishedAt()
    expect(first).toBe(new Date('2026-11-02T12:00:01Z').getTime())

    fail = true
    await vi.advanceTimersByTimeAsync(1000)
    expect(ticker.lastFinishedAt()).toBe(first! + 1000)
  })

  test('stays at the last finish while a run is stuck', async () => {
    let stuck = false
    let release = () => {}
    ticker = startTicker(
      () => (stuck ? new Promise<void>((resolve) => (release = resolve)) : Promise.resolve()),
      1000,
      () => {},
    )
    await vi.advanceTimersByTimeAsync(1000)
    const first = ticker.lastFinishedAt()
    expect(first).not.toBeNull()

    stuck = true
    await vi.advanceTimersByTimeAsync(5000)
    expect(ticker.lastFinishedAt()).toBe(first)
    release()
  })
})
