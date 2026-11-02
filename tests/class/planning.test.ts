import type { Kysely } from 'kysely'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { planSession, subjectForDate } from '../../src/class/planning.js'
import { loadSchoolConfig, type SchoolConfig } from '../../src/shared/config.js'
import type { Database } from '../../src/shared/schema.js'
import { createTestDb } from '../helpers/db.js'
import { insertClass, insertLesson, insertSession } from '../helpers/factories.js'

const exampleConfig = loadSchoolConfig(new URL('../../config/school.example.json', import.meta.url).pathname)

// The week of Monday 2 November 2026.
const MON = '2026-11-02'
const TUE = '2026-11-03'
const WED = '2026-11-04'
const THU = '2026-11-05'
const FRI = '2026-11-06'
const SAT = '2026-11-07'
const SUN = '2026-11-08'
const NEXT_MON = '2026-11-09'
const LAST_FRI = '2026-10-30'

let db: Kysely<Database>
let destroy: () => Promise<void>

beforeEach(async () => {
  ;({ db, destroy } = await createTestDb())
})

afterEach(async () => {
  await destroy()
})

const plan = (p: { date: string; division?: 'primary' | 'junior' | 'senior' }, config: SchoolConfig = exampleConfig) =>
  planSession(db, config, { date: p.date, division: p.division ?? 'junior' })

/** A session of one class on a day, started at `startsAt` (a moment on that day). */
async function startSession(p: {
  classId: number
  date: string
  slot?: 'morning' | 'afternoon' | 'evening'
  kind: 'lesson' | 'study'
  lessonId?: number | null
  startsAt?: string
}): Promise<number> {
  const startsAt = new Date(p.startsAt ?? `${p.date}T10:00:00+08:00`)
  return insertSession(db, {
    classId: p.classId,
    date: p.date,
    slot: p.slot ?? 'morning',
    kind: p.kind,
    lessonId: p.lessonId ?? null,
    startsAt,
    endsAt: new Date(startsAt.getTime() + 30 * 60_000),
  })
}

describe('subjectForDate', () => {
  test('goes Chinese, maths, English, science, humanities from Monday to Friday', () => {
    const subjects = [MON, TUE, WED, THU, FRI].map((d) => subjectForDate(d, 'Asia/Shanghai'))
    expect(subjects).toEqual(['语文', '数学', '英语', '科学', '人文'])
  })

  test('has no subject at the weekend', () => {
    expect(subjectForDate(SAT, 'Asia/Shanghai')).toBeNull()
    expect(subjectForDate(SUN, 'Asia/Shanghai')).toBeNull()
  })

  test('names the same subject to a school in any time zone', () => {
    expect(subjectForDate(WED, 'America/New_York')).toBe('英语')
    expect(subjectForDate(WED, 'Pacific/Auckland')).toBe('英语')
    expect(subjectForDate(SAT, 'Pacific/Kiritimati')).toBeNull()
  })
})

describe('planSession on a weekday', () => {
  test('teaches the approved lesson of the day and division', async () => {
    const lessonId = await insertLesson(db, { date: WED, division: 'junior', title: '光的折射', subject: '科学' })
    expect(await plan({ date: WED })).toEqual({ kind: 'lesson', lessonId, subject: '科学', title: '光的折射' })
  })

  test('studies when the lesson is still a draft', async () => {
    await insertLesson(db, { date: WED, approvedAt: null })
    expect(await plan({ date: WED })).toEqual({ kind: 'study', weekTitles: [] })
  })

  test('studies when there is no lesson at all', async () => {
    expect(await plan({ date: WED })).toEqual({ kind: 'study', weekTitles: [] })
  })

  test('ignores lessons of other days and other divisions', async () => {
    await insertLesson(db, { date: TUE, division: 'junior' })
    await insertLesson(db, { date: THU, division: 'junior' })
    await insertLesson(db, { date: WED, division: 'senior' })
    await insertLesson(db, { date: WED, division: 'primary' })
    expect(await plan({ date: WED, division: 'junior' })).toEqual({ kind: 'study', weekTitles: [] })
    const seniorLesson = await insertLesson(db, { date: THU, division: 'senior', title: '高中的课' })
    expect(await plan({ date: THU, division: 'senior' })).toMatchObject({ kind: 'lesson', lessonId: seniorLesson })
  })

  test('a weekday study session lists no titles, whatever else is approved that week', async () => {
    await insertLesson(db, { date: MON, title: '周一的课' })
    expect(await plan({ date: WED })).toEqual({ kind: 'study', weekTitles: [] })
  })

  test('does not read the day from the server time zone', async () => {
    // Wednesday for the school in every time zone: the date is a calendar day, not an instant.
    const lessonId = await insertLesson(db, { date: WED, title: '周三的课' })
    expect(await plan({ date: WED }, { ...exampleConfig, timezone: 'Pacific/Kiritimati' })).toMatchObject({
      kind: 'lesson',
      lessonId,
    })
    expect(await plan({ date: WED }, { ...exampleConfig, timezone: 'America/Los_Angeles' })).toMatchObject({
      kind: 'lesson',
      lessonId,
    })
  })
})

