import { Cron } from 'croner'

/** Local midnight, every day. */
const DAILY_AT_MIDNIGHT = '0 0 * * *'

/** The next local midnight after `from` in the given timezone. */
export function nextDailyRun(from: Date, timezone: string): Date {
  const next = new Cron(DAILY_AT_MIDNIGHT, { timezone }).nextRun(from)
  if (next === null) throw new Error(`No next daily run after ${from.toISOString()} in ${timezone}`)
  return next
}

/** Runs `run` at every local midnight. A failed run is logged and the next night still runs; it never takes the process down. */
export function startDailyJob(run: () => Promise<unknown>, timezone: string): { stop(): void } {
  const cron = new Cron(DAILY_AT_MIDNIGHT, { timezone }, async () => {
    try {
      await run()
    } catch (err) {
      console.error('Daily job failed', err)
    }
  })
  return { stop: () => void cron.stop() }
}

/**
 * Runs `run` every `minutes` minutes, counted from the end of the last run, and at once when `runNow` is called (the
 * count starts again after that run). A failed run goes to `onError` and the next one still comes; it never takes the
 * process down. After `stop`, no run is scheduled any more.
 */
export function startPeriodicJob(
  run: () => Promise<unknown>,
  minutes: number,
  onError: (err: unknown) => void,
): { runNow(): Promise<void>; stop(): void } {
  let timer: NodeJS.Timeout | undefined
  let stopped = false
  const schedule = () => {
    clearTimeout(timer)
    if (!stopped) timer = setTimeout(() => void runNow(), minutes * 60_000)
  }
  async function runNow(): Promise<void> {
    clearTimeout(timer)
    try {
      await run()
    } catch (err) {
      onError(err)
    } finally {
      schedule()
    }
  }
  schedule()
  return {
    runNow,
    stop() {
      stopped = true
      clearTimeout(timer)
    },
  }
}
