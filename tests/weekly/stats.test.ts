import type { Kysely } from 'kysely'
import { afterEach, beforeEach, expect, test } from 'vitest'
import type { Division } from '../../src/shared/config.js'
import type {
  Database,
  DisciplineKind,
  LessonChange,
  MessageKind,
  MessageModeration,
  StudentStatus,
} from '../../src/shared/schema.js'
import { lastCompletedWeek, weeklyStats } from '../../src/weekly/stats.js'
import { exampleConfig } from '../helpers/app.js'
import { createTestDb } from '../helpers/db.js'
import { insertClass, insertLesson, insertSession, insertStudent } from '../helpers/factories.js'

// The week under review runs from Monday 26 October to Sunday 1 November 2026, school time (UTC+8). Sunday 25 October
// and Monday 2 November are just outside it.
const WEEK = '2026-10-26'
const BEFORE = '2026-10-25'
const AFTER = '2026-11-02'

const config = exampleConfig()
/** A moment at a school-time clock reading (UTC+8). */
const at = (date: string, time = '20:10:00') => new Date(`${date}T${time}+08:00`)

let db: Kysely<Database>
let destroy: () => Promise<void>
beforeEach(async () => {
  ;({ db, destroy } = await createTestDb())
})
afterEach(async () => {
  await destroy()
})

let classNo = 0
const newClass = (division: Division = 'junior') => insertClass(db, { division, classNo: ++classNo })

async function student(p: {
  plugin?: [string, string]
  status?: StudentStatus
  createdAt?: Date
  queuedAt?: Date
  assignedAt?: Date | null
  lastAttendedAt?: Date | null
  suspendedUntil?: Date | null
}): Promise<number> {
  const { id } = await insertStudent(db, {
    status: p.status ?? 'active',
    createdAt: p.createdAt ?? at('2026-09-01'),
    queuedAt: p.queuedAt,
    assignedAt: p.assignedAt === undefined ? at('2026-09-02') : p.assignedAt,
    lastAttendedAt: p.lastAttendedAt ?? null,
    suspendedUntil: p.suspendedUntil ?? null,
  })
  if (p.plugin !== undefined) {
    await db
      .updateTable('students')
      .set({ pluginType: p.plugin[0], pluginVersion: p.plugin[1] })
      .where('id', '=', id)
      .execute()
  }
  return id
}

async function session(classId: number, date: string, kind: 'lesson' | 'study' = 'lesson'): Promise<number> {
  return insertSession(db, { classId, date, kind, startsAt: at(date, '20:00:00'), endsAt: at(date, '20:30:00') })
}

const seqs = new Map<number, number>()
/** A class event of the session, numbered after the ones before it. */
async function event(sessionId: number, step: string, payload: Record<string, unknown> = {}): Promise<void> {
  const seq = (seqs.get(sessionId) ?? 0) + 1
  seqs.set(sessionId, seq)
  const kind = typeof payload.kind === 'string' ? payload.kind : 'noop'
  await db
    .insertInto('classEvents')
    .values({ sessionId, seq, step, kind, payload: JSON.stringify(payload), createdAt: new Date() })
    .execute()
}

/** Call-on `n` of the session: the student is called on, and answers when `answered`. */
async function callOn(sessionId: number, n: number, studentId: number, answered: boolean): Promise<void> {
  await event(sessionId, `call-on-${n}`, { kind: 'teacher', text: '某某同学，请回答' })
  await event(sessionId, `call-on-${n}#2`, { kind: 'called_on', studentId, displayName: '某某', questionKind: 'review' })
  if (answered) await event(sessionId, `answer-${n}`, { kind: 'answer', studentId, displayName: '某某', text: '答案' })
}

async function attend(sessionId: number, studentId: number, connections = 1): Promise<void> {
  await db.insertInto('attendance').values({ sessionId, studentId, firstSeenAt: new Date(), connections }).execute()
}

async function message(
  where: { sessionId: number; classId: number; senderId: number },
  createdAt: Date,
  p: { kind?: MessageKind; moderation?: MessageModeration | null; rule?: string | null; text?: string } = {},
): Promise<number> {
  const blocked = p.moderation !== undefined && p.moderation !== null
  const row = await db
    .insertInto('messages')
    .values({
      ...where,
      kind: p.kind ?? 'chat',
      text: p.text ?? '你好',
      moderation: p.moderation ?? null,
      matchedTerm: p.rule ?? null,
      delivered: !blocked,
      pluginType: 'test',
      pluginVersion: '0.0.0',
      createdAt,
    })
    .returning('id')
    .executeTakeFirstOrThrow()
  return row.id
}