describe('planSession at the weekend', () => {
  test('studies and lists the approved titles of this week, Monday to Friday, in date order', async () => {
    // Inserted out of order on purpose.
    await insertLesson(db, { date: THU, title: '周四' })
    await insertLesson(db, { date: MON, title: '周一' })
    await insertLesson(db, { date: FRI, title: '周五' })
    await insertLesson(db, { date: TUE, title: '周二' })
    await insertLesson(db, { date: WED, title: '周三（草稿）', approvedAt: null })
    // Not this week, or not this division.
    await insertLesson(db, { date: LAST_FRI, title: '上周五' })
    await insertLesson(db, { date: NEXT_MON, title: '下周一' })
    await insertLesson(db, { date: TUE, division: 'senior', title: '高中周二' })

    const expected = { kind: 'study', weekTitles: ['周一', '周二', '周四', '周五'] }
    expect(await plan({ date: SAT })).toEqual(expected)
    expect(await plan({ date: SUN })).toEqual(expected)
  })

  test('studies even when a lesson is approved for the Saturday itself', async () => {
    await insertLesson(db, { date: SAT, title: '周六的课' })
    await insertLesson(db, { date: FRI, title: '周五' })
    expect(await plan({ date: SAT })).toEqual({ kind: 'study', weekTitles: ['周五'] })
  })

  test('lists no titles when weekend study is switched off', async () => {
    await insertLesson(db, { date: FRI, title: '周五' })
    const config = { ...exampleConfig, lesson: { ...exampleConfig.lesson, weekendStudy: false } }
    expect(await plan({ date: SAT }, config)).toEqual({ kind: 'study', weekTitles: [] })
    expect(await plan({ date: SUN }, config)).toEqual({ kind: 'study', weekTitles: [] })
  })

  test('lists an empty week as no titles', async () => {
    expect(await plan({ date: SUN })).toEqual({ kind: 'study', weekTitles: [] })
  })

  test('the week of a Sunday reaches back to its own Monday across a month end', async () => {
    // Sunday 1 November 2026: the week began on Monday 26 October.
    await insertLesson(db, { date: '2026-10-26', title: '十月二十六' })
    await insertLesson(db, { date: '2026-10-30', title: '十月三十' })
    await insertLesson(db, { date: MON, title: '十一月二' })
    expect(await plan({ date: '2026-11-01' })).toEqual({ kind: 'study', weekTitles: ['十月二十六', '十月三十'] })
  })
})

describe('planSession keeps the day decided by its first class', () => {
  test('a morning self-study stays a self-study when the lesson is approved before the afternoon', async () => {
    const lessonId = await insertLesson(db, { date: WED, approvedAt: null })
    const morning = await insertClass(db, { classNo: 1, slot: 'morning' })
    expect(await plan({ date: WED })).toEqual({ kind: 'study', weekTitles: [] })
    await startSession({ classId: morning, date: WED, kind: 'study' })

    await db.updateTable('lessons').set({ approvedAt: new Date(`${WED}T12:00:00+08:00`) }).where('id', '=', lessonId).execute()

    expect(await plan({ date: WED })).toEqual({ kind: 'study', weekTitles: [] })
  })

  test('a morning lesson stays the lesson of the day, and that same lesson', async () => {
    const lessonId = await insertLesson(db, { date: WED, title: '早上讲的课', subject: '英语' })
    const morning = await insertClass(db, { classNo: 1, slot: 'morning' })
    await startSession({ classId: morning, date: WED, kind: 'lesson', lessonId })

    // Even if it is pulled back to a draft afterwards, the afternoon and evening classes teach it too.
    await db.updateTable('lessons').set({ approvedAt: null }).where('id', '=', lessonId).execute()

    expect(await plan({ date: WED })).toEqual({ kind: 'lesson', lessonId, subject: '英语', title: '早上讲的课' })
  })

  test('a weekend self-study that was decided keeps listing the week titles', async () => {
    await insertLesson(db, { date: FRI, title: '周五' })
    const morning = await insertClass(db, { classNo: 1, slot: 'morning' })
    await startSession({ classId: morning, date: SAT, kind: 'study' })
    expect(await plan({ date: SAT })).toEqual({ kind: 'study', weekTitles: ['周五'] })
  })

  test('any class of the division decides, not only one of the same slot', async () => {
    await insertLesson(db, { date: WED, approvedAt: null })
    const classTwo = await insertClass(db, { classNo: 2, slot: 'evening' })
    await startSession({ classId: classTwo, date: WED, slot: 'evening', kind: 'study' })
    await db.updateTable('lessons').set({ approvedAt: new Date(`${WED}T21:00:00+08:00`) }).execute()
    expect(await plan({ date: WED })).toEqual({ kind: 'study', weekTitles: [] })
  })

  test('another division, or another day, does not decide for this one', async () => {
    const lessonId = await insertLesson(db, { date: WED, division: 'junior', title: '初中周三' })
    const seniorClass = await insertClass(db, { division: 'senior', classNo: 1, slot: 'morning' })
    const juniorClass = await insertClass(db, { division: 'junior', classNo: 1, slot: 'morning' })
    await startSession({ classId: seniorClass, date: WED, kind: 'study' })
    await startSession({ classId: juniorClass, date: TUE, kind: 'study' })
    expect(await plan({ date: WED, division: 'junior' })).toMatchObject({ kind: 'lesson', lessonId })
  })

  test('when sessions disagree, the one that began first decides', async () => {
    const lessonId = await insertLesson(db, { date: WED, title: '先开的课' })
    const morning = await insertClass(db, { classNo: 1, slot: 'morning' })
    const evening = await insertClass(db, { classNo: 1, slot: 'evening' })
    await startSession({ classId: evening, date: WED, slot: 'evening', kind: 'study', startsAt: `${WED}T20:00:00+08:00` })
    await startSession({ classId: morning, date: WED, kind: 'lesson', lessonId, startsAt: `${WED}T10:00:00+08:00` })
    expect(await plan({ date: WED })).toMatchObject({ kind: 'lesson', lessonId })
  })

  test('refuses a lesson session that names no lesson', async () => {
    const morning = await insertClass(db, { classNo: 1, slot: 'morning' })
    await startSession({ classId: morning, date: WED, kind: 'lesson', lessonId: null })
    await expect(plan({ date: WED })).rejects.toThrow(/lesson/)
  })
})
