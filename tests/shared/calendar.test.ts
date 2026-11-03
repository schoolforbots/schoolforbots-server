import { describe, expect, test } from 'vitest'
import {
  breakAfter,
  calendarStatus,
  inactivityCutoffDay,
  isOnBreak,
  isSchoolDay,
  nextSchoolDay,
  speechOn,
} from '../../src/shared/calendar.js'
import type { SchoolConfig } from '../../src/shared/config.js'
import { exampleConfig } from '../helpers/app.js'

type Calendar = NonNullable<SchoolConfig['calendar']>

/** The example school with `calendar`, and with or without study halls at the weekend. */
function school(calendar: Calendar, weekendStudy = false): SchoolConfig {
  return exampleConfig({ calendar, lesson: { ...exampleConfig().lesson, weekendStudy } })
}

// December 2026: the 4th is a Friday, the 5th a Saturday, the 7th a Monday; the 21st is a Monday and 4 January 2027 too.
const WINTER_BREAK = { from: '2026-12-21', reopensOn: '2027-01-04', name: '寒假', speech: ['寒假结束啦'] }
const OPENING: Calendar = { openingDay: '2026-12-05', openingSpeech: ['开学啦'], breaks: [WINTER_BREAK] }

// A: no study halls at the weekend; opens on a Saturday, then a winter break.
const A = school(OPENING)
// B: the same, with study halls at the weekend.
const B = school(OPENING, true)
// C: the reopening date is not decided, and the school has always been open.
const C = school({ breaks: [{ from: '2026-12-21', reopensOn: null }] })

describe('a school without a calendar', () => {
  const config = exampleConfig()

  test('is always in term', () => {
    expect(isOnBreak('2020-01-01', config)).toBe(false)
    expect(calendarStatus('2026-12-25', config)).toEqual({ state: 'in_term', breakName: null, reopensOn: null })
    expect(breakAfter('2026-12-18', config)).toBeNull()
    expect(speechOn('2026-12-07', config)).toBeNull()
  })

  test('has school every day when it has study halls at the weekend, and on weekdays when it has not', () => {
    expect(isSchoolDay('2026-12-05', config)).toBe(true)
    expect(isSchoolDay('2026-12-05', school({ breaks: [] }))).toBe(false)
    expect(isSchoolDay('2026-12-07', school({ breaks: [] }))).toBe(true)
    expect(nextSchoolDay('2026-12-05', school({ breaks: [] }))).toBe('2026-12-07')
    expect(nextSchoolDay('2026-12-05', config)).toBe('2026-12-05')
  })

  test('counts back a plain number of days for the inactivity cutoff', () => {
    expect(inactivityCutoffDay('2026-12-10', 30, config)).toBe('2026-11-10')
  })
})

describe('school days', () => {
  test('the days before the opening day are not school days, the opening day is when it is a school day', () => {
    expect(isSchoolDay('2026-12-04', A)).toBe(false)
    expect(isOnBreak('2026-12-04', A)).toBe(true)
    // The opening day is a Saturday, and A has no weekend study.
    expect(isSchoolDay('2026-12-05', A)).toBe(false)
    expect(isOnBreak('2026-12-05', A)).toBe(false)
    expect(isSchoolDay('2026-12-05', B)).toBe(true)
    expect(isSchoolDay('2026-12-07', A)).toBe(true)
  })

  test('a break runs from its first day to the day before the reopening day', () => {
    expect(isSchoolDay('2026-12-18', A)).toBe(true)
    expect(isSchoolDay('2026-12-21', A)).toBe(false)
    expect(isOnBreak('2026-12-21', A)).toBe(true)
    // The last day of the break is a Sunday: a study hall day without the break.
    expect(isSchoolDay('2027-01-03', B)).toBe(false)
    expect(isOnBreak('2027-01-03', B)).toBe(true)
    // The reopening day itself, a Monday, is a school day.
    expect(isSchoolDay('2027-01-04', A)).toBe(true)
    expect(isOnBreak('2027-01-04', A)).toBe(false)
  })

  test('breaks may be listed in any order', () => {
    const later = { from: '2027-02-01', reopensOn: '2027-02-08' }
    const config = school({ breaks: [later, WINTER_BREAK] })
    expect(isOnBreak('2026-12-25', config)).toBe(true)
    expect(isOnBreak('2027-02-03', config)).toBe(true)
    expect(isOnBreak('2027-01-20', config)).toBe(false)
  })
})

