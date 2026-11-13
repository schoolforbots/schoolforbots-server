import { describe, expect, test } from 'vitest'
import { loadSchoolConfig, type SchoolConfig } from '../../src/shared/config.js'
import { classBusy, runClassBusy } from '../../src/tools/class-busy.js'

const base = loadSchoolConfig('config/school.example.json')
const withBreak = (): SchoolConfig => ({
  ...base,
  calendar: { ...base.calendar, breaks: [{ from: '2026-11-09', reopensOn: '2026-11-16', name: '假期' }] },
})

// 2026-11-10 is a Tuesday; the school's clock is UTC+8, so 10:00 there is 02:00 UTC.
const at = (hhmm: string, date = '2026-11-10') => new Date(`${date}T${hhmm}:00+08:00`)
// The example config spreads the classes' steps, their closes too, over 2 seconds after the timetable.
const STAGGER_MS = 2000
const later = (d: Date, ms: number) => new Date(d.getTime() + ms)

describe('classBusy', () => {
  test('is free well before a class opens (20 minutes)', () => {
    expect(classBusy(base, at('09:40'))).toEqual({ busy: false })
  })
  test('is busy 10 minutes before a class opens, and says when it is free', () => {
    const r = classBusy(base, at('09:50'))
    expect(r.busy).toBe(true)
    // Dismissal at minute 30, plus the closing grace of one minute, plus the window of the classes' closes.
    if (r.busy) expect(r.freeAt).toEqual(later(at('10:31'), STAGGER_MS))
  })
  test('is busy during class', () => {
    expect(classBusy(base, at('10:12')).busy).toBe(true)
    expect(classBusy(base, at('20:29')).busy).toBe(true)
  })
  test('is free after class ends', () => {
    expect(classBusy(base, at('10:45'))).toEqual({ busy: false })
    expect(classBusy(base, at('23:00'))).toEqual({ busy: false })
  })
  test('is free all day on a day of break', () => {
    const config = withBreak()
    expect(classBusy(config, at('10:10'))).toEqual({ busy: false })
    expect(classBusy(config, at('09:50', '2026-11-10'))).toEqual({ busy: false })
  })
  test('on a weekend with study halls the school is busy too; without them it is free', () => {
    expect(classBusy(base, at('10:10', '2026-11-14')).busy).toBe(true)
    const noWeekend = { ...base, lesson: { ...base.lesson, weekendStudy: false } }
    expect(classBusy(noWeekend, at('10:10', '2026-11-14'))).toEqual({ busy: false })
  })
  test('joins windows that run into each other', () => {
    const config = {
      ...base,
      slots: { ...base.slots, afternoon: { label: '下午班', start: '10:40', end: '11:10' } },
    }
    const r = classBusy(config, at('10:20'))
    expect(r.busy).toBe(true)
    if (r.busy) expect(r.freeAt).toEqual(later(at('11:11'), STAGGER_MS))
  })
})

describe('runClassBusy', () => {
  const run = (hhmm: string) => {
    const lines: string[] = []
    const code = runClassBusy({ SCHOOL_CONFIG: 'config/school.example.json' }, { now: () => at(hhmm) }, { log: (m) => lines.push(m), error: (m) => lines.push(m) })
    return { code, lines }
  }
  test('exits 0 when free and 3 with the earliest free time when busy', () => {
    expect(run('12:00').code).toBe(0)
    const busy = run('10:05')
    expect(busy.code).toBe(3)
    expect(busy.lines.join('\n')).toContain('11月10日 10:31')
  })
  test('exits 1 when the config cannot be read', () => {
    const lines: string[] = []
    const code = runClassBusy({ SCHOOL_CONFIG: 'nope.json' }, { now: () => at('10:00') }, { log: () => {}, error: (m) => lines.push(m) })
    expect(code).toBe(1)
  })
})
