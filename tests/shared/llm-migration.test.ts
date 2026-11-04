import { sql } from 'kysely'
import { Migrator, type MigrationProvider } from 'kysely/migration'
import { afterEach, beforeEach, expect, test } from 'vitest'
import * as m0001 from '../../src/shared/migrations/0001_init.js'
import * as m0002 from '../../src/shared/migrations/0002_key_reset_decoys.js'
import * as m0003 from '../../src/shared/migrations/0003_student_queue_time.js'
import * as m0004 from '../../src/shared/migrations/0004_class_service.js'
import * as m0005 from '../../src/shared/migrations/0005_school_rules_agreement.js'
import * as m0006 from '../../src/shared/migrations/0006_ai_id.js'
import * as m0007 from '../../src/shared/migrations/0007_llm.js'
import { createTestDb } from '../helpers/db.js'
import { insertClass, insertLesson, insertSession, insertStudent } from '../helpers/factories.js'

const provider: MigrationProvider = {
  async getMigrations() {
    return {
      '0001_init': m0001,
      '0002_key_reset_decoys': m0002,
      '0003_student_queue_time': m0003,
      '0004_class_service': m0004,
      '0005_school_rules_agreement': m0005,
      '0006_ai_id': m0006,
      '0007_llm': m0007,
    }
  },
}

let t: Awaited<ReturnType<typeof createTestDb>>
let migrator: Migrator

beforeEach(async () => {
  t = await createTestDb({ migrate: false })
  migrator = new Migrator({ db: t.db, provider })
})

afterEach(async () => {
  await t.destroy()
})

async function migrateOk(run: Promise<{ error?: unknown }>) {
  const { error } = await run
  expect(error).toBeUndefined()
}

const AT = new Date('2026-11-04T04:00:00Z')
const HOURS = { startsAt: AT, endsAt: new Date('2026-11-04T04:30:00Z') }

async function tableNames(): Promise<string[]> {
  return (await t.db.introspection.getTables()).map((x) => x.name)
}

async function columnsOf(table: string): Promise<string[]> {
  const tables = await t.db.introspection.getTables()
  return tables.find((x) => x.name === table)?.columns.map((c) => c.name) ?? []
}

const NEW_TABLES = [
  'lesson_versions',
  'lesson_topics',
  'lesson_generation',
  'llm_calls',
  'budget_notices',
  'switches',
  'switch_changes',
  'moderation_exclusions',
  'weekly_reviews',
  'admin_sessions',
  'teacher_line_blocks',
]

test('0007 adds the tables and columns, and leaves existing lessons and attendance with their defaults', async () => {
  await migrateOk(migrator.migrateTo('0006_ai_id'))
  const classId = await insertClass(t.db, { classNo: 1 })
  const lessonId = await insertLesson(t.db, { date: '2026-11-04' })
  const sessionId = await insertSession(t.db, { classId, date: '2026-11-04', lessonId, ...HOURS })
  const { id: studentId } = await insertStudent(t.db, { classId })
  await sql`insert into attendance (session_id, student_id, first_seen_at) values (${sessionId}, ${studentId}, ${AT})`.execute(t.db)

  await migrateOk(migrator.migrateToLatest())

  expect(await tableNames()).toEqual(expect.arrayContaining(NEW_TABLES))
  const lesson = await t.db.selectFrom('lessons').selectAll().where('id', '=', lessonId).executeTakeFirstOrThrow()
  expect(lesson).toMatchObject({
    callOnQuestions: null,
    topic: null,
    source: 'import',
    flags: [],
    falsePositives: [],
    version: 1,
    updatedAt: null,
  })
  expect(await t.db.selectFrom('attendance').select('connections').executeTakeFirstOrThrow()).toEqual({ connections: 1 })
})

