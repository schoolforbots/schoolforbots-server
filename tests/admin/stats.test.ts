import { randomUUID } from 'node:crypto'
import { afterEach, expect, test } from 'vitest'
import { approve, saveDraft, type LessonStoreDeps } from '../../src/lessons/store.js'
import type { Division, SchoolConfig, Slot } from '../../src/shared/config.js'
import type { DisciplineKind, LessonContent, MessageKind, MessageModeration } from '../../src/shared/schema.js'
import { setMaintenance } from '../../src/shared/maintenance.js'
import { setSwitch } from '../../src/shared/switches.js'
import { buildAdminTestApp } from '../helpers/admin.js'
import { exampleConfig } from '../helpers/app.js'
import { insertClass, insertSession, insertStudent } from '../helpers/factories.js'

// Today is Wednesday 2026-11-04, noon school time (UTC+8). Yesterday is Tuesday 11-03; the same day last week is
// Tuesday 10-27; today's is Wednesday 10-28. The 7 days of the curves run from Wednesday 10-28 to yesterday.
const NOW = new Date('2026-11-04T12:00:00+08:00')
const TODAY = '2026-11-04'
const YESTERDAY = '2026-11-03'
const LAST_WEEK = '2026-10-27'
const TODAY_LAST_WEEK = '2026-10-28'
const THURSDAY = '2026-11-05'
const FRIDAY = '2026-11-06'

let t: Awaited<ReturnType<typeof buildAdminTestApp>>
let cookie: string
afterEach(async () => {
  await t.destroy()
})

async function start(config?: SchoolConfig): Promise<void> {
  t = await buildAdminTestApp({ now: NOW, config })
  cookie = await t.session()
}

async function daily(days: string | number | undefined) {
  const query = days === undefined ? '' : `?days=${days}`
  return t.app.inject({ method: 'GET', url: t.url(`api/stats/daily${query}`), headers: { cookie } })
}

/** A moment of a school day, at a school-time clock reading (UTC+8). */
const at = (date: string, time: string) => new Date(`${date}T${time}+08:00`)

let classNo = 0
/** A class of its own and its session on that day and slot (the times do not matter here). */
async function session(date: string, slot: Slot, division: Division = 'junior') {
  const classId = await insertClass(t.db, { division, slot, classNo: ++classNo })
  const startsAt = at(date, '10:00:00')
  const sessionId = await insertSession(t.db, { classId, date, slot, startsAt, endsAt: at(date, '10:30:00') })
  return { sessionId, classId }
}

async function attend(sessionId: number, studentIds: number[], firstSeenAt = new Date()): Promise<void> {
  await t.db
    .insertInto('attendance')
    .values(studentIds.map((studentId) => ({ sessionId, studentId, firstSeenAt })))
    .execute()
}

async function message(
  where: { sessionId: number; classId: number; senderId: number },
  createdAt: Date,
  p: { kind?: MessageKind; moderation?: MessageModeration | null; delivered?: boolean } = {},
): Promise<void> {
  await t.db
    .insertInto('messages')
    .values({
      ...where,
      kind: p.kind ?? 'chat',
      text: '你好',
      moderation: p.moderation ?? null,
      delivered: p.delivered ?? true,
      pluginType: 'test',
      pluginVersion: '0.0.0',
      createdAt,
    })
    .execute()
}

async function record(studentId: number, kind: DisciplineKind, createdAt: Date, revokedAt: Date | null = null) {
  await t.db
    .insertInto('disciplineRecords')
    .values({ studentId, sessionId: null, kind, detail: '{}', createdAt, revokedAt })
    .execute()
}

async function registration(createdAt: Date, verifiedAt: Date | null): Promise<void> {
  await t.db
    .insertInto('registrations')
    .values({
      email: `r${randomUUID()}@example.com`,
      ownerName: '主人',
      aiName: '小鱼',
      division: 'junior',
      slot: 'evening',
      referrerId: null,
      aiId: randomUUID(),
      pluginType: 'test',
      pluginVersion: '0.0.0',
      ip: '127.0.0.1',
      codeHash: 'x',
      expiresAt: new Date(createdAt.getTime() + 600_000),
      createdAt,
      verifiedAt,
      schoolRulesVersion: null,
      schoolRulesAgreedAt: null,
    })
    .execute()
}

