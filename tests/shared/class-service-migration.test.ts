import { sql, type Kysely } from 'kysely'
import { Migrator, type MigrationProvider } from 'kysely/migration'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import * as m0001 from '../../src/shared/migrations/0001_init.js'
import * as m0002 from '../../src/shared/migrations/0002_key_reset_decoys.js'
import * as m0003 from '../../src/shared/migrations/0003_student_queue_time.js'
import * as m0004 from '../../src/shared/migrations/0004_class_service.js'
import * as m0005 from '../../src/shared/migrations/0005_school_rules_agreement.js'
import * as m0006 from '../../src/shared/migrations/0006_ai_id.js'
import * as m0007 from '../../src/shared/migrations/0007_llm.js'
import * as m0008 from '../../src/shared/migrations/0008_admin_discipline.js'
import type { Database } from '../../src/shared/schema.js'
import { createTestDb } from '../helpers/db.js'
import { insertClass, insertLesson, insertSession, insertStudent } from '../helpers/factories.js'

const NEW_TABLES = ['attendance', 'class_events', 'class_sessions', 'discipline_records', 'lessons', 'messages', 'summaries']

const OPENS = new Date('2026-11-02T10:00:00Z')
const CLOSES = new Date('2026-11-02T10:30:00Z')

let classCounter = 0

/** A class with a student and a session of that class: what most rows below hang on. */
async function seed(db: Kysely<Database>, p: { date?: string } = {}) {
  const classId = await insertClass(db, { classNo: ++classCounter })
  const { id: studentId } = await insertStudent(db, { classId, status: 'active' })
  const sessionId = await insertSession(db, { classId, date: p.date ?? '2026-11-02', startsAt: OPENS, endsAt: CLOSES })
  return { classId, studentId, sessionId }
}

