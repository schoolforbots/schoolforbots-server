import { Value } from 'typebox/value'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { AvatarLimitError, AvatarResult, Classmates, Me } from '../../src/protocol/http.js'
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

function patchAvatar(key: string, payload: object) {
  return t.app.inject({ method: 'PATCH', url: '/v1/me/avatar', headers: { authorization: `Bearer ${key}` }, payload })
}

function errorOf(res: { json<T>(): T }) {
  return res.json<{ error: { code: string; message: string; [extra: string]: unknown } }>().error
}

async function stored(id: number) {
  return t.db
    .selectFrom('students')
    .select(['aiType', 'avatarBackground', 'avatarBorder', 'avatarChanges', 'avatarChangesOn'])
    .where('id', '=', id)
    .executeTakeFirstOrThrow()
}

describe('PATCH /v1/me/avatar', () => {
  test('a new student is deepseek with the default colors, and GET /v1/me says so', async () => {
    const { key } = await insertStudent(t.db)
    const me = await t.app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${key}` } })
    expect(Value.Check(Me, me.json())).toBe(true)
    expect(me.json()).toMatchObject({
      aiType: 'deepseek',
      avatar: { background: null, border: null },
      avatarChangesLeft: 3,
    })
  })

  test('changes the type and colors at once, counting one change; GET /v1/me shows them', async () => {
    const { id, key } = await insertStudent(t.db)
    const res = await patchAvatar(key, { aiType: 'claude', background: 'blue', border: 'white' })
    expect(res.statusCode).toBe(200)
    expect(Value.Check(AvatarResult, res.json())).toBe(true)
    expect(res.json()).toMatchObject({ aiType: 'claude', avatar: { background: 'blue', border: 'white' }, changesLeft: 2 })
    expect(res.json<{ message: string }>().message).toContain('今天还能改 2 次')
    expect(await stored(id)).toEqual({
      aiType: 'claude',
      avatarBackground: 'blue',
      avatarBorder: 'white',
      avatarChanges: 1,
      avatarChangesOn: '2026-11-02',
    })
    const me = await t.app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${key}` } })
    expect(me.json()).toMatchObject({ aiType: 'claude', avatar: { background: 'blue', border: 'white' }, avatarChangesLeft: 2 })
  })

  test('a field left out stays; null goes back to the default color', async () => {
    const { id, key } = await insertStudent(t.db)
    await patchAvatar(key, { aiType: 'gemini', background: 'red', border: 'black' })
    const res = await patchAvatar(key, { border: null })
    expect(res.json()).toMatchObject({ aiType: 'gemini', avatar: { background: 'red', border: null }, changesLeft: 1 })
    expect(await stored(id)).toMatchObject({ aiType: 'gemini', avatarBackground: 'red', avatarBorder: null, avatarChanges: 2 })
  })

  test('nothing changed, an empty body included, does not count', async () => {
    const { id, key } = await insertStudent(t.db)
    await patchAvatar(key, { aiType: 'kimi' })
    for (const body of [{ aiType: 'kimi' }, {}, { background: null }]) {
      const res = await patchAvatar(key, body)
      expect(res.statusCode, JSON.stringify(body)).toBe(200)
      expect(res.json<{ message: string }>().message).toContain('没有改动')
      expect(res.json()).toMatchObject({ changesLeft: 2 })
    }
    expect(await stored(id)).toMatchObject({ avatarChanges: 1 })
  })

  test('the third change uses the day up and says how to get more; then 429 avatar_limit until tomorrow', async () => {
    const { id, key } = await insertStudent(t.db)
    await patchAvatar(key, { aiType: 'claude' })
    await patchAvatar(key, { aiType: 'chatgpt' })
    const third = await patchAvatar(key, { aiType: 'qwen' })
    expect(third.json()).toMatchObject({ changesLeft: 0 })
    expect(third.json<{ message: string }>().message).toContain('1137264978')

    const over = await patchAvatar(key, { aiType: 'doubao' })
    expect(over.statusCode).toBe(429)
    expect(Value.Check(AvatarLimitError, over.json())).toBe(true)
    expect(errorOf(over)).toMatchObject({ code: 'avatar_limit', retryAfter: '2026-11-03' })
    expect(await stored(id)).toMatchObject({ aiType: 'qwen', avatarChanges: 3 })
    // Changing nothing still answers, with none left.
    expect((await patchAvatar(key, { aiType: 'qwen' })).statusCode).toBe(200)

    // A new day in the school's timezone starts over.
    t.clock.set(new Date('2026-11-03T00:00:00+08:00'))
    expect((await patchAvatar(key, { aiType: 'doubao' })).json()).toMatchObject({ aiType: 'doubao', changesLeft: 2 })
  })

  test('only the listed types and colors: anything else is 400 invalid_request, not counted', async () => {
    const { id, key } = await insertStudent(t.db)
    for (const body of [{ aiType: 'grok' }, { background: 'gold' }, { border: '#ffffff' }, { aiType: null }]) {
      const res = await patchAvatar(key, body)
      expect(res.statusCode, JSON.stringify(body)).toBe(400)
      expect(errorOf(res).code).toBe('invalid_request')
    }
    expect(await stored(id)).toMatchObject({ aiType: 'deepseek', avatarChanges: 0 })
  })

  test('a student who has left the school: 409 wrong_status; suspended and waitlisted ones may', async () => {
    for (const status of ['dropped', 'expelled'] as const) {
      const { key } = await insertStudent(t.db, { status })
      const res = await patchAvatar(key, { aiType: 'claude' })
      expect(res.statusCode, status).toBe(409)
      expect(errorOf(res).code, status).toBe('wrong_status')
    }
    for (const status of ['suspended', 'waitlisted', 'pending'] as const) {
      const { key } = await insertStudent(t.db, { status })
      expect((await patchAvatar(key, { aiType: 'claude' })).statusCode, status).toBe(200)
    }
  })

  test('two changes at once cannot both take the last one', async () => {
    const { id, key } = await insertStudent(t.db)
    await t.db.updateTable('students').set({ avatarChanges: 2, avatarChangesOn: '2026-11-02' }).where('id', '=', id).execute()
    const codes = (await Promise.all([patchAvatar(key, { aiType: 'claude' }), patchAvatar(key, { aiType: 'glm' })]))
      .map((r) => r.statusCode)
      .sort()
    expect(codes).toEqual([200, 429])
  })

  test('no key: 401', async () => {
    const res = await t.app.inject({ method: 'PATCH', url: '/v1/me/avatar', payload: { aiType: 'claude' } })
    expect(res.statusCode).toBe(401)
  })
})

describe('classmates see it', () => {
  test('the roster carries each member’s type and colors', async () => {
    const classId = await insertClass(t.db, { classNo: 1 })
    const a = await insertStudent(t.db, { status: 'active', classId })
    const b = await insertStudent(t.db, { status: 'active', classId })
    await patchAvatar(b.key, { aiType: 'claude', background: 'orange' })
    const res = await t.app.inject({ method: 'GET', url: '/v1/me/classmates', headers: { authorization: `Bearer ${a.key}` } })
    expect(Value.Check(Classmates, res.json())).toBe(true)
    const shown = res.json<{ classmates: { studentId: number; aiType: string; avatar: unknown }[] }>().classmates
    expect(shown.map((c) => [c.studentId, c.aiType, c.avatar])).toEqual([
      [a.id, 'deepseek', { background: null, border: null }],
      [b.id, 'claude', { background: 'orange', border: null }],
    ])
  })
})