async function call(purpose: string, costYuan: string, createdAt: Date): Promise<void> {
  await t.db
    .insertInto('llmCalls')
    .values({
      purpose,
      provider: 'main',
      model: 'example-model',
      inputTokens: 1,
      outputTokens: 1,
      costYuan,
      outcome: 'ok',
      ms: 1,
      createdAt,
    })
    .execute()
}

const zeroSlots = { morning: 0, afternoon: 0, evening: 0 }
const zeroCategories = { sensitive: 0, injection: 0, privacy: 0 }
const zeroCosts = {
  lesson: 0,
  answer: 0,
  comment: 0,
  weekly: 0,
  secondLayerTeacher: 0,
  secondLayerChat: 0,
  wordList: 0,
}
const emptyDay = (date: string) => ({
  date,
  dauBySlot: zeroSlots,
  chat: 0,
  blockedByCategory: zeroCategories,
  blockedBySecondLayer: 0,
  costByPurpose: zeroCosts,
})

test('yesterday, the same day last week and 7 days of curves, counted from a seeded week', async () => {
  await start()
  const s = await Promise.all(Array.from({ length: 6 }, () => insertStudent(t.db)))
  const [s1, s2, s3, s4, s5, s6] = s.map((x) => x.id) as [number, number, number, number, number, number]

  // Yesterday: three students in the morning, two in the evening (one of them also in the morning), one in the
  // afternoon: five different students.
  const morning = await session(YESTERDAY, 'morning')
  const evening = await session(YESTERDAY, 'evening')
  const afternoon = await session(YESTERDAY, 'afternoon', 'primary')
  await attend(morning.sessionId, [s1, s2, s3])
  await attend(evening.sessionId, [s3, s4])
  await attend(afternoon.sessionId, [s5])
  const lastWeek = await session(LAST_WEEK, 'morning')
  await attend(lastWeek.sessionId, [s1, s2])
  const friday = await session('2026-10-30', 'evening')
  await attend(friday.sessionId, [s6])
  // Today's attendance is not in any of the numbers.
  const today = await session(TODAY, 'morning')
  await attend(today.sessionId, [s1])

  // Messages go by the school-time day they were written on.
  const from = (sender: number) => ({ sessionId: morning.sessionId, classId: morning.classId, senderId: sender })
  await message(from(s1), at(YESTERDAY, '00:00:00'))
  await message(from(s1), at(YESTERDAY, '10:05:00'), { kind: 'question' })
  await message(from(s2), at(YESTERDAY, '10:06:00'), { kind: 'answer' })
  await message(from(s2), at(YESTERDAY, '10:07:00'), { moderation: 'sensitive', delivered: false })
  await message(from(s2), at(YESTERDAY, '10:08:00'), { moderation: 'sensitive', delivered: false })
  await message(from(s3), at(YESTERDAY, '10:09:00'), { moderation: 'injection', delivered: false })
  await message(from(s3), at(YESTERDAY, '10:10:00'), { moderation: 'privacy', delivered: false })
  // Held back by the second layer: blocked, though in none of the three categories.
  await message(from(s3), at(YESTERDAY, '20:10:00'), { moderation: 'second_layer', delivered: false })
  await message(from(s3), at(YESTERDAY, '23:59:59'), { kind: 'closing' })
  await message(from(s1), at(TODAY, '00:00:00'))
  await message(from(s1), at(LAST_WEEK, '10:05:00'))
  await message(from(s1), at(LAST_WEEK, '10:06:00'))
  await message(from(s1), at(LAST_WEEK, '10:07:00'), { moderation: 'injection', delivered: false })
  await message(from(s1), at('2026-10-29', '15:00:00'))
  await message(from(s1), at('2026-10-29', '15:01:00'), { moderation: 'privacy', delivered: false })

  await record(s1, 'school_rule', at(YESTERDAY, '10:07:00'))
  await record(s2, 'school_rule', at(YESTERDAY, '20:07:00'))
  await record(s3, 'school_rule', at(YESTERDAY, '20:08:00'), at(TODAY, '09:00:00'))
  await record(s1, 'suspension', at(YESTERDAY, '10:07:00'))
  await record(s3, 'suspension', at(YESTERDAY, '20:08:00'), at(TODAY, '09:00:00'))
  await record(s2, 'expulsion', at(YESTERDAY, '20:07:00'))
  await record(s4, 'parent_notice', at(YESTERDAY, '20:09:00'))
  await record(s4, 'initiations', at(YESTERDAY, '20:09:00'))
  await record(s1, 'school_rule', at(LAST_WEEK, '10:07:00'))

  await registration(at('2026-11-02', '22:00:00'), at(YESTERDAY, '08:00:00'))
  await registration(at(YESTERDAY, '09:00:00'), at(YESTERDAY, '09:05:00'))
  await registration(at(YESTERDAY, '09:30:00'), null)
  await registration(at('2026-11-02', '09:00:00'), at('2026-11-02', '09:01:00'))
  await registration(at(LAST_WEEK, '09:00:00'), at(LAST_WEEK, '09:03:00'))

  await call('lesson', '0.123456', at(YESTERDAY, '00:30:00'))
  await call('answer', '0.200000', at(YESTERDAY, '20:10:00'))
  await call('answer', '0.300000', at(YESTERDAY, '20:20:00'))
  await call('secondLayerChat', '0.000400', at(YESTERDAY, '20:21:00'))
  await call('weekly', '1.500000', at(LAST_WEEK, '00:10:00'))
  await call('comment', '0.250000', at('2026-10-31', '20:10:00'))
  await call('lesson', '0.500000', at(TODAY, '00:30:00'))

  const res = await daily(7)
  expect(res.statusCode).toBe(200)
  const body = res.json()
  expect(body.yesterday).toEqual({
    date: YESTERDAY,
    dau: 5,
    dauBySlot: { morning: 3, afternoon: 1, evening: 2 },
    chat: 9,
    blocked: 5,
    blockedByCategory: { sensitive: 2, injection: 1, privacy: 1 },
    violations: 2,
    suspensions: 1,
    expulsions: 1,
    registrations: 2,
    costYuan: 0.62,
  })
  expect(body.sameDayLastWeek).toEqual({
    date: LAST_WEEK,
    dau: 2,
    dauBySlot: { morning: 2, afternoon: 0, evening: 0 },
    chat: 3,
    blocked: 1,
    blockedByCategory: { sensitive: 0, injection: 1, privacy: 0 },
    violations: 1,
    suspensions: 0,
    expulsions: 0,
    registrations: 1,
    costYuan: 1.5,
  })
  // The month so far: November's calls, today's included; October's are not.
  expect(body.month).toEqual({ costYuan: 1.12, budgetYuan: 300, overBudget: false })

  expect(body.series).toEqual([
    emptyDay('2026-10-28'),
    { ...emptyDay('2026-10-29'), chat: 2, blockedByCategory: { ...zeroCategories, privacy: 1 } },
    { ...emptyDay('2026-10-30'), dauBySlot: { ...zeroSlots, evening: 1 } },
    { ...emptyDay('2026-10-31'), costByPurpose: { ...zeroCosts, comment: 0.25 } },
    emptyDay('2026-11-01'),
    emptyDay('2026-11-02'),
    {
      date: YESTERDAY,
      dauBySlot: { morning: 3, afternoon: 1, evening: 2 },
      chat: 9,
      // With the second layer's one, the five of the day's tile.
      blockedByCategory: { sensitive: 2, injection: 1, privacy: 1 },
      blockedBySecondLayer: 1,
      costByPurpose: { ...zeroCosts, lesson: 0.1235, answer: 0.5, secondLayerChat: 0.0004 },
    },
  ])
})