async function llmCall(purpose: string, createdAt: Date, cost: number, outcome: 'ok' | 'failed' | 'refused' = 'ok') {
  await db
    .insertInto('llmCalls')
    .values({
      purpose,
      provider: 'main',
      model: 'example-model',
      inputTokens: 1,
      outputTokens: 1,
      costYuan: cost,
      outcome,
      ms: 1,
      createdAt,
    })
    .execute()
}

async function version(lessonId: number, n: number, change: LessonChange, createdAt: Date, reason: string | null = null) {
  const content = { title: 't', subject: 's', segments: [], callOnQuestions: null }
  await db
    .insertInto('lessonVersions')
    .values({ lessonId, version: n, content: JSON.stringify(content), change, segmentIndex: null, reason, createdAt })
    .execute()
}

async function record(studentId: number, kind: DisciplineKind, createdAt: Date, revokedAt: Date | null = null) {
  await db
    .insertInto('disciplineRecords')
    .values({ studentId, sessionId: null, kind, detail: '{}', createdAt, revokedAt })
    .execute()
}

test('the week is counted number by number, Monday to Sunday in school time', async () => {
  const j1 = await newClass('junior')
  const j2 = await newClass('junior')
  const p1 = await newClass('primary')
  const s1 = await newClass('senior')

  const a = await student({ plugin: ['openclaw', '1.0'] })
  const b = await student({ plugin: ['openclaw', '1.1'] })
  const c = await student({ plugin: ['other', '2.0'] })
  // Newcomers: first put in a class this week (they joined the queue once, when they registered).
  const n1 = await student({ createdAt: at('2026-10-20'), assignedAt: at(WEEK, '01:00:00') })
  const n2 = await student({ createdAt: at('2026-10-25'), assignedAt: at('2026-10-27', '00:30:00') })
  // Not newcomers: one came back after a drop, one was seated the week before, one the Monday after.
  await student({ createdAt: at('2026-09-01'), queuedAt: at('2026-10-24'), assignedAt: at(WEEK, '01:00:00') })
  await student({ createdAt: at('2026-10-10'), assignedAt: at('2026-10-19', '01:00:00') })
  await student({ createdAt: at('2026-10-25'), assignedAt: at(AFTER, '00:00:00') })

  const tue = await session(j1, '2026-10-27')
  const wedPrimary = await session(p1, '2026-10-28')
  const wedJunior = await session(j1, '2026-10-28')
  const nextMonday = await session(j1, AFTER)
  const where = (sessionId: number, classId: number, senderId: number) => ({ sessionId, classId, senderId })

  // Call-ons: three this week, two answered; the one on the Monday after is not counted.
  await callOn(tue, 1, a, true)
  await callOn(tue, 2, b, false)
  await callOn(wedPrimary, 1, c, true)
  await callOn(nextMonday, 1, a, false)

  // Questions taken: three this week (a blocked one is not taken); the ones just outside are not counted.
  await message(where(tue, j1, a), at(WEEK, '00:00:00'), { kind: 'question' })
  await message(where(tue, j1, a), at('2026-10-27'), { kind: 'question' })
  await message(where(tue, j1, b), at('2026-11-01', '23:59:59'), { kind: 'question' })
  await message(where(tue, j1, b), at('2026-10-27'), { kind: 'question', moderation: 'sensitive', rule: '示例违禁词' })
  await message(where(tue, j1, a), at(BEFORE, '23:59:59'), { kind: 'question' })
  await message(where(tue, j1, a), at(AFTER, '00:00:00'), { kind: 'question' })

  // Answering points: five a lesson; three of the ten this week had an answer.
  for (const sessionId of [tue, wedPrimary]) for (let k = 1; k <= 5; k++) await event(sessionId, `qa-${k}`)
  await event(tue, 'qa-2#2', { kind: 'qa' })
  await event(tue, 'qa-4#2', { kind: 'qa' })
  await event(wedPrimary, 'qa-1#2', { kind: 'qa' })
  await event(nextMonday, 'qa-1')
  await event(nextMonday, 'qa-1#2', { kind: 'qa' })

  // Attendance, with the times each student connected.
  await attend(tue, a, 3)
  await attend(tue, b, 1)
  await attend(tue, n1)
  await attend(tue, n2)
  await attend(wedPrimary, c, 2)
  await attend(wedJunior, n1)
  await attend(nextMonday, a, 5)
  await attend(nextMonday, n2)

  // Study halls on a weekday: two junior classes on Thursday (one lesson not approved) and the senior one on Friday.
  // Saturday's study hall is the weekend's own.
  await session(j1, '2026-10-29', 'study')
  await session(j2, '2026-10-29', 'study')
  await session(s1, '2026-10-30', 'study')
  await session(p1, '2026-10-31', 'study')
  await session(j2, AFTER, 'study')

  // Lesson versions of the week.
  const lessonA = await insertLesson(db, { date: '2026-10-27' })
  await version(lessonA, 1, 'generate', at('2026-10-26', '01:00:00'))
  await version(lessonA, 2, 'edit', at('2026-10-26', '09:00:00'))
  await version(lessonA, 3, 'edit', at('2026-10-26', '09:05:00'))
  await version(lessonA, 4, 'rewrite_segment', at('2026-10-26', '09:10:00'), '太难了')
  await version(lessonA, 5, 'rewrite_lesson', at('2026-10-26', '09:20:00'), '换个话题')
  await version(lessonA, 6, 'rewrite_call_on', at('2026-10-26', '09:30:00'), '问题太长')
  await version(lessonA, 7, 'edit', at(AFTER, '09:00:00'))

  // The teacher: model calls, template comments and lines stopped.
  await llmCall('answer', at('2026-10-27'), 0.5)
  await llmCall('answer', at('2026-10-27'), 0.25)
  await llmCall('comment', at('2026-10-28'), 0.125)
  await llmCall('weekly', at('2026-10-29'), 1)
  await llmCall('answer', at('2026-10-27'), 0, 'failed')
  await llmCall('answer', at('2026-10-28'), 0, 'failed')
  await llmCall('comment', at('2026-10-28'), 0, 'failed')
  await llmCall('lesson', at('2026-10-28'), 0, 'failed')
  await llmCall('secondLayerChat', at('2026-10-28'), 0, 'refused')
  await llmCall('answer', at('2026-10-28'), 0, 'refused')
  await llmCall('answer', at(AFTER, '00:00:00'), 10, 'failed')
  await llmCall('lesson', at(BEFORE, '23:59:59'), 10)
  await event(tue, 'comment-1', { kind: 'teacher', text: '好，请坐。' })
  await event(wedPrimary, 'comment-1', { kind: 'teacher', text: '说得不错。' })
  await event(nextMonday, 'comment-1', { kind: 'teacher', text: '好，请坐。' })
  for (const createdAt of [at('2026-10-27'), at('2026-10-28'), at(AFTER, '00:00:00')]) {
    await db
      .insertInto('teacherLineBlocks')
      .values({ sessionId: tue, purpose: 'answer', layer: 'word_list', createdAt })
      .execute()
  }

  // Blocked lines by day and rule. Lines that went through are not counted.
  const shown = await message(where(tue, j1, a), at('2026-10-27'), { moderation: 'second_layer', text: '第二层拦下的话' })
  await message(where(tue, j1, a), at('2026-10-27'), { kind: 'answer', moderation: 'second_layer', text: '回答被拦' })
  await message(where(tue, j1, a), at(WEEK, '00:00:00'), { moderation: 'sensitive', rule: '示例违禁词' })
  await message(where(tue, j1, a), at(WEEK, '12:00:00'), { moderation: 'privacy' })
  await message(where(tue, j1, b), at('2026-10-27'), { moderation: 'injection', rule: 'PATTERN' })
  await message(where(wedPrimary, p1, c), at('2026-10-28'), { moderation: 'sensitive', rule: 'abc违禁' })
  await message(where(wedPrimary, p1, c), at('2026-10-28'))
  await message(where(tue, j1, a), at(BEFORE, '23:59:59'), { moderation: 'sensitive', rule: '示例违禁词' })
  await message(where(tue, j1, a), at(AFTER, '00:00:00'), { moderation: 'sensitive', rule: '示例违禁词' })

  // Rules marked as flagged wrongly in the review of the week's lessons.
  const marked = async (date: string, rules: string[]) => {
    const id = await insertLesson(db, { date, division: 'primary' })
    await db.updateTable('lessons').set({ falsePositives: JSON.stringify(rules) }).where('id', '=', id).execute()
  }
  await marked('2026-10-28', ['示例违禁词', '隐私信息'])
  await marked('2026-10-30', ['示例违禁词', 'abc违禁'])
  await marked(AFTER, ['下周的词'])

  // Dropped for staying away (30 days): the jobs of the week dropped the students last seen from 25 September up to
  // 2 October.
  await student({ status: 'dropped', lastAttendedAt: at('2026-09-28') })
  await student({ status: 'dropped', assignedAt: at('2026-10-01', '23:00:00') })
  await student({ status: 'dropped', lastAttendedAt: at('2026-10-02', '00:00:00') })
  await student({ status: 'dropped', lastAttendedAt: at('2026-09-24', '23:59:59') })
  await student({ status: 'dropped', lastAttendedAt: at('2026-09-28'), suspendedUntil: at('2026-11-10') })
  await student({ status: 'active', lastAttendedAt: at('2026-09-28') })

  // Suspensions and expulsions given this week and not revoked, by student.
  await record(a, 'suspension', at('2026-10-27'))
  await record(a, 'suspension', at('2026-10-29'))
  await record(b, 'suspension', at('2026-10-27'), at('2026-10-28'))
  await record(c, 'suspension', at(AFTER, '00:00:00'))
  await record(b, 'expulsion', at('2026-11-01'))

  const stats = await weeklyStats(db, config, WEEK)

  expect(stats.weekStart).toBe(WEEK)
  expect(stats.callOn).toEqual({
    rate: 0.6667,
    byDivision: {
      primary: { called: 1, answered: 1 },
      junior: { called: 2, answered: 1 },
      senior: { called: 0, answered: 0 },
    },
    byPlugin: [
      { type: 'openclaw', version: '1.0', called: 1, answered: 1 },
      { type: 'openclaw', version: '1.1', called: 1, answered: 0 },
      { type: 'other', version: '2.0', called: 1, answered: 1 },
    ],
  })
  expect(stats.questions).toEqual({ total: 3, segmentsWithAnswer: 3, segmentsWithout: 7 })
  expect(stats.reconnects).toEqual([
    { type: 'openclaw', version: '1.0', count: 2 },
    { type: 'other', version: '2.0', count: 1 },
    { type: 'openclaw', version: '1.1', count: 0 },
    { type: 'test', version: '0.0.0', count: 0 },
  ])
  expect(stats.lessons).toEqual({ studyHallsForUnreviewed: 2, edits: 2, segmentRewrites: 1, lessonRewrites: 1 })
  expect(stats.teacher).toEqual({ llmFailures: 3, fallbacks: 1, blockedLines: 2, refusals: 2 })

  const zero = { sensitive: 0, injection: 0, privacy: 0, secondLayer: 0 }
  expect(stats.moderation.byDay).toEqual([
    { date: '2026-10-26', ...zero, sensitive: 1, privacy: 1 },
    { date: '2026-10-27', ...zero, sensitive: 1, injection: 1, secondLayer: 2 },
    { date: '2026-10-28', ...zero, sensitive: 1 },
    { date: '2026-10-29', ...zero },
    { date: '2026-10-30', ...zero },
    { date: '2026-10-31', ...zero },
    { date: '2026-11-01', ...zero },
  ])
  // Ties go by the rule's text, compared by code point.
  expect(stats.moderation.topRules).toEqual([
    { rule: '示例违禁词', kind: 'word', count: 2 },
    { rule: 'PATTERN', kind: 'pattern', count: 1 },
    { rule: 'abc违禁', kind: 'word', count: 1 },
  ])
  expect(stats.moderation.falsePositiveMarks).toEqual(['abc违禁', '示例违禁词'])
  expect(stats.moderation.secondLayerChat).toEqual([
    { messageId: shown, text: '第二层拦下的话', at: at('2026-10-27').toISOString() },
  ])

  expect(stats.students).toEqual({ newcomers: 2, cameBackForSecond: 1, dropped: 2, suspended: 1, expelled: 1 })
  expect(stats.cost).toEqual({
    byPurpose: {
      lesson: 0,
      answer: 0.75,
      comment: 0.125,
      weekly: 1,
      secondLayerTeacher: 0,
      secondLayerChat: 0,
      wordList: 0,
    },
    // 1.875 yuan over five students in class: a, b, c and the two newcomers.
    perAttendee: 0.375,
    attendees: 5,
  })
})

