import { randomUUID } from 'node:crypto'
import { sql, type Kysely } from 'kysely'
import pg from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, inject, test, vi } from 'vitest'
import type { Database } from '../../src/shared/schema.js'
import { migrateToLatest } from '../../src/shared/db.js'
import { hashSecret } from '../../src/shared/secrets.js'
import { createTestDb } from '../helpers/db.js'
import { insertClass, insertStudent } from '../helpers/factories.js'

describe('database schema', () => {
  let db: Kysely<Database>
  let destroy: () => Promise<void>

  beforeAll(async () => {
    ;({ db, destroy } = await createTestDb())
  })

  afterAll(async () => {
    await destroy()
  })

  test('migrations create all tables', async () => {
    const tables = (await db.introspection.getTables()).map((t) => t.name).sort()
    expect(tables).toEqual(
      expect.arrayContaining(['bans', 'classes', 'key_resets', 'registrations', 'rename_events', 'students']),
    )
  })

  test('one AI id can hold only one seat', async () => {
    const aiId = randomUUID()
    await insertStudent(db, { aiId, status: 'active' })
    await expect(insertStudent(db, { aiId, status: 'pending' })).rejects.toThrow(/students_ai_seat/)
  })

  test('dropped students free the AI id', async () => {
    const aiId = randomUUID()
    await insertStudent(db, { aiId, status: 'dropped' })
    await expect(insertStudent(db, { aiId, status: 'active' })).resolves.toBeTruthy()
  })

  test('migrating again is a no-op', async () => {
    await expect(migrateToLatest(db)).resolves.toBeUndefined()
  })

  test('a class number is unique within a division and slot', async () => {
    await insertClass(db, { division: 'senior', slot: 'morning', classNo: 1 })
    await expect(insertClass(db, { division: 'senior', slot: 'morning', classNo: 1 })).rejects.toThrow(
      /classes_division_slot_class_no/,
    )
    await expect(insertClass(db, { division: 'senior', slot: 'afternoon', classNo: 1 })).resolves.toEqual(
      expect.any(Number),
    )
  })

  test('insertStudent stores only the key hash and maps camelCase columns', async () => {
    const classId = await insertClass(db, { classNo: 7 })
    const { id, key } = await insertStudent(db, { classId, status: 'active' })
    expect(id).toEqual(expect.any(Number))

    const row = await db.selectFrom('students').selectAll().where('id', '=', id).executeTakeFirstOrThrow()
    expect(row.keyHash).toBe(hashSecret(key))
    expect(row).toMatchObject({ division: 'junior', slot: 'evening', status: 'active', classId, lessonsAttended: 0 })
    expect(row.createdAt).toBeInstanceOf(Date)
  })
})

describe('connection pool', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  test('a connection dropped while idle is logged, not thrown', async () => {
    const { db, destroy } = await createTestDb()
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      // Leave one idle client in the pool, then kill it from the server side, like a database restart does.
      const { rows } = await sql<{ name: string }>`select current_database() as name`.execute(db)
      const name = rows[0]!.name
      const admin = new pg.Client({ connectionString: inject('pgUrl') })
      await admin.connect()
      try {
        await admin.query('select pg_terminate_backend(pid) from pg_stat_activity where datname = $1', [name])
      } finally {
        await admin.end()
      }

      // Without a pool error listener the idle client's error is an uncaught exception that crashes the process.
      await vi.waitFor(() => expect(logged).toHaveBeenCalledWith(expect.any(String), expect.any(Error)))

      // The pool replaces the dead client, so the next query still works.
      await expect(sql`select 1 as ok`.execute(db)).resolves.toBeTruthy()
    } finally {
      await destroy()
    }
  })
})
