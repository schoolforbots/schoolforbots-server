import { afterEach, describe, expect, test } from 'vitest'
import { base32Decode, base32Encode, hashPassword, totpNow, verifyPassword, verifyTotp } from '../../src/admin/auth.js'
import { adminCredentials } from '../../src/tools/admin-password.js'
import { buildAdminTestApp, CSRF, TEST_ADMIN_PATH, TEST_TOTP_SECRET } from '../helpers/admin.js'

describe('TOTP (RFC 6238, appendix B, SHA-1)', () => {
  const secret = base32Encode(Buffer.from('12345678901234567890'))
  // [unix time, the 8-digit code of the RFC]
  const vectors: [number, string][] = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ]

  test.each(vectors)('at %i the code is %s', (time, code) => {
    expect(totpNow(secret, new Date(time * 1000), 8)).toBe(code)
    expect(totpNow(secret, new Date(time * 1000))).toBe(code.slice(2))
  })

  test('the code of the step before and after is accepted, two steps away is not', () => {
    const at = new Date(1111111111 * 1000)
    for (const shift of [-30, 0, 30]) {
      expect(verifyTotp(secret, totpNow(secret, new Date(at.getTime() + shift * 1000)), at)).toBe(
        Math.floor(at.getTime() / 30_000) + shift / 30,
      )
    }
    for (const shift of [-60, 60]) {
      expect(verifyTotp(secret, totpNow(secret, new Date(at.getTime() + shift * 1000)), at)).toBeNull()
    }
  })

  test('a wrong, short, long or non-numeric code is refused', () => {
    const at = new Date(59 * 1000)
    for (const code of ['', '000000', '28782', '2878200', 'abcdef', '287 082']) {
      expect(verifyTotp(secret, code, at)).toBeNull()
    }
    expect(verifyTotp(secret, '287082', at)).toBe(1)
  })

  test('a secret that is not base32 never matches', () => {
    expect(verifyTotp('not base32!', '123456', new Date())).toBeNull()
  })

  test('base32 round-trips, ignoring case, spaces and padding', () => {
    const bytes = Buffer.from([0, 1, 2, 250, 251, 252, 253])
    const text = base32Encode(bytes)
    expect(base32Decode(text)).toEqual(bytes)
    expect(base32Decode(`${text.toLowerCase().slice(0, 4)} ${text.slice(4)}==`)).toEqual(bytes)
  })
})

describe('passwords', () => {
  test('a hash is scrypt$N$r$p$salt$hash, and only its own password verifies', () => {
    const stored = hashPassword('open sesame')
    expect(stored).toMatch(/^scrypt\$16384\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/)
    expect(verifyPassword('open sesame', stored)).toBe(true)
    expect(verifyPassword('open sesame ', stored)).toBe(false)
    expect(verifyPassword('', stored)).toBe(false)
  })

  test('the same password hashes differently each time (a fresh salt)', () => {
    expect(hashPassword('x')).not.toBe(hashPassword('x'))
  })

  test('a stored value that is not a hash of this form never verifies, and never throws', () => {
    for (const stored of ['', 'plain', 'scrypt$1$2', 'bcrypt$16384$8$1$AAAA$AAAA', 'scrypt$16384$8$1$$', 'scrypt$3$8$1$AAAA$AAAA', `scrypt$${2 ** 30}$8$1$AAAA$AAAA`]) {
      expect(verifyPassword('x', stored)).toBe(false)
    }
  })
})

describe('the password tool output', () => {
  test('a hash that verifies, a fresh base32 secret, and an otpauth link without any path', () => {
    const a = adminCredentials('some long password')
    const b = adminCredentials('some long password')
    expect(verifyPassword('some long password', a.hash)).toBe(true)
    expect(a.secret).toMatch(/^[A-Z2-7]{32}$/)
    expect(a.secret).not.toBe(b.secret)
    const uri = new URL(a.uri)
    expect(uri.protocol).toBe('otpauth:')
    expect(uri.hostname).toBe('totp')
    expect(decodeURIComponent(uri.pathname)).toBe('/机器人网校:后台')
    expect(uri.searchParams.get('secret')).toBe(a.secret)
    expect(uri.searchParams.get('issuer')).toBe('机器人网校')
    expect(a.uri).not.toMatch(/[^\x00-\x7f]/)
  })
})

// Only the tests below build an app; the pure ones above leave it unset.
let t: Awaited<ReturnType<typeof buildAdminTestApp>> = undefined as never
afterEach(async () => {
  await t?.destroy()
  t = undefined as never
})

