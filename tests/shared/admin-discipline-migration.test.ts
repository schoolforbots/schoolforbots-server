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

const AT = new Date('2026-11-04T04:00:00Z')
const record = (studentId: number, kind: string) =>
  t.db
    .insertInto('disciplineRecords')
    .values({ studentId, sessionId: null, kind: kind as never, detail: '{}', matchedTerm: null, createdAt: AT, revokedAt: null })
    .execute()

test('0008 lets a record be a withdrawal or a penalty lift, and still refuses any other kind', async () => {
  expect((await migrator.migrateTo('0007_llm')).error).toBeUndefined()
  const { id } = await insertStudent(t.db)
  await expect(record(id, 'withdrawal')).rejects.toThrow(/discipline_records_kind_check/)
  await record(id, 'suspension')

  expect((await migrator.migrateToLatest()).error).toBeUndefined()
  await record(id, 'withdrawal')
  await record(id, 'penalty_lift')
  await expect(record(id, 'bogus')).rejects.toThrow(/discipline_records_kind_check/)
})

test('0008 down removes the two kinds and puts the old check back', async () => {
  expect((await migrator.migrateToLatest()).error).toBeUndefined()
  const { id } = await insertStudent(t.db)
  await record(id, 'withdrawal')
  await record(id, 'penalty_lift')
  await record(id, 'expulsion')

  expect((await migrator.migrateTo('0007_llm')).error).toBeUndefined()
  const kinds = await t.db.selectFrom('disciplineRecords').select('kind').execute()
  expect(kinds).toEqual([{ kind: 'expulsion' }])
  await expect(record(id, 'withdrawal')).rejects.toThrow(/discipline_records_kind_check/)
})
