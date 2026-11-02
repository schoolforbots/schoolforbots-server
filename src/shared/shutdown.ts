/** How long a service has to shut down before it stops waiting and exits 1. */
export const SHUTDOWN_DEADLINE_MS = 10_000

/**
 * The same signal again within this long of the first is the same signal delivered twice, not a second one: under
 * `tsx watch` one Ctrl-C reaches the service from the terminal and again from tsx, which passes it on.
 */
const REPEAT_MS = 500

/**
 * What a service does on SIGTERM and SIGINT: runs `stop` once, then exits 0, or 1 if it failed. It has `deadlineMs`
 * to finish; past that the process exits 1, as it does at once on another signal while stopping (Ctrl-C twice).
 */
export function createShutdown(
  stop: (signal: NodeJS.Signals) => Promise<void>,
  opts: { deadlineMs?: number; exit?: (code: number) => void } = {},
): (signal: NodeJS.Signals) => void {
  const exit = opts.exit ?? ((code: number) => process.exit(code))
  const deadlineMs = opts.deadlineMs ?? SHUTDOWN_DEADLINE_MS
  let first: NodeJS.Signals | null = null
  let repeating = false

  return (signal) => {
    if (first !== null) {
      if (repeating && signal === first) return
      console.error(`${signal} while shutting down: exiting now`)
      exit(1)
      return
    }
    first = signal
    repeating = true
    setTimeout(() => {
      repeating = false
    }, REPEAT_MS).unref()
    // Unref'd: it only stops a shutdown that hangs, and never keeps a finished one alive.
    const deadline = setTimeout(() => {
      console.error(`Shutdown did not finish within ${deadlineMs / 1000} s: exiting`)
      exit(1)
    }, deadlineMs).unref()

    // A stop that throws before it returns its promise fails the same way.
    new Promise<void>((resolve) => resolve(stop(signal))).then(
      () => {
        clearTimeout(deadline)
        exit(0)
      },
      (err: unknown) => {
        clearTimeout(deadline)
        console.error('Shutdown failed', err)
        exit(1)
      },
    )
  }
}
