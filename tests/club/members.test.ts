import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { dropStaleMemberships, isMember, join, joinedAt, leave, membersAmong } from '../../src/club/members.js'
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

/** When the students here registered, before anyone joins a club. */
const REGISTERED = new Date('2026-11-01T12:00:00Z')
const AT = new Date('2026-11-20T12:00:00Z')
const LATER = new Date('2026-11-21T12:00:00Z')

const student = async (status: StudentStatus = 'active') =>
  (await insertStudent(t.db, { status, createdAt: REGISTERED })).id

const rows = async () =>
  (await t.db.selectFrom('clubMembers').select(['studentId', 'joinedAt']).orderBy('studentId').execute())

describe('joining and leaving', () => {
  test('joining makes a member from that moment', async () => {
    const id = await student()
    expect(await isMember(t.db, id, 'doudizhu')).toBe(false)
    expect(await joinedAt(t.db, id, 'doudizhu')).toBeNull()

    expect(await join(t.db, id, 'doudizhu', AT)).toEqual(AT)
    expect(await isMember(t.db, id, 'doudizhu')).toBe(true)
    expect(await joinedAt(t.db, id, 'doudizhu')).toEqual(AT)
  })

  test('joining over a row left behind starts it again from the new moment', async () => {
    const id = await student()
    await join(t.db, id, 'doudizhu', AT)
    expect(await join(t.db, id, 'doudizhu', LATER)).toEqual(LATER)
    expect(await rows()).toEqual([{ studentId: id, joinedAt: LATER }])
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

describe('what counts as a membership', () => {
  test('only while the student is active or suspended', async () => {
    for (const status of ['pending', 'waitlisted', 'active', 'suspended', 'dropped', 'expelled'] as const) {
      const id = await student(status)
      await join(t.db, id, 'doudizhu', AT)
      expect(await isMember(t.db, id, 'doudizhu'), status).toBe(status === 'active' || status === 'suspended')
    }
  })

  test('a membership from before the student last joined the queue (a re-enrolment) does not count', async () => {
    const id = await student()
    await join(t.db, id, 'doudizhu', AT)
    // Withdrawn and back the next day: `queued_at` moves to the re-enrolment, and the nightly job seats them again.
    await t.db.updateTable('students').set({ queuedAt: LATER }).where('id', '=', id).execute()
    expect(await isMember(t.db, id, 'doudizhu')).toBe(false)
    expect(await membersAmong(t.db, [id], 'doudizhu')).toEqual(new Set())

    await join(t.db, id, 'doudizhu', LATER)
    expect(await joinedAt(t.db, id, 'doudizhu')).toEqual(LATER)
  })
})

describe('membersAmong', () => {
  test('gives the current members among the students asked about, and nobody for no students', async () => {
    const [a, b, c, gone] = [await student(), await student(), await student('suspended'), await student('dropped')]
    for (const id of [a, c, gone]) await join(t.db, id, 'doudizhu', AT)

    expect(await membersAmong(t.db, [a, b], 'doudizhu')).toEqual(new Set([a]))
    expect(await membersAmong(t.db, [a, b, c, gone], 'doudizhu')).toEqual(new Set([a, c]))
    expect(await membersAmong(t.db, [], 'doudizhu')).toEqual(new Set())
  })
})

describe('dropStaleMemberships', () => {
  test('deletes every row that is not a current membership, and no other', async () => {
    const keep: number[] = []
    for (const status of ['active', 'suspended'] as const) {
      const id = await student(status)
      await join(t.db, id, 'doudizhu', AT)
      keep.push(id)
    }
    for (const status of ['pending', 'waitlisted', 'dropped', 'expelled'] as const) {
      await join(t.db, await student(status), 'doudizhu', AT)
    }
    const reEnrolled = await student()
    await join(t.db, reEnrolled, 'doudizhu', AT)
    await t.db.updateTable('students').set({ queuedAt: LATER }).where('id', '=', reEnrolled).execute()

    expect(await dropStaleMemberships(t.db)).toBe(5)
    expect((await rows()).map((r) => r.studentId)).toEqual(keep)
    expect(await dropStaleMemberships(t.db)).toBe(0)
  })
})