describe('class service tables', () => {
  let db: Kysely<Database>
  let destroy: () => Promise<void>

  beforeAll(async () => {
    ;({ db, destroy } = await createTestDb())
  })

  afterAll(async () => {
    await destroy()
  })

  test('migrating creates the new tables and the suspension column', async () => {
    const tables = await db.introspection.getTables()
    expect(tables.map((t) => t.name)).toEqual(expect.arrayContaining(NEW_TABLES))
    expect(tables.find((t) => t.name === 'students')?.columns.map((c) => c.name)).toContain('suspended_until')
  })

  test('a student has no suspension until one is set', async () => {
    const { id } = await insertStudent(db)
    const row = await db.selectFrom('students').select('suspendedUntil').where('id', '=', id).executeTakeFirstOrThrow()
    expect(row.suspendedUntil).toBeNull()
  })

  describe('lessons', () => {
    test('insertLesson defaults to an approved junior lesson with five placeholder segments', async () => {
      const id = await insertLesson(db, { date: '2026-12-01' })
      const row = await db.selectFrom('lessons').selectAll().where('id', '=', id).executeTakeFirstOrThrow()
      expect(row).toMatchObject({ date: '2026-12-01', division: 'junior', approvedAt: expect.any(Date) })
      expect(row.subject).toEqual(expect.any(String))
      expect(row.title).toEqual(expect.any(String))
      // jsonb comes back parsed, in the shape that went in.
      expect(row.segments).toHaveLength(5)
      for (const segment of row.segments) expect(segment).toEqual({ text: expect.any(String), gist: expect.any(String) })
    })

    test('a lesson can be left unapproved', async () => {
      const id = await insertLesson(db, { date: '2026-12-02', approvedAt: null })
      const row = await db.selectFrom('lessons').select('approvedAt').where('id', '=', id).executeTakeFirstOrThrow()
      expect(row.approvedAt).toBeNull()
    })

    test('a date comes back as the same calendar day, not as a Date', async () => {
      const id = await insertLesson(db, { date: '2026-12-03' })
      const row = await db.selectFrom('lessons').select('date').where('id', '=', id).executeTakeFirstOrThrow()
      expect(row.date).toBe('2026-12-03')
    })

    test('there is one lesson per day and division', async () => {
      await insertLesson(db, { date: '2026-12-04', division: 'senior' })
      await expect(insertLesson(db, { date: '2026-12-04', division: 'senior' })).rejects.toThrow(/lessons_date_division/)
      await expect(insertLesson(db, { date: '2026-12-04', division: 'primary' })).resolves.toEqual(expect.any(Number))
      await expect(insertLesson(db, { date: '2026-12-05', division: 'senior' })).resolves.toEqual(expect.any(Number))
    })
  })

  describe('class sessions', () => {
    test('insertSession defaults to a lesson in the evening slot with no members', async () => {
      const { sessionId } = await seed(db)
      const row = await db.selectFrom('classSessions').selectAll().where('id', '=', sessionId).executeTakeFirstOrThrow()
      expect(row).toMatchObject({
        date: '2026-11-02',
        slot: 'evening',
        kind: 'lesson',
        lessonId: null,
        startsAt: OPENS,
        endsAt: CLOSES,
        dismissedAt: null,
        members: [],
      })
    })

    test('the members at the door are stored as given', async () => {
      const classId = await insertClass(db, { classNo: ++classCounter })
      const { id: studentId } = await insertStudent(db, { classId, status: 'active' })
      const members = [{ studentId, displayName: '小鱼' }]
      const sessionId = await insertSession(db, { classId, date: '2026-11-03', startsAt: OPENS, endsAt: CLOSES, members })
      const row = await db.selectFrom('classSessions').select('members').where('id', '=', sessionId).executeTakeFirstOrThrow()
      expect(row.members).toEqual(members)
    })

    test('a session can point at its lesson', async () => {
      const classId = await insertClass(db, { classNo: ++classCounter })
      const lessonId = await insertLesson(db, { date: '2026-11-04' })
      const sessionId = await insertSession(db, { classId, date: '2026-11-04', lessonId, startsAt: OPENS, endsAt: CLOSES })
      const row = await db.selectFrom('classSessions').select('lessonId').where('id', '=', sessionId).executeTakeFirstOrThrow()
      expect(row.lessonId).toBe(lessonId)
    })

    test('a class has one session a day', async () => {
      const { classId } = await seed(db)
      await expect(
        insertSession(db, { classId, date: '2026-11-02', startsAt: OPENS, endsAt: CLOSES }),
      ).rejects.toThrow(/class_sessions_class_id_date/)
      await expect(
        insertSession(db, { classId, date: '2026-11-03', startsAt: OPENS, endsAt: CLOSES }),
      ).resolves.toEqual(expect.any(Number))
    })

    test('a session is either a lesson or a study hall', async () => {
      const classId = await insertClass(db, { classNo: ++classCounter })
      await expect(
        insertSession(db, { classId, date: '2026-11-02', kind: 'study', startsAt: OPENS, endsAt: CLOSES }),
      ).resolves.toEqual(expect.any(Number))
      await expect(
        sql`insert into class_sessions (class_id, date, slot, kind, starts_at, ends_at, members)
            values (${classId}, '2026-11-03', 'evening', 'recess', ${OPENS}, ${CLOSES}, '[]')`.execute(db),
      ).rejects.toThrow(/class_sessions_kind_check/)
    })
  })

  describe('class events', () => {
    function event(sessionId: number, seq: number, step: string) {
      return db
        .insertInto('classEvents')
        .values({
          sessionId,
          seq,
          step,
          kind: 'segment',
          payload: JSON.stringify({ index: seq }),
          createdAt: OPENS,
        })
        .execute()
    }

    test('a step is recorded once per session', async () => {
      const { sessionId } = await seed(db)
      await event(sessionId, 1, 'opening')
      await expect(event(sessionId, 2, 'opening')).rejects.toThrow(/class_events_session_id_step/)
      await expect(event(sessionId, 2, 'segment-1')).resolves.toBeDefined()
    })

    test('a sequence number is used once per session', async () => {
      const { sessionId } = await seed(db)
      await event(sessionId, 1, 'opening')
      await expect(event(sessionId, 1, 'segment-1')).rejects.toThrow(/class_events_session_id_seq/)
    })

    test('another session may repeat a step and a sequence number', async () => {
      const first = await seed(db)
      const second = await seed(db)
      await event(first.sessionId, 1, 'opening')
      await expect(event(second.sessionId, 1, 'opening')).resolves.toBeDefined()
    })

    test('the payload comes back parsed', async () => {
      const { sessionId } = await seed(db)
      await event(sessionId, 7, 'segment-3')
      const row = await db.selectFrom('classEvents').select('payload').where('sessionId', '=', sessionId).executeTakeFirstOrThrow()
      expect(row.payload).toEqual({ index: 7 })
    })
  })

  // CamelCasePlugin renames the keys of result rows; it must stop at a jsonb column, which holds free-form data.
  describe('jsonb keys', () => {
    const json = { matched_term: 'x', nested: [{ some_key: 1 }], 'Mixed-Case': { inner_key: ['a_b'] } }
    const text = JSON.stringify(json)

    test('class_events.payload reads back with its keys unchanged', async () => {
      const { sessionId } = await seed(db)
      await db
        .insertInto('classEvents')
        .values({ sessionId, seq: 1, step: 'opening', kind: 'opening', payload: text, createdAt: OPENS })
        .execute()
      const row = await db.selectFrom('classEvents').select('payload').where('sessionId', '=', sessionId).executeTakeFirstOrThrow()
      expect(row.payload).toEqual(json)
    })

    test('discipline_records.detail reads back with its keys unchanged', async () => {
      const { studentId, sessionId } = await seed(db)
      await db
        .insertInto('disciplineRecords')
        .values({ studentId, sessionId, kind: 'rounds', detail: text, createdAt: OPENS })
        .execute()
      const row = await db.selectFrom('disciplineRecords').select('detail').where('sessionId', '=', sessionId).executeTakeFirstOrThrow()
      expect(row.detail).toEqual(json)
    })

    test('summaries.payload reads back with its keys unchanged', async () => {
      const { studentId, sessionId } = await seed(db)
      await db.insertInto('summaries').values({ sessionId, studentId, payload: text, createdAt: CLOSES }).execute()
      const row = await db.selectFrom('summaries').select('payload').where('sessionId', '=', sessionId).executeTakeFirstOrThrow()
      expect(row.payload).toEqual(json)
    })

    test('lessons.segments and class_sessions.members keep their keys too', async () => {
      const segments = [{ text: 'a', gist: 'b', extra_key: { deep_key: 1 } }]
      const lessonId = await insertLesson(db, { date: '2027-01-01', segments })
      const classId = await insertClass(db, { classNo: ++classCounter })
      const members = [{ studentId: 1, displayName: 'x', some_key: [{ other_key: 1 }] }]
      const sessionId = await insertSession(db, { classId, date: '2027-01-01', startsAt: OPENS, endsAt: CLOSES, members })

      const lesson = await db.selectFrom('lessons').select('segments').where('id', '=', lessonId).executeTakeFirstOrThrow()
      const session = await db.selectFrom('classSessions').select('members').where('id', '=', sessionId).executeTakeFirstOrThrow()
      expect(lesson.segments).toEqual(segments)
      expect(session.members).toEqual(members)
    })
  })

  describe('attendance and summaries', () => {
    test('a student is seen once per session', async () => {
      const { sessionId, studentId } = await seed(db)
      await db.insertInto('attendance').values({ sessionId, studentId, firstSeenAt: OPENS }).execute()
      await expect(
        db.insertInto('attendance').values({ sessionId, studentId, firstSeenAt: CLOSES }).execute(),
      ).rejects.toThrow(/attendance_pkey/)
    })

    test('a student has one summary per session', async () => {
      const { sessionId, studentId } = await seed(db)
      const row = { sessionId, studentId, payload: JSON.stringify({ lines: ['今天学了加法'] }), createdAt: CLOSES }
      await db.insertInto('summaries').values(row).execute()
      await expect(db.insertInto('summaries').values(row).execute()).rejects.toThrow(/summaries_pkey/)
      const stored = await db.selectFrom('summaries').select('payload').where('sessionId', '=', sessionId).executeTakeFirstOrThrow()
      expect(stored.payload).toEqual({ lines: ['今天学了加法'] })
    })

    test("the student's summaries have an index with the student first, as the primary key leads with the session", async () => {
      const { rows } = await sql<{ indexdef: string }>`
        select indexdef from pg_indexes where tablename = 'summaries' and indexname = 'summaries_student_id_session_id'`.execute(
        db,
      )
      expect(rows[0]?.indexdef).toMatch(/\(student_id, session_id\)/)
    })
  })

  describe('messages', () => {
    function message(p: { sessionId: number; classId: number; senderId: number; kind?: string; moderation?: string | null }) {
      return sql`
        insert into messages (session_id, class_id, kind, sender_id, text, moderation, delivered, ip, plugin_type,
                              plugin_version, created_at)
        values (${p.sessionId}, ${p.classId}, ${p.kind ?? 'chat'}, ${p.senderId}, '你好', ${p.moderation ?? null}, true,
                '127.0.0.1', 'test', '0.0.0', ${OPENS})`.execute(db)
    }

    test('every kind of message and every moderation category is accepted', async () => {
      const { classId, studentId, sessionId } = await seed(db)
      for (const kind of ['chat', 'question', 'answer', 'closing']) {
        await message({ sessionId, classId, senderId: studentId, kind })
      }
      for (const moderation of ['sensitive', 'injection', 'privacy']) {
        await message({ sessionId, classId, senderId: studentId, moderation })
      }
    })

    test('an unknown kind of message or moderation category is refused', async () => {
      const { classId, studentId, sessionId } = await seed(db)
      await expect(message({ sessionId, classId, senderId: studentId, kind: 'shout' })).rejects.toThrow(
        /messages_kind_check/,
      )
      await expect(message({ sessionId, classId, senderId: studentId, moderation: 'rude' })).rejects.toThrow(
        /messages_moderation_check/,
      )
    })

    test('a stored message maps camelCase and keeps what was matched optional', async () => {
      const { classId, studentId, sessionId } = await seed(db)
      await db
        .insertInto('messages')
        .values({
          sessionId,
          classId,
          kind: 'question',
          conversationId: 'c-1',
          senderId: studentId,
          recipientId: null,
          text: '为什么？',
          moderation: null,
          matchedTerm: null,
          delivered: true,
          ip: null,
          pluginType: 'test',
          pluginVersion: '0.0.0',
          createdAt: OPENS,
        })
        .execute()
      const row = await db.selectFrom('messages').selectAll().where('sessionId', '=', sessionId).executeTakeFirstOrThrow()
      expect(row).toMatchObject({ conversationId: 'c-1', recipientId: null, matchedTerm: null, ip: null, delivered: true })
    })

    test('the message indexes exist', async () => {
      const { rows } = await sql<{ indexname: string }>`select indexname from pg_indexes where tablename = 'messages'`.execute(db)
      expect(rows.map((r) => r.indexname)).toEqual(
        expect.arrayContaining(['messages_session_id', 'messages_sender_id_created_at', 'messages_created_at']),
      )
    })
  })

  describe('discipline records', () => {
    function record(p: { studentId: number; sessionId: number | null; kind: string }) {
      return sql`
        insert into discipline_records (student_id, session_id, kind, detail, created_at)
        values (${p.studentId}, ${p.sessionId}, ${p.kind}, '{}', ${OPENS})`.execute(db)
    }

    test.each(['initiations', 'rounds', 'school_rule'])('a student gets one %s record per lesson', async (kind) => {
      const { studentId, sessionId } = await seed(db)
      await record({ studentId, sessionId, kind })
      await expect(record({ studentId, sessionId, kind })).rejects.toThrow(/discipline_once_per_lesson/)
    })

    test('different kinds, students or lessons each get their own record', async () => {
      const { classId, studentId, sessionId } = await seed(db)
      const { id: otherStudent } = await insertStudent(db, { classId, status: 'active' })
      const otherSession = await insertSession(db, { classId, date: '2026-11-03', startsAt: OPENS, endsAt: CLOSES })

      await record({ studentId, sessionId, kind: 'rounds' })
      await expect(record({ studentId, sessionId, kind: 'initiations' })).resolves.toBeDefined()
      await expect(record({ studentId: otherStudent, sessionId, kind: 'rounds' })).resolves.toBeDefined()
      await expect(record({ studentId, sessionId: otherSession, kind: 'rounds' })).resolves.toBeDefined()
    })

    test.each(['privacy_block', 'parent_notice', 'suspension', 'expulsion'])(
      '%s records may repeat within a lesson',
      async (kind) => {
        const { studentId, sessionId } = await seed(db)
        await record({ studentId, sessionId, kind })
        await expect(record({ studentId, sessionId, kind })).resolves.toBeDefined()
      },
    )

    test('a record may belong to no lesson, and an unknown kind is refused', async () => {
      const { studentId, sessionId } = await seed(db)
      await expect(record({ studentId, sessionId: null, kind: 'suspension' })).resolves.toBeDefined()
      await expect(record({ studentId, sessionId, kind: 'warning' })).rejects.toThrow(/discipline_records_kind_check/)
    })

    test('the record stores its detail parsed and can be revoked', async () => {
      const { studentId, sessionId } = await seed(db)
      await db
        .insertInto('disciplineRecords')
        .values({
          studentId,
          sessionId,
          kind: 'school_rule',
          detail: JSON.stringify({ category: 'sensitive' }),
          matchedTerm: null,
          createdAt: OPENS,
          revokedAt: CLOSES,
        })
        .execute()
      const row = await db.selectFrom('disciplineRecords').selectAll().where('studentId', '=', studentId).executeTakeFirstOrThrow()
      expect(row).toMatchObject({ detail: { category: 'sensitive' }, revokedAt: CLOSES })
    })

    test('the student and time index exists', async () => {
      const { rows } = await sql<{ indexdef: string }>`
        select indexdef from pg_indexes where tablename = 'discipline_records' and indexname = 'discipline_records_student_id_created_at'`.execute(
        db,
      )
      expect(rows[0]?.indexdef).toMatch(/\(student_id, created_at\)/)
    })
  })
})

