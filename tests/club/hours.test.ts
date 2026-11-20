import { describe, expect, test } from 'vitest'
import { clubClosedAt, clubClosures, clubHours, nextClose } from '../../src/club/hours.js'
import { loadSchoolConfig, type SchoolConfig } from '../../src/shared/config.js'
import { classBusy } from '../../src/tools/class-busy.js'

// The example school: sessions at 10:00, 15:00 and 20:00 on the school's clock (UTC+8), doors 15 minutes before,
// dismissal at minute 30, a closing grace of 60 seconds and closes spread over 2 seconds; study halls at the weekend.
const base = loadSchoolConfig('config/school.example.json')

// 2026-11-10 is a Tuesday, 2026-11-14 a Saturday and 2026-11-16 a Monday.
const at = (hhmm: string, date = '2026-11-10', ss = '00') => new Date(`${date}T${hhmm}:${ss}+08:00`)
const later = (d: Date, ms: number) => new Date(d.getTime() + ms)
/** The end of a session's window in the example: dismissal, the closing grace and the 2 seconds of spread closes. */
const endOf = (hhmm: string, date = '2026-11-10') => at(hhmm, date, '02')
const closure = (startsAt: Date, endsAt: Date) => ({ startsAt, endsAt })

const withCalendar = (calendar: SchoolConfig['calendar'], club: Partial<SchoolConfig['club']> = {}): SchoolConfig => ({
  ...base,
  calendar,
  club: { ...base.club, ...club },
})
const withLesson = (lesson: Partial<SchoolConfig['lesson']>, slots: Partial<SchoolConfig['slots']> = {}): SchoolConfig => ({
  ...base,
  lesson: { ...base.lesson, ...lesson },
  slots: { ...base.slots, ...slots },
})

describe('a school day', () => {
  test('closes the clubs from the doors of each session to the end of its closing', () => {
    expect(clubClosures(base, at('09:00'))).toEqual([
      closure(at('09:45'), endOf('10:31')),
      closure(at('14:45'), endOf('15:31')),
      closure(at('19:45'), endOf('20:31')),
    ])
  })

  test('is closed from the first moment of the doors to just before the end', () => {
    expect(clubClosedAt(base, later(at('09:45'), -1))).toEqual({ closed: false })
    expect(clubClosedAt(base, at('09:45'))).toEqual({ closed: true, reopensAt: endOf('10:31') })
    expect(clubClosedAt(base, at('10:12'))).toEqual({ closed: true, reopensAt: endOf('10:31') })
    expect(clubClosedAt(base, later(endOf('10:31'), -1)).closed).toBe(true)
    expect(clubClosedAt(base, endOf('10:31'))).toEqual({ closed: false })
    expect(clubClosedAt(base, at('20:29'))).toEqual({ closed: true, reopensAt: endOf('20:31') })
    expect(clubClosedAt(base, at('23:00'))).toEqual({ closed: false })
  })

  test('a closure going on now starts now in the list', () => {
    expect(clubClosures(base, at('10:00'))[0]).toEqual(closure(at('10:00'), endOf('10:31')))
  })

  test('the list covers 24 hours: a closure that starts within them and goes on past them ends with them', () => {
    const list = clubClosures(base, at('09:50'))
    expect(list).toEqual([
      closure(at('09:50'), endOf('10:31')),
      closure(at('14:45'), endOf('15:31')),
      closure(at('19:45'), endOf('20:31')),
      closure(at('09:45', '2026-11-11'), at('09:50', '2026-11-11')),
    ])
    // One that starts just as the 24 hours end is not in it.
    expect(clubClosures(base, at('09:45'))).toHaveLength(3)
  })
})

describe('the weekend', () => {
  test('with study halls the clubs close for them as on a weekday', () => {
    expect(clubClosedAt(base, at('10:10', '2026-11-14'))).toEqual({ closed: true, reopensAt: endOf('10:31', '2026-11-14') })
    expect(clubClosures(base, at('00:00', '2026-11-14'))).toHaveLength(3)
  })

  test('without them the clubs are open all weekend', () => {
    const config = withLesson({ weekendStudy: false })
    expect(clubClosedAt(config, at('10:10', '2026-11-14'))).toEqual({ closed: false })
    expect(clubClosures(config, at('00:00', '2026-11-14'))).toEqual([])
    // Sunday noon: the next 24 hours reach Monday's first session.
    expect(clubClosures(config, at('12:00', '2026-11-15'))).toEqual([closure(at('09:45', '2026-11-16'), endOf('10:31', '2026-11-16'))])
  })
})