test('the most-hit rules come first, at most twenty, with ties in a fixed order', async () => {
  const classId = await newClass()
  const sender = await student({})
  const sessionId = await session(classId, '2026-10-27')
  const where = { sessionId, classId, senderId: sender }
  for (let i = 0; i < 22; i++) {
    for (let k = 0; k <= (i === 5 ? 2 : 0); k++) {
      const rule = `规则${String(i).padStart(2, '0')}`
      await message(where, at('2026-10-27'), { moderation: i % 2 === 0 ? 'sensitive' : 'injection', rule })
    }
  }
  const { topRules } = (await weeklyStats(db, config, WEEK)).moderation
  expect(topRules).toHaveLength(20)
  expect(topRules[0]).toEqual({ rule: '规则05', kind: 'pattern', count: 3 })
  expect(topRules.slice(1, 4)).toEqual([
    { rule: '规则00', kind: 'word', count: 1 },
    { rule: '规则01', kind: 'pattern', count: 1 },
    { rule: '规则02', kind: 'word', count: 1 },
  ])
  expect(topRules.at(-1)).toEqual({ rule: '规则19', kind: 'pattern', count: 1 })
})

test('an empty week is all zeros', async () => {
  const stats = await weeklyStats(db, config, WEEK)
  expect(stats.callOn).toEqual({
    rate: 0,
    byDivision: {
      primary: { called: 0, answered: 0 },
      junior: { called: 0, answered: 0 },
      senior: { called: 0, answered: 0 },
    },
    byPlugin: [],
  })
  expect(stats.questions).toEqual({ total: 0, segmentsWithAnswer: 0, segmentsWithout: 0 })
  expect(stats.reconnects).toEqual([])
  expect(stats.lessons).toEqual({ studyHallsForUnreviewed: 0, edits: 0, segmentRewrites: 0, lessonRewrites: 0 })
  expect(stats.teacher).toEqual({ llmFailures: 0, fallbacks: 0, blockedLines: 0, refusals: 0 })
  expect(stats.moderation.byDay).toHaveLength(7)
  expect(stats.moderation.topRules).toEqual([])
  expect(stats.moderation.falsePositiveMarks).toEqual([])
  expect(stats.moderation.secondLayerChat).toEqual([])
  expect(stats.students).toEqual({ newcomers: 0, cameBackForSecond: 0, dropped: 0, suspended: 0, expelled: 0 })
  expect(stats.cost).toMatchObject({ perAttendee: 0, attendees: 0 })
})

test('nobody is counted as dropped before the school has been open the days it takes', async () => {
  // Open since 5 October: no job of the week had 30 days of school behind it.
  const opened = exampleConfig({ calendar: { breaks: [], openingDay: '2026-10-05' } })
  await student({ status: 'dropped', lastAttendedAt: at('2026-09-28') })
  expect((await weeklyStats(db, opened, WEEK)).students.dropped).toBe(0)
})

test('a week starts on a Monday', async () => {
  await expect(weeklyStats(db, config, '2026-10-27')).rejects.toThrow(/Monday/)
})

test('the last completed week is the one before the current week, in school time', () => {
  const tz = config.timezone
  expect(lastCompletedWeek(new Date('2026-11-04T12:00:00+08:00'), tz)).toBe('2026-10-26')
  expect(lastCompletedWeek(new Date('2026-11-02T00:00:00+08:00'), tz)).toBe('2026-10-26')
  expect(lastCompletedWeek(new Date('2026-11-01T23:59:59+08:00'), tz)).toBe('2026-10-19')
  expect(lastCompletedWeek(new Date('2026-11-08T23:59:59+08:00'), tz)).toBe('2026-10-26')
})
