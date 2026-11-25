import { Value } from 'typebox/value'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { isMember } from '../../src/club/members.js'
import { PlacementResult } from '../../src/protocol/http.js'
import { runHourlyAssignment } from '../../src/registration/daily-job.js'
import { buildTestApp } from '../helpers/app.js'
import { insertClass, insertStudent } from '../helpers/factories.js'

type TestApp = Awaited<ReturnType<typeof buildTestApp>>

const HOUR = 60 * 60_000
const DAY = 24 * HOUR

let t: TestApp

beforeEach(async () => {
  t = await buildTestApp()
})

afterEach(async () => {
  await t.destroy()
})

async function useConfig(config: NonNullable<Parameters<typeof buildTestApp>[0]>['config']) {
  await t.destroy()
  t = await buildTestApp({ config })
}

function move(key: string, body: unknown) {
  return t.app.inject({ method: 'PATCH', url: '/v1/me/placement', headers: { authorization: `Bearer ${key}` }, payload: body as object })
}

function errorOf(res: { json<T>(): T }) {
  return res.json<{ error: { code: string; [extra: string]: unknown } }>().error
}

const rowOf = (id: number) =>
  t.db
    .selectFrom('students')
    .select(['status', 'division', 'slot', 'classId', 'assignedAt', 'queuedAt', 'lastMovedAt', 'lessonsAttended'])
    .where('id', '=', id)
    .executeTakeFirstOrThrow()