describe('login', () => {
  test('a right password and code set the cookie, and api/session then works', async () => {
    t = await buildAdminTestApp()
    const res = await t.login()
    expect(res.statusCode).toBe(200)
    const cookie = res.cookies[0]!
    expect(cookie).toMatchObject({
      name: 'sfb_admin',
      httpOnly: true,
      secure: true,
      sameSite: 'Strict',
      path: TEST_ADMIN_PATH,
      maxAge: 12 * 3600,
    })
    const expiresAt = new Date(t.clock.now().getTime() + 12 * 3600_000).toISOString()
    expect(res.json()).toEqual({ expiresAt })

    const session = await t.app.inject({ method: 'GET', url: t.url('api/session'), headers: { cookie: `sfb_admin=${cookie.value}` } })
    expect(session.statusCode).toBe(200)
    expect(session.json()).toEqual({ expiresAt })
  })

  test('only the hash of the token is stored', async () => {
    t = await buildAdminTestApp()
    const res = await t.login()
    const rows = await t.db.selectFrom('adminSessions').selectAll().execute()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.tokenHash).not.toContain(res.cookies[0]!.value)
    expect(rows[0]!.tokenHash).toMatch(/^[0-9a-f]{64}$/)
  })

  test('a wrong password, a wrong code, or both give the same 401 and no cookie', async () => {
    t = await buildAdminTestApp()
    const good = (await t.login({ remoteAddress: '10.0.0.1' })).statusCode
    expect(good).toBe(200)
    const bodies = new Set<string>()
    for (const [i, over] of [{ password: 'wrong' }, { code: '000000' }, { password: 'wrong', code: '000000' }, { code: '' }].entries()) {
      const res = await t.login({ ...over, remoteAddress: `10.0.1.${i}` })
      expect(res.statusCode).toBe(401)
      expect(res.cookies).toEqual([])
      bodies.add(res.body)
    }
    expect(bodies.size).toBe(1)
    expect([...bodies][0]).toContain('密码或验证码不对')
  })

  test('a body of the wrong shape is a 400, not a login', async () => {
    t = await buildAdminTestApp()
    const res = await t.app.inject({ method: 'POST', url: t.url('api/login'), headers: CSRF, payload: { password: 1 } })
    expect(res.statusCode).toBe(400)
  })

  test('without the X-Requested-With header even a right login is a 403', async () => {
    t = await buildAdminTestApp()
    const res = await t.login({ headers: {} })
    expect(res.statusCode).toBe(403)
    expect(await t.db.selectFrom('adminSessions').selectAll().execute()).toEqual([])
  })

  test('the sixth login from one address in a minute is a 429, another address is not limited', async () => {
    t = await buildAdminTestApp()
    for (let i = 0; i < 5; i++) expect((await t.login({ password: 'wrong' })).statusCode).toBe(401)
    expect((await t.login()).statusCode).toBe(429)
    expect((await t.login({ remoteAddress: '10.9.9.9' })).statusCode).toBe(200)
  })

  test('ten wrong logins in a row lock the login for 15 minutes, even for the right ones; a success resets the count', async () => {
    t = await buildAdminTestApp()
    let n = 0
    const wrong = () => t.login({ password: 'wrong', remoteAddress: `10.1.0.${n++}` })
    // nine failures, one success: the count starts again
    for (let i = 0; i < 9; i++) expect((await wrong()).statusCode).toBe(401)
    expect((await t.login({ remoteAddress: `10.1.0.${n++}` })).statusCode).toBe(200)
    for (let i = 0; i < 9; i++) expect((await wrong()).statusCode).toBe(401)
    // the tenth failure
    expect((await wrong()).statusCode).toBe(401)

    const locked = await t.login({ remoteAddress: `10.1.0.${n++}` })
    expect(locked.statusCode).toBe(429)
    expect(locked.json().error.message).toContain('锁定')
    expect(locked.cookies).toEqual([])

    t.clock.advance(14 * 60_000)
    expect((await t.login({ remoteAddress: `10.1.0.${n++}` })).statusCode).toBe(429)
    t.clock.advance(60_000 + 1)
    expect((await t.login({ remoteAddress: `10.1.0.${n++}` })).statusCode).toBe(200)
  })

  test('the locked login does not check the password, so it cannot be used to guess it', async () => {
    t = await buildAdminTestApp()
    for (let i = 0; i < 10; i++) await t.login({ password: 'wrong', remoteAddress: `10.2.0.${i}` })
    const right = await t.login({ remoteAddress: '10.2.1.1' })
    expect(right.statusCode).toBe(429)
    expect(await t.db.selectFrom('adminSessions').selectAll().execute()).toEqual([])
  })

  test('a code that has logged in is refused the second time, as a failure, and so is an older one', async () => {
    t = await buildAdminTestApp()
    const at = t.clock.now()
    const code = (ms: number) => totpNow(TEST_TOTP_SECRET, new Date(at.getTime() + ms))
    expect((await t.login({ code: code(0), remoteAddress: '10.4.0.1' })).statusCode).toBe(200)

    const again = await t.login({ code: code(0), remoteAddress: '10.4.0.2' })
    expect(again.statusCode).toBe(401)
    expect(again.cookies).toEqual([])
    expect((await t.login({ code: code(-30_000), remoteAddress: '10.4.0.3' })).statusCode).toBe(401)
    expect(await t.db.selectFrom('adminSessions').selectAll().execute()).toHaveLength(1)

    // the next step's code is a new one
    expect((await t.login({ code: code(30_000), remoteAddress: '10.4.0.4' })).statusCode).toBe(200)
  })

  test('a refused replay counts towards the lock', async () => {
    t = await buildAdminTestApp()
    expect((await t.login({ remoteAddress: '10.5.0.0' })).statusCode).toBe(200)
    // the same code, ten times: the code is right but used
    for (let i = 1; i <= 10; i++) {
      expect((await t.login({ code: totpNow(TEST_TOTP_SECRET, t.clock.now()), remoteAddress: `10.5.0.${i}` })).statusCode).toBe(401)
    }
    expect((await t.login({ code: totpNow(TEST_TOTP_SECRET, new Date(t.clock.now().getTime() + 30_000)), remoteAddress: '10.5.1.1' })).statusCode).toBe(429)
  })

  test('a code of the neighbouring step is accepted, and one of two steps away is not', async () => {
    t = await buildAdminTestApp()
    const at = t.clock.now()
    expect((await t.login({ code: totpNow(TEST_TOTP_SECRET, new Date(at.getTime() + 60_000)), remoteAddress: '10.3.0.1' })).statusCode).toBe(401)
    expect((await t.login({ code: totpNow(TEST_TOTP_SECRET, new Date(at.getTime() - 30_000)), remoteAddress: '10.3.0.2' })).statusCode).toBe(200)
  })
})

