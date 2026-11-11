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

async function columns(table: string): Promise<string[]> {
  const tables = await t.db.introspection.getTables()
  return tables.find((x) => x.name === table)?.columns.map((c) => c.name) ?? []
}

test('0010 gives old lessons and versions no call-on reminders, and can be undone and applied again', async () => {
  await migrateOk(migrator.migrateTo('0009_llm_cached_tokens'))
  expect(await columns('lessons')).not.toContain('call_on_checks')
  expect(await columns('lesson_versions')).not.toContain('call_on_checks')
  await t.db
    .insertInto('lessons' as never)
    .values({ date: '2026-11-04', division: 'junior', subject: '科学', title: '课', segments: '[]', created_at: new Date() } as never)
    .execute()
  await t.db
    .insertInto('lessonVersions' as never)
    .values({ lesson_id: 1, version: 1, content: '{}', change: 'generate', created_at: new Date() } as never)
    .execute()

  await migrateOk(migrator.migrateToLatest())
  expect(await t.db.selectFrom('lessons').select('callOnChecks').execute()).toEqual([{ callOnChecks: [] }])
  expect(await t.db.selectFrom('lessonVersions').select('callOnChecks').execute()).toEqual([{ callOnChecks: [] }])

  await migrateOk(migrator.migrateTo('0009_llm_cached_tokens'))
  expect(await columns('lessons')).not.toContain('call_on_checks')
  expect(await columns('lesson_versions')).not.toContain('call_on_checks')
  expect(await t.db.selectFrom('lessons').select('title').execute()).toEqual([{ title: '课' }])

  await migrateOk(migrator.migrateToLatest())
  expect(await columns('lessons')).toContain('call_on_checks')
  expect(await columns('lesson_versions')).toContain('call_on_checks')
})
