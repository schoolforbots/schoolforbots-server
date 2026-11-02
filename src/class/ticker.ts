export interface Ticker {
  /** No run starts after this; resolves once the run still going, if any, has finished. */
  stop(): Promise<void>
}

/**
 * Runs `run` every `intervalMs` on real time. A run still going when the next is due is not waited for: that one is
 * skipped, so runs never pile up behind a slow one. A failed run goes to `onError`, and the next still happens.
 */
export function startTicker(run: () => Promise<void>, intervalMs: number, onError: (err: unknown) => void): Ticker {
  let inFlight: Promise<void> | null = null
  const timer = setInterval(() => {
    if (inFlight !== null) return
    inFlight = Promise.resolve()
      .then(run)
      .catch(onError)
      .finally(() => {
        inFlight = null
      })
  }, intervalMs)
  return {
    stop() {
      clearInterval(timer)
      return inFlight ?? Promise.resolve()
    },
  }
}
