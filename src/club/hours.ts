import type { Static } from 'typebox'
import type { ClubHours } from '../protocol/club-http.js'
import { isSchoolDay } from '../shared/calendar.js'
import type { SchoolConfig } from '../shared/config.js'
import { addDaysToDate, atLocalTime, localDate } from '../shared/local-time.js'

// When the clubs are closed by the timetable. On every school day (weekend study halls too) each session closes the
// clubs from the moment its doors open to the end of its closing grace and of the window the classes' closes are
// spread over (`lesson.staggerMillis`): the window `classBusy` (src/tools/class-busy.ts) counts, but from the doors
// themselves, without the restart tool's minimum lead. Windows that run into each other, or touch, are one closure.
// With `club.openBeforeTerm` false the clubs are also closed until the opening day (`calendar.openingDay`).
//
// Neither `club.enabled` nor maintenance is counted here: the club service checks those itself.

const DAY_MS = 24 * 60 * 60 * 1000
/** `closures` covers this long from now, as `ClubHours` says. */
const CLOSURES_SPAN_MS = DAY_MS
/** When no closure is found ahead (a school on a break with no end, say), the next close is put this far away. */
const NO_CLOSE_AHEAD_MS = 7 * DAY_MS

export interface Closure {
  startsAt: Date
  endsAt: Date
}

export type ClubClosed = { closed: false } | { closed: true; reopensAt: Date }

interface Span {
  from: number
  until: number
}

/** How long a session's window reaches before and after the slot's start, in milliseconds. */
function reach(config: SchoolConfig): { lead: number; tail: number } {
  const { lesson } = config
  return {
    lead: lesson.doorsOpenMinutesBefore * 60_000,
    tail: lesson.dismissalMinute * 60_000 + lesson.closingGraceSeconds * 1000 + lesson.staggerMillis,
  }
}

/** The windows of the sessions on `day`, none when it is not a school day. */
function windowsOn(config: SchoolConfig, day: string): Span[] {
  if (!isSchoolDay(day, config)) return []
  const { lead, tail } = reach(config)
  return Object.values(config.slots).map((slot) => {
    const start = atLocalTime(day, slot.start, config.timezone).getTime()
    return { from: start - lead, until: start + tail }
  })
}

/** The closure before the opening day, when the clubs do not open before term; it has no start. */
function beforeTerm(config: SchoolConfig): Span | null {
  const openingDay = config.calendar?.openingDay
  if (config.club.openBeforeTerm || openingDay === undefined) return null
  return { from: -Infinity, until: atLocalTime(openingDay, '00:00', config.timezone).getTime() }
}

/**
 * Every closing span (unmerged) that may overlap `[from, until)`: the windows of the days around it, far enough out
 * that a window reaching into it from a day before or after is among them, and the one before term.
 */
function spansAround(config: SchoolConfig, from: number, until: number): Span[] {
  const { lead, tail } = reach(config)
  const first = localDate(new Date(from - tail - DAY_MS), config.timezone)
  const last = localDate(new Date(until + lead + DAY_MS), config.timezone)
  const spans: Span[] = []
  for (let day = first; day <= last; day = addDaysToDate(day, 1)) spans.push(...windowsOn(config, day))
  const pre = beforeTerm(config)
  if (pre !== null) spans.push(pre)
  return spans
}

/** Spans in order of their start, those that overlap or touch joined into one. */
function merge(spans: Span[]): Span[] {
  const sorted = [...spans].sort((a, b) => a.from - b.from)
  const out: Span[] = []
  for (const span of sorted) {
    const prev = out[out.length - 1]
    if (prev !== undefined && span.from <= prev.until) prev.until = Math.max(prev.until, span.until)
    else out.push({ ...span })
  }
  return out
}

/**
 * The times the clubs are closed from `now` to 24 hours later, in order, those that run into each other joined, each
 * cut to that span: one going on at `now` starts at `now`, and one going on 24 hours later ends then.
 */
export function clubClosures(config: SchoolConfig, now: Date): Closure[] {
  const from = now.getTime()
  const until = from + CLOSURES_SPAN_MS
  return merge(spansAround(config, from, until))
    .filter((s) => s.from < until && s.until > from)
    .map((s) => ({ startsAt: new Date(Math.max(s.from, from)), endsAt: new Date(Math.min(s.until, until)) }))
}

/**
 * Whether the clubs are closed at `now`, and if so when they open again: the end of the closure, or of the chain of
 * closures that run into each other. A closure starts at its first moment and has ended at its last.
 */
export function clubClosedAt(config: SchoolConfig, now: Date): ClubClosed {
  let at = now.getTime()
  // Windows that cover whole days with no end in sight cannot come from a sane config; stop a year out all the same.
  const giveUpAt = at + 366 * DAY_MS
  let closed = false
  for (;;) {
    const t = at
    const around = spansAround(config, t, t).filter((s) => s.from <= t && t < s.until)
    if (around.length === 0 || t >= giveUpAt) break
    // Each pass moves `at` later, to the end of a span around it.
    at = Math.max(...around.map((s) => s.until))
    closed = true
  }
  return closed ? { closed: true, reopensAt: new Date(at) } : { closed: false }
}

/**
 * When the clubs next close: `now` when they are closed already, else the start of the first closure after it. The
 * search goes as far ahead as lessons are prepared (`lessonGeneration.horizonDays`, the days `lessonDaysAhead` sees),
 * and at least 7 days. With no closure in that time (a long break, or one with no end) the answer is 7 days from
 * `now`: a moment far enough away for `welcome.closesAt` and `RoomState.closesAt`, which the service will have told
 * again by then, and never later than a real closure, since the search covers those 7 days.
 */
export function nextClose(config: SchoolConfig, now: Date): Date {
  if (clubClosedAt(config, now).closed) return now
  const from = now.getTime()
  const until = from + Math.max(config.lessonGeneration.horizonDays * DAY_MS, NO_CLOSE_AHEAD_MS)
  const starts = spansAround(config, from, until)
    .map((s) => s.from)
    .filter((start) => start > from && start <= until)
  return new Date(starts.length > 0 ? Math.min(...starts) : from + NO_CLOSE_AHEAD_MS)
}

/** `GET /v1/school-calendar`'s `clubs`: whether the clubs are on, and when they are closed in the next 24 hours. */
export function clubHours(config: SchoolConfig, now: Date): Static<typeof ClubHours> {
  return {
    enabled: config.club.enabled,
    closures: clubClosures(config, now).map((c) => ({
      startsAt: c.startsAt.toISOString(),
      endsAt: c.endsAt.toISOString(),
    })),
  }
}
