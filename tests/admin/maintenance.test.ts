import { afterEach, expect, test, vi } from 'vitest'
import { buildAdminTestApp, CSRF } from '../helpers/admin.js'

let t: Awaited<ReturnType<typeof buildAdminTestApp>>
afterEach(async () => {
  await t.destroy()
})

const put = (cookie: string, payload: unknown) =>
  t.app.inject({ method: 'PUT', url: t.url('api/maintenance'), headers: { cookie, ...CSRF }, payload: payload as object })

test('without a login both routes are a 401', async () => {
  t = await buildAdminTestApp()
  expect((await t.app.inject({ method: 'GET', url: t.url('api/maintenance') })).statusCode).toBe(401)
  expect((await t.app.inject({ method: 'PUT', url: t.url('api/maintenance'), headers: CSRF, payload: { on: false } })).statusCode).toBe(401)
})

test('turning it on needs a message of 1 to 200 characters, and an expected time in the future', async () => {
  t = await buildAdminTestApp()
  const cookie = await t.session()
  const bad = [
    { on: true },
    { on: true, message: '   ' },
    { on: true, message: '字'.repeat(201) },
    { on: true, message: '升级', expectedBackAt: '2026-11-02T11:00:00+08:00' },
    { on: true, message: '升级', expectedBackAt: 'tomorrow-ish' },
    { on: true, message: 5 },
  ]
  for (const payload of bad) {
    const res = await put(cookie, payload)
    expect(res.statusCode, JSON.stringify(payload)).toBe(400)
    expect(res.json()).toMatchObject({ error: { code: 'invalid_request' } })
  }
  expect(await t.db.selectFrom('maintenancePeriods').selectAll().execute()).toEqual([])
  expect((await put(cookie, { on: true, message: '字'.repeat(200) })).statusCode).toBe(200)
})

test('on, change, off: GET follows, every change is in the table, and the watch is refreshed each time', async () => {
  const refresh = vi.fn(async () => {})
  t = await buildAdminTestApp({ maintenance: { current: () => null, refresh, onChange: () => {}, stop: () => {} } })
  const cookie = await t.session()
  const get = async () => (await t.app.inject({ method: 'GET', url: t.url('api/maintenance'), headers: { cookie } })).json()
  expect(await get()).toEqual({ maintenance: null })

  const started = t.clock.now().toISOString()
  const res = await put(cookie, { on: true, message: ' 升级中 ', expectedBackAt: '2026-11-02T18:00:00+08:00' })
  expect(res.statusCode).toBe(200)
  const expected = { maintenance: { message: '升级中', since: started, expectedBackAt: '2026-11-02T10:00:00.000Z' } }
  expect(res.json()).toEqual(expected)
  expect(await get()).toEqual(expected)

  t.clock.advance(60_000)
  const changed = await put(cookie, { on: true, message: '还要一会儿', expectedBackAt: null })
  expect(changed.json()).toEqual({ maintenance: { message: '还要一会儿', since: started, expectedBackAt: null } })

  t.clock.advance(60_000)
  const off = await put(cookie, { on: false })
  expect(off.json()).toEqual({ maintenance: null })
  expect(await get()).toEqual({ maintenance: null })

  expect(refresh).toHaveBeenCalledTimes(3)
  const rows = await t.db.selectFrom('maintenancePeriods').select(['message', 'startedAt', 'endedAt']).execute()
  expect(rows).toEqual([{ message: '还要一会儿', startedAt: new Date(started), endedAt: t.clock.now() }])
})

test('an edit without expectedBackAt keeps the stored time, even when it has passed; null clears it; a past value is a 400', async () => {
  t = await buildAdminTestApp()
  const cookie = await t.session()
  // Switched on without an expected time: none.
  expect((await put(cookie, { on: true, message: '甲' })).json().maintenance.expectedBackAt).toBeNull()

  const back = '2026-11-02T06:00:00.000Z'
  await put(cookie, { on: true, message: '甲', expectedBackAt: back })
  t.clock.advance(5 * 3_600_000) // the stored time is now in the past
  const edited = await put(cookie, { on: true, message: '乙' })
  expect(edited.statusCode).toBe(200)
  expect(edited.json().maintenance).toMatchObject({ message: '乙', expectedBackAt: back })

  expect((await put(cookie, { on: true, message: '乙', expectedBackAt: back })).statusCode).toBe(400)
  const cleared = await put(cookie, { on: true, message: '乙', expectedBackAt: null })
  expect(cleared.json().maintenance).toMatchObject({ message: '乙', expectedBackAt: null })
})
