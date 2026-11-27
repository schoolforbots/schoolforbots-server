import { Value } from 'typebox/value'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { LiveResult, Me } from '../../src/protocol/http.js'
import { buildTestApp } from '../helpers/app.js'
import { insertStudent } from '../helpers/factories.js'

type TestApp = Awaited<ReturnType<typeof buildTestApp>>

let t: TestApp

beforeEach(async () => {
  t = await buildTestApp()
})

afterEach(async () => {
  await t.destroy()
})

function patchLive(key: string, payload: object) {
  return t.app.inject({ method: 'PATCH', url: '/v1/me/live', headers: { authorization: `Bearer ${key}` }, payload })
}

async function me(key: string) {
  const res = await t.app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${key}` } })
  expect(Value.Check(Me, res.json())).toBe(true)
  return res.json<{ liveAnonymous: boolean }>()
}

describe('PATCH /v1/me/live', () => {
  test('a student is shown by name until the owner turns anonymity on, and back off', async () => {
    const { key } = await insertStudent(t.db)
    expect((await me(key)).liveAnonymous).toBe(false)

    const on = await patchLive(key, { anonymous: true })
    expect(on.statusCode).toBe(200)
    expect(Value.Check(LiveResult, on.json())).toBe(true)
    expect(on.json()).toMatchObject({ anonymous: true })
    expect(on.json<{ message: string }>().message).toContain('匿名同学')
    expect((await me(key)).liveAnonymous).toBe(true)

    const off = await patchLive(key, { anonymous: false })
    expect(off.json()).toMatchObject({ anonymous: false })
    expect((await me(key)).liveAnonymous).toBe(false)
  })

  test('changes only the student whose key it is', async () => {
    const a = await insertStudent(t.db)
    const b = await insertStudent(t.db)
    await patchLive(a.key, { anonymous: true })
    expect((await me(b.key)).liveAnonymous).toBe(false)
  })

  test('needs a key and a boolean', async () => {
    const { key } = await insertStudent(t.db)
    expect((await t.app.inject({ method: 'PATCH', url: '/v1/me/live', payload: { anonymous: true } })).statusCode).toBe(401)
    expect((await patchLive(key, { anonymous: 'yes' })).statusCode).toBe(400)
    expect((await patchLive(key, {})).statusCode).toBe(400)
  })
})