test('the new tables take rows and refuse what their checks and unique keys forbid', async () => {
  await migrateOk(migrator.migrateToLatest())
  const classId = await insertClass(t.db, { classNo: 1 })
  const sessionId = await insertSession(t.db, { classId, date: '2026-11-04', ...HOURS })

  // A version of a lesson that no longer exists: there is no foreign key to lessons.
  await t.db
    .insertInto('lessonVersions')
    .values({
      lessonId: 999,
      version: 1,
      content: JSON.stringify({ title: 't', subject: 's', segments: [], callOnQuestions: null }),
      change: 'generate',
      segmentIndex: null,
      reason: null,
      createdAt: AT,
    })
    .execute()
  await expect(
    t.db
      .insertInto('lessonVersions')
      .values({ lessonId: 999, version: 2, content: '{}', change: 'bogus' as never, segmentIndex: null, reason: null, createdAt: AT })
      .execute(),
  ).rejects.toThrow(/lesson_versions_change_check/)

  await t.db.insertInto('lessonTopics').values({ date: '2026-11-05', division: 'junior', topic: '光', createdAt: AT }).execute()
  await expect(
    t.db.insertInto('lessonTopics').values({ date: '2026-11-05', division: 'junior', topic: '热', createdAt: AT }).execute(),
  ).rejects.toThrow(/lesson_topics_date_division/)
  await t.db
    .insertInto('lessonGeneration')
    .values({ date: '2026-11-05', division: 'junior', attempts: 1, firstFailedAt: AT, lastFailedAt: AT, lastError: 'x' })
    .execute()
  await expect(
    t.db
      .insertInto('lessonGeneration')
      .values({ date: '2026-11-05', division: 'junior', attempts: 2, firstFailedAt: AT, lastFailedAt: AT, lastError: 'y' })
      .execute(),
  ).rejects.toThrow(/lesson_generation_date_division/)

  await t.db
    .insertInto('llmCalls')
    .values({ purpose: 'lesson', provider: 'p', model: 'm', inputTokens: 1, outputTokens: 2, costYuan: '0.000123', outcome: 'ok', ms: 5, createdAt: AT })
    .execute()
  expect(await t.db.selectFrom('llmCalls').select('costYuan').executeTakeFirstOrThrow()).toEqual({ costYuan: '0.000123' })
  await expect(
    t.db
      .insertInto('llmCalls')
      .values({ purpose: 'lesson', provider: 'p', model: 'm', inputTokens: 1, outputTokens: 2, costYuan: 0, outcome: 'meh' as never, ms: 5, createdAt: AT })
      .execute(),
  ).rejects.toThrow(/llm_calls_outcome_check/)

  await t.db.insertInto('budgetNotices').values({ month: '2026-11', notifiedAt: AT }).execute()
  await expect(t.db.insertInto('budgetNotices').values({ month: '2026-11', notifiedAt: AT }).execute()).rejects.toThrow()
  await t.db.insertInto('switches').values({ name: 'teacherLlm', on: true, updatedAt: AT }).execute()
  await t.db.insertInto('switchChanges').values({ name: 'teacherLlm', on: false, createdAt: AT }).execute()

  await t.db.insertInto('moderationExclusions').values({ kind: 'word', value: '白菜', createdAt: AT }).execute()
  await expect(
    t.db.insertInto('moderationExclusions').values({ kind: 'word', value: '白菜', createdAt: AT }).execute(),
  ).rejects.toThrow(/moderation_exclusions_kind_value/)
  await expect(
    t.db.insertInto('moderationExclusions').values({ kind: 'regex' as never, value: 'a', createdAt: AT }).execute(),
  ).rejects.toThrow(/moderation_exclusions_kind_check/)

  await t.db.insertInto('weeklyReviews').values({ weekStart: '2026-11-02', stats: '{}', suggestions: '[]', createdAt: AT }).execute()
  await t.db.insertInto('adminSessions').values({ tokenHash: 'h', expiresAt: AT, createdAt: AT }).execute()

  await t.db.insertInto('teacherLineBlocks').values({ sessionId, purpose: 'answer', layer: 'word_list', createdAt: AT }).execute()
  await expect(
    t.db.insertInto('teacherLineBlocks').values({ sessionId, purpose: 'chat' as never, layer: 'word_list', createdAt: AT }).execute(),
  ).rejects.toThrow(/teacher_line_blocks_purpose_check/)
  await expect(
    t.db.insertInto('teacherLineBlocks').values({ sessionId, purpose: 'answer', layer: 'third' as never, createdAt: AT }).execute(),
  ).rejects.toThrow(/teacher_line_blocks_layer_check/)
  expect(await columnsOf('teacher_line_blocks')).not.toContain('text')

  await expect(
    t.db.insertInto('lessons').values({ date: '2026-11-06', division: 'junior', subject: 's', title: 't', segments: '[]', source: 'other' as never, approvedAt: null, createdAt: AT, callOnQuestions: null, topic: null, updatedAt: null }).execute(),
  ).rejects.toThrow(/lessons_source_check/)
})

test('a message can be blocked by the second layer, and 0007 can be undone and applied again', async () => {
  await migrateOk(migrator.migrateToLatest())
  const classId = await insertClass(t.db, { classNo: 1 })
  const sessionId = await insertSession(t.db, { classId, date: '2026-11-04', ...HOURS })
  const { id: studentId } = await insertStudent(t.db, { classId })
  const message = (moderation: string) => sql`
    insert into messages (session_id, class_id, kind, sender_id, text, moderation, delivered, plugin_type, plugin_version, created_at)
    values (${sessionId}, ${classId}, 'chat', ${studentId}, 'x', ${moderation}, false, 't', '0', ${AT})`
  await message('second_layer').execute(t.db)
  await expect(message('other').execute(t.db)).rejects.toThrow(/messages_moderation_check/)

  await migrateOk(migrator.migrateTo('0006_ai_id'))
  const names = await tableNames()
  for (const table of NEW_TABLES) expect(names, table).not.toContain(table)
  expect(await columnsOf('attendance')).not.toContain('connections')
  for (const column of ['call_on_questions', 'topic', 'source', 'flags', 'false_positives', 'version', 'updated_at']) {
    expect(await columnsOf('lessons'), column).not.toContain(column)
  }
  // The old check is back: the second layer is no category. The row it had is kept, as the nearest old category.
  await expect(message('second_layer').execute(t.db)).rejects.toThrow(/messages_moderation_check/)
  expect((await sql<{ moderation: string }>`select moderation from messages`.execute(t.db)).rows).toEqual([
    { moderation: 'sensitive' },
  ])

  await migrateOk(migrator.migrateToLatest())
  expect(await tableNames()).toEqual(expect.arrayContaining(NEW_TABLES))
})
