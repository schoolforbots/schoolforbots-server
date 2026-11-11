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

test('0012 creates the four ops tables and the http_status column', async () => {
  const tables = await t.db.introspection.getTables()
  const cols = (name: string) => tables.find((x) => x.name === name)?.columns.map((c) => c.name)
  expect(cols('service_starts')).toEqual(['id', 'service', 'started_at'])
  expect(cols('ops_events')).toEqual(['id', 'service', 'kind', 'at'])
  expect(cols('alert_notices')).toEqual(['kind', 'last_sent_at'])
  expect(cols('backup_runs')).toEqual(['id', 'finished_at', 'ok'])
  expect(cols('llm_calls')).toContain('http_status')
})

test('backup_runs takes the backup script\'s insert with no id, and ops_events refuses an unknown kind', async () => {
  await sql`insert into backup_runs(finished_at, ok) values (now(), true)`.execute(t.db)
  await sql`insert into backup_runs(finished_at, ok) values (now(), false)`.execute(t.db)
  expect((await t.db.selectFrom('backupRuns').select('id').execute()).length).toBe(2)
  await expect(
    t.db.insertInto('opsEvents').values({ service: 'class', kind: 'bogus' as never, at: new Date() }).execute(),
  ).rejects.toThrow()
})