describe('nextSchoolDay', () => {
  test('is the day itself when it is a school day', () => {
    expect(nextSchoolDay('2026-12-08', A)).toBe('2026-12-08')
  })

  test('before the school opens, is the first school day from the opening day, not the opening day itself', () => {
    expect(nextSchoolDay('2026-12-01', A)).toBe('2026-12-07')
    expect(nextSchoolDay('2026-12-01', B)).toBe('2026-12-05')
  })

  test('on a break, is the first school day from the reopening day', () => {
    expect(nextSchoolDay('2026-12-25', A)).toBe('2027-01-04')
    // Reopening on a Saturday without weekend study: the Monday.
    const saturday = school({ breaks: [{ from: '2026-12-21', reopensOn: '2027-01-02' }] })
    expect(nextSchoolDay('2026-12-21', saturday)).toBe('2027-01-04')
  })

  test('on a break whose end is not decided, is null', () => {
    expect(nextSchoolDay('2026-12-21', C)).toBeNull()
    expect(nextSchoolDay('2027-03-01', C)).toBeNull()
    // Before that break, school days are found as usual.
    expect(nextSchoolDay('2026-12-18', C)).toBe('2026-12-18')
    // A weekend before it leads straight into it.
    expect(nextSchoolDay('2026-12-19', C)).toBeNull()
  })

  test('skips over breaks that follow each other', () => {
    const chained = school({
      breaks: [
        { from: '2026-12-21', reopensOn: '2026-12-28' },
        { from: '2026-12-28', reopensOn: '2027-01-04' },
      ],
    })
    expect(nextSchoolDay('2026-12-21', chained)).toBe('2027-01-04')
    expect(nextSchoolDay('2026-12-30', chained)).toBe('2027-01-04')
  })

  test('is null when a chain of breaks ends in one that is not decided', () => {
    const chained = school({
      breaks: [
        { from: '2026-12-21', reopensOn: '2026-12-28' },
        { from: '2026-12-28', reopensOn: null },
      ],
    })
    expect(nextSchoolDay('2026-12-21', chained)).toBeNull()
  })

  test('skips a break that begins right at the opening day', () => {
    const config = school({
      openingDay: '2026-12-07',
      breaks: [{ from: '2026-12-07', reopensOn: '2026-12-14' }],
    })
    expect(nextSchoolDay('2026-12-01', config)).toBe('2026-12-14')
  })
})

describe('calendarStatus', () => {
  test('is not_started before the opening day, with the first school day', () => {
    expect(calendarStatus('2026-12-01', A)).toEqual({ state: 'not_started', breakName: null, reopensOn: '2026-12-07' })
    expect(calendarStatus('2026-12-04', A)).toEqual({ state: 'not_started', breakName: null, reopensOn: '2026-12-07' })
  })

  test('is in_term from the opening day until a break', () => {
    expect(calendarStatus('2026-12-05', A).state).toBe('in_term')
    expect(calendarStatus('2026-12-08', A)).toEqual({ state: 'in_term', breakName: null, reopensOn: null })
    expect(calendarStatus('2027-01-04', A).state).toBe('in_term')
  })

  test('is on_break during a break, with its name and the first school day after it', () => {
    expect(calendarStatus('2026-12-21', A)).toEqual({ state: 'on_break', breakName: '寒假', reopensOn: '2027-01-04' })
    expect(calendarStatus('2026-12-25', A)).toEqual({ state: 'on_break', breakName: '寒假', reopensOn: '2027-01-04' })
    expect(calendarStatus('2027-01-03', A).state).toBe('on_break')
  })

  test('has no reopening day when it is not decided, and no name when the break has none', () => {
    expect(calendarStatus('2026-12-21', C)).toEqual({ state: 'on_break', breakName: null, reopensOn: null })
    expect(calendarStatus('2026-12-18', C).state).toBe('in_term')
  })

  test('looks past the break that follows', () => {
    const chained = school({
      breaks: [
        { from: '2026-12-21', reopensOn: '2026-12-28' },
        { from: '2026-12-28', reopensOn: '2027-01-04' },
      ],
    })
    expect(calendarStatus('2026-12-22', chained).reopensOn).toBe('2027-01-04')
    expect(calendarStatus('2026-12-29', chained).reopensOn).toBe('2027-01-04')
  })

  test('has no reopening day when the opening day itself is followed by a break that is not decided', () => {
    const config = school({ openingDay: '2026-12-07', breaks: [{ from: '2026-12-07', reopensOn: null }] })
    expect(calendarStatus('2026-12-01', config)).toEqual({ state: 'not_started', breakName: null, reopensOn: null })
  })
})

