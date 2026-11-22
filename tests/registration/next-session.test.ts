import { Value } from 'typebox/value'
import { afterEach, describe, expect, test } from 'vitest'
import { NextSessionResult } from '../../src/protocol/http.js'
import type { Division, SchoolConfig, Slot } from '../../src/shared/config.js'
import { setMaintenance } from '../../src/shared/maintenance.js'
import type { StudentStatus } from '../../src/shared/schema.js'
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

/** A class in `slot` of `division`, with one student of each status given (one active student by default); its id. */
async function addClass(division: Division, slot: Slot, statuses: StudentStatus[] = ['active']): Promise<number> {
  const classId = await insertClass(t.db, { division, slot, classNo: ++classNo })
  for (const status of statuses) await insertStudent(t.db, { division, slot, status, classId })
  return classId
}

async function nextSession() {
  const res = await t.app.inject({ method: 'GET', url: '/v1/next-session' })
  expect(res.statusCode).toBe(200)
  const body = res.json()
  expect(Value.Check(NextSessionResult, body)).toBe(true)
  return { body, headers: res.headers, session: body.session }
}

/** The times of a slot on a day of the example school, as the answer gives them. */
function times(date: string, start: string, end: string, doors: string) {
  return {
    date,
    startsAt: new Date(`${date}T${start}:00+08:00`).toISOString(),
    endsAt: new Date(`${date}T${end}:00+08:00`).toISOString(),
    doorsOpenAt: new Date(`${date}T${doors}:00+08:00`).toISOString(),
  }
}

const EVENING = (date: string) => ({ ...times(date, '20:00', '20:30', '19:45'), slot: 'evening' })
const MORNING = (date: string) => ({ ...times(date, '10:00', '10:30', '09:45'), slot: 'morning' })

