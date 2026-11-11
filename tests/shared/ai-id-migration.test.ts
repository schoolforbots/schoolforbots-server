import { randomUUID } from 'node:crypto'
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
      '0006_ai_id': m0006,
      '0007_llm': m0007,
      '0008_admin_discipline': m0008,
      '0009_llm_cached_tokens': m0009,
      '0010_call_on_checks': m0010,
      '0011_maintenance': m0011,
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

const AT = new Date('2026-10-01T04:00:00Z')

async function columnsOf(table: string): Promise<string[]> {
  const tables = await t.db.introspection.getTables()
  return tables.find((x) => x.name === table)?.columns.map((c) => c.name) ?? []
}

/** A student, a registration and a ban on one install id, in the schema as it was before 0006. */
async function insertBeforeAiId(installId: string) {
  await migrateOk(migrator.migrateTo('0005_school_rules_agreement'))
  await sql`
    insert into students (email, owner_name, ai_name, division, slot, status, install_id, plugin_type, plugin_version,
                          key_hash, registration_ip, created_at, queued_at)
    values ('old@example.com', '阿杰', '小鱼', 'junior', 'evening', 'active', ${installId}, 'test', '0.0.0',
            'hash', '127.0.0.1', ${AT}, ${AT})`.execute(t.db)
  await sql`
    insert into registrations (email, owner_name, ai_name, division, slot, install_id, plugin_type, plugin_version, ip,
                               code_hash, expires_at, created_at)
    values ('old@example.com', '阿杰', '小鱼', 'junior', 'evening', ${installId}, 'test', '0.0.0', '127.0.0.1',
            'hash', ${AT}, ${AT})`.execute(t.db)
  await sql`insert into bans (email, install_id, until, reason) values (null, ${installId}, ${AT}, 'expelled')`.execute(t.db)
}

test('0006 keeps every install id as the AI id of its student, registration and ban', async () => {
  const id = randomUUID()
  await insertBeforeAiId(id)
  await migrateOk(migrator.migrateToLatest())

  expect(await t.db.selectFrom('students').select('aiId').executeTakeFirstOrThrow()).toEqual({ aiId: id })
  expect(await t.db.selectFrom('registrations').select('aiId').executeTakeFirstOrThrow()).toEqual({ aiId: id })
  expect(await t.db.selectFrom('bans').select('aiId').executeTakeFirstOrThrow()).toEqual({ aiId: id })
  for (const table of ['students', 'registrations', 'bans']) expect(await columnsOf(table), table).not.toContain('install_id')
})

test('after 0006 an AI id still holds one seat, refused under the renamed index', async () => {
  const id = randomUUID()
  await insertBeforeAiId(id)
  await migrateOk(migrator.migrateToLatest())

  await expect(insertStudent(t.db, { aiId: id, status: 'pending' })).rejects.toThrow(/students_ai_seat/)
  const indexes = await sql<{ indexname: string }>`select indexname from pg_indexes where tablename in ('students', 'registrations')`.execute(t.db)
  const names = indexes.rows.map((r) => r.indexname)
  expect(names).toEqual(expect.arrayContaining(['students_ai_seat', 'registrations_email_ai_id_created_at']))
  expect(names.filter((n) => n.includes('install'))).toEqual([])
})

test('0006 can be undone and applied again without losing the ids', async () => {
  const id = randomUUID()
  await insertBeforeAiId(id)
  await migrateOk(migrator.migrateToLatest())

  await migrateOk(migrator.migrateTo('0005_school_rules_agreement'))
  for (const table of ['students', 'registrations', 'bans']) {
    expect(await columnsOf(table), table).toContain('install_id')
    expect(await columnsOf(table), table).not.toContain('ai_id')
  }
  const { rows } = await sql<{ installId: string }>`select install_id from students`.execute(t.db)
  expect(rows).toEqual([{ installId: id }])

  await migrateOk(migrator.migrateToLatest())
  expect(await t.db.selectFrom('students').select('aiId').executeTakeFirstOrThrow()).toEqual({ aiId: id })
})
