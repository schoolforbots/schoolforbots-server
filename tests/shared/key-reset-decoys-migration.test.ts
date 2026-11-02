import { sql } from 'kysely'
import { Migrator, type MigrationProvider } from 'kysely/migration'
import { afterEach, beforeEach, expect, test } from 'vitest'
import * as m0001 from '../../src/shared/migrations/0001_init.js'
import * as m0002 from '../../src/shared/migrations/0002_key_reset_decoys.js'
import { createTestDb } from '../helpers/db.js'
import { insertStudent } from '../helpers/factories.js'

const provider: MigrationProvider = {
  async getMigrations() {
    return { '0001_init': m0001, '0002_key_reset_decoys': m0002 }
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

const EXPIRES = new Date('2026-11-02T04:10:00Z')
const CREATED = new Date('2026-11-02T04:00:00Z')

test('0002 fills in what existing key resets requested before it makes the new columns required', async () => {
  // createTestDb migrated to the latest; go back to the old shape and put a row there.
  await migrateOk(migrator.migrateTo('0001_init'))
  const { id: studentId } = await insertStudent(t.db, { email: 'owner@example.com' })
  await sql`
    insert into key_resets (student_id, code_hash, expires_at, created_at)
    values (${studentId}, 'hash', ${EXPIRES}, ${CREATED})`.execute(t.db)

  await migrateOk(migrator.migrateToLatest())

  const row = await t.db.selectFrom('keyResets').selectAll().executeTakeFirstOrThrow()
  expect(row).toMatchObject({ studentId, requestedStudentId: studentId, requestedEmail: 'owner@example.com' })
})

test('after 0002 a key reset may have no student, but must say what it requested', async () => {
  await t.db
    .insertInto('keyResets')
    .values({
      studentId: null,
      requestedStudentId: 4242,
      requestedEmail: 'nobody@example.com',
      codeHash: 'hash',
      expiresAt: EXPIRES,
      createdAt: CREATED,
      usedAt: null,
    })
    .execute()

  await expect(
    sql`insert into key_resets (student_id, code_hash, expires_at, created_at)
        values (null, 'hash', ${EXPIRES}, ${CREATED})`.execute(t.db),
  ).rejects.toThrow(/requested_student_id/)
  await expect(
    sql`insert into key_resets (student_id, requested_student_id, code_hash, expires_at, created_at)
        values (null, 1, 'hash', ${EXPIRES}, ${CREATED})`.execute(t.db),
  ).rejects.toThrow(/requested_email/)
})

test('0002 adds an index for looking up a student id by time', async () => {
  const { rows } = await sql<{ indexdef: string }>`
    select indexdef from pg_indexes where tablename = 'key_resets' and indexname = 'key_resets_requested_student_id_created_at'`.execute(
    t.db,
  )
  expect(rows[0]?.indexdef).toMatch(/\(requested_student_id, created_at\)/)
})

test('0002 can be undone: decoys go, real rows stay', async () => {
  const { id: studentId } = await insertStudent(t.db, { email: 'owner@example.com' })
  const base = { codeHash: 'hash', expiresAt: EXPIRES, createdAt: CREATED, usedAt: null }
  await t.db
    .insertInto('keyResets')
    .values([
      { ...base, studentId, requestedStudentId: studentId, requestedEmail: 'owner@example.com' },
      { ...base, studentId: null, requestedStudentId: 4242, requestedEmail: 'nobody@example.com' },
    ])
    .execute()

  await migrateOk(migrator.migrateTo('0001_init'))

  // (The camel-case plugin renames the columns of raw queries too.)
  const rows = await sql<{ studentId: number }>`select student_id from key_resets`.execute(t.db)
  expect(rows.rows).toEqual([{ studentId }])
  await expect(
    sql`insert into key_resets (student_id, code_hash, expires_at, created_at)
        values (null, 'hash', ${EXPIRES}, ${CREATED})`.execute(t.db),
  ).rejects.toThrow(/student_id/)

  await migrateOk(migrator.migrateToLatest())
})
