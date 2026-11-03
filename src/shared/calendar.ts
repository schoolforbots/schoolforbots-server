import type { SchoolConfig } from './config.js'
import { addDaysToDate, isoWeekday } from './local-time.js'

// The school calendar: which days the school is open, whether it is in term, and what is said when it opens. Pure
// functions of a day (`YYYY-MM-DD` in the school's time zone) and the config, shared by both services.
//
// A break covers its `from` day up to the day before `reopensOn`, the day the school is back; `reopensOn: null` means
// that day is not decided, so the break has no end yet. The days before the opening day count as a break too: the
// school has not opened. Weekends follow `lesson.weekendStudy`. Without a calendar the school is always in term.

export type SchoolState = 'not_started' | 'in_term' | 'on_break'

export interface CalendarStatus {
  state: SchoolState
  /** The name of the break the day is in, when it is in one that has a name. */
  breakName: string | null
  /** The first school day on or after the day the school is back; null in term, and when it is not decided. */
  reopensOn: string | null
}

type Break = NonNullable<SchoolConfig['calendar']>['breaks'][number]

/** The break from the config that `date` is in, if any (the days before the opening day are not one of them). */
function breakOn(date: string, config: SchoolConfig): Break | undefined {
  return config.calendar?.breaks.find((b) => b.from <= date && (b.reopensOn === null || date < b.reopensOn))
}

/** Whether the school is on holiday on `date`: before the opening day, or in a break. */
export function isOnBreak(date: string, config: SchoolConfig): boolean {
  const openingDay = config.calendar?.openingDay
  return (openingDay !== undefined && date < openingDay) || breakOn(date, config) !== undefined
}

/**
 * Whether the school holds sessions on `date`: it is not on break, and it is a weekday, or Saturday or Sunday with
 * the config having weekend study halls (without them the weekend is a holiday).
 */
export function isSchoolDay(date: string, config: SchoolConfig): boolean {
  return !isOnBreak(date, config) && (isoWeekday(date) <= 5 || config.lesson.weekendStudy)
}

/** Walks from `from` to the first school day on or after it, or to the break with no end that comes first. */
function walkToSchoolDay(from: string, config: SchoolConfig): { schoolDay: string } | { endless: Break } {
  const openingDay = config.calendar?.openingDay
  let day = from
  // Each pass moves to a later day: the opening day, the end of a break, or the next day. A break with no end
  // returns, and the breaks and the opening day are finitely many, so the walk ends.
  for (;;) {
    if (openingDay !== undefined && day < openingDay) {
      day = openingDay
      continue
    }
    const onBreak = breakOn(day, config)
    if (onBreak !== undefined) {
      if (onBreak.reopensOn === null) return { endless: onBreak }
      day = onBreak.reopensOn
      continue
    }
    if (isoWeekday(day) <= 5 || config.lesson.weekendStudy) return { schoolDay: day }
    day = addDaysToDate(day, 1)
  }
}

/**
 * The first school day on or after `from`: `from` itself when it is one. Null when the school is on a break from
 * then on that has no reopening day yet.
 */
export function nextSchoolDay(from: string, config: SchoolConfig): string | null {
  const reached = walkToSchoolDay(from, config)
  return 'schoolDay' in reached ? reached.schoolDay : null
}

/**
 * The break with no reopening day yet that comes before any school day on or after `from`: the one that makes
 * `nextSchoolDay` null, whether `from` is in it or in term before it. Null when there is a school day first.
 */
export function undecidedBreakAhead(from: string, config: SchoolConfig): { name: string | null; from: string } | null {
  const reached = walkToSchoolDay(from, config)
  return 'endless' in reached ? { name: reached.endless.name ?? null, from: reached.endless.from } : null
}

/** The first school day after break `b`, null when it has no reopening day yet. */
function reopeningOf(b: Break, config: SchoolConfig): string | null {
  return b.reopensOn === null ? null : nextSchoolDay(b.reopensOn, config)
}

/** Whether the school has not opened yet, is in term, or is on a break on `date`, and when it is next in session. */
export function calendarStatus(date: string, config: SchoolConfig): CalendarStatus {
  const openingDay = config.calendar?.openingDay
  if (openingDay !== undefined && date < openingDay) {
    return { state: 'not_started', breakName: null, reopensOn: nextSchoolDay(openingDay, config) }
  }
  const onBreak = breakOn(date, config)
  if (onBreak === undefined) return { state: 'in_term', breakName: null, reopensOn: null }
  return { state: 'on_break', breakName: onBreak.name ?? null, reopensOn: reopeningOf(onBreak, config) }
}

/**
 * The break to announce at the end of the last class of the school day `date`: the one the next day of study falls
 * in. That day is the next one, or when the weekend is a holiday, the Monday after a Friday, so a break that takes
 * no school day away is not announced. `reopensOn` is the first school day after the break.
 */
export function breakAfter(
  date: string,
  config: SchoolConfig,
): { name: string | null; from: string; reopensOn: string | null } | null {
  let next = addDaysToDate(date, 1)
  while (isoWeekday(next) > 5 && !config.lesson.weekendStudy) next = addDaysToDate(next, 1)
  const onBreak = breakOn(next, config)
  if (onBreak === undefined) return null
  return { name: onBreak.name ?? null, from: onBreak.from, reopensOn: reopeningOf(onBreak, config) }
}

/**
 * The speech the teacher gives to open the school day `date`, one sentence per item, or null for an ordinary day:
 * the opening speech on the first school day on or after the opening day, the speech of a break on the first school
 * day after it. Where breaks follow each other, the last of them speaks, and the opening speech goes before any.
 */
export function speechOn(date: string, config: SchoolConfig): string[] | null {
  const { calendar } = config
  if (calendar === undefined) return null
  if (calendar.openingDay !== undefined && nextSchoolDay(calendar.openingDay, config) === date) {
    return calendar.openingSpeech ?? null
  }
  let speech: string[] | null = null
  let latestReopensOn = ''
  for (const b of calendar.breaks) {
    if (b.speech === undefined || b.reopensOn === null || b.reopensOn <= latestReopensOn) continue
    if (nextSchoolDay(b.reopensOn, config) === date) {
      speech = b.speech
      latestReopensOn = b.reopensOn
    }
  }
  return speech
}

/**
 * The day D with `days` days that are not a holiday in `[D, today)`, for dropping students who have not come to class
 * since before D. Weekends count as days; days on a break, and all the days before the opening day, do not. Null when
 * there are not that many such days since the opening day, so that nobody is dropped for it yet.
 */
export function inactivityCutoffDay(today: string, days: number, config: SchoolConfig): string | null {
  const openingDay = config.calendar?.openingDay
  let day = today
  let counted = 0
  while (counted < days) {
    day = addDaysToDate(day, -1)
    if (openingDay !== undefined && day < openingDay) return null
    if (!isOnBreak(day, config)) counted += 1
  }
  return day
}
