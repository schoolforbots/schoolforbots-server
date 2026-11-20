import { sql } from 'kysely'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { createTestDb } from '../helpers/db.js'
import { insertStudent } from '../helpers/factories.js'

let t: Awaited<ReturnType<typeof createTestDb>>
beforeEach(async () => {
  t = await createTestDb()
})
afterEach(async () => {
  await t.destroy()
})

const AT = new Date('2026-11-20T12:00:00Z')

test('0013 creates club_members, one row per student and club', async () => {
  const tables = await t.db.introspection.getTables()
  const table = tables.find((x) => x.name === 'club_members')
  expect(table?.columns.map((c) => c.name)).toEqual(['student_id', 'club', 'joined_at'])
  expect(table?.columns.every((c) => !c.isNullable)).toBe(true)

  const { id } = await insertStudent(t.db, { status: 'active' })
  await t.db.insertInto('clubMembers').values({ studentId: id, club: 'doudizhu', joinedAt: AT }).execute()
  await expect(
    t.db.insertInto('clubMembers').values({ studentId: id, club: 'doudizhu', joinedAt: AT }).execute(),
  ).rejects.toThrow(/club_members_pkey|unique/)
  // Another club is another row.
  await t.db.insertInto('clubMembers').values({ studentId: id, club: 'chess', joinedAt: AT }).execute()
  expect(await t.db.selectFrom('clubMembers').select(['studentId', 'club', 'joinedAt']).orderBy('club').execute()).toEqual([
    { studentId: id, club: 'chess', joinedAt: AT },
    { studentId: id, club: 'doudizhu', joinedAt: AT },
  ])
})

test('a membership needs a student that exists', async () => {
  await expect(
    t.db.insertInto('clubMembers').values({ studentId: 999_999, club: 'doudizhu', joinedAt: AT }).execute(),
  ).rejects.toThrow(/foreign key/)
  const fk = await sql<{ conname: string }>`
    select conname from pg_constraint where conrelid = 'club_members'::regclass and contype = 'f'`.execute(t.db)
  expect(fk.rows).toHaveLength(1)
})
