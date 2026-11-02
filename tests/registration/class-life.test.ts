import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { sql } from 'kysely'
import { Value } from 'typebox/value'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { Admission, Classmates, ErrorBody, InvalidNameError, ReEnrollResult, RenameResult } from '../../src/protocol/http.js'
import { runDailyJob } from '../../src/registration/daily-job.js'
import { loadSchoolConfig, type Slot } from '../../src/shared/config.js'
import { lock, slotLockKey } from '../../src/shared/db.js'
import { buildTestApp } from '../helpers/app.js'
import { insertClass, insertStudent } from '../helpers/factories.js'

type TestApp = Awaited<ReturnType<typeof buildTestApp>>

const DAY = 24 * 60 * 60_000
const exampleConfig = loadSchoolConfig(new URL('../../config/school.example.json', import.meta.url).pathname)

let t: TestApp

beforeEach(async () => {
  t = await buildTestApp()
})

afterEach(async () => {
  await t.destroy()
})

/** Replaces the app of the current test with one built from the example config plus these overrides. */
async function useConfig(config: NonNullable<Parameters<typeof buildTestApp>[0]>['config']) {
  await t.destroy()
  t = await buildTestApp({ config })
}

const bearer = (key: string) => ({ authorization: `Bearer ${key}` })

function get(url: string, key: string) {
  return t.app.inject({ method: 'GET', url, headers: bearer(key) })
}

function rename(key: string, body: unknown) {
  return t.app.inject({ method: 'PATCH', url: '/v1/me/name', headers: bearer(key), payload: body as object })
}

function reEnroll(key: string) {
  return t.app.inject({ method: 'POST', url: '/v1/me/re-enroll', headers: bearer(key) })
}

function errorOf(res: { json<T>(): T }) {
  return res.json<{ error: { code: string; message: string; [extra: string]: unknown } }>().error
}

/**
 * Makes every update of a student row take `ms` longer. A transaction that checks first and writes afterwards then
 * has a wide gap in between, so requests that are not properly serialized overlap in it on every run.
 */
async function slowStudentUpdates(ms: number) {
  await sql
    .raw(
      `create function slow_student_update() returns trigger language plpgsql as
       $$ begin perform pg_sleep(${ms / 1000}); return new; end $$`,
    )
    .execute(t.db)
  await sql
    .raw(
      `create trigger slow_student_update before update on students
       for each row execute function slow_student_update()`,
    )
    .execute(t.db)
}

const studentRow = (id: number) =>
  t.db.selectFrom('students').selectAll().where('id', '=', id).executeTakeFirstOrThrow()

const renameEvents = () =>
  t.db
    .selectFrom('renameEvents')
    .select(['studentId', 'classId', 'oldDisplayName', 'newDisplayName', 'createdAt', 'announcedAt'])
    .orderBy('id')
    .execute()

describe('authentication', () => {
  test('every endpoint needs a valid key', async () => {
    const requests = [
      { method: 'GET', url: '/v1/me/admission' },
      { method: 'GET', url: '/v1/me/classmates' },
      { method: 'PATCH', url: '/v1/me/name', payload: { ownerName: '阿杰', aiName: '小鱼' } },
      { method: 'POST', url: '/v1/me/re-enroll' },
    ] as const
    for (const request of requests) {
      const res = await t.app.inject({ ...request, headers: bearer('ais_notAKeyAnyoneWasGiven') })
      expect(res.statusCode, `${request.method} ${request.url}`).toBe(401)
      expect(errorOf(res).code).toBe('unauthorized')
    }
  })
})

