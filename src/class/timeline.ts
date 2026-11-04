import type { SchoolConfig } from '../shared/config.js'

export type StepName =
  | 'doors'
  | 'opening'
  | `segment-${number}`
  | `callouts-${number}`
  | 'call-on'
  | 'call-on-close'
  | 'dismissal'
  | 'close'

const MINUTE_MS = 60_000

// The order of steps that fall on the same instant, earliest first. At a segment boundary that is: the call-on
// closes, the callouts for the segment just ended, then the next segment; the call-on follows the segment it comes
// after; the last callouts come right before the dismissal.
const RANK = {
  doors: 0,
  opening: 1,
  callOnClose: 2,
  callouts: 3,
  segment: 4,
  callOn: 5,
  dismissal: 6,
  close: 7,
} as const

/**
 * The steps of one class session in the order they happen. Offsets count from `startsAt` (minute 0 is the opening;
 * the doors open before it), and `speed` divides every offset, so 60 plays an hour in a minute. A study hall has no
 * segments and no call-on, but keeps the callouts on the same beat as a lesson.
 */
export function lessonSteps(
  startsAt: Date,
  kind: 'lesson' | 'study',
  lesson: SchoolConfig['lesson'],
  speed: number,
): { step: StepName; at: Date }[] {
  const entries: { step: StepName; offsetMs: number; rank: number }[] = []
  const add = (step: StepName, offsetMs: number, rank: number): void => {
    entries.push({ step, offsetMs, rank })
  }

  const segmentCount = lesson.segmentMinutes.length
  add('doors', -lesson.doorsOpenMinutesBefore * MINUTE_MS, RANK.doors)
  add('opening', 0, RANK.opening)

  lesson.segmentMinutes.forEach((minute, i) => {
    const k = i + 1
    // The callouts for segment k - 1 come just before segment k starts.
    if (k >= 2) add(`callouts-${k - 1}`, minute * MINUTE_MS, RANK.callouts)
    if (kind === 'lesson') add(`segment-${k}`, minute * MINUTE_MS, RANK.segment)
  })

  // The call-on needs a next segment (the config guarantees one): that segment's start is the deadline to answer.
  // One call-on for now, after the first one the config lists.
  const callOnAfter = lesson.callOns[0]?.afterSegment ?? 0
  if (kind === 'lesson' && callOnAfter >= 1 && callOnAfter < segmentCount) {
    const after = lesson.segmentMinutes[callOnAfter - 1]
    const next = lesson.segmentMinutes[callOnAfter]
    if (after !== undefined && next !== undefined) {
      add('call-on', after * MINUTE_MS, RANK.callOn)
      add('call-on-close', next * MINUTE_MS, RANK.callOnClose)
    }
  }

  const dismissalMs = lesson.dismissalMinute * MINUTE_MS
  if (segmentCount > 0) add(`callouts-${segmentCount}`, dismissalMs, RANK.callouts)
  add('dismissal', dismissalMs, RANK.dismissal)
  add('close', dismissalMs + lesson.closingGraceSeconds * 1000, RANK.close)

  return entries
    .map(({ step, offsetMs, rank }) => ({
      step,
      // Whole milliseconds, so a compressed timeline is the same on every run.
      at: new Date(startsAt.getTime() + Math.round(offsetMs / speed)),
      rank,
    }))
    .sort((a, b) => a.at.getTime() - b.at.getTime() || a.rank - b.rank)
    .map(({ step, at }) => ({ step, at }))
}
