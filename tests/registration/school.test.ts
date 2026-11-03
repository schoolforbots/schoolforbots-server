import { Value } from 'typebox/value'
import { afterEach, describe, expect, test } from 'vitest'
import { SchoolCalendar } from '../../src/protocol/http.js'
import type { SchoolConfig } from '../../src/shared/config.js'
import { buildTestApp, exampleConfig } from '../helpers/app.js'

type TestApp = Awaited<ReturnType<typeof buildTestApp>>
type Calendar = NonNullable<SchoolConfig['calendar']>

let t: TestApp

afterEach(async () => {
  await t.destroy()
})

/** A school with this calendar, whose clock reads `now` (the helper's default clock is 2 November 2026, noon). */
async function schoolWith(calendar: Calendar | undefined, now?: string, config: { weekendStudy?: boolean } = {}) {
  const lesson = { ...exampleConfig().lesson, ...config }
  t = await buildTestApp({ config: { calendar, lesson } })
  if (now !== undefined) t.clock.set(new Date(now))
}

async function getCalendar() {
  const res = await t.app.inject({ method: 'GET', url: '/v1/school-calendar' })
  expect(res.statusCode).toBe(200)
  expect(Value.Check(SchoolCalendar, res.json())).toBe(true)
  return res.json()
}

// December 2026: the 5th is a Saturday, the 7th a Monday. The example school holds study halls at the weekend.
const WINTER_BREAK = { from: '2026-12-21', reopensOn: '2027-01-04', name: '寒假' }
const OPENING: Calendar = { openingDay: '2026-12-05', breaks: [WINTER_BREAK] }

describe('GET /v1/school-calendar', () => {
  test('needs no key, and a school with no calendar is always in term', async () => {
    await schoolWith(undefined)

    expect(await getCalendar()).toEqual({
      today: '2026-11-02',
      state: 'in_term',
      breakName: null,
      reopensOn: null,
      openingDay: null,
      breaks: [],
    })
  })

  test('before the opening day the school has not started, and says the day it opens', async () => {
    await schoolWith(OPENING)

    expect(await getCalendar()).toEqual({
      today: '2026-11-02',
      state: 'not_started',
      breakName: null,
      reopensOn: '2026-12-05',
      openingDay: '2026-12-05',
      breaks: [{ from: '2026-12-21', reopensOn: '2027-01-04', name: '寒假' }],
    })
  })

  test('in term, from the opening day on: no break name and no reopening day', async () => {
    await schoolWith(OPENING, '2026-12-05T08:00:00+08:00')

    expect(await getCalendar()).toMatchObject({
      today: '2026-12-05',
      state: 'in_term',
      breakName: null,
      reopensOn: null,
      openingDay: '2026-12-05',
      breaks: [{ from: '2026-12-21', reopensOn: '2027-01-04', name: '寒假' }],
    })
  })

  test('on a break with a name: the name and the first school day after it', async () => {
    await schoolWith(OPENING, '2026-12-25T12:00:00+08:00')

    expect(await getCalendar()).toMatchObject({
      today: '2026-12-25',
      state: 'on_break',
      breakName: '寒假',
      reopensOn: '2027-01-04',
      breaks: [{ from: '2026-12-21', reopensOn: '2027-01-04', name: '寒假' }],
    })
  })

  test('a break with no reopening date yet and no name: on break, nothing to say about the return', async () => {
    await schoolWith({ breaks: [{ from: '2026-12-21', reopensOn: null }] }, '2026-12-25T12:00:00+08:00')

    expect(await getCalendar()).toEqual({
      today: '2026-12-25',
      state: 'on_break',
      breakName: null,
      reopensOn: null,
      openingDay: null,
      breaks: [{ from: '2026-12-21', reopensOn: null, name: null }],
    })
  })

  test('the breaks listed are those not over yet, by start day, whatever order the config has them in', async () => {
    const autumn = { from: '2026-10-01', reopensOn: '2026-10-08', name: '国庆假期' }
    const spring = { from: '2027-02-08', reopensOn: null }
    await schoolWith({ breaks: [spring, WINTER_BREAK, autumn] }, '2026-10-07T12:00:00+08:00')
    // The last day of the autumn break, which is still going on.
    expect((await getCalendar()).breaks).toEqual([
      { from: '2026-10-01', reopensOn: '2026-10-08', name: '国庆假期' },
      { from: '2026-12-21', reopensOn: '2027-01-04', name: '寒假' },
      { from: '2027-02-08', reopensOn: null, name: null },
    ])

    // The day the school is back the autumn break is over, and it is gone from the list.
    t.clock.set(new Date('2026-10-08T12:00:00+08:00'))
    expect(await getCalendar()).toMatchObject({
      state: 'in_term',
      breaks: [
        { from: '2026-12-21', reopensOn: '2027-01-04', name: '寒假' },
        { from: '2027-02-08', reopensOn: null, name: null },
      ],
    })

    // Once the winter break is over too, only the one with no end remains.
    t.clock.set(new Date('2027-01-04T12:00:00+08:00'))
    expect((await getCalendar()).breaks).toEqual([{ from: '2027-02-08', reopensOn: null, name: null }])
  })

  test('the day is the school\'s: late evening in UTC is already the next day in Beijing', async () => {
    await schoolWith(OPENING, '2026-12-20T20:00:00Z')

    expect(await getCalendar()).toMatchObject({ today: '2026-12-21', state: 'on_break', breakName: '寒假' })
  })

  test('a reopening day that is no school day is given as the school day after it', async () => {
    // Without study halls at the weekend, a break that ends on Saturday 5 December is over on Monday the 7th.
    const midterm = { from: '2026-11-23', reopensOn: '2026-12-05', name: '期中假' }
    await schoolWith({ breaks: [midterm] }, '2026-11-25T12:00:00+08:00', { weekendStudy: false })

    expect(await getCalendar()).toMatchObject({
      state: 'on_break',
      reopensOn: '2026-12-07',
      breaks: [{ from: '2026-11-23', reopensOn: '2026-12-07', name: '期中假' }],
    })
  })
})
