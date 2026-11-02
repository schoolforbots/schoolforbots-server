import { Value } from 'typebox/value'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { ErrorBody, Me } from '../../src/protocol/http.js'
import { buildTestApp } from '../helpers/app.js'
import { insertClass, insertStudent } from '../helpers/factories.js'

type TestApp = Awaited<ReturnType<typeof buildTestApp>>

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

function errorOf(res: { json<T>(): T }) {
  return res.json<{ error: { code: string; message: string } }>().error
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
    })
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