/** Something of every kind a day's numbers count, at `time` (school time) on `date`, by `student`. */
async function everything(date: string, time: string, student: number): Promise<void> {
  const when = at(date, time)
  const { sessionId, classId } = await session(date, 'morning')
  await attend(sessionId, [student], when)
  const where = { sessionId, classId, senderId: student }
  await message(where, when)
  await message(where, when, { moderation: 'privacy', delivered: false })
  await record(student, 'school_rule', when)
  await record(student, 'suspension', when)
  await record(student, 'expulsion', when)
  await registration(when, when)
  await call('answer', '0.100000', when)
}

/** A day's numbers with `n` of everything `everything` adds, `students` students in the morning. */
const numbersOf = (date: string, n: number, students = n) => ({
  date,
  dau: students,
  dauBySlot: { ...zeroSlots, morning: students },
  chat: 2 * n,
  blocked: n,
  blockedByCategory: { ...zeroCategories, privacy: n },
  violations: n,
  suspensions: n,
  expulsions: n,
  registrations: n,
  costYuan: round2(0.1 * n),
})
const round2 = (n: number) => Math.round(n * 100) / 100

test('today counts up to now, set against the same day last week up to the same time; the curves stop at yesterday', async () => {
  await start()
  const s = await Promise.all(Array.from({ length: 4 }, () => insertStudent(t.db)))
  const [s1, s2, s3, s4] = s.map((x) => x.id) as [number, number, number, number]

  // Today: from its first second on, and later in the day. The last second of yesterday is yesterday's.
  await everything(TODAY, '00:00:00', s1)
  await everything(TODAY, '11:59:59', s2)
  await everything(TODAY, '15:00:00', s3)
  await everything(YESTERDAY, '23:59:59', s4)
  // The same day last week: up to noon, at noon, and in the evening.
  await everything(TODAY_LAST_WEEK, '00:00:00', s1)
  await everything(TODAY_LAST_WEEK, '09:00:00', s2)
  await everything(TODAY_LAST_WEEK, '11:59:59', s3)
  await everything(TODAY_LAST_WEEK, '12:00:00', s4)
  await everything(TODAY_LAST_WEEK, '20:00:00', s1)

  const noon = (await daily(7)).json()
  expect(noon.asOf).toBe(NOW.toISOString())
  expect(noon.todaySoFar).toEqual(numbersOf(TODAY, 2))
  expect(noon.sameTimeLastWeek).toEqual(numbersOf(TODAY_LAST_WEEK, 3))
  // Yesterday's tile is all of yesterday, the same day last week all of it too.
  expect(noon.yesterday).toEqual(numbersOf(YESTERDAY, 1))
  // The curves end with yesterday: today is drawn once it is over. The same day last week has the whole day.
  const series = noon.series as { date: string; chat: number }[]
  expect(series.at(-1)?.date).toBe(YESTERDAY)
  expect(series.map((d) => d.date)).not.toContain(TODAY)
  expect(series.find((d) => d.date === TODAY_LAST_WEEK)?.chat).toBe(10)

  // After the afternoon class the day has grown, and last week's cut has moved with the clock.
  t.clock.set(at(TODAY, '16:30:00'))
  const afternoon = (await daily(7)).json()
  expect(afternoon.asOf).toBe(at(TODAY, '16:30:00').toISOString())
  expect(afternoon.todaySoFar).toEqual(numbersOf(TODAY, 3))
  expect(afternoon.sameTimeLastWeek).toEqual(numbersOf(TODAY_LAST_WEEK, 4))

  // In the last second of the day, all of last week's day is in, and still none of today's curve.
  t.clock.set(at(TODAY, '23:59:59'))
  const late = (await daily(7)).json()
  // s1 came twice that day: four students.
  expect(late.sameTimeLastWeek).toEqual(numbersOf(TODAY_LAST_WEEK, 5, 4))
  expect((late.series as { date: string }[]).at(-1)?.date).toBe(YESTERDAY)
})