describe('sessions', () => {
  test('no cookie, a made-up cookie, and an expired session are 401', async () => {
    t = await buildAdminTestApp()
    const get = (cookie?: string) =>
      t.app.inject({ method: 'GET', url: t.url('api/session'), headers: cookie ? { cookie } : {} })
    expect((await get()).statusCode).toBe(401)
    expect((await get('sfb_admin=nonsense')).statusCode).toBe(401)

    const cookie = await t.session()
    expect((await get(cookie)).statusCode).toBe(200)
    t.clock.advance(12 * 3600_000 - 1)
    expect((await get(cookie)).statusCode).toBe(200)
    t.clock.advance(1)
    expect((await get(cookie)).statusCode).toBe(401)
  })

  test('every other address under api/ needs a session too, even one that does not exist', async () => {
    t = await buildAdminTestApp()
    for (const [method, path] of [['GET', 'api/switches'], ['GET', 'api/nothing'], ['POST', 'api/logout'], ['PUT', 'api/switches/teacherLlm']] as const) {
      const res = await t.app.inject({ method, url: t.url(path), headers: CSRF, payload: method === 'GET' ? undefined : { on: true } })
      expect(res.statusCode, `${method} ${path}`).toBe(401)
    }
    const cookie = await t.session()
    expect((await t.app.inject({ method: 'GET', url: t.url('api/nothing'), headers: { cookie } })).statusCode).toBe(404)
  })

  test('logout deletes the session and clears the cookie; it needs the header too', async () => {
    t = await buildAdminTestApp()
    const cookie = await t.session()
    const refused = await t.app.inject({ method: 'POST', url: t.url('api/logout'), headers: { cookie } })
    expect(refused.statusCode).toBe(403)

    const res = await t.app.inject({ method: 'POST', url: t.url('api/logout'), headers: { cookie, ...CSRF } })
    expect(res.statusCode).toBe(200)
    expect(res.cookies[0]).toMatchObject({ name: 'sfb_admin', value: '', path: TEST_ADMIN_PATH })
    expect(await t.db.selectFrom('adminSessions').selectAll().execute()).toEqual([])
    const after = await t.app.inject({ method: 'GET', url: t.url('api/session'), headers: { cookie } })
    expect(after.statusCode).toBe(401)
  })

  test('a new login removes the sessions that have expired', async () => {
    t = await buildAdminTestApp()
    await t.session()
    t.clock.advance(13 * 3600_000)
    await t.session()
    expect(await t.db.selectFrom('adminSessions').selectAll().execute()).toHaveLength(1)
  })

  test('the API behind the login has a limit of its own, apart from the public one', async () => {
    t = await buildAdminTestApp()
    const cookie = await t.session()
    const get = () => t.app.inject({ method: 'GET', url: t.url('api/session'), headers: { cookie } })
    // More than the public limit of one address in a minute (60 with the example config) all go through...
    expect(t.config.httpRateLimitPerMinute).toBe(60)
    for (let i = 0; i < 61; i++) expect((await get()).statusCode).toBe(200)
    // ...and leave the public limit of the address as it was.
    for (let i = 0; i < 60; i++) {
      expect((await t.app.inject({ method: 'GET', url: '/v1/school-calendar' })).statusCode).toBe(200)
    }
    expect((await t.app.inject({ method: 'GET', url: '/v1/school-calendar' })).statusCode).toBe(429)
    // The admin's own limit is 600 in a minute.
    for (let i = 61; i < 600; i++) await get()
    const over = await get()
    expect(over.statusCode).toBe(429)
    expect(over.json().error.code).toBe('rate_limited')
  })
})