describe('PATCH /v1/me/placement', () => {
  test('a student in a class leaves it, waits for a class of the new division and slot, and the next hour places them', async () => {
    const classId = await insertClass(t.db, { classNo: 1, division: 'junior', slot: 'evening' })
    const assignedAt = new Date(t.clock.now().getTime() - 10 * DAY)
    const { id, key } = await insertStudent(t.db, { status: 'active', classId, createdAt: assignedAt, assignedAt, division: 'junior', slot: 'evening' })
    await t.db.updateTable('students').set({ lessonsAttended: 7 }).where('id', '=', id).execute()
    const before = await rowOf(id)

    const res = await move(key, { division: 'senior', slot: 'morning' })
    expect(res.statusCode).toBe(200)
    expect(Value.Check(PlacementResult, res.json())).toBe(true)
    expect(res.json()).toEqual({ status: 'pending', division: 'senior', slot: 'morning', moved: true })
    expect(await rowOf(id)).toMatchObject({
      status: 'pending',
      division: 'senior',
      slot: 'morning',
      classId: null,
      assignedAt: null,
      queuedAt: before.queuedAt,
      lastMovedAt: t.clock.now(),
      lessonsAttended: 7,
    })

    t.clock.advance(HOUR)
    expect(await runHourlyAssignment({ db: t.db, config: t.config, clock: t.clock })).toMatchObject({ assigned: 1, classesCreated: 1 })
    const placed = await rowOf(id)
    expect(placed).toMatchObject({ status: 'active', division: 'senior', slot: 'morning', assignedAt: t.clock.now() })
    const newClass = await t.db.selectFrom('classes').select(['division', 'slot']).where('id', '=', placed.classId!).executeTakeFirstOrThrow()
    expect(newClass).toEqual({ division: 'senior', slot: 'morning' })
  })

  test('the club membership goes along: it counts again once the student is in the new class', async () => {
    const classId = await insertClass(t.db, { classNo: 1 })
    const { id, key } = await insertStudent(t.db, { status: 'active', classId, createdAt: new Date(t.clock.now().getTime() - 10 * DAY) })
    await t.db.insertInto('clubMembers').values({ studentId: id, club: 'doudizhu', joinedAt: new Date(t.clock.now().getTime() - 5 * DAY) }).execute()

    expect((await move(key, { division: 'primary', slot: 'evening' })).statusCode).toBe(200)
    // Waiting for a class, the student is not in the club for now.
    expect(await isMember(t.db, id, 'doudizhu')).toBe(false)
    await runHourlyAssignment({ db: t.db, config: t.config, clock: t.clock })
    expect(await isMember(t.db, id, 'doudizhu')).toBe(true)
  })

  test('within the slot the seat is kept: a move there never meets a full slot, and a waitlisted student keeps their place', async () => {
    await useConfig({ slotCapacity: 1 })
    const classId = await insertClass(t.db, { classNo: 1 })
    const seated = await insertStudent(t.db, { status: 'active', classId, division: 'junior', slot: 'evening' })
    const queuedAt = new Date(t.clock.now().getTime() - DAY)
    const waiting = await insertStudent(t.db, { status: 'waitlisted', division: 'junior', slot: 'evening', queuedAt })

    const res = await move(seated.key, { division: 'senior', slot: 'evening' })
    expect(res.json()).toEqual({ status: 'pending', division: 'senior', slot: 'evening', moved: true })

    expect((await move(waiting.key, { division: 'primary', slot: 'evening' })).json()).toEqual({
      status: 'waitlisted',
      division: 'primary',
      slot: 'evening',
      moved: true,
    })
    expect(await rowOf(waiting.id)).toMatchObject({ status: 'waitlisted', division: 'primary', queuedAt })
  })

  test('into a slot with no free seat, or with students waiting for one: 409 slot_full, and the student stays put', async () => {
    await useConfig({ slotCapacity: 1 })
    const classId = await insertClass(t.db, { classNo: 1 })
    const { id, key } = await insertStudent(t.db, { status: 'active', classId, slot: 'evening' })
    await insertStudent(t.db, { status: 'pending', slot: 'morning' })

    const full = await move(key, { division: 'junior', slot: 'morning' })
    expect(full.statusCode).toBe(409)
    expect(errorOf(full).code).toBe('slot_full')
    expect(await rowOf(id)).toMatchObject({ status: 'active', slot: 'evening', classId, lastMovedAt: null })

    // The afternoon has room, but somebody waits for a seat there (left over from a smaller capacity): no jumping the queue.
    await insertStudent(t.db, { status: 'waitlisted', slot: 'afternoon' })
    expect(errorOf(await move(key, { division: 'junior', slot: 'afternoon' })).code).toBe('slot_full')
  })

  test('once a day: a second move within moveCooldownDays is a 409 move_cooldown that says the day it is allowed again', async () => {
    const { key } = await insertStudent(t.db, { status: 'pending', division: 'junior', slot: 'evening' })

    expect((await move(key, { division: 'senior', slot: 'evening' })).statusCode).toBe(200)
    t.clock.advance(23 * HOUR)
    const early = await move(key, { division: 'primary', slot: 'evening' })
    expect(early.statusCode).toBe(409)
    // Moved at 12:00 on 2 November in Beijing: allowed again from 12:00 on 3 November.
    expect(errorOf(early)).toMatchObject({ code: 'move_cooldown', retryAfter: '2026-11-03' })

    t.clock.advance(HOUR)
    expect((await move(key, { division: 'primary', slot: 'evening' })).json()).toMatchObject({ division: 'primary', moved: true })
  })

  test('asking for the division and slot the student already has changes nothing and starts no cooldown', async () => {
    const classId = await insertClass(t.db, { classNo: 1 })
    const { id, key } = await insertStudent(t.db, { status: 'active', classId, division: 'junior', slot: 'evening' })

    expect((await move(key, { division: 'junior', slot: 'evening' })).json()).toEqual({
      status: 'active',
      division: 'junior',
      slot: 'evening',
      moved: false,
    })
    expect(await rowOf(id)).toMatchObject({ status: 'active', classId, lastMovedAt: null })
  })

  test('a suspended student cannot move: 409 still_suspended with the end of the suspension', async () => {
    const classId = await insertClass(t.db, { classNo: 1 })
    const until = new Date(t.clock.now().getTime() + 2 * DAY)
    const { key } = await insertStudent(t.db, { status: 'suspended', classId, suspendedUntil: until })

    const res = await move(key, { division: 'senior', slot: 'evening' })
    expect(res.statusCode).toBe(409)
    expect(errorOf(res)).toMatchObject({ code: 'still_suspended', until: until.toISOString() })
  })

  test('a student who has left the school cannot move: 409 wrong_status', async () => {
    const { key } = await insertStudent(t.db, { status: 'dropped' })
    const res = await move(key, { division: 'senior', slot: 'evening' })
    expect(res.statusCode).toBe(409)
    expect(errorOf(res).code).toBe('wrong_status')
  })

  test('a division or slot that does not exist is a 400 invalid_request', async () => {
    const { key } = await insertStudent(t.db, { status: 'pending' })
    expect((await move(key, { division: 'college', slot: 'evening' })).statusCode).toBe(400)
    expect((await move(key, { division: 'junior' })).statusCode).toBe(400)
  })

  test('two moves at once by one student: one goes through, the other meets the cooldown', async () => {
    const { key } = await insertStudent(t.db, { status: 'pending', division: 'junior', slot: 'evening' })
    const [a, b] = await Promise.all([
      move(key, { division: 'senior', slot: 'evening' }),
      move(key, { division: 'primary', slot: 'evening' }),
    ])
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409])
    expect(errorOf(a.statusCode === 409 ? a : b).code).toBe('move_cooldown')
  })
})
