import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createShutdown } from '../../src/shared/shutdown.js'

describe('createShutdown', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    // What the handler prints on the way out is not what these tests look at.
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  /** A stop that stays in flight until the test settles it. */
  function controlledStop() {
    let settle: { resolve(): void; reject(err: Error): void } | undefined
    const stop = vi.fn(
      (_signal: NodeJS.Signals) =>
        new Promise<void>((resolve, reject) => {
          settle = { resolve, reject }
        }),
    )
    return { stop, settle: () => settle! }
  }

  test('stops once and exits 0', async () => {
    const { stop, settle } = controlledStop()
    const exit = vi.fn()
    const shutdown = createShutdown(stop, { exit })

    shutdown('SIGTERM')
    expect(stop).toHaveBeenCalledExactlyOnceWith('SIGTERM')
    await vi.advanceTimersByTimeAsync(0)
    expect(exit).not.toHaveBeenCalled()

    settle().resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(exit).toHaveBeenCalledExactlyOnceWith(0)
    // The deadline is off once the stop has finished.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(exit).toHaveBeenCalledTimes(1)
  })

  test('a failed stop exits 1', async () => {
    const { stop, settle } = controlledStop()
    const exit = vi.fn()
    createShutdown(stop, { exit })('SIGINT')

    settle().reject(new Error('the pool would not end'))
    await vi.advanceTimersByTimeAsync(0)
    expect(exit).toHaveBeenCalledExactlyOnceWith(1)
  })

  test('a stop that does not finish in time exits 1 at the deadline', async () => {
    const { stop } = controlledStop()
    const exit = vi.fn()
    createShutdown(stop, { exit, deadlineMs: 10_000 })('SIGTERM')

    await vi.advanceTimersByTimeAsync(9_999)
    expect(exit).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(exit).toHaveBeenCalledExactlyOnceWith(1)
  })

  test('the default deadline is 10 s', async () => {
    const { stop } = controlledStop()
    const exit = vi.fn()
    createShutdown(stop, { exit })('SIGTERM')

    await vi.advanceTimersByTimeAsync(9_999)
    expect(exit).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(exit).toHaveBeenCalledExactlyOnceWith(1)
  })

  test('a second signal while stopping exits 1 at once, and never stops twice', async () => {
    const { stop } = controlledStop()
    const exit = vi.fn()
    const shutdown = createShutdown(stop, { exit })

    shutdown('SIGINT')
    await vi.advanceTimersByTimeAsync(2_000)
    shutdown('SIGINT') // Ctrl-C again
    expect(exit).toHaveBeenCalledExactlyOnceWith(1)
    expect(stop).toHaveBeenCalledTimes(1)
  })

  test('a different signal while stopping exits 1 at once too', async () => {
    const { stop } = controlledStop()
    const exit = vi.fn()
    const shutdown = createShutdown(stop, { exit })

    shutdown('SIGTERM')
    shutdown('SIGINT')
    expect(exit).toHaveBeenCalledExactlyOnceWith(1)
  })

  test('the same signal again right away is one Ctrl-C delivered twice (tsx watch), not a second one', async () => {
    const { stop, settle } = controlledStop()
    const exit = vi.fn()
    const shutdown = createShutdown(stop, { exit })

    shutdown('SIGINT')
    shutdown('SIGINT')
    await vi.advanceTimersByTimeAsync(100)
    shutdown('SIGINT')
    expect(exit).not.toHaveBeenCalled()
    expect(stop).toHaveBeenCalledTimes(1)

    settle().resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(exit).toHaveBeenCalledExactlyOnceWith(0)
  })
})
