import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { dropNonStudents, isMember, join, joinedAt, leave, membersAmong } from '../../src/club/members.js'
import type { StudentStatus } from '../../src/shared/schema.js'
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
const LATER = new Date('2026-11-21T12:00:00Z')

const student = async (status: StudentStatus = 'active') => (await insertStudent(t.db, { status })).id

describe('joining and leaving', () => {
  test('joining makes a member from that moment, and joining again keeps the first moment', async () => {
    const id = await student()
    expect(await isMember(t.db, id, 'doudizhu')).toBe(false)
    expect(await joinedAt(t.db, id, 'doudizhu')).toBeNull()

    expect(await join(t.db, id, 'doudizhu', AT)).toEqual(AT)
    expect(await join(t.db, id, 'doudizhu', LATER)).toEqual(AT)
    expect(await isMember(t.db, id, 'doudizhu')).toBe(true)
    expect(await joinedAt(t.db, id, 'doudizhu')).toEqual(AT)
  })

  test('leaving ends the membership, and joining after it starts a new one', async () => {
    const id = await student()
    await join(t.db, id, 'doudizhu', AT)
    await leave(t.db, id, 'doudizhu')
    expect(await isMember(t.db, id, 'doudizhu')).toBe(false)
    // Leaving again changes nothing.
    await leave(t.db, id, 'doudizhu')

    expect(await join(t.db, id, 'doudizhu', LATER)).toEqual(LATER)
  })
})

describe('membersAmong', () => {
  test('gives the members among the students asked about, and nobody for no students', async () => {
    const [a, b, c] = [await student(), await student(), await student()]
    await join(t.db, a, 'doudizhu', AT)
    await join(t.db, c, 'doudizhu', AT)

    expect(await membersAmong(t.db, [a, b], 'doudizhu')).toEqual(new Set([a]))
    expect(await membersAmong(t.db, [a, b, c], 'doudizhu')).toEqual(new Set([a, c]))
    expect(await membersAmong(t.db, [], 'doudizhu')).toEqual(new Set())
  })
})

describe('dropNonStudents', () => {
  test('takes out the dropped and expelled students, and nobody else', async () => {
    const keep: number[] = []
    for (const status of ['pending', 'waitlisted', 'active', 'suspended'] as const) {
      const id = await student(status)
      await join(t.db, id, 'doudizhu', AT)
      keep.push(id)
    }
    for (const status of ['dropped', 'expelled'] as const) await join(t.db, await student(status), 'doudizhu', AT)

    expect(await dropNonStudents(t.db)).toBe(2)
    const left = await t.db.selectFrom('clubMembers').select('studentId').orderBy('studentId').execute()
    expect(left.map((r) => r.studentId)).toEqual(keep)
    expect(await dropNonStudents(t.db)).toBe(0)
  })
})
