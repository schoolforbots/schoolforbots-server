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
import * as m0008 from '../../src/shared/migrations/0008_admin_discipline.js'
import * as m0009 from '../../src/shared/migrations/0009_llm_cached_tokens.js'
import * as m0010 from '../../src/shared/migrations/0010_call_on_checks.js'
import * as m0011 from '../../src/shared/migrations/0011_maintenance.js'
import * as m0012 from '../../src/shared/migrations/0012_ops.js'
import { createTestDb } from '../helpers/db.js'

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
      '0009_llm_cached_tokens': m0009,
      '0010_call_on_checks': m0010,
      '0011_maintenance': m0011,
      '0012_ops': m0012,
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
const AGREED_AT = new Date('2026-11-03T04:00:00Z')

async function columnsOf(table: string): Promise<string[]> {
  const tables = await t.db.introspection.getTables()
  return tables.find((x) => x.name === table)?.columns.map((c) => c.name) ?? []
}

/** Puts a registration and a student into the schema as it was before 0005, with no school rules columns. */
async function insertBeforeAgreement() {
  await migrateOk(migrator.migrateTo('0004_class_service'))
  await sql`
    insert into students (email, owner_name, ai_name, division, slot, status, install_id, plugin_type, plugin_version,
                          key_hash, registration_ip, created_at, queued_at)
    values ('old@example.com', '阿杰', '小鱼', 'junior', 'evening', 'waitlisted', gen_random_uuid(), 'test', '0.0.0',
            'hash', '127.0.0.1', ${REGISTERED}, ${REGISTERED})`.execute(t.db)
  await sql`
    insert into registrations (email, owner_name, ai_name, division, slot, install_id, plugin_type, plugin_version, ip,
                               code_hash, expires_at, created_at)
    values ('old@example.com', '阿杰', '小鱼', 'junior', 'evening', gen_random_uuid(), 'test', '0.0.0', '127.0.0.1',
            'hash', ${REGISTERED}, ${REGISTERED})`.execute(t.db)
}

test('0005 leaves the registrations and students there before it with no agreed version and no agreed time', async () => {
  await insertBeforeAgreement()
  await migrateOk(migrator.migrateToLatest())

  const student = await t.db.selectFrom('students').select(['schoolRulesVersion', 'schoolRulesAgreedAt']).executeTakeFirstOrThrow()
  expect(student).toEqual({ schoolRulesVersion: null, schoolRulesAgreedAt: null })
  const registration = await t.db
    .selectFrom('registrations')
    .select(['schoolRulesVersion', 'schoolRulesAgreedAt'])
    .executeTakeFirstOrThrow()
  expect(registration).toEqual({ schoolRulesVersion: null, schoolRulesAgreedAt: null })
})

test('after 0005 a registration and a student can record the version agreed to and when', async () => {
  await insertBeforeAgreement()
  await migrateOk(migrator.migrateToLatest())

  await t.db.updateTable('students').set({ schoolRulesVersion: '2026-11-03', schoolRulesAgreedAt: AGREED_AT }).execute()
  await t.db.updateTable('registrations').set({ schoolRulesVersion: '2026-11-03', schoolRulesAgreedAt: AGREED_AT }).execute()

  const student = await t.db.selectFrom('students').select(['schoolRulesVersion', 'schoolRulesAgreedAt']).executeTakeFirstOrThrow()
  expect(student).toEqual({ schoolRulesVersion: '2026-11-03', schoolRulesAgreedAt: AGREED_AT })
  const registration = await t.db
    .selectFrom('registrations')
    .select(['schoolRulesVersion', 'schoolRulesAgreedAt'])
    .executeTakeFirstOrThrow()
  expect(registration).toEqual({ schoolRulesVersion: '2026-11-03', schoolRulesAgreedAt: AGREED_AT })
})

test('0005 can be undone and applied again without losing registrations or students', async () => {
  await insertBeforeAgreement()
  await migrateOk(migrator.migrateToLatest())
  await t.db.updateTable('students').set({ schoolRulesVersion: '2026-11-03', schoolRulesAgreedAt: AGREED_AT }).execute()
  const { id } = await t.db.selectFrom('students').select('id').executeTakeFirstOrThrow()

  await migrateOk(migrator.migrateTo('0004_class_service'))
  for (const table of ['students', 'registrations']) {
    const columns = await columnsOf(table)
    expect(columns, table).not.toContain('school_rules_version')
    expect(columns, table).not.toContain('school_rules_agreed_at')
  }

  await migrateOk(migrator.migrateToLatest())
  // The rows are still there; what was agreed to was not kept.
  const student = await t.db.selectFrom('students').select(['id', 'schoolRulesVersion', 'schoolRulesAgreedAt']).executeTakeFirstOrThrow()
  expect(student).toEqual({ id, schoolRulesVersion: null, schoolRulesAgreedAt: null })
  await expect(t.db.selectFrom('registrations').select('id').executeTakeFirstOrThrow()).resolves.toBeTruthy()
})