describe('speechOn', () => {
  test('the opening speech is for the first school day, not the opening day when that is none', () => {
    expect(speechOn('2026-12-05', A)).toBeNull()
    expect(speechOn('2026-12-07', A)).toEqual(['开学啦'])
    expect(speechOn('2026-12-05', B)).toEqual(['开学啦'])
    expect(speechOn('2026-12-07', B)).toBeNull()
  })

  test('the opening speech is for the day itself only', () => {
    expect(speechOn('2026-12-04', A)).toBeNull()
    expect(speechOn('2026-12-08', A)).toBeNull()
  })

  test('a school that has no opening day has no opening speech', () => {
    expect(speechOn('2026-12-07', exampleConfig({ calendar: { openingSpeech: ['开学啦'], breaks: [] } }))).toBeNull()
  })

  test('the speech of a break is for the first school day after it', () => {
    expect(speechOn('2027-01-04', A)).toEqual(['寒假结束啦'])
    expect(speechOn('2027-01-05', A)).toBeNull()
    expect(speechOn('2026-12-21', A)).toBeNull()
  })

  test('a break reopening at the weekend speaks on the Monday', () => {
    const config = school({ breaks: [{ from: '2026-12-21', reopensOn: '2027-01-02', speech: ['欢迎回来'] }] })
    expect(speechOn('2027-01-02', config)).toBeNull()
    expect(speechOn('2027-01-04', config)).toEqual(['欢迎回来'])
  })

  test('a break without a speech, or without a reopening day, has none', () => {
    expect(speechOn('2027-01-04', school({ breaks: [{ from: '2026-12-21', reopensOn: '2027-01-04' }] }))).toBeNull()
    expect(speechOn('2027-01-04', C)).toBeNull()
  })

  test('of breaks that follow each other, the last one speaks when the school is back', () => {
    const config = school({
      breaks: [
        { from: '2026-12-21', reopensOn: '2026-12-28', speech: ['第一段'] },
        { from: '2026-12-28', reopensOn: '2027-01-04', speech: ['第二段'] },
      ],
    })
    expect(speechOn('2026-12-28', config)).toBeNull()
    expect(speechOn('2027-01-04', config)).toEqual(['第二段'])
  })

  test('the opening speech wins over the speech of a break that ends the same day', () => {
    const config = school({
      openingDay: '2026-12-07',
      openingSpeech: ['开学啦'],
      breaks: [{ from: '2026-12-07', reopensOn: '2026-12-14', speech: ['回来啦'] }],
    })
    expect(speechOn('2026-12-14', config)).toEqual(['开学啦'])
  })
})

