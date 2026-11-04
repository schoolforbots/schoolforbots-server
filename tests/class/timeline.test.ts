import { describe, expect, test } from 'vitest'
import { lessonSteps } from '../../src/class/timeline.js'
import type { SchoolConfig } from '../../src/shared/config.js'
import { exampleConfig } from '../helpers/app.js'

const { lesson, teacherAi } = exampleConfig()
const LEAD = teacherAi.answerLeadSeconds

// A lesson starting at 20:00 Beijing time (UTC+8).
const STARTS_AT = new Date('2026-11-02T20:00:00+08:00')

/** Each step as `name hh:mm:ss.mmm`, the time read as Beijing time. */
function show(steps: { step: string; at: Date }[]): string[] {
  return steps.map(({ step, at }) => `${step} ${new Date(at.getTime() + 8 * 3_600_000).toISOString().slice(11, 23)}`)
}

function withLesson(overrides: Partial<SchoolConfig['lesson']>): SchoolConfig['lesson'] {
  return { ...lesson, ...overrides }
}

describe('lessonSteps for a lesson', () => {
  test('lays the steps out in real time (speed 1), ordering steps at the same instant', () => {
    expect(show(lessonSteps(STARTS_AT, 'lesson', lesson, 1, LEAD))).toEqual([
      'doors 19:45:00.000',
      'opening 20:00:00.000',
      'segment-1 20:05:00.000',
      'qa-1 20:09:00.000',
      'callouts-1 20:10:00.000',
      'segment-2 20:10:00.000',
      'call-on-1 20:10:00.000',
      'qa-2 20:14:00.000',
      'call-on-close-1 20:15:00.000',
      'callouts-2 20:15:00.000',
      'segment-3 20:15:00.000',
      'qa-3 20:19:00.000',
      'callouts-3 20:20:00.000',
      'segment-4 20:20:00.000',
      'call-on-2 20:20:00.000',
      'qa-4 20:24:00.000',
      'call-on-close-2 20:25:00.000',
      'callouts-4 20:25:00.000',
      'segment-5 20:25:00.000',
      'qa-5 20:29:00.000',
      'callouts-5 20:30:00.000',
      'dismissal 20:30:00.000',
      'close 20:31:00.000',
    ])
  })

  test('compresses every offset, the doors included, by the speed (speed 60)', () => {
    expect(show(lessonSteps(STARTS_AT, 'lesson', lesson, 60, LEAD))).toEqual([
      'doors 19:59:45.000',
      'opening 20:00:00.000',
      'segment-1 20:00:05.000',
      'qa-1 20:00:09.000',
      'callouts-1 20:00:10.000',
      'segment-2 20:00:10.000',
      'call-on-1 20:00:10.000',
      'qa-2 20:00:14.000',
      'call-on-close-1 20:00:15.000',
      'callouts-2 20:00:15.000',
      'segment-3 20:00:15.000',
      'qa-3 20:00:19.000',
      'callouts-3 20:00:20.000',
      'segment-4 20:00:20.000',
      'call-on-2 20:00:20.000',
      'qa-4 20:00:24.000',
      'call-on-close-2 20:00:25.000',
      'callouts-4 20:00:25.000',
      'segment-5 20:00:25.000',
      'qa-5 20:00:29.000',
      'callouts-5 20:00:30.000',
      'dismissal 20:00:30.000',
      'close 20:00:31.000',
    ])
  })

  test('returns the steps sorted by time', () => {
    const times = lessonSteps(STARTS_AT, 'lesson', lesson, 1, LEAD).map(({ at }) => at.getTime())
    expect(times).toEqual([...times].sort((a, b) => a - b))
  })

  test('follows the config: the number of segments, the call-on segment, the doors and the grace period', () => {
    const custom = withLesson({
      doorsOpenMinutesBefore: 10,
      segmentMinutes: [4, 8, 12],
      dismissalMinute: 20,
      closingGraceSeconds: 30,
      callOns: [
        { kind: 'review', afterSegment: 1 },
        { kind: 'extension', afterSegment: 2 },
      ],
    })
    expect(show(lessonSteps(STARTS_AT, 'lesson', custom, 1, LEAD))).toEqual([
      'doors 19:50:00.000',
      'opening 20:00:00.000',
      'segment-1 20:04:00.000',
      'call-on-1 20:04:00.000',
      'qa-1 20:07:00.000',
      'call-on-close-1 20:08:00.000',
      'callouts-1 20:08:00.000',
      'segment-2 20:08:00.000',
      'call-on-2 20:08:00.000',
      'qa-2 20:11:00.000',
      'call-on-close-2 20:12:00.000',
      'callouts-2 20:12:00.000',
      'segment-3 20:12:00.000',
      'qa-3 20:19:00.000',
      'callouts-3 20:20:00.000',
      'dismissal 20:20:00.000',
      'close 20:20:30.000',
    ])
  })

  test('puts doors before opening and dismissal before close when the offsets coincide', () => {
    const custom = withLesson({ doorsOpenMinutesBefore: 0, closingGraceSeconds: 0 })
    const steps = show(lessonSteps(STARTS_AT, 'lesson', custom, 1, LEAD))
    expect(steps.slice(0, 2)).toEqual(['doors 20:00:00.000', 'opening 20:00:00.000'])
    expect(steps.slice(-4)).toEqual(['qa-5 20:29:00.000', 'callouts-5 20:30:00.000', 'dismissal 20:30:00.000', 'close 20:30:00.000'])
  })

  test('rounds a compressed offset to a whole millisecond', () => {
    const custom = withLesson({ segmentMinutes: [1, 2], dismissalMinute: 3, callOns: [{ kind: 'review', afterSegment: 1 }] })
    const steps = lessonSteps(STARTS_AT, 'lesson', custom, 7, LEAD)
    // 60 000 ms / 7 = 8 571.43 ms
    expect(steps.find((s) => s.step === 'segment-1')?.at.getTime()).toBe(STARTS_AT.getTime() + 8571)
  })

  test('has no call-on pair when no segment follows the call-on segment', () => {
    const custom = withLesson({ callOns: [{ kind: 'review', afterSegment: 5 }] })
    const names = lessonSteps(STARTS_AT, 'lesson', custom, 1, LEAD).map((s) => s.step)
    expect(names.filter((n) => n.startsWith('call-on'))).toEqual([])
  })

  test('shortens the answering lead with the speed, and ends the last answering window at the dismissal', () => {
    const steps = lessonSteps(STARTS_AT, 'lesson', lesson, 30, LEAD)
    const at = (name: string) => steps.find((s) => s.step === name)!.at.getTime()
    // 60 s of lead at speed 30 is 2 s before the next segment starts; for the last segment, before the dismissal.
    expect(at('segment-2') - at('qa-1')).toBe(2000)
    expect(at('dismissal') - at('qa-5')).toBe(2000)
  })
})

describe('lessonSteps for a study hall', () => {
  test('has no segments, call-ons or answering points, but keeps the callouts on the same beat', () => {
    expect(show(lessonSteps(STARTS_AT, 'study', lesson, 1, LEAD))).toEqual([
      'doors 19:45:00.000',
      'opening 20:00:00.000',
      'callouts-1 20:10:00.000',
      'callouts-2 20:15:00.000',
      'callouts-3 20:20:00.000',
      'callouts-4 20:25:00.000',
      'callouts-5 20:30:00.000',
      'dismissal 20:30:00.000',
      'close 20:31:00.000',
    ])
  })

  test('compresses a study hall by the speed too', () => {
    expect(show(lessonSteps(STARTS_AT, 'study', lesson, 60, LEAD))).toEqual([
      'doors 19:59:45.000',
      'opening 20:00:00.000',
      'callouts-1 20:00:10.000',
      'callouts-2 20:00:15.000',
      'callouts-3 20:00:20.000',
      'callouts-4 20:00:25.000',
      'callouts-5 20:00:30.000',
      'dismissal 20:00:30.000',
      'close 20:00:31.000',
    ])
  })
})
