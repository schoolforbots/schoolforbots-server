export interface Ticker {
  /** No run starts after this; resolves once the run still going, if any, has finished. */
  stop(): Promise<void>
  /** `Date.now()` when the last run ended, whether it succeeded or failed; null before the first has ended. */
  lastFinishedAt(): number | null
}

/**
 * Runs `run` every `intervalMs` on real time. A run still going when the next is due is not waited for: that one is
 * skipped, so runs never pile up behind a slow one. A failed run goes to `onError`, and the next still happens.
 */
export function startTicker(run: () => Promise<void>, intervalMs: number, onError: (err: unknown) => void): Ticker {
  let inFlight: Promise<void> | null = null
  let finishedAt: number | null = null
  const timer = setInterval(() => {
    if (inFlight !== null) return
    inFlight = Promise.resolve()
      .then(run)
      .catch(onError)
      .finally(() => {
        finishedAt = Date.now()
        inFlight = null
      })
  }, intervalMs)
  return {
    lastFinishedAt: () => finishedAt,
    stop() {
      clearInterval(timer)
      return inFlight ?? Promise.resolve()
    },
  }
}
