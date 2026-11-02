import { randomUUID } from 'node:crypto'
import type { Kysely } from 'kysely'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
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

  test('one install id can hold only one seat', async () => {
    const installId = randomUUID()
    await insertStudent(db, { installId, status: 'active' })
    await expect(insertStudent(db, { installId, status: 'pending' })).rejects.toThrow(/students_install_seat/)
  })

  test('dropped students free the install id', async () => {
    const installId = randomUUID()
    await insertStudent(db, { installId, status: 'dropped' })
    await expect(insertStudent(db, { installId, status: 'active' })).resolves.toBeTruthy()
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
