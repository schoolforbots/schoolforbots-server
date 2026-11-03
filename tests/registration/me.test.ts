import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { sql } from 'kysely'
import { Value } from 'typebox/value'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { disciplineRecorder } from '../../src/class/discipline.js'
import { ErrorBody, Me, RecordsResult, WithdrawResult } from '../../src/protocol/http.js'
import { lock, slotLockKey } from '../../src/shared/db.js'
import { buildTestApp } from '../helpers/app.js'
import { insertClass, insertSession, insertStudent } from '../helpers/factories.js'

type TestApp = Awaited<ReturnType<typeof buildTestApp>>

const DAY = 24 * 60 * 60_000

let t: TestApp

beforeEach(async () => {
  t = await buildTestApp()
})

afterEach(async () => {
  await t.destroy()
})

function getMe(authorization?: string) {
  return t.app.inject({
    method: 'GET',
    url: '/v1/me',
    ...(authorization === undefined ? {} : { headers: { authorization } }),
  })
}

function get(url: string, key: string) {
  return t.app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${key}` } })
}

function errorOf(res: { json<T>(): T }) {
  return res.json<{ error: { code: string; message: string; [extra: string]: unknown } }>().error
}

describe('GET /v1/me', () => {
  test('no or bad key → 401 unauthorized', async () => {
    const { key } = await insertStudent(t.db)
    const stored = await t.db.selectFrom('students').select('keyHash').executeTakeFirstOrThrow()

    const attempts: [string, string | undefined][] = [
      ['no Authorization header', undefined],
      ['an empty header', ''],
      ['a key that belongs to nobody', 'Bearer ais_notAKeyAnyoneWasGiven'],
      ['the bare key without a scheme', key],
      ['another scheme', `Basic ${key}`],
      ['a scheme without a key', 'Bearer'],
      ['a scheme with a blank key', 'Bearer   '],
      ['a key followed by more text', `Bearer ${key} extra`],
      // Only hashes are stored, so a leaked row must not be usable as a key.
      ['the stored hash used as the key', `Bearer ${stored.keyHash}`],
    ]
    for (const [label, authorization] of attempts) {
      const res = await getMe(authorization)
      expect(res.statusCode, label).toBe(401)
      expect(errorOf(res).code, label).toBe('unauthorized')
      expect(Value.Check(ErrorBody, res.json()), label).toBe(true)
    }

    // Control: the real key does work.
    expect((await getMe(`Bearer ${key}`)).statusCode).toBe(200)
  })

  test('the Bearer scheme is matched case-insensitively', async () => {
    const { key } = await insertStudent(t.db)
    expect((await getMe(`bearer ${key}`)).statusCode).toBe(200)
    expect((await getMe(`BEARER   ${key}`)).statusCode).toBe(200)
  })

  test('me returns identity with display name and no class while pending', async () => {
    const { id, key } = await insertStudent(t.db, { ownerName: '阿杰', aiName: '小鱼' })

    const res = await getMe(`Bearer ${key}`)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      studentId: id,
      ownerName: '阿杰',
      aiName: '小鱼',
      displayName: '阿杰家的小鱼',
      division: 'junior',
      slot: 'evening',
      status: 'pending',
      className: null,
      lastRenamedAt: null,
      suspendedUntil: null,
      // A student from before the school asked owners to agree to the rules (the factory's default) has no version.
      schoolRulesVersion: null,
    })
    expect(Value.Check(Me, res.json())).toBe(true)
  })

  test('me names the version of the school rules the student last agreed to', async () => {
    const { id, key } = await insertStudent(t.db, {
      schoolRulesVersion: '2026-11-03',
      schoolRulesAgreedAt: new Date('2026-11-03T04:00:00Z'),
    })

    const res = await getMe(`Bearer ${key}`)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ studentId: id, schoolRulesVersion: '2026-11-03' })
    expect(Value.Check(Me, res.json())).toBe(true)
  })

  test('me names the class and the last rename once the student is assigned', async () => {
    const classId = await insertClass(t.db, { division: 'senior', slot: 'morning', classNo: 7 })
    const lastRenamedAt = new Date('2026-10-20T08:30:00Z')
    const { id, key } = await insertStudent(t.db, {
      division: 'senior',
      slot: 'morning',
      status: 'active',
      classId,
      lastRenamedAt,
    })

    const res = await getMe(`Bearer ${key}`)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      studentId: id,
      status: 'active',
      className: '高中部·上午班·7 班',
      lastRenamedAt: lastRenamedAt.toISOString(),
    })
    expect(Value.Check(Me, res.json())).toBe(true)
  })

  test('me shows a suspended student the day the suspension ends, and nobody else', async () => {
    const classId = await insertClass(t.db, { classNo: 1 })
    const suspendedUntil = new Date('2026-11-05T00:00:00+08:00')
    const assignedAt = new Date('2026-10-01T00:00:00Z')
    const suspended = await insertStudent(t.db, { status: 'suspended', classId, assignedAt, suspendedUntil })
    const active = await insertStudent(t.db, { status: 'active', classId, assignedAt })

    const res = await getMe(`Bearer ${suspended.key}`)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      studentId: suspended.id,
      status: 'suspended',
      className: '初中部·晚班·1 班',
      suspendedUntil: suspendedUntil.toISOString(),
    })
    expect(Value.Check(Me, res.json())).toBe(true)

    const other = await getMe(`Bearer ${active.key}`)
    expect(other.json()).toMatchObject({ status: 'active', suspendedUntil: null })
  })

  test('me shows a suspension only while it runs: from the moment it ends, before the nightly job too, it is null', async () => {
    const classId = await insertClass(t.db, { classNo: 1 })
    const ends = new Date(t.clock.now().getTime() + DAY)
    // Still marked suspended until the nightly job, and a student who withdrew in a suspension, or was suspended after.
    const suspended = await insertStudent(t.db, { status: 'suspended', classId, assignedAt: t.clock.now(), suspendedUntil: ends })
    const dropped = await insertStudent(t.db, { status: 'dropped', suspendedUntil: ends })

    for (const { key } of [suspended, dropped]) {
      expect((await getMe(`Bearer ${key}`)).json()).toMatchObject({ suspendedUntil: ends.toISOString() })
    }
    t.clock.set(new Date(ends.getTime() - 1))
    for (const { key } of [suspended, dropped]) {
      expect((await getMe(`Bearer ${key}`)).json()).toMatchObject({ suspendedUntil: ends.toISOString() })
    }
    t.clock.set(ends)
    expect((await getMe(`Bearer ${suspended.key}`)).json()).toMatchObject({ status: 'suspended', suspendedUntil: null })
    expect((await getMe(`Bearer ${dropped.key}`)).json()).toMatchObject({ status: 'dropped', suspendedUntil: null })
  })

  test('an expelled student has no class and no suspension to show', async () => {
    const { id, key } = await insertStudent(t.db, { status: 'expelled' })

    const res = await getMe(`Bearer ${key}`)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ studentId: id, status: 'expelled', className: null, suspendedUntil: null })
  })

  test('each key sees only its own student', async () => {
    const a = await insertStudent(t.db, { ownerName: '甲', aiName: '一号' })
    const b = await insertStudent(t.db, { ownerName: '乙', aiName: '二号' })

    expect((await getMe(`Bearer ${a.key}`)).json()).toMatchObject({ studentId: a.id, displayName: '甲家的一号' })
    expect((await getMe(`Bearer ${b.key}`)).json()).toMatchObject({ studentId: b.id, displayName: '乙家的二号' })
  })
})

describe('POST /v1/me/withdraw', () => {
  const bearer = (key: string) => ({ authorization: `Bearer ${key}` })

  function withdraw(key: string) {
    return t.app.inject({ method: 'POST', url: '/v1/me/withdraw', headers: bearer(key) })
  }

  function reEnroll(key: string) {
    return t.app.inject({
      method: 'POST',
      url: '/v1/me/re-enroll',
      headers: bearer(key),
      payload: { schoolRulesVersion: t.schoolRules.current.version },
    })
  }

  /** A registration of an AI on this install, from a mailbox of its own: only the install's seat can refuse it. */
  function registerOn(installId: string) {
    return t.app.inject({
      method: 'POST',
      url: '/v1/registrations',
      payload: {
        email: 'newcomer@example.com',
        ownerName: '阿杰',
        aiName: '小鱼',
        division: 'junior',
        slot: 'evening',
        installId,
        plugin: { type: 'astrbot', version: '0.1.0' },
        schoolRulesVersion: t.schoolRules.current.version,
      },
    })
  }

  const studentRow = (id: number) =>
    t.db.selectFrom('students').selectAll().where('id', '=', id).executeTakeFirstOrThrow()

  test.each(['pending', 'waitlisted', 'active'] as const)(
    'a student who is %s can withdraw: dropped, no class, the seat is free again',
    async (status) => {
      const classId = status === 'active' ? await insertClass(t.db, { classNo: 1 }) : null
      const installId = randomUUID()
      const { id, key } = await insertStudent(t.db, {
        status,
        classId,
        installId,
        assignedAt: classId === null ? null : t.clock.now(),
      })
      // While the seat is held, the install cannot take another AI.
      expect(errorOf(await registerOn(installId)).code).toBe('install_has_seat')

      const res = await withdraw(key)
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ status: 'dropped' })
      expect(Value.Check(WithdrawResult, res.json())).toBe(true)
      expect(await studentRow(id)).toMatchObject({ id, status: 'dropped', classId: null })

      expect((await registerOn(installId)).statusCode).toBe(202)
    },
  )

  test('a suspended student can withdraw too, but the install stays closed until the suspension ends', async () => {
    const classId = await insertClass(t.db, { classNo: 1 })
    const installId = randomUUID()
    const suspendedUntil = new Date(t.clock.now().getTime() + 3 * DAY)
    const { id, key } = await insertStudent(t.db, {
      status: 'suspended',
      classId,
      installId,
      assignedAt: t.clock.now(),
      suspendedUntil,
    })
    expect(errorOf(await registerOn(installId)).code).toBe('install_has_seat')

    const res = await withdraw(key)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: 'dropped' })
    expect(await studentRow(id)).toMatchObject({ status: 'dropped', classId: null, suspendedUntil })

    // The seat is free, but a new registration on the same install would be a clean AI in the middle of the suspension.
    const early = await registerOn(installId)
    expect(early.statusCode).toBe(409)
    expect(early.json()).toEqual({
      error: {
        code: 'still_suspended',
        message: '停课还没结束，结束后才能重新入学。',
        until: suspendedUntil.toISOString(),
      },
    })
    expect(t.mailer.sent).toEqual([])

    t.clock.set(suspendedUntil)
    expect((await registerOn(installId)).statusCode).toBe(202)
  })

  test('withdrawing leaves the student number, the key and the names as they were', async () => {
    const classId = await insertClass(t.db, { classNo: 1 })
    const assignedAt = new Date('2026-10-01T00:00:00Z')
    const { id, key } = await insertStudent(t.db, {
      ownerName: '阿杰',
      aiName: '小鱼',
      status: 'active',
      classId,
      assignedAt,
    })

    expect((await withdraw(key)).statusCode).toBe(200)

    expect(await studentRow(id)).toMatchObject({ id, ownerName: '阿杰', aiName: '小鱼', assignedAt, suspendedUntil: null })
    expect((await getMe(`Bearer ${key}`)).json()).toMatchObject({
      studentId: id,
      status: 'dropped',
      className: null,
      suspendedUntil: null,
    })
  })

  test('withdrawing in a suspension keeps it: no coming back before it ends, a clean return once it has', async () => {
    const classId = await insertClass(t.db, { classNo: 1 })
    const suspendedUntil = new Date(t.clock.now().getTime() + 3 * DAY)
    const { id, key } = await insertStudent(t.db, {
      status: 'suspended',
      classId,
      assignedAt: t.clock.now(),
      suspendedUntil,
    })

    expect((await withdraw(key)).statusCode).toBe(200)
    expect(await studentRow(id)).toMatchObject({ status: 'dropped', classId: null, suspendedUntil })
    // The owner can read when the suspension ends.
    expect((await getMe(`Bearer ${key}`)).json()).toMatchObject({
      status: 'dropped',
      suspendedUntil: suspendedUntil.toISOString(),
    })

    const early = await reEnroll(key)
    expect(early.statusCode).toBe(409)
    expect(early.json()).toEqual({
      error: {
        code: 'still_suspended',
        message: '停课还没结束，结束后才能重新入学。',
        until: suspendedUntil.toISOString(),
      },
    })
    expect(Value.Check(ErrorBody, early.json())).toBe(true)

    // Until the last moment of it: only `until > now` is still a suspension.
    t.clock.set(new Date(suspendedUntil.getTime() - 1))
    expect(errorOf(await reEnroll(key)).code).toBe('still_suspended')
    expect(await studentRow(id)).toMatchObject({ status: 'dropped', suspendedUntil })

    t.clock.set(suspendedUntil)
    const back = await reEnroll(key)
    expect(back.statusCode).toBe(200)
    expect(back.json()).toEqual({ status: 'pending' })
    expect(await studentRow(id)).toMatchObject({ status: 'pending', classId: null, suspendedUntil: null })
    expect((await getMe(`Bearer ${key}`)).json()).toMatchObject({ status: 'pending', suspendedUntil: null })
  })

  test.each(['dropped', 'expelled'] as const)('a student who is %s cannot withdraw → 409 wrong_status', async (status) => {
    const { id, key } = await insertStudent(t.db, { status })

    const res = await withdraw(key)
    expect(res.statusCode).toBe(409)
    expect(errorOf(res).code).toBe('wrong_status')
    expect(Value.Check(ErrorBody, res.json())).toBe(true)
    expect((await studentRow(id)).status).toBe(status)
  })

  test('the records stay: after withdrawing, the owner reads the same ones as before', async () => {
    const classId = await insertClass(t.db, { classNo: 1 })
    const { id, key } = await insertStudent(t.db, { status: 'active', classId, assignedAt: t.clock.now() })
    const day = new Date(t.clock.now().getTime() - 2 * DAY)
    const sessionId = await insertSession(t.db, {
      classId,
      date: '2026-10-31',
      startsAt: new Date(day.getTime() + 8 * 60 * 60_000),
      endsAt: new Date(day.getTime() + 9 * 60 * 60_000),
    })
    await disciplineRecorder.record(t.db, { studentId: id, sessionId, kind: 'school_rule', detail: {}, matchedTerm: '示例', at: day })
    await disciplineRecorder.record(t.db, { studentId: id, sessionId, kind: 'initiations', detail: {}, at: day })

    const before = await get('/v1/me/records', key)
    expect(before.statusCode).toBe(200)
    expect(before.json<{ records: unknown[] }>().records).toHaveLength(2)

    expect((await withdraw(key)).statusCode).toBe(200)

    const after = await get('/v1/me/records', key)
    expect(after.statusCode).toBe(200)
    expect(Value.Check(RecordsResult, after.json())).toBe(true)
    expect(after.json()).toEqual({ ...before.json(), status: 'dropped' })
  })

  test('a withdrawal waits for the slot lock the nightly job holds, so the job cannot undo it', async () => {
    const classId = await insertClass(t.db, { classNo: 1 })
    const { id, key } = await insertStudent(t.db, { status: 'active', slot: 'evening', classId, assignedAt: t.clock.now() })

    let response!: ReturnType<typeof withdraw>
    await t.db.transaction().execute(async (trx) => {
      await lock(trx, slotLockKey('evening'))
      response = withdraw(key)
      await sleep(300)
      // Still in the class: the request is waiting for the lock, whatever the job is doing with the slot.
      expect(await studentRow(id)).toMatchObject({ status: 'active', classId })
    })

    expect((await response).statusCode).toBe(200)
    expect(await studentRow(id)).toMatchObject({ status: 'dropped', classId: null })
  })

  test('the same student withdrawing twice at once is accepted once', async () => {
    const classId = await insertClass(t.db, { classNo: 1 })
    const { key } = await insertStudent(t.db, { status: 'active', classId, assignedAt: t.clock.now() })
    // Every update of a student row takes longer, so requests that are not properly serialized overlap in it.
    await sql
      .raw(
        `create function slow_student_update() returns trigger language plpgsql as
         $$ begin perform pg_sleep(0.1); return new; end $$`,
      )
      .execute(t.db)
    await sql
      .raw(
        `create trigger slow_student_update before update on students
         for each row execute function slow_student_update()`,
      )
      .execute(t.db)

    const results = await Promise.all([withdraw(key), withdraw(key), withdraw(key)])
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409, 409])
  })
})