test('the same time last week is cut at the same time on the school’s clock, across a daylight saving change', async () => {
  // 04:00 UTC on 11-04 is 20:00 on Tuesday 11-03 in Los Angeles (PST, UTC-8). A week before, Tuesday 10-27, the
  // clocks were still on PDT (UTC-7): the cut is 20:00 PDT, not 21:00 PDT (seven times 24 hours before).
  await start({ ...exampleConfig(), timezone: 'America/Los_Angeles' })
  const student = (await insertStudent(t.db)).id
  const { sessionId, classId } = await session('2026-11-03', 'evening')
  const where = { sessionId, classId, senderId: student }

  // Today in Los Angeles: from its midnight (08:00 UTC), not the second before.
  await message(where, new Date('2026-11-03T07:59:59Z'))
  await message(where, new Date('2026-11-03T08:00:00Z'))
  await message(where, new Date('2026-11-04T03:59:59Z'))
  // The same Tuesday last week: from its midnight (07:00 UTC) up to 20:00 PDT (03:00 UTC on the 28th).
  await message(where, new Date('2026-10-27T06:59:59Z'))
  await message(where, new Date('2026-10-27T07:00:00Z'))
  await message(where, new Date('2026-10-28T02:59:59Z'))
  await message(where, new Date('2026-10-28T03:00:00Z'))
  await message(where, new Date('2026-10-28T03:30:00Z'))

  const body = (await daily(7)).json()
  expect(body.today).toBe('2026-11-03')
  expect(body.todaySoFar).toMatchObject({ date: '2026-11-03', chat: 2 })
  expect(body.sameTimeLastWeek).toMatchObject({ date: '2026-10-27', chat: 2 })
  expect(body.series.at(-1).date).toBe('2026-11-02')
})

