import type { LightMyRequestResponse } from 'fastify'
import { afterEach, describe, expect, test } from 'vitest'
import { buildAdminTestApp, CSRF, TEST_ADMIN_PATH } from '../helpers/admin.js'
import { buildTestApp, exampleConfig } from '../helpers/app.js'

// What the school publishes to everyone can be read by a web page on any site, in its visitor's browser; nothing else
// can, and no CORS preflight is answered.

/** The routes a page on another site may read, as Fastify names them. */
const CROSS_SITE = ['/v1/school-calendar', '/v1/school-rules', '/v1/school-rules/diff', '/v1/school-rules/:version']

/** What a browser adds to a request a page on another site makes. */
const FROM_ANOTHER_SITE = { origin: 'https://another-site.example' }

let destroy: (() => Promise<void>) | undefined

afterEach(async () => {
  await destroy?.()
  destroy = undefined
})

async function schoolApp(config: Parameters<typeof exampleConfig>[0] = {}) {
  const t = await buildTestApp({ config })
  destroy = t.destroy
  return t
}

function expectReadableFromAnySite(res: LightMyRequestResponse) {
  expect(res.headers['access-control-allow-origin']).toBe('*')
  // `*` already keeps the visitor's cookies out of it; this header would ask for them.
  expect(res.headers['access-control-allow-credentials']).toBeUndefined()
}

function expectNotReadableFromAnotherSite(res: LightMyRequestResponse) {
  expect(Object.keys(res.headers).filter((name) => name.startsWith('access-control-'))).toEqual([])
}

describe('reading the school calendar and the school rules from another site', () => {
  test('each of the four routes allows any site', async () => {
    const t = await schoolApp()
    const current = t.schoolRules.current.version

    for (const url of [
      '/v1/school-calendar',
      '/v1/school-rules',
      `/v1/school-rules/diff?from=${current}`,
      `/v1/school-rules/${current}`,
    ]) {
      const res = await t.app.inject({ method: 'GET', url, headers: FROM_ANOTHER_SITE })
      expect(res.statusCode, url).toBe(200)
      expectReadableFromAnySite(res)
    }
  })

  test('so does an error from them, so the page can tell what went wrong', async () => {
    const t = await schoolApp()

    for (const [url, status] of [
      ['/v1/school-rules/2000-01-01', 404],
      ['/v1/school-rules/not-a-date', 400],
      ['/v1/school-rules/diff', 400],
      ['/v1/school-rules/diff?from=2000-01-01', 404],
    ] as const) {
      const res = await t.app.inject({ method: 'GET', url, headers: FROM_ANOTHER_SITE })
      expect(res.statusCode, url).toBe(status)
      expectReadableFromAnySite(res)
    }
  })

  test('and so does the rate limit, so a page can tell it apart from a school it cannot reach', async () => {
    const t = await schoolApp({ httpRateLimitPerMinute: 1 })

    await t.app.inject({ method: 'GET', url: '/v1/school-calendar', headers: FROM_ANOTHER_SITE })
    const res = await t.app.inject({ method: 'GET', url: '/v1/school-calendar', headers: FROM_ANOTHER_SITE })

    expect(res.statusCode).toBe(429)
    expect(res.json().error.code).toBe('rate_limited')
    expectReadableFromAnySite(res)
  })

  test('no preflight is answered, so only a simple GET gets through', async () => {
    const t = await schoolApp()

    for (const url of ['/v1/school-calendar', '/v1/school-rules']) {
      const preflight = await t.app.inject({
        method: 'OPTIONS',
        url,
        headers: {
          ...FROM_ANOTHER_SITE,
          'access-control-request-method': 'GET',
          'access-control-request-headers': 'authorization',
        },
      })
      expect(preflight.statusCode, url).toBe(404)
      expectNotReadableFromAnotherSite(preflight)

      const post = await t.app.inject({ method: 'POST', url, headers: FROM_ANOTHER_SITE })
      expect(post.statusCode, url).toBe(404)
      expectNotReadableFromAnotherSite(post)
    }
  })

  test('no other route allows another site, the admin pages included', async () => {
    const routes: { method: string; url: string }[] = []
    const t = await buildAdminTestApp({
      // High enough that every request reaches its route instead of the rate limit.
      config: exampleConfig({ httpRateLimitPerMinute: 10_000 }),
      onRoute: (route) => {
        for (const method of [route.method].flat()) routes.push({ method, url: route.url })
      },
    })
    destroy = t.destroy

    // The list really holds the route groups: the four routes above, the plugin API and the admin pages.
    expect(routes.map((route) => route.url)).toEqual(expect.arrayContaining(CROSS_SITE))
    expect(routes).toEqual(
      expect.arrayContaining([
        { method: 'POST', url: '/v1/registrations' },
        { method: 'GET', url: '/v1/me' },
        { method: 'POST', url: `${TEST_ADMIN_PATH}/api/login` },
      ]),
    )
    // The health checks are added straight onto the app, before the hook is, so they are named here.
    const others = [
      ...routes.filter((route) => !CROSS_SITE.includes(route.url)),
      { method: 'GET', url: '/healthz' },
      { method: 'GET', url: '/healthz/mail' },
    ]

    for (const { method, url } of others) {
      // Any value in place of a parameter or a wildcard: whatever the route answers, it must not allow another site.
      const path = url.replace(/:\w+/g, 'x').replace(/\*$/, 'x')
      const res = await t.app.inject({
        method: method as 'GET',
        url: path,
        headers: { ...FROM_ANOTHER_SITE, ...CSRF, authorization: 'Bearer not-a-real-key' },
      })
      expect(res.statusCode, `${method} ${url}`).not.toBe(429)
      expectNotReadableFromAnotherSite(res)
    }
  })
})
