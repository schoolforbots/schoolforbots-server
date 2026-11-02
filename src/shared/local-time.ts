const DAY_MS = 24 * 60 * 60_000

const formatters = new Map<string, Intl.DateTimeFormat>()

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone)
  if (f === undefined) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    })
    formatters.set(timeZone, f)
  }
  return f
}

/** What a wall clock in `timeZone` reads at `ms`, written as the UTC timestamp with that same reading (whole seconds). */
function wallClock(ms: number, timeZone: string): number {
  const part = (parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value)
  const parts = formatter(timeZone).formatToParts(ms)
  return Date.UTC(
    part(parts, 'year'),
    part(parts, 'month') - 1,
    part(parts, 'day'),
    part(parts, 'hour'),
    part(parts, 'minute'),
    part(parts, 'second'),
  )
}

/** How far the wall clock of `timeZone` is ahead of UTC at `ms`. */
function offsetAt(ms: number, timeZone: string): number {
  return wallClock(ms, timeZone) - Math.floor(ms / 1000) * 1000
}

/**
 * The first instant of a calendar day in `timeZone`: of the day `moment` falls on, or of the day `daysBack`
 * calendar days before it. Days are counted on the calendar, so one that daylight saving time makes 23 or
 * 25 hours long still counts as one; and a day whose midnight is skipped starts at its first instant.
 */
export function startOfLocalDay(moment: Date, timeZone: string, daysBack = 0): Date {
  const today = new Date(wallClock(moment.getTime(), timeZone))
  // That day's 00:00 as a wall-clock reading (a UTC timestamp); Date.UTC rolls a day count below 1 into earlier months.
  const midnight = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - daysBack)

  // Turned into an instant with the UTC offset in force a day before and a day after it. Without a daylight saving
  // change around that midnight the two agree. With one, the day starts at the earlier instant that is on that day.
  const starts = [midnight - DAY_MS, midnight + DAY_MS]
    .map((probe) => midnight - offsetAt(probe, timeZone))
    .filter((instant) => {
      const reading = wallClock(instant, timeZone)
      return reading >= midnight && reading < midnight + DAY_MS
    })
  if (starts.length === 0) throw new Error(`No start of day for ${new Date(midnight).toISOString().slice(0, 10)} in ${timeZone}`)
  return new Date(Math.min(...starts))
}