test('whether classes are held today: in term, before the opening day, on a break, at the weekend, in maintenance', async () => {
  const example = exampleConfig()
  const calendar = (c: Partial<NonNullable<SchoolConfig['calendar']>>) => ({ ...example, calendar: { breaks: [], ...c } })
  const status = async () => (await daily(7)).json().todayStatus

  await start()
  expect(await status()).toEqual({ state: 'in_term', breakName: null, schoolDay: true, maintenance: false })
  await setMaintenance(t.db, { message: '换服务器', expectedBackAt: null }, at(TODAY, '11:00:00'))
  expect(await status()).toEqual({ state: 'in_term', breakName: null, schoolDay: true, maintenance: true })
  await setMaintenance(t.db, null, at(TODAY, '11:30:00'))
  expect(await status()).toMatchObject({ maintenance: false })
  await t.destroy()

  await start(calendar({ openingDay: THURSDAY }))
  expect(await status()).toEqual({ state: 'not_started', breakName: null, schoolDay: false, maintenance: false })
  await t.destroy()

  await start(calendar({ breaks: [{ from: YESTERDAY, reopensOn: FRIDAY, name: '秋假' }] }))
  expect(await status()).toEqual({ state: 'on_break', breakName: '秋假', schoolDay: false, maintenance: false })
  await t.destroy()

  // Saturday 11-07, with no study halls at the weekend (signed in again: the session of Wednesday has run out).
  await start({ ...example, lesson: { ...example.lesson, weekendStudy: false } })
  t.clock.set(at('2026-11-07', '12:00:00'))
  cookie = await t.session()
  expect(await status()).toEqual({ state: 'in_term', breakName: null, schoolDay: false, maintenance: false })
})

test('the same time last week counts from the opening day itself', async () => {
  const example = exampleConfig()
  await start({ ...example, calendar: { openingDay: TODAY_LAST_WEEK, breaks: [] } })
  const body = (await daily(7)).json()
  // Tuesday 10-27 came before the opening; Wednesday 10-28 was the opening day.
  expect(body.sameDayLastWeek).toBeNull()
  expect(body.sameTimeLastWeek).toEqual(numbersOf(TODAY_LAST_WEEK, 0))
})

test('the curves cover 7, 30 or 90 days, oldest first, and any other number of days is a 400', async () => {
  await start()
  for (const days of [7, 30, 90]) {
    const series = (await daily(days)).json().series as { date: string }[]
    expect(series).toHaveLength(days)
    expect(series.at(-1)?.date).toBe(YESTERDAY)
    expect(series.map((d) => d.date)).toEqual([...series.map((d) => d.date)].sort())
  }
  expect(((await daily(30)).json().series as { date: string }[])[0]?.date).toBe('2026-10-05')
  for (const days of [undefined, 10, 0, 'abc', '7.0', '07']) {
    const res = await daily(days)
    expect(res.statusCode, String(days)).toBe(400)
    expect(res.json().error.code).toBe('invalid_request')
  }
})

