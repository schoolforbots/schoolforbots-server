import { describe, expect, test } from 'vitest'
import { startOfLocalDay } from '../../src/shared/local-time.js'

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
