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

/** The calendar date, `YYYY-MM-DD`, that a wall clock in `timeZone` reads at `moment`: the school day it falls on. */
export function localDate(moment: Date, timeZone: string): string {
  return new Date(wallClock(moment.getTime(), timeZone)).toISOString().slice(0, 10)
}

/** The time of day, `HH:MM`, that a wall clock in `timeZone` reads at `moment`. */
export function localTimeOfDay(moment: Date, timeZone: string): string {
  return new Date(wallClock(moment.getTime(), timeZone)).toISOString().slice(11, 16)
}

/** A moment as the school's wall clock reads it, e.g. `11月3日 20:00`. */
export function localMoment(moment: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(moment)
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? ''
  return `${part('month')}月${part('day')}日 ${part('hour')}:${part('minute')}`
}

const TIME_OF_DAY = /^([01]\d|2[0-3]):([0-5]\d)$/

/**
 * The instant a wall clock in `timeZone` reads `time` (`HH:MM`) on `date` (`YYYY-MM-DD`). On a day the clocks change,
 * a time that comes twice is its first occurrence, and a time that is skipped reads as the same time after the jump
 * (02:30 on a day that skips from 02:00 to 03:00 is 03:30).
 */
export function atLocalTime(date: string, time: string, timeZone: string): Date {
  const match = TIME_OF_DAY.exec(time)
  if (match === null) throw new Error(`Not a time of day (HH:MM): ${time}`)
  const reading = requireDateText(date) + (Number(match[1]) * 60 + Number(match[2])) * 60_000

  // As in startOfLocalDay: try the offsets in force a day before and a day after, and keep those that read right.
  const candidates = [reading - DAY_MS, reading + DAY_MS].map((probe) => reading - offsetAt(probe, timeZone))
  const exact = candidates.filter((instant) => wallClock(instant, timeZone) === reading)
  // A skipped time: the offset from before the jump lands just as far past it.
  return new Date(exact.length > 0 ? Math.min(...exact) : Math.max(...candidates))
}

// A school-calendar day is a `YYYY-MM-DD` text with no time zone, and the same date falls on the same weekday
// everywhere. The helpers below do calendar arithmetic on it with UTC timestamps, never with a Date's local fields.

const DATE_TEXT = /^(\d{4})-(\d{2})-(\d{2})$/

/** The UTC midnight of a `YYYY-MM-DD` date, or null when the text is not a real calendar date. */
function parseDateText(text: string): number | null {
  const match = DATE_TEXT.exec(text)
  if (match === null) return null
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])]
  const ms = Date.UTC(year, month - 1, day)
  const back = new Date(ms)
  // Date.UTC rolls 30 February over into March; a real date comes back as it went in.
  const real = back.getUTCFullYear() === year && back.getUTCMonth() === month - 1 && back.getUTCDate() === day
  return real ? ms : null
}

function requireDateText(text: string): number {
  const ms = parseDateText(text)
  if (ms === null) throw new Error(`Not a calendar date (YYYY-MM-DD): ${text}`)
  return ms
}

/** Whether `text` is a real calendar date written `YYYY-MM-DD`. */
export function isDateText(text: string): boolean {
  return parseDateText(text) !== null
}

/** The weekday of a `YYYY-MM-DD` date: 1 is Monday, 7 is Sunday. */
export function isoWeekday(date: string): number {
  return new Date(requireDateText(date)).getUTCDay() || 7
}

/** The calendar date `days` days after `date` (before it, when negative). */
export function addDaysToDate(date: string, days: number): string {
  return new Date(requireDateText(date) + days * DAY_MS).toISOString().slice(0, 10)
}

/** The month and day of a `YYYY-MM-DD` date as the school writes it, without padding: `12月7日`. */
export function monthDay(date: string): string {
  const day = new Date(requireDateText(date))
  return `${day.getUTCMonth() + 1}月${day.getUTCDate()}日`
}
// CI trial, not for merging