test('with nothing recorded every number is zero; the same day last week is null before the school opened', async () => {
  const example = exampleConfig()
  await start({ ...example, calendar: { ...example.calendar, openingDay: '2026-11-02', breaks: [] } })
  const body = (await daily(7)).json()
  expect(body.yesterday).toEqual({
    date: YESTERDAY,
    dau: 0,
    dauBySlot: zeroSlots,
    chat: 0,
    blocked: 0,
    blockedByCategory: zeroCategories,
    violations: 0,
    suspensions: 0,
    expulsions: 0,
    registrations: 0,
    costYuan: 0,
  })
  expect(body.sameDayLastWeek).toBeNull()
  expect(body.todaySoFar).toEqual({ ...body.yesterday, date: TODAY })
  expect(body.sameTimeLastWeek).toBeNull()
  expect(body.month).toEqual({ costYuan: 0, budgetYuan: 300, overBudget: false })
  expect(body.switchChanges).toEqual([])
})

const LESSON: LessonContent = {
  title: '一课',
  subject: '科学',
  segments: Array.from({ length: 5 }, (_, i) => ({ text: `第${i + 1}段`, gist: `要点${i + 1}` })),
  callOnQuestions: { review: '复习题？', extension: '引申题？' },
}

/** A lesson of that day and division: a draft, or approved; a title with a listed word gives it a red mark. */
async function lesson(date: string, division: Division, opts: { approved?: boolean; title?: string } = {}) {
  const store: LessonStoreDeps = { db: t.db, clock: t.clock, moderator: t.moderator }
  const content = { ...LESSON, title: opts.title ?? LESSON.title }
  const { lessonId } = await saveDraft(store, { date, division }, content, { source: 'api', change: 'generate' })
  if (opts.approved === true) await approve(store, lessonId, 1)
  return lessonId
}

/** The example school, with lessons made `horizonDays` days ahead. */
function horizon(horizonDays: number, more: Partial<SchoolConfig> = {}): SchoolConfig {
  const example = exampleConfig()
  return { ...example, lessonGeneration: { ...example.lessonGeneration, horizonDays }, ...more }
}

test('the reminders: lessons not reviewed, failures that lasted into a new day, the budget', async () => {
  const example = exampleConfig()
  // Two days ahead: today (Wednesday), Thursday and Friday. At noon, today's doors have opened.
  await start(horizon(2, { llm: { ...example.llm, monthlyBudgetYuan: 1 } }))
  await lesson(TODAY, 'primary')
  await lesson(TODAY, 'junior', { approved: true })
  await lesson(TODAY, 'senior', { approved: true })
  await lesson(THURSDAY, 'primary', { approved: true })
  await lesson(FRIDAY, 'primary', { title: '示例违禁词' })
  await lesson(FRIDAY, 'junior', { approved: true })
  await lesson(FRIDAY, 'senior', { approved: true })
  const failure = (date: string, division: Division, firstFailedAt: Date) => ({
    date,
    division,
    attempts: 3,
    firstFailedAt,
    lastFailedAt: at(TODAY, '11:00:00'),
    lastError: '大模型的回复里没有找到 JSON',
  })
  await t.db
    .insertInto('lessonGeneration')
    .values([
      // Failing since the last second of yesterday: a reminder. Since the first second of today: not yet.
      failure(THURSDAY, 'junior', at(YESTERDAY, '23:59:59')),
      failure(THURSDAY, 'senior', at(TODAY, '00:00:00')),
      // Days outside the queue.
      failure(YESTERDAY, 'senior', at(LAST_WEEK, '01:00:00')),
      failure('2026-11-20', 'senior', at(LAST_WEEK, '01:00:00')),
    ])
    .execute()
  await call('lesson', '1.500000', at('2026-11-01', '00:30:00'))

  const body = (await daily(7)).json()
  // The doors of the first class of the day open at 09:45 school time (10:00 less 15 minutes), 01:45 UTC.
  expect(body.reminders).toEqual({
    unreviewed: [
      { date: THURSDAY, division: 'junior', deadline: '2026-11-05T01:45:00.000Z' },
      { date: THURSDAY, division: 'senior', deadline: '2026-11-05T01:45:00.000Z' },
      { date: FRIDAY, division: 'primary', deadline: '2026-11-06T01:45:00.000Z' },
    ],
    generationFailed: [{ date: THURSDAY, division: 'junior', attempts: 3, lastError: '大模型的回复里没有找到 JSON' }],
  })
  expect(body.month).toEqual({ costYuan: 1.5, budgetYuan: 1, overBudget: true })
})

