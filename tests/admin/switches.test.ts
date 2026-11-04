import { afterEach, expect, test, vi } from 'vitest'
import { switchChanges } from '../../src/shared/switches.js'
import { buildAdminTestApp, CSRF } from '../helpers/admin.js'

let t: Awaited<ReturnType<typeof buildAdminTestApp>>
afterEach(async () => {
  await t.destroy()
})

test('with no rows every switch shows its default and no update time', async () => {
  t = await buildAdminTestApp()
  const cookie = await t.session()
  const res = await t.app.inject({ method: 'GET', url: t.url('api/switches'), headers: { cookie } })
  expect(res.statusCode).toBe(200)
  expect(res.json()).toEqual({
    switches: [
      { name: 'teacherLlm', on: t.config.switchDefaults.teacherLlm, updatedAt: null },
      { name: 'secondLayerTeacher', on: t.config.switchDefaults.secondLayerTeacher, updatedAt: null },
      { name: 'secondLayerChat', on: t.config.switchDefaults.secondLayerChat, updatedAt: null },
    ],
  })
})

test('PUT sets the switch, records the change, refreshes the running copy and answers with the new row', async () => {
  const refresh = vi.fn(async () => {})
  t = await buildAdminTestApp({ switches: { isOn: () => true, refresh, stop: () => {} } })
  const cookie = await t.session()
  const before = t.clock.now()
  t.clock.advance(60_000)
  const wanted = !t.config.switchDefaults.secondLayerChat

  const res = await t.app.inject({
    method: 'PUT',
    url: t.url('api/switches/secondLayerChat'),
    headers: { cookie, ...CSRF },
    payload: { on: wanted },
  })
  expect(res.statusCode).toBe(200)
  expect(res.json()).toEqual({ name: 'secondLayerChat', on: wanted, updatedAt: t.clock.now().toISOString() })
  expect(refresh).toHaveBeenCalledTimes(1)

  expect(await switchChanges(t.db, before, new Date(t.clock.now().getTime() + 1))).toEqual([
    { name: 'secondLayerChat', on: wanted, at: t.clock.now() },
  ])
  const list = await t.app.inject({ method: 'GET', url: t.url('api/switches'), headers: { cookie } })
  expect(list.json().switches.find((s: { name: string }) => s.name === 'secondLayerChat')).toEqual({
    name: 'secondLayerChat',
    on: wanted,
    updatedAt: t.clock.now().toISOString(),
  })
})

test('a PUT without X-Requested-With is a 403 and changes nothing', async () => {
  t = await buildAdminTestApp()
  const cookie = await t.session()
  const res = await t.app.inject({ method: 'PUT', url: t.url('api/switches/teacherLlm'), headers: { cookie }, payload: { on: false } })
  expect(res.statusCode).toBe(403)
  expect(await t.db.selectFrom('switches').selectAll().execute()).toEqual([])
  expect(await t.db.selectFrom('switchChanges').selectAll().execute()).toEqual([])
})

test('an unknown switch is a 404 and a body that is not { on: boolean } is a 400', async () => {
  t = await buildAdminTestApp()
  const cookie = await t.session()
  const put = (name: string, payload: unknown) =>
    t.app.inject({ method: 'PUT', url: t.url(`api/switches/${name}`), headers: { cookie, ...CSRF }, payload: payload as object })
  expect((await put('nonsense', { on: true })).statusCode).toBe(404)
  expect((await put('__proto__', { on: true })).statusCode).toBe(404)
  expect((await put('teacherLlm', { on: 'yes' })).statusCode).toBe(400)
  expect((await put('teacherLlm', {})).statusCode).toBe(400)
  expect(await t.db.selectFrom('switchChanges').selectAll().execute()).toEqual([])
})
