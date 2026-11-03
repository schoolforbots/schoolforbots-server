import { sql } from 'kysely'
import { Migrator, type MigrationProvider } from 'kysely/migration'
import { afterEach, beforeEach, expect, test } from 'vitest'
import * as m0001 from '../../src/shared/migrations/0001_init.js'
import * as m0002 from '../../src/shared/migrations/0002_key_reset_decoys.js'
import * as m0003 from '../../src/shared/migrations/0003_student_queue_time.js'
import * as m0004 from '../../src/shared/migrations/0004_class_service.js'
import * as m0005 from '../../src/shared/migrations/0005_school_rules_agreement.js'
import { createTestDb } from '../helpers/db.js'
import { insertStudent } from '../helpers/factories.js'

const provider: MigrationProvider = {
  async getMigrations() {
    return {
      '0001_init': m0001,
      '0002_key_reset_decoys': m0002,
      '0003_student_queue_time': m0003,
      '0004_class_service': m0004,
      '0005_school_rules_agreement': m0005,
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

const REGISTERED = new Date('2026-08-01T04:00:00Z')

test('0003 gives existing students the time they registered as their queue time', async () => {
  // createTestDb migrated to the latest; go back to before 0003 and put a student there, without the new column.
  await migrateOk(migrator.migrateTo('0002_key_reset_decoys'))
  await sql`
    insert into students (email, owner_name, ai_name, division, slot, status, install_id, plugin_type, plugin_version,
                          key_hash, registration_ip, created_at)
    values ('old@example.com', '阿杰', '小鱼', 'junior', 'evening', 'waitlisted', gen_random_uuid(), 'test', '0.0.0',
            'hash', '127.0.0.1', ${REGISTERED})`.execute(t.db)

  await migrateOk(migrator.migrateToLatest())

  const row = await t.db.selectFrom('students').select(['createdAt', 'queuedAt']).executeTakeFirstOrThrow()
  expect(row).toEqual({ createdAt: REGISTERED, queuedAt: REGISTERED })
})

test('after 0003 a student must have a queue time', async () => {
  await expect(
    sql`
      insert into students (email, owner_name, ai_name, division, slot, status, install_id, plugin_type, plugin_version,
                            key_hash, registration_ip, created_at)
      values ('new@example.com', '阿杰', '小鱼', 'junior', 'evening', 'pending', gen_random_uuid(), 'test', '0.0.0',
              'hash', '127.0.0.1', ${REGISTERED})`.execute(t.db),
  ).rejects.toThrow(/queued_at/)
})

test('0003 can be undone and applied again without losing students', async () => {
  const { id } = await insertStudent(t.db, { createdAt: REGISTERED, queuedAt: new Date('2026-10-01T00:00:00Z') })

  await migrateOk(migrator.migrateTo('0002_key_reset_decoys'))
  const tables = await t.db.introspection.getTables()
  expect(tables.find((table) => table.name === 'students')?.columns.map((c) => c.name)).not.toContain('queued_at')

  await migrateOk(migrator.migrateToLatest())
  // Applying it again starts from what was registered: the later queue time was not kept.
  const row = await t.db.selectFrom('students').select(['id', 'queuedAt']).executeTakeFirstOrThrow()
  expect(row).toEqual({ id, queuedAt: REGISTERED })
})
