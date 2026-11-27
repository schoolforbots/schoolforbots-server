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
import * as m0021 from '../../src/shared/migrations/0021_avatar.js'
import * as m0022 from '../../src/shared/migrations/0022_live_anonymous.js'
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
      '0021_avatar': m0021,
      '0022_live_anonymous': m0022,
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

async function studentColumns() {
  const tables = await t.db.introspection.getTables()
  return tables.find((x) => x.name === 'students')?.columns ?? []
}

test('0022 gives students a live_anonymous that is false, for those there already too, and can be undone and applied again', async () => {
  await migrateOk(migrator.migrateTo('0020_self_intro'))
  expect((await studentColumns()).map((c) => c.name)).not.toContain('live_anonymous')
  const { id } = await insertStudent(t.db, { status: 'active' })

  await migrateOk(migrator.migrateToLatest())
  const column = (await studentColumns()).find((c) => c.name === 'live_anonymous')
  expect(column).toMatchObject({ dataType: 'bool', isNullable: false, hasDefaultValue: true })
  expect(await t.db.selectFrom('students').select(['id', 'liveAnonymous']).execute()).toEqual([{ id, liveAnonymous: false }])

  await migrateOk(migrator.migrateTo('0020_self_intro'))
  expect((await studentColumns()).map((c) => c.name)).not.toContain('live_anonymous')
  expect(await t.db.selectFrom('students').select('id').execute()).toEqual([{ id }])

  await migrateOk(migrator.migrateToLatest())
  expect((await studentColumns()).map((c) => c.name)).toContain('live_anonymous')
})
