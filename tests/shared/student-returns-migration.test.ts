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
import * as m0013 from '../../src/shared/migrations/0013_club_members.js'
import * as m0014 from '../../src/shared/migrations/0014_doudizhu_games.js'
import * as m0015 from '../../src/shared/migrations/0015_reinstated_at.js'
import * as m0016 from '../../src/shared/migrations/0016_notices.js'
import * as m0017 from '../../src/shared/migrations/0017_last_moved_at.js'
import * as m0018 from '../../src/shared/migrations/0018_student_returns.js'
import * as m0019 from '../../src/shared/migrations/0019_broadcasts.js'
import * as m0020 from '../../src/shared/migrations/0020_self_intro.js'
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
      '0012_ops': m0012,
      '0013_club_members': m0013,
      '0014_doudizhu_games': m0014,
      '0015_reinstated_at': m0015,
      '0016_notices': m0016,
      '0017_last_moved_at': m0017,
      '0018_student_returns': m0018,
      '0019_broadcasts': m0019,
      '0020_self_intro': m0020,
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
const BACK = new Date('2026-10-01T04:00:00Z')

const returns = () =>
  t.db.selectFrom('studentReturns').select(['studentId', 'kind', 'previousStudentId', 'sameIp', 'at']).orderBy('id').execute()

test('0018 records each student who re-enrolled before it once, at the last re-enroll, and nobody else', async () => {
  await migrateOk(migrator.migrateTo('0017_last_moved_at'))
  const back = await insertStudent(t.db, { status: 'pending', createdAt: REGISTERED, queuedAt: BACK })
  await insertStudent(t.db, { status: 'active', createdAt: REGISTERED, queuedAt: REGISTERED })
  await insertStudent(t.db, { status: 'dropped', createdAt: REGISTERED, queuedAt: REGISTERED })

  await migrateOk(migrator.migrateToLatest())

  expect(await returns()).toEqual([{ studentId: back.id, kind: 're_enroll', previousStudentId: null, sameIp: null, at: BACK }])
})

test('a re-enroll has no previous student, and a new student has one and says whether the address was the same', async () => {
  const gone = await insertStudent(t.db, { status: 'dropped' })
  const { id } = await insertStudent(t.db, { status: 'pending' })
  const insert = (values: Record<string, unknown>) =>
    t.db.insertInto('studentReturns').values({ studentId: id, at: BACK, ...values } as never).execute()

  await insert({ kind: 're_enroll' })
  await insert({ kind: 'new_student', previousStudentId: gone.id, sameIp: false })
  await expect(insert({ kind: 're_enroll', previousStudentId: gone.id })).rejects.toThrow(/student_returns_kind_check/)
  await expect(insert({ kind: 'new_student', previousStudentId: gone.id })).rejects.toThrow(/student_returns_kind_check/)
  await expect(insert({ kind: 'new_student', sameIp: true })).rejects.toThrow(/student_returns_kind_check/)
  await expect(insert({ kind: 'came_back' })).rejects.toThrow(/student_returns_kind_check/)
  await expect(insert({ kind: 'new_student', previousStudentId: 999_999, sameIp: true })).rejects.toThrow(/foreign key/)
})

test('0018 can be undone and applied again', async () => {
  await insertStudent(t.db, { status: 'pending', createdAt: REGISTERED, queuedAt: BACK })
  await migrateOk(migrator.migrateTo('0017_last_moved_at'))
  const tables = await t.db.introspection.getTables()
  expect(tables.map((table) => table.name)).not.toContain('student_returns')

  await migrateOk(migrator.migrateToLatest())
  expect(await returns()).toHaveLength(1)
})