describe('breaks and the time before term', () => {
  const breakWeek = { breaks: [{ from: '2026-11-09', reopensOn: '2026-11-16', name: '假期' }] }

  test('on a break the clubs are open all day, and close again for the first session back', () => {
    const config = withCalendar(breakWeek)
    expect(clubClosedAt(config, at('10:10'))).toEqual({ closed: false })
    expect(clubClosures(config, at('00:00'))).toEqual([])
    expect(clubClosures(config, at('12:00', '2026-11-15'))).toEqual([closure(at('09:45', '2026-11-16'), endOf('10:31', '2026-11-16'))])
  })

  test('before the opening day the clubs are open, by default', () => {
    const config = withCalendar({ openingDay: '2026-11-16', breaks: [] })
    expect(config.club.openBeforeTerm).toBe(true)
    expect(clubClosedAt(config, at('10:10'))).toEqual({ closed: false })
    expect(clubClosures(config, at('00:00'))).toEqual([])
  })

  test('with openBeforeTerm false they stay closed until the opening day', () => {
    const config = withCalendar({ openingDay: '2026-11-16', breaks: [] }, { openBeforeTerm: false })
    expect(clubClosedAt(config, at('10:10'))).toEqual({ closed: true, reopensAt: at('00:00', '2026-11-16') })
    expect(clubClosures(config, at('10:00'))).toEqual([closure(at('10:00'), at('10:00', '2026-11-11'))])
    expect(nextClose(config, at('10:00'))).toEqual(at('10:00'))
    // The day before: closed to midnight, then the first session.
    expect(clubClosures(config, at('12:00', '2026-11-15'))).toEqual([
      closure(at('12:00', '2026-11-15'), at('00:00', '2026-11-16')),
      closure(at('09:45', '2026-11-16'), endOf('10:31', '2026-11-16')),
    ])
    // From the opening day on, the timetable as usual.
    expect(clubClosedAt(config, at('08:00', '2026-11-16'))).toEqual({ closed: false })
  })

  test('openBeforeTerm false changes nothing without an opening day', () => {
    const config = withCalendar(undefined, { openBeforeTerm: false })
    expect(clubClosedAt(config, at('12:00'))).toEqual({ closed: false })
    expect(clubClosures(config, at('09:00'))).toEqual(clubClosures(base, at('09:00')))
  })
})

describe('windows across midnight and windows that run into each other', () => {
  test('a session late in the evening closes the clubs into the next day', () => {
    const config = withLesson({}, { evening: { label: '晚班', start: '23:50', end: '00:20' } })
    const reopensAt = at('00:21', '2026-11-11', '02')
    expect(clubClosedAt(config, at('23:40'))).toEqual({ closed: true, reopensAt })
    expect(clubClosedAt(config, at('00:10', '2026-11-11'))).toEqual({ closed: true, reopensAt })
    expect(clubClosures(config, at('00:10', '2026-11-11'))[0]).toEqual(closure(at('00:10', '2026-11-11'), reopensAt))
  })

  test('the window of the last session before a break still closes the clubs after midnight', () => {
    const config: SchoolConfig = {
      ...withLesson({}, { evening: { label: '晚班', start: '23:50', end: '00:20' } }),
      calendar: { breaks: [{ from: '2026-11-11', reopensOn: '2026-11-16' }] },
    }
    expect(clubClosedAt(config, at('00:10', '2026-11-11')).closed).toBe(true)
    expect(clubClosedAt(config, at('10:10', '2026-11-11'))).toEqual({ closed: false })
  })

  test('overlapping windows are one closure', () => {
    const config = withLesson({}, { afternoon: { label: '下午班', start: '10:40', end: '11:10' } })
    expect(clubClosures(config, at('09:00'))).toEqual([
      closure(at('09:45'), endOf('11:11')),
      closure(at('19:45'), endOf('20:31')),
    ])
    expect(clubClosedAt(config, at('10:00'))).toEqual({ closed: true, reopensAt: endOf('11:11') })
  })

  test('windows that only touch are one closure too', () => {
    const config = withLesson(
      { doorsOpenMinutesBefore: 0, closingGraceSeconds: 0, staggerMillis: 0 },
      { afternoon: { label: '下午班', start: '10:30', end: '11:00' } },
    )
    expect(clubClosures(config, at('09:00'))[0]).toEqual(closure(at('10:00'), at('11:00')))
    expect(clubClosedAt(config, at('10:15'))).toEqual({ closed: true, reopensAt: at('11:00') })
  })
})

