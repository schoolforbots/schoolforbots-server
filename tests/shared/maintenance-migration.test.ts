import { sql } from 'kysely'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { createTestDb } from '../helpers/db.js'

let t: Awaited<ReturnType<typeof createTestDb>>
beforeEach(async () => {
  t = await createTestDb()
})
afterEach(async () => {
  await t.destroy()
})

test('0011 creates maintenance_periods, and lets at most one row stay open', async () => {
  const tables = await t.db.introspection.getTables()
  const cols = tables.find((x) => x.name === 'maintenance_periods')?.columns.map((c) => c.name)
  expect(cols).toEqual(['id', 'message', 'expected_back_at', 'started_at', 'ended_at'])

  const open = (message: string) =>
    t.db.insertInto('maintenancePeriods').values({ message, expectedBackAt: null, startedAt: new Date(), endedAt: null }).execute()
  await open('一')
  await expect(open('二')).rejects.toThrow(/maintenance_periods_one_open|unique/)

  await t.db.updateTable('maintenancePeriods').set({ endedAt: new Date() }).execute()
  await open('二')
  expect(await t.db.selectFrom('maintenancePeriods').select('message').orderBy('id').execute()).toEqual([{ message: '一' }, { message: '二' }])
  const idx = await sql<{ indexname: string }>`select indexname from pg_indexes where tablename = 'maintenance_periods'`.execute(t.db)
  expect(idx.rows.map((r) => r.indexname)).toContain('maintenance_periods_one_open')
})
