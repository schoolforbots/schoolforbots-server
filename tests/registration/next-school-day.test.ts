import { Value } from 'typebox/value'
import { afterEach, describe, expect, test } from 'vitest'
import { NextSchoolDayResult } from '../../src/protocol/http.js'
import type { Division, SchoolConfig, Slot } from '../../src/shared/config.js'
import { setMaintenance } from '../../src/shared/maintenance.js'
import { buildTestApp, exampleConfig } from '../helpers/app.js'
import { insertClass, insertLesson, insertSession, insertStudent } from '../helpers/factories.js'

// The example school: Asia/Shanghai, morning 10:00–10:30, afternoon 15:00–15:30, evening 20:00–20:30, the doors open
// 15 minutes before. 2026-11-23 is a Monday.

type TestApp = Awaited<ReturnType<typeof buildTestApp>>
type Calendar = NonNullable<SchoolConfig['calendar']>

let t: TestApp

afterEach(async () => {
  await t.destroy()
})

async function school(now: string, config: { calendar?: Calendar; weekendStudy?: boolean } = {}): Promise<void> {
  const example = exampleConfig()
  t = await buildTestApp({
    config: {
      calendar: config.calendar ?? example.calendar,
      lesson: { ...example.lesson, weekendStudy: config.weekendStudy ?? example.lesson.weekendStudy },
    },
  })
  t.clock.set(new Date(now))
}

let classNo = 0

async function addClass(division: Division, slot: Slot): Promise<number> {
  const classId = await insertClass(t.db, { division, slot, classNo: ++classNo })
  await insertStudent(t.db, { division, slot, status: 'active', classId })
  return classId
}

async function nextSchoolDay() {
  const res = await t.app.inject({ method: 'GET', url: '/v1/next-school-day' })
  expect(res.statusCode).toBe(200)
  const body = res.json()
  expect(Value.Check(NextSchoolDayResult, body)).toBe(true)
  return { body, headers: res.headers, day: body.day }
}

const at = (date: string, clock: string) => new Date(`${date}T${clock}:00+08:00`).toISOString()

/** The three slots of a day of the example school, as the answer gives them. */
const SLOTS = (date: string) => [
  { slot: 'morning', startsAt: at(date, '10:00'), endsAt: at(date, '10:30'), doorsOpenAt: at(date, '09:45') },
  { slot: 'afternoon', startsAt: at(date, '15:00'), endsAt: at(date, '15:30'), doorsOpenAt: at(date, '14:45') },
  { slot: 'evening', startsAt: at(date, '20:00'), endsAt: at(date, '20:30'), doorsOpenAt: at(date, '19:45') },
]

const PREPARING = (division: Division) => ({ division, kind: 'lesson', subject: null, title: null })
const STUDY = (division: Division) => ({ division, kind: 'study', subject: null, title: null })

describe('GET /v1/next-school-day', () => {
  test('gives the three divisions and the three slots, though no class has students, readable from any site', async () => {
    await school('2026-11-23T08:00:00+08:00')
    await insertLesson(t.db, { date: '2026-11-23', division: 'primary', subject: '科学', title: '为什么秋天叶子会变黄' })
    await insertLesson(t.db, { date: '2026-11-23', division: 'junior', subject: '科学', title: '光的折射', approvedAt: null })

    const { body, headers } = await nextSchoolDay()
    expect(body).toEqual({
      day: {
        date: '2026-11-23',
        kind: 'lesson',
        slots: SLOTS('2026-11-23'),
        divisions: [
          { division: 'primary', kind: 'lesson', subject: '科学', title: '为什么秋天叶子会变黄' },
          // Not approved yet, or not written: being prepared.
          PREPARING('junior'),
          PREPARING('senior'),
        ],
      },
    })
    expect(headers['access-control-allow-origin']).toBe('*')
    expect(headers['cache-control']).toBe('public, max-age=60')
  })

  test('today until its last slot is dismissed, then the next school day', async () => {
    await school('2026-11-23T20:29:59+08:00')
    expect((await nextSchoolDay()).day.date).toBe('2026-11-23')

    t.clock.set(new Date('2026-11-23T20:30:00+08:00'))
    expect((await nextSchoolDay()).day).toMatchObject({ date: '2026-11-24', slots: SLOTS('2026-11-24') })
  })

  test('a weekend day is a study hall for every division; without weekend study halls it is skipped', async () => {
    await school('2026-11-27T21:00:00+08:00')
    // A lesson on a Saturday is never taught.
    await insertLesson(t.db, { date: '2026-11-28', division: 'junior' })
    expect((await nextSchoolDay()).day).toEqual({
      date: '2026-11-28',
      kind: 'study',
      slots: SLOTS('2026-11-28'),
      divisions: [STUDY('primary'), STUDY('junior'), STUDY('senior')],
    })
    await t.destroy()

    await school('2026-11-27T21:00:00+08:00', { weekendStudy: false })
    expect((await nextSchoolDay()).day).toMatchObject({ date: '2026-11-30', kind: 'lesson' })
  })

  test('a division whose classes have already made the day a study hall stays one', async () => {
    await school('2026-11-23T12:00:00+08:00')
    const morning = await addClass('junior', 'morning')
    await insertSession(t.db, {
      classId: morning,
      date: '2026-11-23',
      slot: 'morning',
      kind: 'study',
      startsAt: new Date('2026-11-23T10:00:00+08:00'),
      endsAt: new Date('2026-11-23T10:30:00+08:00'),
    })
    await insertLesson(t.db, { date: '2026-11-23', division: 'junior', subject: '科学', title: '光的折射' })

    expect((await nextSchoolDay()).day).toMatchObject({
      kind: 'lesson',
      divisions: [PREPARING('primary'), STUDY('junior'), PREPARING('senior')],
    })
  })

  test('a break is skipped, however long; null on a break with no reopening day yet', async () => {
    await school('2026-11-23T21:00:00+08:00', { calendar: { breaks: [{ from: '2026-11-24', reopensOn: '2027-02-22' }] } })
    expect((await nextSchoolDay()).day.date).toBe('2027-02-22')
    await t.destroy()

    await school('2026-11-23T12:00:00+08:00', { calendar: { openingDay: '2026-12-01', breaks: [] } })
    expect((await nextSchoolDay()).day.date).toBe('2026-12-01')
    await t.destroy()

    await school('2026-11-23T21:00:00+08:00', { calendar: { breaks: [{ from: '2026-11-24', reopensOn: null }] } })
    expect((await nextSchoolDay()).body).toEqual({ day: null })
  })

  test('a maintenance does not change the day', async () => {
    await school('2026-11-23T12:00:00+08:00')
    await setMaintenance(t.db, { message: '升级', expectedBackAt: null }, t.clock.now())
    await t.maintenance.refresh()

    expect((await nextSchoolDay()).day.date).toBe('2026-11-23')
  })
})