test('a lesson not reviewed is a reminder until the doors open, and not once a class of its division has begun the day', async () => {
  // One day ahead: today and Thursday, whose lessons are all approved.
  await start(horizon(1))
  for (const division of ['primary', 'junior', 'senior'] as const) await lesson(THURSDAY, division, { approved: true })
  await lesson(TODAY, 'primary')
  await lesson(TODAY, 'junior', { approved: true })
  await lesson(TODAY, 'senior')
  // A senior class holds a study hall today: the day is decided for the division, whatever is approved later.
  const classId = await insertClass(t.db, { division: 'senior', slot: 'morning', classNo: ++classNo })
  await insertSession(t.db, {
    classId,
    date: TODAY,
    slot: 'morning',
    kind: 'study',
    startsAt: at(TODAY, '10:00:00'),
    endsAt: at(TODAY, '10:30:00'),
  })

  t.clock.set(at(TODAY, '09:44:59'))
  expect((await daily(7)).json().reminders.unreviewed).toEqual([
    { date: TODAY, division: 'primary', deadline: '2026-11-04T01:45:00.000Z' },
  ])
  t.clock.set(at(TODAY, '09:45:00'))
  expect((await daily(7)).json().reminders.unreviewed).toEqual([])
})

test('a reminder is due by the doors of the division\'s first slot with classes, not the school\'s first slot', async () => {
  await start(horizon(1))
  for (const division of ['primary', 'junior', 'senior'] as const) await lesson(THURSDAY, division, { approved: true })
  await lesson(TODAY, 'junior')
  await lesson(TODAY, 'senior')
  // The junior classes meet in the afternoon and the evening; the senior division has no class at all.
  await insertClass(t.db, { division: 'junior', slot: 'evening', classNo: ++classNo })
  await insertClass(t.db, { division: 'junior', slot: 'afternoon', classNo: ++classNo })

  // Noon: the morning doors have opened, the afternoon ones (14:45 school time) have not.
  t.clock.set(at(TODAY, '12:00:00'))
  expect((await daily(7)).json().reminders.unreviewed).toEqual([
    { date: TODAY, division: 'junior', deadline: '2026-11-04T06:45:00.000Z' },
  ])
})

test('the switch changes are the ones made over the days of the curves', async () => {
  await start()
  await setSwitch(t.db, 'teacherLlm', false, at('2026-10-27', '23:59:59'))
  await setSwitch(t.db, 'teacherLlm', true, at('2026-10-28', '00:00:00'))
  await setSwitch(t.db, 'secondLayerChat', true, at(YESTERDAY, '20:00:00'))
  await setSwitch(t.db, 'secondLayerChat', false, at(TODAY, '08:00:00'))

  expect((await daily(7)).json().switchChanges).toEqual([
    { name: 'teacherLlm', on: true, at: at('2026-10-28', '00:00:00').toISOString() },
    { name: 'secondLayerChat', on: true, at: at(YESTERDAY, '20:00:00').toISOString() },
  ])
  expect((await daily(30)).json().switchChanges).toHaveLength(3)
})

test('the answer names the school’s time zone, the clock its times and days are read on, and its today', async () => {
  await start({ ...exampleConfig(), timezone: 'Europe/London' })
  expect((await daily(7)).json()).toMatchObject({ timeZone: 'Europe/London', today: TODAY })
  await t.destroy()
  // Noon in Beijing is still the evening before in Los Angeles.
  await start({ ...exampleConfig(), timezone: 'America/Los_Angeles' })
  expect((await daily(7)).json()).toMatchObject({ timeZone: 'America/Los_Angeles', today: YESTERDAY })
})