describe('GET /v1/me/admission', () => {
  test('admission before assignment → 409 not_assigned', async () => {
    const { key } = await insertStudent(t.db, { status: 'pending' })

    const res = await get('/v1/me/admission', key)
    expect(res.statusCode).toBe(409)
    expect(errorOf(res).code).toBe('not_assigned')
    expect(Value.Check(ErrorBody, res.json())).toBe(true)
  })

  test('admission after the nightly job', async () => {
    const createdAt = t.clock.now()
    const me = await insertStudent(t.db, { ownerName: '阿杰', aiName: '小鱼', status: 'pending', createdAt })
    const other = await insertStudent(t.db, { ownerName: '小明', aiName: '大黄', status: 'pending', createdAt })
    t.clock.set(new Date('2026-11-03T00:00:00+08:00'))
    await runDailyJob({ db: t.db, config: exampleConfig, clock: t.clock })

    const res = await get('/v1/me/admission', me.key)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      studentId: me.id,
      displayName: '阿杰家的小鱼',
      division: 'junior',
      slot: 'evening',
      classNo: 1,
      className: '初中部·晚班·1 班',
      teacher: { name: '老周' },
      startsOn: '2026-11-03',
      classmates: [
        { studentId: me.id, displayName: '阿杰家的小鱼' },
        { studentId: other.id, displayName: '小明家的大黄' },
      ],
      suspendedUntil: null,
    })
    expect(Value.Check(Admission, res.json())).toBe(true)
  })

  test('a suspended student is still in the class: the letter and the roster come with the end of the suspension', async () => {
    const classId = await insertClass(t.db, { classNo: 1 })
    const assignedAt = new Date('2026-10-01T00:00:00Z')
    const suspendedUntil = new Date('2026-11-05T00:00:00+08:00')
    const me = await insertStudent(t.db, {
      ownerName: '阿杰',
      aiName: '小鱼',
      status: 'suspended',
      classId,
      assignedAt,
      suspendedUntil,
    })
    const other = await insertStudent(t.db, { ownerName: '小明', aiName: '大黄', status: 'active', classId, assignedAt })

    const res = await get('/v1/me/admission', me.key)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      studentId: me.id,
      className: '初中部·晚班·1 班',
      classmates: [
        { studentId: me.id, displayName: '阿杰家的小鱼' },
        { studentId: other.id, displayName: '小明家的大黄' },
      ],
      suspendedUntil: suspendedUntil.toISOString(),
    })
    expect(Value.Check(Admission, res.json())).toBe(true)

    // The classmate who is not suspended sees null.
    expect((await get('/v1/me/admission', other.key)).json()).toMatchObject({ suspendedUntil: null })
  })

  test('an expelled student has no class, so there is no letter → 409 not_assigned', async () => {
    const { key } = await insertStudent(t.db, { status: 'expelled' })

    const res = await get('/v1/me/admission', key)
    expect(res.statusCode).toBe(409)
    expect(errorOf(res).code).toBe('not_assigned')
  })

  test('startsOn is the assignment date in Beijing time, not in UTC', async () => {
    const classId = await insertClass(t.db, { classNo: 1 })
    // 20:00 UTC on 2 November is already 04:00 on 3 November in Beijing.
    const { key } = await insertStudent(t.db, {
      status: 'active',
      classId,
      assignedAt: new Date('2026-11-02T20:00:00Z'),
    })

    const res = await get('/v1/me/admission', key)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ startsOn: '2026-11-03' })
  })

  test('startsOn follows the configured timezone', async () => {
    await useConfig({ timezone: 'America/New_York' })
    const classId = await insertClass(t.db, { classNo: 1 })
    // 02:00 UTC on 3 November is still the evening of 2 November in New York.
    const { key } = await insertStudent(t.db, {
      status: 'active',
      classId,
      assignedAt: new Date('2026-11-03T02:00:00Z'),
    })

    expect((await get('/v1/me/admission', key)).json()).toMatchObject({ startsOn: '2026-11-02' })
  })

  test('a teacher missing from the config shows as the persona id', async () => {
    const classId = await insertClass(t.db, { classNo: 1, teacherPersonaId: 'retired-teacher' })
    const { key } = await insertStudent(t.db, { status: 'active', classId, assignedAt: t.clock.now() })

    expect((await get('/v1/me/admission', key)).json()).toMatchObject({ teacher: { name: 'retired-teacher' } })
  })
})

describe('GET /v1/me/classmates', () => {
  test('no class → 409 not_assigned', async () => {
    const { key } = await insertStudent(t.db, { status: 'waitlisted' })

    const res = await get('/v1/me/classmates', key)
    expect(res.statusCode).toBe(409)
    expect(errorOf(res).code).toBe('not_assigned')
  })

  test('classmates lists only active and suspended members', async () => {
    const classId = await insertClass(t.db, { classNo: 3 })
    const otherClassId = await insertClass(t.db, { classNo: 4 })
    const assignedAt = t.clock.now()
    const member = (p: Parameters<typeof insertStudent>[1]) => insertStudent(t.db, { classId, assignedAt, ...p })

    const me = await member({ ownerName: '甲', aiName: '一号', status: 'active' })
    const suspended = await member({ ownerName: '乙', aiName: '二号', status: 'suspended' })
    const active = await member({ ownerName: '丙', aiName: '三号', status: 'active' })
    // These never show up: a student who left, was expelled or is not yet admitted, and another class.
    await member({ ownerName: '丁', aiName: '四号', status: 'dropped' })
    await member({ ownerName: '戊', aiName: '五号', status: 'expelled' })
    await member({ ownerName: '己', aiName: '六号', status: 'pending' })
    await insertStudent(t.db, { ownerName: '庚', aiName: '七号', status: 'active', classId: otherClassId, assignedAt })

    const res = await get('/v1/me/classmates', me.key)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      className: '初中部·晚班·3 班',
      classmates: [
        { studentId: me.id, displayName: '甲家的一号' },
        { studentId: suspended.id, displayName: '乙家的二号' },
        { studentId: active.id, displayName: '丙家的三号' },
      ],
    })
    expect(Value.Check(Classmates, res.json())).toBe(true)
  })

  test('classmates are ordered by student number', async () => {
    const classId = await insertClass(t.db, { classNo: 1 })
    const assignedAt = t.clock.now()
    const ids: number[] = []
    for (let i = 0; i < 4; i++) {
      ids.push((await insertStudent(t.db, { status: 'active', classId, assignedAt })).id)
    }
    const { key } = await insertStudent(t.db, { status: 'suspended', classId, assignedAt })

    const listed = (await get('/v1/me/classmates', key)).json<{ classmates: { studentId: number }[] }>().classmates
    expect(listed.map((c) => c.studentId)).toEqual([...ids, listed.at(-1)!.studentId])
    expect(listed.map((c) => c.studentId)).toEqual([...listed.map((c) => c.studentId)].sort((a, b) => a - b))
  })
})

