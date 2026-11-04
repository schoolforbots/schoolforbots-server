import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { captureLogs } from '../helpers/logs.js'
import { buildAdminTestApp, CSRF, TEST_ADMIN_PATH, TEST_PASSWORD } from '../helpers/admin.js'

let t: Awaited<ReturnType<typeof buildAdminTestApp>>
afterEach(async () => {
  await t.destroy()
})

function builtFrontEnd() {
  const dist = mkdtempSync(join(tmpdir(), 'admin-dist-'))
  mkdirSync(join(dist, 'assets'))
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>front end</title>')
  writeFileSync(join(dist, 'outside.txt'), 'not for the web')
  writeFileSync(join(dist, 'assets', 'app.js'), 'console.log(1)')
  return dist
}

test('without ADMIN_* every path under the would-be path is a plain 404', async () => {
  t = await buildAdminTestApp({ admin: false })
  for (const [method, path] of [
    ['GET', ''],
    ['GET', '/'],
    ['GET', '/assets/app.js'],
    ['GET', '/api/session'],
    ['POST', '/api/login'],
    ['PUT', '/api/switches/teacherLlm'],
  ] as const) {
    const res = await t.app.inject({ method, url: `${TEST_ADMIN_PATH}${path}`, headers: CSRF, payload: method === 'GET' ? undefined : {} })
    expect(res.statusCode, `${method} ${path}`).toBe(404)
  }
})

test('the path without a slash redirects to the one with it', async () => {
  t = await buildAdminTestApp({ distDir: builtFrontEnd() })
  const res = await t.app.inject({ method: 'GET', url: TEST_ADMIN_PATH })
  expect(res.statusCode).toBe(302)
  expect(res.headers.location).toBe(`${TEST_ADMIN_PATH}/`)
})

test('the page, its assets and any other page of the front end are served, api/ is not one of them', async () => {
  t = await buildAdminTestApp({ distDir: builtFrontEnd() })
  const index = await t.app.inject({ method: 'GET', url: `${TEST_ADMIN_PATH}/` })
  expect(index.statusCode).toBe(200)
  expect(index.headers['content-type']).toContain('text/html')
  expect(index.body).toContain('front end')

  const asset = await t.app.inject({ method: 'GET', url: `${TEST_ADMIN_PATH}/assets/app.js` })
  expect(asset.statusCode).toBe(200)
  expect(asset.body).toBe('console.log(1)')
  expect((await t.app.inject({ method: 'GET', url: `${TEST_ADMIN_PATH}/assets/missing.js` })).statusCode).toBe(404)
  // A file next to the assets is not reachable through them (whatever the answer is, it is not the file).
  const escape = await t.app.inject({ method: 'GET', url: `${TEST_ADMIN_PATH}/assets/%2e%2e/outside.txt` })
  expect(escape.body).not.toContain('not for the web')

  const page = await t.app.inject({ method: 'GET', url: `${TEST_ADMIN_PATH}/lessons/2026-11-03` })
  expect(page.statusCode).toBe(200)
  expect(page.body).toContain('front end')

  const api = await t.app.inject({ method: 'GET', url: `${TEST_ADMIN_PATH}/api/session` })
  expect(api.statusCode).toBe(401)
  expect(api.body).not.toContain('front end')
})

test('without a built front end the page is a Chinese notice', async () => {
  t = await buildAdminTestApp({ distDir: join(tmpdir(), 'no-such-admin-dist') })
  for (const url of [`${TEST_ADMIN_PATH}/`, `${TEST_ADMIN_PATH}/lessons`]) {
    const res = await t.app.inject({ method: 'GET', url })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/html')
    expect(res.body).toContain('后台页面还没打包，先运行 npm run admin:build')
  }
})

test('the logs carry neither the admin path, nor the cookie, nor the password', async () => {
  const logs = captureLogs()
  t = await buildAdminTestApp({ logger: { level: 'info', stream: logs.stream } })
  const cookie = await t.session()
  await t.login({ password: 'wrong guess' })
  await t.app.inject({ method: 'GET', url: `${TEST_ADMIN_PATH}/api/session?x=1`, headers: { cookie } })
  await t.app.inject({ method: 'GET', url: `${TEST_ADMIN_PATH}/lessons/1` })
  await t.app.inject({ method: 'GET', url: `${TEST_ADMIN_PATH.toUpperCase()}/api/session` })
  await t.app.inject({ method: 'GET', url: `/%74est-back-office/api/session` })
  await t.app.inject({ method: 'POST', url: `${TEST_ADMIN_PATH}/api/login`, headers: CSRF, payload: '{ not json' })
  // An ordinary request still logs its own URL.
  await t.app.inject({ method: 'GET', url: '/v1/school-calendar' })

  const text = logs.entries().map((e) => JSON.stringify(e)).join('\n')
  expect(text).not.toContain('test-back-office')
  expect(text).not.toContain(cookie.split('=')[1]!)
  expect(text).not.toContain(TEST_PASSWORD)
  expect(text).not.toContain('wrong guess')
  expect(text).not.toMatch(/sfb_admin/)
  const urls = logs.entries().flatMap((e) => (e.req?.url === undefined ? [] : [e.req.url as string]))
  expect(urls).toContain('[admin]')
  expect(urls).toContain('/v1/school-calendar')
})
