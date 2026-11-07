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

async function migrateOk(run: Promise<{ error?: unknown }>) {
  const { error } = await run
  expect(error).toBeUndefined()
}

async function llmCallColumns(): Promise<string[]> {
  const tables = await t.db.introspection.getTables()
  return tables.find((x) => x.name === 'llm_calls')?.columns.map((c) => c.name) ?? []
}

const AT = new Date('2026-11-04T04:00:00Z')

test('0009 gives old llm_calls rows 0 cached input tokens, and can be undone and applied again', async () => {
  await migrateOk(migrator.migrateTo('0008_admin_discipline'))
  expect(await llmCallColumns()).not.toContain('cached_input_tokens')
  await t.db
    .insertInto('llmCalls' as never)
    .values({ purpose: 'lesson', provider: 'p', model: 'm', input_tokens: 10, output_tokens: 2, cost_yuan: '0.000123', outcome: 'ok', ms: 5, created_at: AT } as never)
    .execute()

  await migrateOk(migrator.migrateToLatest())
  expect(await llmCallColumns()).toContain('cached_input_tokens')
  expect(await t.db.selectFrom('llmCalls').select(['inputTokens', 'cachedInputTokens']).execute()).toEqual([
    { inputTokens: 10, cachedInputTokens: 0 },
  ])

  await migrateOk(migrator.migrateTo('0008_admin_discipline'))
  expect(await llmCallColumns()).not.toContain('cached_input_tokens')
  expect(await t.db.selectFrom('llmCalls').select('inputTokens').execute()).toEqual([{ inputTokens: 10 }])

  await migrateOk(migrator.migrateToLatest())
  expect(await llmCallColumns()).toContain('cached_input_tokens')
})
