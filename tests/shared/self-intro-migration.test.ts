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
import * as m0022 from '../../src/shared/migrations/0022_live_anonymous.js'
import { createTestDb } from '../helpers/db.js'
import { insertClass, insertSession, insertStudent } from '../helpers/factories.js'

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

const intros = () =>
  t.db.selectFrom('students').select(['id', 'intro', 'introClassId', 'introAttempts', 'introAttemptsOn']).orderBy('id').execute()

test('0020 counts a member who was in a session of their class as introduced there, and nobody else', async () => {
  await migrateOk(migrator.migrateTo('0019_broadcasts'))
  const classId = await insertClass(t.db, { division: 'junior', slot: 'evening', classNo: 1 })
  const other = await insertClass(t.db, { division: 'junior', slot: 'evening', classNo: 2 })
  const seen = await insertStudent(t.db, { status: 'active', classId })
  const placed = await insertStudent(t.db, { status: 'active', classId })
  // Was in a session of the other class, and has moved here since.
  const moved = await insertStudent(t.db, { status: 'active', classId })
  const waiting = await insertStudent(t.db, { status: 'pending' })
  await insertSession(t.db, {
    classId,
    date: '2026-11-02',
    kind: 'study',
    startsAt: new Date('2026-11-02T12:00:00Z'),
    endsAt: new Date('2026-11-02T12:30:00Z'),
    members: [{ studentId: seen.id, displayName: 'x' }],
  })
  await insertSession(t.db, {
    classId: other,
    date: '2026-11-02',
    kind: 'study',
    startsAt: new Date('2026-11-02T12:00:00Z'),
    endsAt: new Date('2026-11-02T12:30:00Z'),
    members: [{ studentId: moved.id, displayName: 'y' }],
  })

  await migrateOk(migrator.migrateTo('0020_self_intro'))
  const empty = { intro: null, introAttempts: 0, introAttemptsOn: null }
  expect(await intros()).toEqual([
    { id: seen.id, introClassId: classId, ...empty },
    { id: placed.id, introClassId: null, ...empty },
    { id: moved.id, introClassId: null, ...empty },
    { id: waiting.id, introClassId: null, ...empty },
  ])
})

test('0020 goes down and up again', async () => {
  await migrateOk(migrator.migrateTo('0020_self_intro'))
  await migrateOk(migrator.migrateTo('0019_broadcasts'))
  const columns = await t.db.introspection.getTables()
  const students = columns.find((c) => c.name === 'students')
  expect(students?.columns.map((c) => c.name)).not.toContain('intro')
  await migrateOk(migrator.migrateTo('0020_self_intro'))
})
