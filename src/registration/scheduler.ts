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