describe('GET /v1/next-session', () => {
  test('gives the session going on now, from its doors opening to its end, readable from any site', async () => {
    await school('2026-11-23T20:10:00+08:00')
    await addClass('junior', 'evening')
    await insertLesson(t.db, { date: '2026-11-23', division: 'junior', subject: '科学', title: '光的折射' })

    const { body, headers } = await nextSession()
    expect(body).toEqual({
      session: {
        date: '2026-11-23',
        slot: 'evening',
        startsAt: '2026-11-23T12:00:00.000Z',
        endsAt: '2026-11-23T12:30:00.000Z',
        doorsOpenAt: '2026-11-23T11:45:00.000Z',
        inProgress: true,
        kind: 'lesson',
        divisions: [{ division: 'junior', subject: '科学', title: '光的折射' }],
      },
    })
    expect(headers['access-control-allow-origin']).toBe('*')
    expect(headers['cache-control']).toBe('public, max-age=60')

    t.clock.set(new Date('2026-11-23T19:45:00+08:00'))
    expect((await nextSession()).session).toMatchObject({ ...EVENING('2026-11-23'), inProgress: true })

    t.clock.set(new Date('2026-11-23T19:44:59+08:00'))
    expect((await nextSession()).session).toMatchObject({ ...EVENING('2026-11-23'), inProgress: false })
  })

  test('after a slot ends, the next slot that has a class', async () => {
    await school('2026-11-23T10:29:59+08:00')
    await addClass('junior', 'morning')
    await addClass('junior', 'evening')

    expect((await nextSession()).session).toMatchObject({ ...MORNING('2026-11-23'), inProgress: true })

    t.clock.set(new Date('2026-11-23T10:30:00+08:00'))
    expect((await nextSession()).session).toMatchObject({ ...EVENING('2026-11-23'), inProgress: false })
  })

  test('after the last slot of the day, the first one of the next school day', async () => {
    await school('2026-11-23T20:30:00+08:00')
    await addClass('junior', 'morning')
    await addClass('junior', 'evening')

    expect((await nextSession()).session).toMatchObject({ ...MORNING('2026-11-24'), inProgress: false })
  })

  test('a weekend study hall is a session; a weekend without study halls is not', async () => {
    await school('2026-11-27T21:00:00+08:00')
    await addClass('junior', 'evening')
    // A lesson on a Saturday is never taught.
    await insertLesson(t.db, { date: '2026-11-28', division: 'junior' })

    expect((await nextSession()).session).toMatchObject({
      ...EVENING('2026-11-28'),
      kind: 'study',
      divisions: [{ division: 'junior', subject: null, title: null }],
    })
    await t.destroy()

    await school('2026-11-27T21:00:00+08:00', { weekendStudy: false })
    await addClass('junior', 'evening')
    expect((await nextSession()).session).toMatchObject({ ...EVENING('2026-11-30'), kind: 'lesson' })
  })

  test('no session on a break, nor before the opening day', async () => {
    await school('2026-11-23T21:00:00+08:00', { calendar: { breaks: [{ from: '2026-11-24', reopensOn: '2026-11-26' }] } })
    await addClass('junior', 'evening')
    expect((await nextSession()).session).toMatchObject(EVENING('2026-11-26'))
    await t.destroy()

    await school('2026-11-23T12:00:00+08:00', { calendar: { openingDay: '2026-12-01', breaks: [] } })
    await addClass('junior', 'evening')
    expect((await nextSession()).session).toMatchObject(EVENING('2026-12-01'))
  })

  test('under maintenance, the session on now is not in progress: the first one after now is given', async () => {
    await school('2026-11-23T20:10:00+08:00')
    await addClass('junior', 'evening')
    await setMaintenance(t.db, { message: '服务器升级中', expectedBackAt: null }, new Date('2026-11-23T20:05:00+08:00'))
    await t.maintenance.refresh()
    expect((await nextSession()).session).toMatchObject({ ...EVENING('2026-11-24'), inProgress: false })

    // The doors are open, but the session has not started: it is the first one after now, not in progress.
    t.clock.set(new Date('2026-11-23T19:50:00+08:00'))
    expect((await nextSession()).session).toMatchObject({ ...EVENING('2026-11-23'), inProgress: false })
  })

  test('under maintenance with an expected end, the first session that starts after it', async () => {
    await school('2026-11-23T20:10:00+08:00')
    await addClass('junior', 'evening')
    await setMaintenance(
      t.db,
      { message: '服务器升级中', expectedBackAt: new Date('2026-11-25T20:00:00+08:00') },
      new Date('2026-11-23T20:05:00+08:00'),
    )
    await t.maintenance.refresh()
    expect((await nextSession()).session).toMatchObject({ ...EVENING('2026-11-25'), inProgress: false })

    // An expected end already past counts from now.
    t.clock.set(new Date('2026-11-25T20:10:00+08:00'))
    expect((await nextSession()).session).toMatchObject({ ...EVENING('2026-11-26'), inProgress: false })
  })

  test('a lesson day gives the approved lessons only; one not approved, or not written, is being prepared', async () => {
    await school('2026-11-23T12:00:00+08:00')
    await addClass('primary', 'evening')
    await addClass('junior', 'evening')
    await addClass('senior', 'evening')
    await insertLesson(t.db, { date: '2026-11-23', division: 'primary', subject: '科学', title: '为什么秋天叶子会变黄' })
    await insertLesson(t.db, { date: '2026-11-23', division: 'junior', subject: '科学', title: '光的折射', approvedAt: null })

    expect((await nextSession()).session).toMatchObject({
      kind: 'lesson',
      divisions: [
        { division: 'primary', subject: '科学', title: '为什么秋天叶子会变黄' },
        { division: 'junior', subject: null, title: null },
        { division: 'senior', subject: null, title: null },
      ],
    })
  })

  test('a day the class service has already made a study hall stays one, though a lesson is approved since', async () => {
    await school('2026-11-23T12:00:00+08:00')
    const morning = await addClass('junior', 'morning')
    await addClass('junior', 'evening')
    await insertSession(t.db, {
      classId: morning,
      date: '2026-11-23',
      slot: 'morning',
      kind: 'study',
      startsAt: new Date('2026-11-23T10:00:00+08:00'),
      endsAt: new Date('2026-11-23T10:30:00+08:00'),
    })
    await insertLesson(t.db, { date: '2026-11-23', division: 'junior', subject: '科学', title: '光的折射' })

    expect((await nextSession()).session).toMatchObject({
      ...EVENING('2026-11-23'),
      kind: 'study',
      divisions: [{ division: 'junior', subject: null, title: null }],
    })
  })

  test('only the divisions with a class that has students in it, in order', async () => {
    await school('2026-11-23T12:00:00+08:00')
    await addClass('senior', 'evening')
    await addClass('primary', 'evening', ['suspended'])
    // Students who are not in the class any more, or not yet.
    await addClass('junior', 'evening', ['dropped', 'expelled', 'pending', 'waitlisted'])
    // A class of the division in another slot does not put it in this one.
    await addClass('junior', 'morning')

    expect((await nextSession()).session).toMatchObject({
      ...EVENING('2026-11-23'),
      divisions: [
        { division: 'primary', subject: null, title: null },
        { division: 'senior', subject: null, title: null },
      ],
    })
  })

  test('a slot whose classes have no students in them is skipped', async () => {
    await school('2026-11-23T08:00:00+08:00')
    await addClass('junior', 'morning', ['pending', 'dropped'])
    await addClass('primary', 'afternoon', [])
    await addClass('junior', 'evening')

    expect((await nextSession()).session).toMatchObject(EVENING('2026-11-23'))
  })

  test('null when there is no session in the next 30 days', async () => {
    await school('2026-11-23T12:00:00+08:00')
    expect((await nextSession()).body).toEqual({ session: null })
    await t.destroy()

    await school('2026-11-23T21:00:00+08:00', { calendar: { breaks: [{ from: '2026-11-24', reopensOn: '2026-12-23' }] } })
    await addClass('junior', 'evening')
    // 30 days from today (2026-11-23 to 2026-12-22) are all over or on the break.
    expect((await nextSession()).body).toEqual({ session: null })

    t.clock.set(new Date('2026-11-23T12:00:00+08:00'))
    expect((await nextSession()).session).toMatchObject(EVENING('2026-11-23'))
  })
})