describe('nextClose', () => {
  test('is the start of the next closure, or now when the clubs are closed', () => {
    expect(nextClose(base, at('09:00'))).toEqual(at('09:45'))
    expect(nextClose(base, at('10:00'))).toEqual(at('10:00'))
    expect(nextClose(base, at('21:00'))).toEqual(at('09:45', '2026-11-11'))
  })

  test('looks past a break within the days lessons are prepared for', () => {
    const config = withCalendar({ breaks: [{ from: '2026-11-11', reopensOn: '2026-11-16' }] })
    expect(nextClose(config, at('21:00'))).toEqual(at('09:45', '2026-11-16'))
  })

  test('is 7 days away when no closure comes in that time', () => {
    const endless = withCalendar({ breaks: [{ from: '2026-11-11', reopensOn: null }] })
    expect(nextClose(endless, at('21:00'))).toEqual(later(at('21:00'), 7 * 24 * 60 * 60 * 1000))
    const long = withCalendar({ breaks: [{ from: '2026-11-11', reopensOn: '2026-12-31' }] })
    expect(nextClose(long, at('21:00'))).toEqual(later(at('21:00'), 7 * 24 * 60 * 60 * 1000))
  })
})

describe('agrees with classBusy', () => {
  // classBusy, the restart tool's check, counts at least 15 minutes before a session; the example's doors open 15
  // minutes before, so the two windows are the same there.
  const configs: Array<[string, SchoolConfig]> = [
    ['the example', base],
    ['no study halls at the weekend', withLesson({ weekendStudy: false })],
    ['a break', withCalendar({ breaks: [{ from: '2026-11-12', reopensOn: '2026-11-16' }] })],
    ['sessions that run into each other', withLesson({}, { afternoon: { label: '下午班', start: '10:40', end: '11:10' } })],
  ]
  test.each(configs)('%s: closed whenever classBusy says busy, open again when it says free', (_, config) => {
    // Every 5 minutes from Wednesday to Sunday, and either side of each edge of a closure (and of classBusy's windows,
    // where they are the same).
    const from = at('00:00', '2026-11-11').getTime()
    const until = at('00:00', '2026-11-16').getTime()
    const moments = new Set<number>()
    for (let t = from; t < until; t += 5 * 60_000) moments.add(t)
    for (let t = from; t < until; t += 24 * 60 * 60 * 1000) {
      for (const c of clubClosures(config, new Date(t))) {
        for (const edge of [c.startsAt.getTime(), c.endsAt.getTime()]) [edge - 1, edge].forEach((m) => moments.add(m))
      }
    }
    for (const t of moments) {
      const now = new Date(t)
      const busy = classBusy(config, now)
      const closed = clubClosedAt(config, now)
      if (busy.busy) expect(closed).toEqual({ closed: true, reopensAt: busy.freeAt })
      else expect(closed).toEqual({ closed: false })
    }
  })
})

describe('clubHours', () => {
  test('gives the switch and the closures as ISO times', () => {
    expect(clubHours(base, at('09:00'))).toEqual({
      enabled: true,
      closures: [
        { startsAt: '2026-11-10T01:45:00.000Z', endsAt: '2026-11-10T02:31:02.000Z' },
        { startsAt: '2026-11-10T06:45:00.000Z', endsAt: '2026-11-10T07:31:02.000Z' },
        { startsAt: '2026-11-10T11:45:00.000Z', endsAt: '2026-11-10T12:31:02.000Z' },
      ],
    })
  })

  test('says when the clubs are turned off, and still lists the closures', () => {
    const off = { ...base, club: { ...base.club, enabled: false } }
    const hours = clubHours(off, at('09:00'))
    expect(hours.enabled).toBe(false)
    expect(hours.closures).toHaveLength(3)
  })
})
