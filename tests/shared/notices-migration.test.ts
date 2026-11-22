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

const AT = new Date('2026-11-20T10:30:00Z')

const START = new Date('2026-11-23T18:00:00Z')
const END = new Date('2026-11-23T19:00:00Z')

function insert(values: {
  kind?: string
  status?: string
  publishedAt?: Date | null
  startsAt?: Date | null
  endsAt?: Date | null
}) {
  return t.db
    .insertInto('notices')
    .values({
      title: '公告',
      kind: (values.kind ?? 'general') as 'general',
      status: values.status as 'draft' | undefined,
      publishedAt: values.publishedAt ?? null,
      startsAt: values.startsAt ?? null,
      endsAt: values.endsAt ?? null,
      createdAt: AT,
    })
    .returning(['id', 'body', 'status', 'startsAt', 'endsAt', 'updatedAt'])
    .executeTakeFirstOrThrow()
}

test('0016 creates notices: a draft by default, with an empty body and no times', async () => {
  const tables = await t.db.introspection.getTables()
  const cols = tables.find((x) => x.name === 'notices')?.columns.map((c) => c.name)
  expect(cols).toEqual([
    'id', 'title', 'body', 'kind', 'starts_at', 'ends_at', 'status', 'published_at', 'updated_at', 'created_at',
  ])

  const first = await insert({})
  const second = await insert({ kind: 'maintenance', startsAt: START })
  expect(first).toEqual({ id: first.id, body: '', status: 'draft', startsAt: null, endsAt: null, updatedAt: null })
  expect(second.id).toBeGreaterThan(first.id)

  const idx = await sql<{ indexname: string }>`select indexname from pg_indexes where tablename = 'notices'`.execute(t.db)
  expect(idx.rows.map((r) => r.indexname)).toContain('notices_status_published_at')
})

test('0016 takes only the known kinds and statuses, and no notice ever published without its publishing time', async () => {
  await expect(insert({ kind: 'urgent' })).rejects.toThrow(/notices_kind_check/)
  await expect(insert({ status: 'hidden', publishedAt: AT })).rejects.toThrow(/notices_status_check/)
  await expect(insert({ status: 'published' })).rejects.toThrow(/notices_published_at_check/)
  await expect(insert({ status: 'withdrawn' })).rejects.toThrow(/notices_published_at_check/)

  // The check asks nothing of a draft.
  for (const status of ['draft', 'published', 'withdrawn']) await insert({ status, publishedAt: AT })
})

test('0016 gives a maintenance notice a start, and an end only after it; a general notice has neither', async () => {
  await insert({ kind: 'maintenance', startsAt: START })
  await insert({ kind: 'maintenance', startsAt: START, endsAt: END })

  await expect(insert({ kind: 'maintenance' })).rejects.toThrow(/notices_window_check/)
  await expect(insert({ kind: 'maintenance', endsAt: END })).rejects.toThrow(/notices_window_check/)
  await expect(insert({ kind: 'maintenance', startsAt: START, endsAt: START })).rejects.toThrow(/notices_window_check/)
  await expect(insert({ kind: 'maintenance', startsAt: END, endsAt: START })).rejects.toThrow(/notices_window_check/)
  await expect(insert({ kind: 'general', startsAt: START })).rejects.toThrow(/notices_window_check/)
  await expect(insert({ kind: 'general', endsAt: END })).rejects.toThrow(/notices_window_check/)
})
