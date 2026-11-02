import { describe, expect, test } from 'vitest'
import { addDaysToDate, isDateText, isoWeekday, startOfLocalDay } from '../../src/shared/local-time.js'

const at = (iso: string) => new Date(iso)
const start = (iso: string, timeZone: string, daysBack?: number) => startOfLocalDay(at(iso), timeZone, daysBack).toISOString()

describe('startOfLocalDay', () => {
  test('is the local midnight that began the day of the moment', () => {
    expect(start('2026-11-03T05:00:00+08:00', 'Asia/Shanghai')).toBe('2026-11-02T16:00:00.000Z')
    // 20:00 UTC on 2 November is already 3 November in Beijing.
    expect(start('2026-11-02T20:00:00Z', 'Asia/Shanghai')).toBe('2026-11-02T16:00:00.000Z')
  })

  test('midnight itself starts its day; a millisecond earlier is still the day before', () => {
    expect(start('2026-11-03T00:00:00+08:00', 'Asia/Shanghai')).toBe('2026-11-02T16:00:00.000Z')
    expect(start('2026-11-02T23:59:59.999+08:00', 'Asia/Shanghai')).toBe('2026-11-01T16:00:00.000Z')
  })

  test('goes back whole calendar days, across month ends', () => {
    expect(start('2026-11-03T05:00:00+08:00', 'Asia/Shanghai', 1)).toBe('2026-11-01T16:00:00.000Z')
    expect(start('2026-11-03T05:00:00+08:00', 'Asia/Shanghai', 30)).toBe('2026-10-03T16:00:00.000Z')
    expect(start('2026-03-01T12:00:00+08:00', 'Asia/Shanghai', 1)).toBe('2026-02-27T16:00:00.000Z')
  })

  test('follows the given timezone', () => {
    // 02:00 UTC on 3 November is still the evening of 2 November in New York (EST, UTC-5).
    expect(start('2026-11-03T02:00:00Z', 'America/New_York')).toBe('2026-11-02T05:00:00.000Z')
    expect(start('2026-11-03T02:00:00Z', 'UTC')).toBe('2026-11-03T00:00:00.000Z')
  })

  test('counts calendar days across a daylight saving change, not 24-hour periods', () => {
    // New York leaves daylight saving time at 02:00 on 1 November 2026: that day is 25 hours long.
    expect(start('2026-11-01T15:00:00Z', 'America/New_York')).toBe('2026-11-01T04:00:00.000Z') // EDT midnight
    expect(start('2026-11-02T15:00:00Z', 'America/New_York')).toBe('2026-11-02T05:00:00.000Z') // EST midnight
    expect(start('2026-11-02T15:00:00Z', 'America/New_York', 1)).toBe('2026-11-01T04:00:00.000Z')
    // It enters daylight saving time at 02:00 on 8 March 2026: that day is 23 hours long.
    expect(start('2026-03-08T18:00:00Z', 'America/New_York')).toBe('2026-03-08T05:00:00.000Z')
    expect(start('2026-03-09T18:00:00Z', 'America/New_York', 1)).toBe('2026-03-08T05:00:00.000Z')
  })

  test('a day whose midnight is skipped by daylight saving time starts at its first instant', () => {
    // Santiago skips from 00:00 to 01:00 on 6 September 2026, so that day begins at 01:00 (UTC-3).
    expect(start('2026-09-06T15:00:00Z', 'America/Santiago')).toBe('2026-09-06T04:00:00.000Z')
    expect(start('2026-09-07T15:00:00Z', 'America/Santiago', 1)).toBe('2026-09-06T04:00:00.000Z')
  })
})

describe('calendar dates', () => {
  test('isDateText accepts real YYYY-MM-DD dates only', () => {
    expect(isDateText('2026-11-02')).toBe(true)
    expect(isDateText('2028-02-29')).toBe(true)
    for (const bad of ['2026-02-29', '2026-13-01', '2026-00-10', '2026-11-31', '2026-1-2', '20261102', '2026-11-02T00:00', ' 2026-11-02', '']) {
      expect(isDateText(bad), bad).toBe(false)
    }
  })

  test('isoWeekday counts Monday as 1 and Sunday as 7', () => {
    expect(isoWeekday('2026-11-02')).toBe(1)
    expect(isoWeekday('2026-11-04')).toBe(3)
    expect(isoWeekday('2026-11-07')).toBe(6)
    expect(isoWeekday('2026-11-08')).toBe(7)
    expect(isoWeekday('2000-01-01')).toBe(6)
  })

  test('addDaysToDate moves by calendar days across month and year ends', () => {
    expect(addDaysToDate('2026-11-02', 4)).toBe('2026-11-06')
    expect(addDaysToDate('2026-11-02', -2)).toBe('2026-10-31')
    expect(addDaysToDate('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDaysToDate('2028-03-01', -1)).toBe('2028-02-29')
    expect(addDaysToDate('2026-11-02', 0)).toBe('2026-11-02')
  })

  test('refuse something that is not a date', () => {
    expect(() => isoWeekday('2026-02-30')).toThrow(/2026-02-30/)
    expect(() => addDaysToDate('tomorrow', 1)).toThrow(/tomorrow/)
  })
})