describe('PATCH /v1/me/name', () => {
  test('pending rename applies silently', async () => {
    const { id, key } = await insertStudent(t.db, { ownerName: '阿杰', aiName: '小鱼', status: 'pending' })

    const res = await rename(key, { ownerName: '阿杰', aiName: '大鱼' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ displayName: '阿杰家的大鱼', announced: false })
    expect(Value.Check(RenameResult, res.json())).toBe(true)

    const row = await studentRow(id)
    expect(row).toMatchObject({ ownerName: '阿杰', aiName: '大鱼', lastRenamedAt: null })
    expect(await renameEvents()).toEqual([])
  })

  test('a waitlisted student renames silently too, and as often as they like', async () => {
    const { id, key } = await insertStudent(t.db, { status: 'waitlisted' })

    expect((await rename(key, { ownerName: '甲', aiName: '一号' })).json()).toEqual({
      displayName: '甲家的一号',
      announced: false,
    })
    expect((await rename(key, { ownerName: '乙', aiName: '二号' })).json()).toEqual({
      displayName: '乙家的二号',
      announced: false,
    })
    expect(await studentRow(id)).toMatchObject({ ownerName: '乙', aiName: '二号', lastRenamedAt: null })
    expect(await renameEvents()).toEqual([])
  })

  test('the stored name is the normalized one', async () => {
    const { id, key } = await insertStudent(t.db, { status: 'pending' })

    const res = await rename(key, { ownerName: '  阿杰 ', aiName: '小​鱼' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ displayName: '阿杰家的小鱼' })
    expect(await studentRow(id)).toMatchObject({ ownerName: '阿杰', aiName: '小鱼' })
  })

  test('active rename is announced and starts the cooldown', async () => {
    const classId = await insertClass(t.db, { classNo: 1 })
    const { id, key } = await insertStudent(t.db, {
      ownerName: '阿杰',
      aiName: '小鱼',
      status: 'active',
      classId,
      assignedAt: t.clock.now(),
    })

    const renamedAt = t.clock.now()
    const res = await rename(key, { ownerName: '阿杰', aiName: '大鱼' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ displayName: '阿杰家的大鱼', announced: true })

    expect(await studentRow(id)).toMatchObject({ ownerName: '阿杰', aiName: '大鱼', lastRenamedAt: renamedAt })
    expect(await renameEvents()).toEqual([
      {
        studentId: id,
        classId,
        oldDisplayName: '阿杰家的小鱼',
        newDisplayName: '阿杰家的大鱼',
        createdAt: renamedAt,
        announcedAt: null,
      },
    ])

    // 29 days later the cooldown still holds; the answer says on which day it ends.
    t.clock.advance(29 * DAY)
    const early = await rename(key, { ownerName: '阿杰', aiName: '巨鱼' })
    expect(early.statusCode).toBe(409)
    expect(errorOf(early)).toMatchObject({ code: 'rename_cooldown', retryAfter: '2026-12-02' })
    expect(Value.Check(ErrorBody, early.json())).toBe(true)
    expect(await studentRow(id)).toMatchObject({ aiName: '大鱼', lastRenamedAt: renamedAt })
    expect(await renameEvents()).toHaveLength(1)

    // 31 days after the first rename it is allowed again, and the cooldown restarts.
    t.clock.advance(2 * DAY)
    const later = await rename(key, { ownerName: '阿杰', aiName: '巨鱼' })
    expect(later.statusCode).toBe(200)
    expect(later.json()).toEqual({ displayName: '阿杰家的巨鱼', announced: true })
    expect(await studentRow(id)).toMatchObject({ aiName: '巨鱼', lastRenamedAt: t.clock.now() })
    expect((await renameEvents()).map((e) => [e.oldDisplayName, e.newDisplayName])).toEqual([
      ['阿杰家的小鱼', '阿杰家的大鱼'],
      ['阿杰家的大鱼', '阿杰家的巨鱼'],
    ])
  })

  test('the cooldown ends exactly renameCooldownDays after the last rename', async () => {
    const classId = await insertClass(t.db, { classNo: 1 })
    const lastRenamedAt = t.clock.now()
    const { key } = await insertStudent(t.db, { status: 'active', classId, assignedAt: lastRenamedAt, lastRenamedAt })

    t.clock.advance(30 * DAY - 1)
    expect((await rename(key, { ownerName: '甲', aiName: '一号' })).statusCode).toBe(409)
    t.clock.advance(1)
    expect((await rename(key, { ownerName: '甲', aiName: '一号' })).statusCode).toBe(200)
  })

  test('a suspended student renames like an active one', async () => {
    const classId = await insertClass(t.db, { classNo: 1 })
    const { id, key } = await insertStudent(t.db, {
      ownerName: '阿杰',
      aiName: '小鱼',
      status: 'suspended',
      classId,
      assignedAt: t.clock.now(),
    })

    const res = await rename(key, { ownerName: '阿杰', aiName: '大鱼' })
    expect(res.json()).toEqual({ displayName: '阿杰家的大鱼', announced: true })
    expect(await renameEvents()).toMatchObject([{ studentId: id, classId }])
  })

  test('rename to a classmate name → 409 name_taken', async () => {
    const classId = await insertClass(t.db, { classNo: 1 })
    const otherClassId = await insertClass(t.db, { classNo: 2 })
    const assignedAt = t.clock.now()
    const { id, key } = await insertStudent(t.db, {
      ownerName: '阿杰',
      aiName: '小鱼',
      status: 'active',
      classId,
      assignedAt,
    })
    await insertStudent(t.db, { ownerName: '小明', aiName: '大黄', status: 'suspended', classId, assignedAt })
    // Names of someone in another class, and of someone who left this one, are free to take.
    await insertStudent(t.db, { ownerName: '小红', aiName: '花花', status: 'active', classId: otherClassId, assignedAt })
    await insertStudent(t.db, { ownerName: '小刚', aiName: '旺财', status: 'dropped', classId, assignedAt })

    const taken = await rename(key, { ownerName: '小明', aiName: '大黄' })
    expect(taken.statusCode).toBe(409)
    expect(errorOf(taken).code).toBe('name_taken')
    expect(Value.Check(ErrorBody, taken.json())).toBe(true)
    // A refused rename costs nothing: no cooldown, no announcement, no change.
    expect(await studentRow(id)).toMatchObject({ ownerName: '阿杰', aiName: '小鱼', lastRenamedAt: null })
    expect(await renameEvents()).toEqual([])

    expect((await rename(key, { ownerName: '小红', aiName: '花花' })).statusCode).toBe(200)
  })

  test.each([
    ['a combining grapheme joiner', '小鱼\u034f'],
    ['an emoji variation selector', '小鱼\ufe0f'],
    ['a Hangul filler', '小鱼\u3164'],
    ['a Braille blank', '小鱼\u2800'],
  ])('a classmate name with %s added is still taken', async (_label, aiName) => {
    const classId = await insertClass(t.db, { classNo: 1 })
    const assignedAt = t.clock.now()
    const { id, key } = await insertStudent(t.db, { status: 'active', classId, assignedAt })
    await insertStudent(t.db, { ownerName: '阿杰', aiName: '小鱼', status: 'active', classId, assignedAt })

    const res = await rename(key, { ownerName: '阿杰', aiName })
    expect(res.statusCode).toBe(409)
    expect(errorOf(res).code).toBe('name_taken')
    expect(await studentRow(id)).toMatchObject({ lastRenamedAt: null })
  })

  test('a classmate name is still taken when an invisible character keeps an accent decomposed', async () => {
    const classId = await insertClass(t.db, { classNo: 1 })
    const assignedAt = t.clock.now()
    const { id, key } = await insertStudent(t.db, { status: 'active', classId, assignedAt })
    // The classmate is 阿杰家的小鱼é (precomposed é); e + combining grapheme joiner + combining acute looks the same.
    await insertStudent(t.db, { ownerName: '阿杰', aiName: '小鱼é', status: 'active', classId, assignedAt })

    const res = await rename(key, { ownerName: '阿杰', aiName: '小鱼e͏́' })
    expect(res.statusCode).toBe(409)
    expect(errorOf(res).code).toBe('name_taken')
    expect(await studentRow(id)).toMatchObject({ lastRenamedAt: null })
    expect(await renameEvents()).toEqual([])
  })

  test('the owner and AI parts are compared as the joined display name', async () => {
    const classId = await insertClass(t.db, { classNo: 1 })
    const assignedAt = t.clock.now()
    const { key } = await insertStudent(t.db, { status: 'active', classId, assignedAt })
    // "甲家的乙" + "丙" and "甲" + "乙家的丙" both display as 甲家的乙家的丙.
    await insertStudent(t.db, { ownerName: '甲家的乙', aiName: '丙', status: 'active', classId, assignedAt })

    const res = await rename(key, { ownerName: '甲', aiName: '乙家的丙' })
    expect(res.statusCode).toBe(409)
    expect(errorOf(res).code).toBe('name_taken')
  })

  test.each([
    ['a Cyrillic AI name', { ownerName: '阿杰', aiName: 'TOM' }, { ownerName: '阿杰', aiName: '\u0422\u041E\u041C' }],
    ['a Greek AI name', { ownerName: '阿杰', aiName: 'TOM' }, { ownerName: '阿杰', aiName: '\u03A4\u039F\u039C' }],
    ['a Cyrillic owner name', { ownerName: 'Pop', aiName: '小鱼' }, { ownerName: '\u0420\u043E\u0440', aiName: '小鱼' }],
    ['a Latin name for a classmate with the Cyrillic one', { ownerName: '阿杰', aiName: '\u0422\u041E\u041C' }, { ownerName: '阿杰', aiName: 'TOM' }],
  ])('a classmate name written with look-alike letters is still taken: %s', async (_label, classmate, wanted) => {
    const classId = await insertClass(t.db, { classNo: 1 })
    const assignedAt = t.clock.now()
    const { id, key } = await insertStudent(t.db, { status: 'active', classId, assignedAt })
    await insertStudent(t.db, { ...classmate, status: 'active', classId, assignedAt })

    const res = await rename(key, wanted)
    expect(res.statusCode).toBe(409)
    expect(errorOf(res).code).toBe('name_taken')
    expect(await studentRow(id)).toMatchObject({ lastRenamedAt: null })
    expect(await renameEvents()).toEqual([])
  })

  test('a name that differs from the classmate\'s by a letter that is not a look-alike is free', async () => {
    const classId = await insertClass(t.db, { classNo: 1 })
    const assignedAt = t.clock.now()
    const { key } = await insertStudent(t.db, { status: 'active', classId, assignedAt })
    await insertStudent(t.db, { ownerName: '阿杰', aiName: 'TOM', status: 'active', classId, assignedAt })

    // Cyrillic Т О and a Cyrillic small te, which is not in the table
    const res = await rename(key, { ownerName: '阿杰', aiName: '\u0422\u041E\u0442' })
    expect(res.statusCode).toBe(200)
  })

  test('concurrent renames to one name in a class let exactly one through', async () => {
    const classId = await insertClass(t.db, { classNo: 1 })
    const assignedAt = t.clock.now()
    const students = []
    for (let i = 0; i < 5; i++) students.push(await insertStudent(t.db, { status: 'active', classId, assignedAt }))
    await slowStudentUpdates(100)

    const results = await Promise.all(students.map((s) => rename(s.key, { ownerName: '抢注', aiName: '小鱼' })))
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409, 409, 409, 409])
    expect(await renameEvents()).toHaveLength(1)
    const named = await t.db.selectFrom('students').select('id').where('ownerName', '=', '抢注').execute()
    expect(named).toHaveLength(1)
  })

  /** Holds the lock of `slot` in an open transaction until `release` is called. */
  async function holdSlotLock(slot: Slot) {
    let release!: () => void
    const released = new Promise<void>((resolve) => (release = resolve))
    let locked!: () => void
    const isLocked = new Promise<void>((resolve) => (locked = resolve))
    const holder = t.db.transaction().execute(async (trx) => {
      await lock(trx, slotLockKey(slot))
      locked()
      await released
    })
    await isLocked
    return {
      async release() {
        release()
        await holder
      },
    }
  }

  test.each(['pending', 'active'] as const)(
    'rename of a student who is %s waits for the slot lock, which the nightly job holds while it reads names',
    async (status) => {
      const classId = status === 'active' ? await insertClass(t.db, { classNo: 1 }) : null
      const { key } = await insertStudent(t.db, { status, slot: 'evening', classId, assignedAt: classId === null ? null : t.clock.now() })
      const held = await holdSlotLock('evening')

      let finished = false
      const renaming = rename(key, { ownerName: '甲', aiName: '一号' }).then((res) => {
        finished = true
        return res
      })
      await sleep(300)
      const finishedWhileLocked = finished
      await held.release()

      expect(finishedWhileLocked).toBe(false)
      expect((await renaming).statusCode).toBe(200)
    },
  )

  test('another slot\'s lock does not hold a rename up', async () => {
    const classId = await insertClass(t.db, { classNo: 1 })
    const { key } = await insertStudent(t.db, { status: 'active', slot: 'evening', classId, assignedAt: t.clock.now() })
    const held = await holdSlotLock('morning')
    try {
      expect((await rename(key, { ownerName: '甲', aiName: '一号' })).statusCode).toBe(200)
    } finally {
      await held.release()
    }
  })

  test('concurrent renames by one student start the cooldown once', async () => {
    const classId = await insertClass(t.db, { classNo: 1 })
    const { key } = await insertStudent(t.db, { status: 'active', classId, assignedAt: t.clock.now() })
    await slowStudentUpdates(100)

    const results = await Promise.all(
      ['甲', '乙', '丙'].map((owner) => rename(key, { ownerName: owner, aiName: '小鱼' })),
    )
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409, 409])
    expect(await renameEvents()).toHaveLength(1)
  })

  test('rename failing moderation → 400 invalid_name', async () => {
    const { id, key } = await insertStudent(t.db, { ownerName: '阿杰', aiName: '小鱼', status: 'pending' })

    const tooLong = await rename(key, { ownerName: '阿杰', aiName: '一二三四五六七八九十零' })
    expect(tooLong.statusCode).toBe(400)
    expect(errorOf(tooLong)).toMatchObject({ code: 'invalid_name', part: 'ai', reason: 'too_long' })
    expect(Value.Check(ErrorBody, tooLong.json())).toBe(true)

    const empty = await rename(key, { ownerName: ' ', aiName: '小鱼' })
    expect(empty.statusCode).toBe(400)
    expect(errorOf(empty)).toMatchObject({ code: 'invalid_name', part: 'owner', reason: 'empty' })

    expect(await studentRow(id)).toMatchObject({ ownerName: '阿杰', aiName: '小鱼' })
  })

  test('a name that mixes look-alike scripts → 400 invalid_name, mixed_script, and nothing changes', async () => {
    const classId = await insertClass(t.db, { classNo: 1 })
    const { id, key } = await insertStudent(t.db, { ownerName: '阿杰', aiName: '小鱼', status: 'active', classId, assignedAt: t.clock.now() })

    // Т and о are Cyrillic, m is Latin: it reads as Tom.
    const res = await rename(key, { ownerName: '阿杰', aiName: 'Тоm' })
    expect(res.statusCode).toBe(400)
    expect(errorOf(res)).toMatchObject({ code: 'invalid_name', part: 'ai', reason: 'mixed_script' })
    expect(Value.Check(InvalidNameError, res.json())).toBe(true)
    expect(await studentRow(id)).toMatchObject({ ownerName: '阿杰', aiName: '小鱼', lastRenamedAt: null })
    expect(await renameEvents()).toEqual([])
  })

  test('a name the moderator blocks → 400 invalid_name, and an active student keeps the cooldown free', async () => {
    const classId = await insertClass(t.db, { classNo: 1 })
    const { id, key } = await insertStudent(t.db, { status: 'active', classId, assignedAt: t.clock.now() })

    const res = await rename(key, { ownerName: '阿杰', aiName: '示例违禁词' })
    expect(res.statusCode).toBe(400)
    expect(errorOf(res)).toMatchObject({ code: 'invalid_name', part: 'ai', reason: 'moderation' })
    expect(await studentRow(id)).toMatchObject({ lastRenamedAt: null })
    expect(await renameEvents()).toEqual([])
  })

  test('a rename whose joined display name fails moderation → 400 invalid_name, part both', async () => {
    const classId = await insertClass(t.db, { classNo: 1 })
    const { id, key } = await insertStudent(t.db, { ownerName: '阿杰', aiName: '小鱼', status: 'active', classId, assignedAt: t.clock.now() })

    // QQ家的12345678 reads as a QQ number, though neither part does alone.
    const res = await rename(key, { ownerName: 'QQ', aiName: '12345678' })
    expect(res.statusCode).toBe(400)
    expect(errorOf(res)).toMatchObject({ code: 'invalid_name', part: 'both', reason: 'moderation' })
    expect(Value.Check(InvalidNameError, res.json())).toBe(true)
    expect(await studentRow(id)).toMatchObject({ ownerName: '阿杰', aiName: '小鱼', lastRenamedAt: null })
    expect(await renameEvents()).toEqual([])
  })

  test.each(['pending', 'waitlisted', 'active', 'suspended'] as const)(
    '%s student: renaming to the name already held changes nothing, even during the cooldown',
    async (status) => {
      const inClass = status === 'active' || status === 'suspended'
      const classId = inClass ? await insertClass(t.db, { classNo: 1 }) : null
      // Renamed a moment ago, so a real rename would hit the cooldown.
      const lastRenamedAt = inClass ? t.clock.now() : null
      const { id, key } = await insertStudent(t.db, {
        ownerName: '阿杰',
        aiName: '小鱼',
        status,
        classId,
        assignedAt: inClass ? t.clock.now() : null,
        lastRenamedAt,
      })
      const before = await studentRow(id)
      t.clock.advance(DAY)

      // The same name once normalized: spacing and an invisible character do not make it a new one.
      for (const body of [
        { ownerName: '阿杰', aiName: '小鱼' },
        { ownerName: ' 阿杰 ', aiName: '小鱼\u034f' },
      ]) {
        const res = await rename(key, body)
        expect(res.statusCode, status).toBe(200)
        expect(res.json(), status).toEqual({ displayName: '阿杰家的小鱼', announced: false })
      }
      expect(await studentRow(id)).toEqual(before)
      expect(await renameEvents()).toEqual([])
    },
  )

  test('renaming to the name already held neither starts the cooldown nor is announced', async () => {
    const classId = await insertClass(t.db, { classNo: 1 })
    const { id, key } = await insertStudent(t.db, { ownerName: '阿杰', aiName: '小鱼', status: 'active', classId, assignedAt: t.clock.now() })

    const res = await rename(key, { ownerName: '阿杰', aiName: '小鱼' })
    expect(res.json()).toEqual({ displayName: '阿杰家的小鱼', announced: false })
    expect(await studentRow(id)).toMatchObject({ lastRenamedAt: null })
    expect(await renameEvents()).toEqual([])

    // So a real rename right after it still goes through.
    expect((await rename(key, { ownerName: '阿杰', aiName: '大鱼' })).json()).toEqual({ displayName: '阿杰家的大鱼', announced: true })
  })

  test('dropped and expelled students cannot rename, not even to the name they have → 409 wrong_status', async () => {
    for (const status of ['dropped', 'expelled'] as const) {
      const { key } = await insertStudent(t.db, { ownerName: '阿杰', aiName: '小鱼', status })
      const res = await rename(key, { ownerName: '阿杰', aiName: '小鱼' })
      expect(res.statusCode, status).toBe(409)
      expect(errorOf(res).code, status).toBe('wrong_status')
    }
  })

  test('dropped and expelled students cannot rename → 409 wrong_status', async () => {
    for (const status of ['dropped', 'expelled'] as const) {
      const { id, key } = await insertStudent(t.db, { ownerName: '阿杰', aiName: '小鱼', status })
      const res = await rename(key, { ownerName: '阿杰', aiName: '大鱼' })
      expect(res.statusCode, status).toBe(409)
      expect(errorOf(res).code, status).toBe('wrong_status')
      expect(await studentRow(id), status).toMatchObject({ aiName: '小鱼' })
    }
  })

  test('malformed bodies → 400 invalid_request', async () => {
    const { key } = await insertStudent(t.db, { status: 'pending' })
    const bodies = [
      {},
      { ownerName: '阿杰' },
      { aiName: '小鱼' },
      { ownerName: 1, aiName: '小鱼' },
      { ownerName: 'x'.repeat(65), aiName: '小鱼' },
      { ownerName: '阿杰', aiName: 'x'.repeat(65) },
    ]
    for (const body of bodies) {
      const res = await rename(key, body)
      expect(res.statusCode, JSON.stringify(body).slice(0, 40)).toBe(400)
      expect(errorOf(res).code).toBe('invalid_request')
    }
  })
})