describe('breakAfter', () => {
  test('without weekend study, the Friday before a break that starts on Monday announces it', () => {
    expect(breakAfter('2026-12-18', A)).toEqual({ name: '寒假', from: '2026-12-21', reopensOn: '2027-01-04' })
    expect(breakAfter('2026-12-17', A)).toBeNull()
  })

  test('with weekend study, the Sunday before it announces it, and the Friday does not', () => {
    expect(breakAfter('2026-12-18', B)).toBeNull()
    expect(breakAfter('2026-12-19', B)).toBeNull()
    expect(breakAfter('2026-12-20', B)).toEqual({ name: '寒假', from: '2026-12-21', reopensOn: '2027-01-04' })
  })

  test('a break that starts on a day in the middle of the week is announced the day before', () => {
    const config = school({ breaks: [{ from: '2026-12-23', reopensOn: '2027-01-04', name: '寒假' }] })
    expect(breakAfter('2026-12-22', config)).toEqual({ name: '寒假', from: '2026-12-23', reopensOn: '2027-01-04' })
    expect(breakAfter('2026-12-21', config)).toBeNull()
  })

  test('a break that starts at the weekend is announced the Friday before it, when there is no weekend study', () => {
    const config = school({ breaks: [{ from: '2026-12-19', reopensOn: '2027-01-04', name: '寒假' }] })
    expect(breakAfter('2026-12-18', config)).toEqual({ name: '寒假', from: '2026-12-19', reopensOn: '2027-01-04' })
  })

  test('a break that takes no school day away is not announced', () => {
    // Saturday alone: the weekend is a holiday anyway.
    const config = school({ breaks: [{ from: '2026-12-19', reopensOn: '2026-12-20' }] })
    expect(breakAfter('2026-12-18', config)).toBeNull()
  })

  test('a break whose end is not decided is announced with no reopening day, and no name when it has none', () => {
    expect(breakAfter('2026-12-20', C)).toEqual({ name: null, from: '2026-12-21', reopensOn: null })
  })

  test('the reopening day is the first school day after the break, and after one that follows it', () => {
    const chained = school({
      breaks: [
        { from: '2026-12-21', reopensOn: '2026-12-28', name: '寒假' },
        { from: '2026-12-28', reopensOn: '2027-01-02' },
      ],
    })
    expect(breakAfter('2026-12-18', chained)).toEqual({ name: '寒假', from: '2026-12-21', reopensOn: '2027-01-04' })
  })

  test('the day before the opening day announces nothing', () => {
    expect(breakAfter('2026-12-04', A)).toBeNull()
  })
})

describe('inactivityCutoffDay', () => {
  test('without a calendar counts back whole days', () => {
    expect(inactivityCutoffDay('2026-12-10', 30, exampleConfig())).toBe('2026-11-10')
    expect(inactivityCutoffDay('2026-12-10', 1, exampleConfig())).toBe('2026-12-09')
  })

  test('does not count the days of a break', () => {
    // 14 days of winter break: the cutoff moves back by 14 days.
    expect(inactivityCutoffDay('2027-01-20', 30, A)).toBe('2026-12-07')
  })

  test('on a break itself, counts the days before the break', () => {
    expect(inactivityCutoffDay('2026-12-25', 10, A)).toBe('2026-12-11')
  })

  test('counts weekends as days, with or without study halls', () => {
    expect(inactivityCutoffDay('2027-01-20', 30, B)).toBe('2026-12-07')
  })

  test('is null when the days since the opening day do not make up the number of days', () => {
    expect(inactivityCutoffDay('2026-12-20', 30, A)).toBeNull()
    expect(inactivityCutoffDay('2026-12-05', 1, A)).toBeNull()
  })

  test('is the opening day when exactly that many days have passed since it', () => {
    // 12-05 to 12-19: 15 days.
    expect(inactivityCutoffDay('2026-12-20', 15, A)).toBe('2026-12-05')
    expect(inactivityCutoffDay('2026-12-20', 16, A)).toBeNull()
  })

  test('counts the days before a break that is not decided, and the break itself not at all', () => {
    expect(inactivityCutoffDay('2026-12-21', 10, C)).toBe('2026-12-11')
    expect(inactivityCutoffDay('2027-06-01', 10, C)).toBe('2026-12-11')
  })
})
