import { Value } from 'typebox/value'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { ClubMembership } from '../../src/protocol/club-http.js'
import { ErrorBody } from '../../src/protocol/http.js'
import { ERROR_MESSAGES } from '../../src/registration/errors.js'
import type { StudentStatus } from '../../src/shared/schema.js'
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

const URL = '/v1/me/clubs/doudizhu'

function call(method: 'GET' | 'POST' | 'DELETE', key: string | undefined, url = URL) {
  return t.app.inject({ method, url, ...(key === undefined ? {} : { headers: { authorization: `Bearer ${key}` } }) })
}

/** The reply's membership, after checking it is a 200 with a `ClubMembership`. */
async function membershipOf(method: 'GET' | 'POST' | 'DELETE', key: string) {
  const res = await call(method, key)
  expect(res.statusCode, res.body).toBe(200)
  expect(Value.Check(ClubMembership, res.json())).toBe(true)
  return res.json<{ club: string; member: boolean; joinedAt: string | null }>()
}

function errorOf(res: { statusCode: number; json<T>(): T }) {
  const body = res.json<{ error: { code: string; message: string } }>()
  expect(Value.Check(ErrorBody, body)).toBe(true)
  return { status: res.statusCode, ...body.error }
}

/** A student in a class, the kind that may join. */
async function activeStudent() {
  const classId = await insertClass(t.db, { classNo: 1 })
  return insertStudent(t.db, { status: 'active', classId, assignedAt: t.clock.now() })
}

const NOT_MEMBER = { club: 'doudizhu', member: false, joinedAt: null }

describe('joining', () => {
  test('a student in a class joins from now, and joining again answers the same', async () => {
    const { id, key } = await activeStudent()
    expect(await membershipOf('GET', key)).toEqual(NOT_MEMBER)

    const now = t.clock.now().toISOString()
    expect(await membershipOf('POST', key)).toEqual({ club: 'doudizhu', member: true, joinedAt: now })

    t.clock.advance(60_000)
    expect(await membershipOf('POST', key)).toEqual({ club: 'doudizhu', member: true, joinedAt: now })
    expect(await membershipOf('GET', key)).toEqual({ club: 'doudizhu', member: true, joinedAt: now })
    expect(await t.db.selectFrom('clubMembers').select(['studentId', 'club']).execute()).toEqual([
      { studentId: id, club: 'doudizhu' },
    ])
  })

  test.each<[string, { status: StudentStatus; inClass: boolean }, string]>([
    ['a pending student', { status: 'pending', inClass: false }, '还没有分到班级，分班以后才能入社。'],
    ['a waitlisted student', { status: 'waitlisted', inClass: false }, '还没有分到班级，分班以后才能入社。'],
    ['an active student with no class', { status: 'active', inClass: false }, '还没有分到班级，分班以后才能入社。'],
    ['a suspended student', { status: 'suspended', inClass: true }, '停课期间不能入社，停课结束以后再来。'],
    ['a dropped student', { status: 'dropped', inClass: false }, '已经离开学校，不能入社。'],
    ['an expelled student', { status: 'expelled', inClass: false }, '已经离开学校，不能入社。'],
  ])('%s may not join: 409 not_eligible, saying why', async (_label, { status, inClass }, message) => {
    const classId = inClass ? await insertClass(t.db, { classNo: 1 }) : null
    const { key } = await insertStudent(t.db, { status, classId })

    expect(errorOf(await call('POST', key))).toEqual({ status: 409, code: 'not_eligible', message })
    expect(await membershipOf('GET', key)).toEqual(NOT_MEMBER)
    expect(await t.db.selectFrom('clubMembers').selectAll().execute()).toEqual([])
  })

  test('a member who is suspended stays a member, and joining again answers the membership', async () => {
    const { id, key } = await activeStudent()
    const { joinedAt } = await membershipOf('POST', key)
    await t.db.updateTable('students').set({ status: 'suspended' }).where('id', '=', id).execute()

    expect(await membershipOf('GET', key)).toEqual({ club: 'doudizhu', member: true, joinedAt })
    expect(await membershipOf('POST', key)).toEqual({ club: 'doudizhu', member: true, joinedAt })
  })

  test('the default message of not_eligible says who may join', () => {
    expect(ERROR_MESSAGES.not_eligible).toBe('只有在读、已经分到班级的学生才能入社。')
  })
})

describe('leaving', () => {
  test('a member leaves, and joining again starts from the new moment', async () => {
    const { key } = await activeStudent()
    await membershipOf('POST', key)

    expect(await membershipOf('DELETE', key)).toEqual(NOT_MEMBER)
    expect(await membershipOf('GET', key)).toEqual(NOT_MEMBER)

    t.clock.advance(24 * 60 * 60_000)
    expect(await membershipOf('POST', key)).toEqual({
      club: 'doudizhu',
      member: true,
      joinedAt: t.clock.now().toISOString(),
    })
  })

  test('leaving when not a member succeeds too, whatever the status', async () => {
    for (const status of ['pending', 'active', 'suspended', 'dropped', 'expelled'] as const) {
      const { key } = await insertStudent(t.db, { status })
      expect(await membershipOf('DELETE', key)).toEqual(NOT_MEMBER)
    }
  })

  test('leaving takes out only that student', async () => {
    const one = await activeStudent()
    const classId = (await t.db.selectFrom('classes').select('id').executeTakeFirstOrThrow()).id
    const other = await insertStudent(t.db, { status: 'active', classId })
    await membershipOf('POST', one.key)
    await membershipOf('POST', other.key)

    await membershipOf('DELETE', one.key)
    expect(await t.db.selectFrom('clubMembers').select('studentId').execute()).toEqual([{ studentId: other.id }])
  })
})

describe('every club route', () => {
  test.each(['GET', 'POST', 'DELETE'] as const)('%s needs a key: 401 unauthorized', async (method) => {
    await activeStudent()
    for (const key of [undefined, 'ais_notAKeyAnyoneWasGiven']) {
      expect(errorOf(await call(method, key))).toMatchObject({ status: 401, code: 'unauthorized' })
    }
    expect(await t.db.selectFrom('clubMembers').selectAll().execute()).toEqual([])
  })

  test.each(['GET', 'POST', 'DELETE'] as const)('%s takes only a club that exists: 400 invalid_request', async (method) => {
    const { key } = await activeStudent()
    for (const club of ['chess', 'DOUDIZHU', 'doudizhu%20']) {
      expect(errorOf(await call(method, key, `/v1/me/clubs/${club}`))).toMatchObject({ status: 400, code: 'invalid_request' })
    }
    expect(await t.db.selectFrom('clubMembers').selectAll().execute()).toEqual([])
  })

  test('a JSON Content-Type with no body is a 400 invalid_request, as for the other routes with no body', async () => {
    const { key } = await activeStudent()
    const res = await t.app.inject({
      method: 'POST',
      url: URL,
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    })
    expect(errorOf(res)).toMatchObject({ status: 400, code: 'invalid_request' })
  })
})
