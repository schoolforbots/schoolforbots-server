import { afterEach, expect, test } from 'vitest'
import { buildTestApp } from '../helpers/app.js'

let t: Awaited<ReturnType<typeof buildTestApp>>

afterEach(async () => {
  await t.app.close()
  await t.db.destroy().catch(() => {})
})

test('GET /healthz answers 200 {"ok":true} and nothing else', async () => {
  t = await buildTestApp()
  const res = await t.app.inject({ method: 'GET', url: '/healthz' })
  expect(res.statusCode).toBe(200)
  expect(res.json()).toEqual({ ok: true })
  expect(res.body).toBe('{"ok":true}')
})

test('answers 503 {"ok":false} when the database is gone', async () => {
  t = await buildTestApp()
  await t.db.destroy()
  const res = await t.app.inject({ method: 'GET', url: '/healthz' })
  expect(res.statusCode).toBe(503)
  expect(res.body).toBe('{"ok":false}')
})

test('is not rate limited', async () => {
  t = await buildTestApp()
  for (let i = 0; i < 200; i++) {
    expect((await t.app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200)
  }
})