describe('POST /v1/me/re-enroll', () => {
  test('re-enroll only from dropped; full slot → waitlisted', async () => {
    await useConfig({ slotCapacity: 2 })
    const classId = await insertClass(t.db, { classNo: 1 })
    const assignedAt = t.clock.now()
    await insertStudent(t.db, { status: 'active', classId, assignedAt })

    // Dropped, with a free seat in the slot.
    const dropped = await insertStudent(t.db, { status: 'dropped' })
    const first = await reEnroll(dropped.key)
    expect(first.statusCode).toBe(200)
    expect(first.json()).toEqual({ status: 'pending' })
    expect(Value.Check(ReEnrollResult, first.json())).toBe(true)
    expect(await studentRow(dropped.id)).toMatchObject({ id: dropped.id, status: 'pending' })

    // Any other status is refused, including the student who has just come back.
    const refused = {
      pending: dropped,
      waitlisted: await insertStudent(t.db, { status: 'waitlisted' }),
      active: await insertStudent(t.db, { status: 'active', classId, assignedAt }),
      suspended: await insertStudent(t.db, { status: 'suspended', classId, assignedAt }),
      expelled: await insertStudent(t.db, { status: 'expelled' }),
    }
    for (const [status, student] of Object.entries(refused)) {
      const res = await reEnroll(student.key)
      expect(res.statusCode, status).toBe(409)
      expect(errorOf(res).code, status).toBe('wrong_status')
      expect(Value.Check(ErrorBody, res.json()), status).toBe(true)
    }
    expect((await studentRow(refused.expelled.id)).status).toBe('expelled')

    // The slot is full now (active + pending + active + suspended), so the next one waits.
    const another = await insertStudent(t.db, { status: 'dropped' })
    const second = await reEnroll(another.key)
    expect(second.statusCode).toBe(200)
    expect(second.json()).toEqual({ status: 'waitlisted' })
    expect(await studentRow(another.id)).toMatchObject({ id: another.id, status: 'waitlisted' })
  })

  test('re-enrolling resets the class record and keeps the student number', async () => {
    const classId = await insertClass(t.db, { classNo: 1 })
    const { id, key } = await insertStudent(t.db, {
      ownerName: '阿杰',
      aiName: '小鱼',
      status: 'dropped',
      classId,
      assignedAt: new Date('2026-09-01T00:00:00Z'),
      lastAttendedAt: new Date('2026-09-20T12:00:00Z'),
      lastRenamedAt: new Date('2026-09-10T12:00:00Z'),
    })
    await t.db.updateTable('students').set({ lessonsAttended: 7 }).where('id', '=', id).execute()

    const res = await reEnroll(key)
    expect(res.statusCode).toBe(200)

    const row = await studentRow(id)
    expect(row).toMatchObject({
      id,
      status: 'pending',
      classId: null,
      lessonsAttended: 0,
      lastAttendedAt: null,
      assignedAt: null,
      ownerName: '阿杰',
      aiName: '小鱼',
      lastRenamedAt: new Date('2026-09-10T12:00:00Z'),
    })
    // Same key, same number: the plugin keeps working with what it has.
    expect(((await get('/v1/me', key)).json<{ studentId: number }>()).studentId).toBe(id)
  })

  test('re-enroll joins the queue now: queued_at is the clock time, created_at is untouched', async () => {
    const registeredAt = new Date('2026-08-01T04:00:00Z')
    const { id, key } = await insertStudent(t.db, { status: 'dropped', createdAt: registeredAt, queuedAt: registeredAt })

    expect((await reEnroll(key)).json()).toEqual({ status: 'pending' })
    expect(await studentRow(id)).toMatchObject({ createdAt: registeredAt, queuedAt: t.clock.now() })

    // The same when the slot is full and the student waits.
    await useConfig({ slotCapacity: 1 })
    await insertStudent(t.db, { slot: 'evening', status: 'active' })
    const waiting = await insertStudent(t.db, { status: 'dropped', createdAt: registeredAt, queuedAt: registeredAt })
    t.clock.advance(3 * DAY)

    expect((await reEnroll(waiting.key)).json()).toEqual({ status: 'waitlisted' })
    expect(await studentRow(waiting.id)).toMatchObject({ createdAt: registeredAt, queuedAt: t.clock.now() })
  })

  test('a returner waits behind students who were already on the waitlist', async () => {
    const config = { ...exampleConfig, slotCapacity: 1 }
    await useConfig({ slotCapacity: 1 })
    const now = t.clock.now()
    const classId = await insertClass(t.db, { classNo: 1 })
    // The only seat belongs to a student who stopped coming, so the nightly job frees it.
    await insertStudent(t.db, {
      status: 'active',
      classId,
      assignedAt: new Date(now.getTime() - 60 * DAY),
      lastAttendedAt: new Date(now.getTime() - 31 * DAY),
    })
    // Registered a day ago and has been waiting since.
    const waiting = await insertStudent(t.db, {
      status: 'waitlisted',
      createdAt: new Date(now.getTime() - 1 * DAY),
    })
    // Registered long before that, dropped out, and comes back today into the full slot.
    const returner = await insertStudent(t.db, {
      status: 'dropped',
      createdAt: new Date(now.getTime() - 90 * DAY),
    })
    expect((await reEnroll(returner.key)).json()).toEqual({ status: 'waitlisted' })

    expect(await runDailyJob({ db: t.db, config, clock: t.clock })).toMatchObject({ dropped: 1, promoted: 1 })
    expect(await studentRow(waiting.id)).toMatchObject({ status: 'active' })
    expect(await studentRow(returner.id)).toMatchObject({ status: 'waitlisted', classId: null })
  })

  test('a returning student is placed by the next nightly job', async () => {
    const { id, key } = await insertStudent(t.db, { status: 'dropped' })
    expect((await reEnroll(key)).statusCode).toBe(200)

    t.clock.set(new Date('2026-11-03T00:00:00+08:00'))
    expect(await runDailyJob({ db: t.db, config: exampleConfig, clock: t.clock })).toMatchObject({ assigned: 1 })
    expect(await studentRow(id)).toMatchObject({ status: 'active', assignedAt: t.clock.now() })
    expect((await get('/v1/me/admission', key)).statusCode).toBe(200)
  })

  test('capacity counts pending, active and suspended students of the slot only', async () => {
    await useConfig({ slotCapacity: 3 })
    await insertStudent(t.db, { slot: 'evening', status: 'active' })
    await insertStudent(t.db, { slot: 'evening', status: 'pending' })
    await insertStudent(t.db, { slot: 'evening', status: 'suspended' })
    await insertStudent(t.db, { slot: 'evening', status: 'waitlisted' })
    await insertStudent(t.db, { slot: 'evening', status: 'expelled' })
    const wait = await insertStudent(t.db, { slot: 'evening', status: 'dropped' })
    const morning = await insertStudent(t.db, { slot: 'morning', status: 'dropped' })

    expect((await reEnroll(wait.key)).json()).toEqual({ status: 'waitlisted' })
    expect((await reEnroll(morning.key)).json()).toEqual({ status: 'pending' })
  })

  test('a returner does not take a free seat ahead of students waiting in the slot', async () => {
    await useConfig({ slotCapacity: 4 })
    await insertStudent(t.db, { slot: 'evening', status: 'active' })
    // The seat is free, but the nightly job has not yet promoted this one: the returner must not jump the queue.
    await insertStudent(t.db, { slot: 'evening', status: 'waitlisted' })
    const evening = await insertStudent(t.db, { slot: 'evening', status: 'dropped' })
    // A waitlist in another slot holds nobody back here, and the other way round.
    const morning = await insertStudent(t.db, { slot: 'morning', status: 'dropped' })

    expect((await reEnroll(evening.key)).json()).toEqual({ status: 'waitlisted' })
    expect(await studentRow(evening.id)).toMatchObject({ status: 'waitlisted', queuedAt: t.clock.now() })
    expect((await reEnroll(morning.key)).json()).toEqual({ status: 'pending' })
  })

  test('once nobody waits in the slot, a returner gets a free seat again', async () => {
    await useConfig({ slotCapacity: 4 })
    const waiting = await insertStudent(t.db, { slot: 'evening', status: 'waitlisted' })
    const first = await insertStudent(t.db, { slot: 'evening', status: 'dropped' })
    const second = await insertStudent(t.db, { slot: 'evening', status: 'dropped' })

    expect((await reEnroll(first.key)).json()).toEqual({ status: 'waitlisted' })

    // The waiting students leave the waitlist (promoted or dropped); the free seat is then for the next arrival.
    await t.db.updateTable('students').set({ status: 'dropped' }).where('slot', '=', 'evening').where('status', '=', 'waitlisted').execute()
    expect(await studentRow(waiting.id)).toMatchObject({ status: 'dropped' })
    expect((await reEnroll(second.key)).json()).toEqual({ status: 'pending' })
  })

  test('concurrent re-enrolls cannot overshoot the slot capacity', async () => {
    await useConfig({ slotCapacity: 2 })
    const dropped = []
    for (let i = 0; i < 5; i++) dropped.push(await insertStudent(t.db, { status: 'dropped' }))
    await slowStudentUpdates(100)

    const results = await Promise.all(dropped.map((s) => reEnroll(s.key)))
    expect(results.map((r) => r.statusCode)).toEqual([200, 200, 200, 200, 200])
    expect(results.map((r) => r.json<{ status: string }>().status).sort()).toEqual([
      'pending',
      'pending',
      'waitlisted',
      'waitlisted',
      'waitlisted',
    ])
  })

  test('the same student re-enrolling twice at once is accepted once', async () => {
    const { key } = await insertStudent(t.db, { status: 'dropped' })
    await slowStudentUpdates(100)

    const results = await Promise.all([reEnroll(key), reEnroll(key), reEnroll(key)])
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409, 409])
  })

  test('an install that has taken another seat meanwhile → 409 install_has_seat', async () => {
    const installId = randomUUID()
    const dropped = await insertStudent(t.db, { status: 'dropped', installId })
    await insertStudent(t.db, { status: 'pending', installId })

    const res = await reEnroll(dropped.key)
    expect(res.statusCode).toBe(409)
    expect(errorOf(res).code).toBe('install_has_seat')
    expect((await studentRow(dropped.id)).status).toBe('dropped')
  })

  test('an email already at its seat limit → 409 email_limit', async () => {
    const email = 'family@example.com'
    const dropped = await insertStudent(t.db, { status: 'dropped', email })
    for (let i = 0; i < 3; i++) await insertStudent(t.db, { status: 'active', email })

    const res = await reEnroll(dropped.key)
    expect(res.statusCode).toBe(409)
    expect(errorOf(res).code).toBe('email_limit')
    expect((await studentRow(dropped.id)).status).toBe('dropped')
  })
})
