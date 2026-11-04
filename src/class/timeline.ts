import type { SchoolConfig } from '../shared/config.js'

export type StepName =
  | 'doors'
  | 'opening'
  | `segment-${number}`
  | `qa-${number}`
  | `callouts-${number}`
  | `call-on-${number}`
  | `call-on-close-${number}`
  | 'dismissal'
  | 'close'

const MINUTE_MS = 60_000

// The order of steps that fall on the same instant, earliest first. At a segment boundary that is: the call-on
// closes, the callouts for the segment just ended, then the next segment, then the call-on that comes after that
// segment; the answering point of a segment (`qa`) is `answerLeadSeconds` before the boundary that ends the segment
// and ranks after the call-on, should the two ever coincide; the last callouts come right before the dismissal.
const RANK = {
  doors: 0,
  opening: 1,
  callOnClose: 2,
  callouts: 3,
  segment: 4,
  callOn: 5,
  qa: 6,
  dismissal: 7,
  close: 8,
} as const

/**
 * The steps of one class session in the order they happen. Offsets count from `startsAt` (minute 0 is the opening;
 * the doors open before it), and `speed` divides every offset, so 60 plays an hour in a minute (the answering lead included). A study hall has no
 * segments, call-ons or answering points, but keeps the callouts on the same beat as a lesson.
 */
export function lessonSteps(
  startsAt: Date,
  kind: 'lesson' | 'study',
  lesson: SchoolConfig['lesson'],
  speed: number,
  answerLeadSeconds: number,
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

  const dismissalMs = lesson.dismissalMinute * MINUTE_MS
  if (kind === 'lesson') {
    // The teacher answers the questions of segment k from its start until `answerLeadSeconds` before the next
    // segment starts (before the dismissal, for the last one).
    lesson.segmentMinutes.forEach((_, i) => {
      const end = lesson.segmentMinutes[i + 1] !== undefined ? lesson.segmentMinutes[i + 1]! * MINUTE_MS : dismissalMs
      add(`qa-${i + 1}`, end - answerLeadSeconds * 1000, RANK.qa)
    })
    // A call-on needs a next segment (the config guarantees one): that segment's start is the deadline to answer.
    lesson.callOns.forEach((callOn, i) => {
      const after = lesson.segmentMinutes[callOn.afterSegment - 1]
      const next = lesson.segmentMinutes[callOn.afterSegment]
      if (after === undefined || next === undefined) return
      add(`call-on-${i + 1}`, after * MINUTE_MS, RANK.callOn)
      add(`call-on-close-${i + 1}`, next * MINUTE_MS, RANK.callOnClose)
    })
  }

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
