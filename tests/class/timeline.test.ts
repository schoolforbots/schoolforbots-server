import { describe, expect, test } from 'vitest'
import { lessonSteps } from '../../src/class/timeline.js'
import { loadSchoolConfig, type SchoolConfig } from '../../src/shared/config.js'

const { lesson } = loadSchoolConfig(new URL('../../config/school.example.json', import.meta.url).pathname)

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
    expect(show(lessonSteps(STARTS_AT, 'lesson', lesson, 1))).toEqual([
      'doors 19:45:00.000',
      'opening 20:00:00.000',
      'segment-1 20:05:00.000',
      'callouts-1 20:10:00.000',
      'segment-2 20:10:00.000',
      'callouts-2 20:15:00.000',
      'segment-3 20:15:00.000',
      'call-on 20:15:00.000',
      'call-on-close 20:20:00.000',
      'callouts-3 20:20:00.000',
      'segment-4 20:20:00.000',
      'callouts-4 20:25:00.000',
      'segment-5 20:25:00.000',
      'callouts-5 20:30:00.000',
      'dismissal 20:30:00.000',
      'close 20:31:00.000',
    ])
  })

  test('compresses every offset, the doors included, by the speed (speed 60)', () => {
    expect(show(lessonSteps(STARTS_AT, 'lesson', lesson, 60))).toEqual([
      'doors 19:59:45.000',
      'opening 20:00:00.000',
      'segment-1 20:00:05.000',
      'callouts-1 20:00:10.000',
      'segment-2 20:00:10.000',
      'callouts-2 20:00:15.000',
      'segment-3 20:00:15.000',
      'call-on 20:00:15.000',
      'call-on-close 20:00:20.000',
      'callouts-3 20:00:20.000',
      'segment-4 20:00:20.000',
      'callouts-4 20:00:25.000',
      'segment-5 20:00:25.000',
      'callouts-5 20:00:30.000',
      'dismissal 20:00:30.000',
      'close 20:00:31.000',
    ])
  })

  test('returns the steps sorted by time', () => {
    const times = lessonSteps(STARTS_AT, 'lesson', lesson, 1).map(({ at }) => at.getTime())
    expect(times).toEqual([...times].sort((a, b) => a - b))
  })

  test('follows the config: the number of segments, the call-on segment, the doors and the grace period', () => {
    const custom = withLesson({
      doorsOpenMinutesBefore: 10,
      segmentMinutes: [4, 8, 12],
      dismissalMinute: 20,
      closingGraceSeconds: 30,
      callOnAfterSegment: 1,
    })
    expect(show(lessonSteps(STARTS_AT, 'lesson', custom, 1))).toEqual([
      'doors 19:50:00.000',
      'opening 20:00:00.000',
      'segment-1 20:04:00.000',
      'call-on 20:04:00.000',
      'call-on-close 20:08:00.000',
      'callouts-1 20:08:00.000',
      'segment-2 20:08:00.000',
      'callouts-2 20:12:00.000',
      'segment-3 20:12:00.000',
      'callouts-3 20:20:00.000',
      'dismissal 20:20:00.000',
      'close 20:20:30.000',
    ])
  })

  test('puts doors before opening and dismissal before close when the offsets coincide', () => {
    const custom = withLesson({ doorsOpenMinutesBefore: 0, closingGraceSeconds: 0 })
    const steps = show(lessonSteps(STARTS_AT, 'lesson', custom, 1))
    expect(steps.slice(0, 2)).toEqual(['doors 20:00:00.000', 'opening 20:00:00.000'])
    expect(steps.slice(-3)).toEqual(['callouts-5 20:30:00.000', 'dismissal 20:30:00.000', 'close 20:30:00.000'])
  })

  test('rounds a compressed offset to a whole millisecond', () => {
    const custom = withLesson({ segmentMinutes: [1, 2], dismissalMinute: 3, callOnAfterSegment: 1 })
    const steps = lessonSteps(STARTS_AT, 'lesson', custom, 7)
    // 60 000 ms / 7 = 8 571.43 ms
    expect(steps.find((s) => s.step === 'segment-1')?.at.getTime()).toBe(STARTS_AT.getTime() + 8571)
  })

  test('has no call-on pair when no segment follows the call-on segment', () => {
    const custom = withLesson({ callOnAfterSegment: 5 })
    const names = lessonSteps(STARTS_AT, 'lesson', custom, 1).map((s) => s.step)
    expect(names).not.toContain('call-on')
    expect(names).not.toContain('call-on-close')
  })
})

describe('lessonSteps for a study hall', () => {
  test('has no segments and no call-on, but keeps the callouts on the same beat', () => {
    expect(show(lessonSteps(STARTS_AT, 'study', lesson, 1))).toEqual([
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
    expect(show(lessonSteps(STARTS_AT, 'study', lesson, 60))).toEqual([
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