describe('undoing and redoing 0004', () => {
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
      '0008_admin_discipline': m0008,
      }
    },
  }

  let t: Awaited<ReturnType<typeof createTestDb>>
  let migrator: Migrator

  beforeEach(async () => {
    t = await createTestDb()
    migrator = new Migrator({ db: t.db, provider })
  })

  afterEach(async () => {
    await t.destroy()
  })

  async function migrateOk(run: Promise<{ error?: unknown }>) {
    const { error } = await run
    expect(error).toBeUndefined()
  }

  async function tableNames(): Promise<string[]> {
    return (await t.db.introspection.getTables()).map((table) => table.name)
  }

  test('down removes the new tables and the column, and up brings them back', async () => {
    await migrateOk(migrator.migrateTo('0003_student_queue_time'))
    const afterDown = await t.db.introspection.getTables()
    for (const name of NEW_TABLES) expect(afterDown.map((table) => table.name)).not.toContain(name)
    expect(afterDown.find((table) => table.name === 'students')?.columns.map((c) => c.name)).not.toContain('suspended_until')

    await migrateOk(migrator.migrateToLatest())
    expect(await tableNames()).toEqual(expect.arrayContaining(NEW_TABLES))
  })

  test('down and up keep the students, classes and the division and slot types', async () => {
    const classId = await insertClass(t.db, { classNo: 1 })
    const { id } = await insertStudent(t.db, { classId, status: 'active' })

    await migrateOk(migrator.migrateTo('0003_student_queue_time'))
    await migrateOk(migrator.migrateToLatest())

    const row = await t.db.selectFrom('students').select(['id', 'division', 'slot', 'suspendedUntil']).executeTakeFirstOrThrow()
    expect(row).toEqual({ id, division: 'junior', slot: 'evening', suspendedUntil: null })
    // The enum types are still the ones from 0001: a new lesson and session can use them.
    const lessonId = await insertLesson(t.db, { date: '2026-11-02' })
    await expect(
      insertSession(t.db, { classId, date: '2026-11-02', lessonId, startsAt: OPENS, endsAt: CLOSES }),
    ).resolves.toEqual(expect.any(Number))
  })

  test('down also works with rows in every new table', async () => {
    const classId = await insertClass(t.db, { classNo: 1 })
    const { id: studentId } = await insertStudent(t.db, { classId, status: 'active' })
    const lessonId = await insertLesson(t.db, { date: '2026-11-02' })
    const sessionId = await insertSession(t.db, { classId, date: '2026-11-02', lessonId, startsAt: OPENS, endsAt: CLOSES })
    await t.db
      .insertInto('classEvents')
      .values({ sessionId, seq: 1, step: 'opening', kind: 'opening', payload: '{}', createdAt: OPENS })
      .execute()
    await t.db.insertInto('attendance').values({ sessionId, studentId, firstSeenAt: OPENS }).execute()
    await t.db
      .insertInto('messages')
      .values({
        sessionId,
        classId,
        kind: 'chat',
        senderId: studentId,
        text: '你好',
        delivered: true,
        pluginType: 'test',
        pluginVersion: '0.0.0',
        createdAt: OPENS,
      })
      .execute()
    await t.db
      .insertInto('disciplineRecords')
      .values({ studentId, sessionId, kind: 'rounds', detail: '{}', createdAt: OPENS })
      .execute()
    await t.db.insertInto('summaries').values({ sessionId, studentId, payload: '{}', createdAt: CLOSES }).execute()

    await migrateOk(migrator.migrateTo('0003_student_queue_time'))
    await migrateOk(migrator.migrateToLatest())

    for (const name of NEW_TABLES) {
      const { rows } = await sql<{ n: string }>`select count(*) as n from ${sql.table(name)}`.execute(t.db)
      expect(rows[0]?.n).toBe('0')
    }
  })
})
