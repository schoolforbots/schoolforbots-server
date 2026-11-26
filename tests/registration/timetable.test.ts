import { Value } from 'typebox/value'
import { afterEach, describe, expect, test } from 'vitest'
import { TimetableResult } from '../../src/protocol/http.js'
import type { Division, SchoolConfig } from '../../src/shared/config.js'
import { setMaintenance } from '../../src/shared/maintenance.js'
import { buildTestApp, exampleConfig } from '../helpers/app.js'
import { insertClass, insertLesson, insertSession, insertStudent } from '../helpers/factories.js'

// The example school: Asia/Shanghai, morning 10:00–10:30, afternoon 15:00–15:30, evening 20:00–20:30, the doors open
// 15 minutes before, weekend study halls, lessons written 7 days ahead. 2026-11-23 is a Monday.

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

async function timetable(query = '') {
  const res = await t.app.inject({ method: 'GET', url: `/v1/timetable${query}` })
  expect(res.statusCode).toBe(200)
  const body = res.json()
  expect(Value.Check(TimetableResult, body)).toBe(true)
  return { body, headers: res.headers, raw: res.body }
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
const PREPARING_DAY = (date: string) => ({
  date,
  kind: 'lesson',
  holiday: null,
  slots: SLOTS(date),
  divisions: [PREPARING('primary'), PREPARING('junior'), PREPARING('senior')],
})
const STUDY_DAY = (date: string) => ({
  date,
  kind: 'study',
  holiday: null,
  slots: SLOTS(date),
  divisions: [STUDY('primary'), STUDY('junior'), STUDY('senior')],
})

describe('GET /v1/timetable', () => {
  test('gives 14 days from today, only the approved lessons, readable from any site', async () => {
    await school('2026-11-23T21:00:00+08:00')
    await insertLesson(t.db, { date: '2026-11-23', division: 'primary', subject: '科学', title: '为什么秋天叶子会变黄' })
    await insertLesson(t.db, { date: '2026-11-24', division: 'senior', subject: '历史', title: '丝绸之路' })
    await insertLesson(t.db, {
      date: '2026-11-24',
      division: 'junior',
      subject: '数学',
      title: '还没审过的题目',
      approvedAt: null,
      segments: [{ text: '还没审过的正文', gist: '还没审过的要点' }],
    })

    const { body, headers, raw } = await timetable()
    expect(body.today).toBe('2026-11-23')
    expect(body.lessonsPlannedThrough).toBe('2026-11-30')
    expect(body.days.map((d: { date: string }) => d.date)).toEqual([
      '2026-11-23', '2026-11-24', '2026-11-25', '2026-11-26', '2026-11-27', '2026-11-28', '2026-11-29',
      '2026-11-30', '2026-12-01', '2026-12-02', '2026-12-03', '2026-12-04', '2026-12-05', '2026-12-06',
    ])
    // Today is given though its last slot has been dismissed.
    expect(body.days[0]).toEqual({
      date: '2026-11-23',
      kind: 'lesson',
      holiday: null,
      slots: SLOTS('2026-11-23'),
      divisions: [
        { division: 'primary', kind: 'lesson', subject: '科学', title: '为什么秋天叶子会变黄' },
        PREPARING('junior'),
        PREPARING('senior'),
      ],
    })
    expect(body.days[1].divisions).toEqual([
      PREPARING('primary'),
      // Not approved: nothing of it gets out.
      PREPARING('junior'),
      { division: 'senior', kind: 'lesson', subject: '历史', title: '丝绸之路' },
    ])
    expect(raw).not.toContain('还没审过')
    expect(raw).not.toContain('数学')
    // Only the subject and the title: no part of the lesson, nor its questions.
    expect(raw).not.toContain('要点')
    expect(raw).not.toContain('正文')
    expect(body.days[5]).toEqual(STUDY_DAY('2026-11-28'))
    expect(body.days[13]).toEqual(STUDY_DAY('2026-12-06'))
    expect(body.days[11]).toEqual(PREPARING_DAY('2026-12-04'))

    expect(headers['access-control-allow-origin']).toBe('*')
    expect(headers['cache-control']).toBe('public, max-age=60')
  })

  test('an approved lesson past the days lessons are written for is given too', async () => {
    await school('2026-11-23T08:00:00+08:00')
    await insertLesson(t.db, { date: '2026-12-03', division: 'junior', subject: '语文', title: '冬天的诗' })

    const { body } = await timetable()
    expect(body.days[10]).toMatchObject({
      date: '2026-12-03',
      divisions: [PREPARING('primary'), { division: 'junior', subject: '语文', title: '冬天的诗' }, PREPARING('senior')],
    })
  })

  test('days asks for fewer days, from 1 to 14', async () => {
    await school('2026-11-23T08:00:00+08:00')
    expect((await timetable('?days=1')).body.days).toEqual([PREPARING_DAY('2026-11-23')])
    expect((await timetable('?days=14')).body.days).toHaveLength(14)

    for (const days of ['0', '15', '-1', '1.5', 'abc', '']) {
      const res = await t.app.inject({ method: 'GET', url: `/v1/timetable?days=${days}` })
      expect(res.statusCode, days).toBe(400)
      expect(res.json().error.code, days).toBe('invalid_request')
      expect(res.headers['access-control-allow-origin'], days).toBe('*')
      expect(res.headers['cache-control'], days).toBeUndefined()
    }
  })

  test('a division whose classes have already made today a study hall stays one', async () => {
    await school('2026-11-23T12:00:00+08:00')
    const classId = await insertClass(t.db, { division: 'junior', slot: 'morning', classNo: 1 })
    await insertStudent(t.db, { division: 'junior', slot: 'morning', status: 'active', classId })
    await insertSession(t.db, {
      classId,
      date: '2026-11-23',
      slot: 'morning',
      kind: 'study',
      startsAt: new Date('2026-11-23T10:00:00+08:00'),
      endsAt: new Date('2026-11-23T10:30:00+08:00'),
    })
    await insertLesson(t.db, { date: '2026-11-23', division: 'junior', subject: '科学', title: '光的折射' })

    const { body, raw } = await timetable('?days=1')
    expect(body.days[0]).toMatchObject({
      kind: 'lesson',
      divisions: [PREPARING('primary'), STUDY('junior'), PREPARING('senior')],
    })
    expect(raw).not.toContain('光的折射')
    // Nothing about a class or a student.
    expect(raw).not.toContain('classId')
  })

  test('the days the school holds no session are holidays, saying why', async () => {
    await school('2026-11-23T08:00:00+08:00', {
      weekendStudy: false,
      calendar: {
        openingDay: '2026-11-24',
        breaks: [
          { from: '2026-12-01', reopensOn: '2026-12-03', name: '校庆' },
          { from: '2026-12-04', reopensOn: null },
        ],
      },
    })
    const holiday = (date: string, reason: string, name: string | null = null) => ({
      date,
      kind: 'holiday',
      holiday: { reason, name },
      slots: [],
      divisions: [],
    })

    expect((await timetable()).body.days).toEqual([
      holiday('2026-11-23', 'not_started'),
      PREPARING_DAY('2026-11-24'),
      PREPARING_DAY('2026-11-25'),
      PREPARING_DAY('2026-11-26'),
      PREPARING_DAY('2026-11-27'),
      holiday('2026-11-28', 'weekend'),
      holiday('2026-11-29', 'weekend'),
      PREPARING_DAY('2026-11-30'),
      holiday('2026-12-01', 'break', '校庆'),
      holiday('2026-12-02', 'break', '校庆'),
      PREPARING_DAY('2026-12-03'),
      // A break with no name, and no reopening day yet.
      holiday('2026-12-04', 'break'),
      holiday('2026-12-05', 'break'),
      holiday('2026-12-06', 'break'),
    ])
  })

  test('a lesson on a holiday or at the weekend is never given', async () => {
    await school('2026-11-23T08:00:00+08:00', { calendar: { breaks: [{ from: '2026-11-25', reopensOn: '2026-11-26' }] } })
    await insertLesson(t.db, { date: '2026-11-25', division: 'junior', title: '放假那天的课' })
    await insertLesson(t.db, { date: '2026-11-28', division: 'junior', title: '星期六的课' })

    const { body, raw } = await timetable()
    expect(body.days[2]).toMatchObject({ date: '2026-11-25', kind: 'holiday' })
    expect(body.days[5]).toEqual(STUDY_DAY('2026-11-28'))
    expect(raw).not.toContain('的课')
  })

  test('a maintenance does not change the timetable', async () => {
    await school('2026-11-23T08:00:00+08:00')
    await setMaintenance(t.db, { message: '升级', expectedBackAt: null }, t.clock.now())
    await t.maintenance.refresh()

    expect((await timetable('?days=1')).body.days).toEqual([PREPARING_DAY('2026-11-23')])
  })
})
