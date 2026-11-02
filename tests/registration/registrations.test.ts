import { randomUUID } from 'node:crypto'
import { Value } from 'typebox/value'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { ErrorBody, RegistrationAccepted, VerifyResult } from '../../src/protocol/http.js'
import { hashSecret } from '../../src/shared/secrets.js'
import { buildTestApp } from '../helpers/app.js'
import { insertStudent } from '../helpers/factories.js'
import { captureLogs } from '../helpers/logs.js'

type TestApp = Awaited<ReturnType<typeof buildTestApp>>

const MINUTE = 60_000
const HOUR = 60 * MINUTE

let t: TestApp

beforeEach(async () => {
  t = await buildTestApp()
})

afterEach(async () => {
  await t.destroy()
})

/** Replaces the app of the current test with one built from the example config plus these overrides. */
async function useConfig(config: NonNullable<Parameters<typeof buildTestApp>[0]>['config']) {
  await t.destroy()
  t = await buildTestApp({ config })
}

function registrationBody(overrides: Record<string, unknown> = {}) {
  return {
    email: 'A@Example.com ',
    ownerName: '阿杰',
    aiName: '小鱼',
    division: 'junior',
    slot: 'evening',
    installId: randomUUID(),
    plugin: { type: 'astrbot', version: '0.1.0' },
    ...overrides,
  }
}

function register(body: unknown, remoteAddress?: string) {
  return t.app.inject({
    method: 'POST',
    url: '/v1/registrations',
    payload: body as object,
    ...(remoteAddress === undefined ? {} : { remoteAddress }),
  })
}

function verify(registrationId: string, code: string) {
  return t.app.inject({ method: 'POST', url: `/v1/registrations/${registrationId}/verify`, payload: { code } })
}

/** Registers, expects 202, and returns the id plus the code from the newest mail. */
async function registerOk(overrides: Record<string, unknown> = {}, remoteAddress?: string) {
  const res = await register(registrationBody(overrides), remoteAddress)
  expect(res.statusCode).toBe(202)
  const { registrationId } = res.json<{ registrationId: string }>()
  const code = t.mailer.sent.at(-1)!.code
  return { registrationId, code }
}

function wrongCodeFor(code: string): string {
  return code === '000000' ? '111111' : '000000'
}

async function ban(p: { email?: string; installId?: string; until: Date }) {
  await t.db
    .insertInto('bans')
    .values({ email: p.email ?? null, installId: p.installId ?? null, until: p.until, reason: 'test', createdAt: t.clock.now() })
    .execute()
}

function errorOf(res: { json<T>(): T }) {
  return res.json<{ error: { code: string; message: string; [k: string]: unknown } }>().error
}

describe('POST /v1/registrations', () => {
  test('register sends a 6-digit code to the normalized email', async () => {
    const installId = randomUUID()
    const res = await register(registrationBody({ installId }))

    expect(res.statusCode).toBe(202)
    const body = res.json<{ registrationId: string; expiresAt: string }>()
    expect(Value.Check(RegistrationAccepted, body)).toBe(true)
    expect(body.expiresAt).toBe(new Date(t.clock.now().getTime() + 10 * MINUTE).toISOString())

    expect(t.mailer.sent).toEqual([
      { to: 'a@example.com', purpose: 'register', code: expect.stringMatching(/^\d{6}$/) },
    ])

    const row = await t.db
      .selectFrom('registrations')
      .selectAll()
      .where('id', '=', body.registrationId)
      .executeTakeFirstOrThrow()
    expect(row).toMatchObject({
      email: 'a@example.com',
      ownerName: '阿杰',
      aiName: '小鱼',
      division: 'junior',
      slot: 'evening',
      installId,
      pluginType: 'astrbot',
      pluginVersion: '0.1.0',
      ip: '127.0.0.1',
      codeHash: hashSecret(t.mailer.sent[0]!.code),
      attempts: 0,
      referrerId: null,
      verifiedAt: null,
    })
    expect(row.createdAt).toEqual(t.clock.now())
    expect(row.expiresAt).toEqual(new Date(t.clock.now().getTime() + 10 * MINUTE))
  })

  test('the stored name parts are the normalized ones', async () => {
    const { registrationId } = await registerOk({ ownerName: '  阿​杰 ', aiName: '小  鱼' })
    const row = await t.db.selectFrom('registrations').selectAll().where('id', '=', registrationId).executeTakeFirstOrThrow()
    expect(row).toMatchObject({ ownerName: '阿杰', aiName: '小 鱼' })
  })

  test('bad name is rejected with part and reason', async () => {
    const res = await register(registrationBody({ ownerName: '一二三四五六七八九十一' }))
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({
      error: { code: 'invalid_name', message: expect.any(String), part: 'owner', reason: 'too_long' },
    })
    expect(Value.Check(ErrorBody, res.json())).toBe(true)
    expect(t.mailer.sent).toEqual([])
  })

  test('an empty AI name is reported as part ai, reason empty', async () => {
    const res = await register(registrationBody({ aiName: ' ​ ' }))
    expect(res.statusCode).toBe(400)
    expect(errorOf(res)).toMatchObject({ code: 'invalid_name', part: 'ai', reason: 'empty' })
  })

  test('a moderation hit says which part failed but never echoes what matched', async () => {
    const res = await register(registrationBody({ aiName: '示例违禁词' }))
    expect(res.statusCode).toBe(400)
    const error = errorOf(res)
    expect(error).toMatchObject({ code: 'invalid_name', part: 'ai', reason: 'moderation' })
    expect(Object.keys(error).sort()).toEqual(['code', 'message', 'part', 'reason'])
    expect(res.body).not.toContain('示例违禁词')
  })

  test('fourth AI on one email is refused; dropped ones do not count', async () => {
    await insertStudent(t.db, { email: 'a@example.com', status: 'active' })
    await insertStudent(t.db, { email: 'a@example.com', status: 'active' })
    await insertStudent(t.db, { email: 'a@example.com', status: 'dropped' })
    expect((await register(registrationBody())).statusCode).toBe(202)

    await insertStudent(t.db, { email: 'a@example.com', status: 'active' })
    const res = await register(registrationBody())
    expect(res.statusCode).toBe(409)
    expect(errorOf(res).code).toBe('email_limit')
  })

  test('install id with a seat is refused', async () => {
    const installId = randomUUID()
    await insertStudent(t.db, { installId, status: 'active' })
    const res = await register(registrationBody({ installId }))
    expect(res.statusCode).toBe(409)
    expect(errorOf(res).code).toBe('install_has_seat')
    expect(t.mailer.sent).toEqual([])
  })

  test('an install id whose student dropped out can register again', async () => {
    const installId = randomUUID()
    await insertStudent(t.db, { installId, status: 'dropped' })
    expect((await register(registrationBody({ installId }))).statusCode).toBe(202)
  })

  test.each(['email', 'installId'] as const)('active ban on the %s blocks, expired ban does not', async (kind) => {
    const installId = randomUUID()
    const target = kind === 'email' ? { email: 'A@EXAMPLE.com' } : { installId }
    const now = t.clock.now()

    await ban({ ...target, until: new Date(now.getTime() + HOUR) })
    const blocked = await register(registrationBody({ installId }))
    expect(blocked.statusCode).toBe(403)
    expect(errorOf(blocked).code).toBe('banned')
    expect(t.mailer.sent).toEqual([])

    // A ban that ends exactly now is over: only until > now counts.
    t.clock.advance(HOUR)
    expect((await register(registrationBody({ installId }))).statusCode).toBe(202)
  })

  test('an expired ban in the past does not block', async () => {
    const installId = randomUUID()
    await ban({ email: 'a@example.com', until: new Date(t.clock.now().getTime() - 1) })
    await ban({ installId, until: new Date(t.clock.now().getTime() - HOUR) })
    expect((await register(registrationBody({ installId }))).statusCode).toBe(202)
  })

  test('sixth registration from one IP within 24h is refused', async () => {
    const ip = '203.0.113.7'
    for (let i = 0; i < 5; i++) {
      const res = await register(registrationBody({ email: `ip${i}@example.com` }), ip)
      expect(res.statusCode).toBe(202)
    }
    const sixth = await register(registrationBody({ email: 'ip5@example.com' }), ip)
    expect(sixth.statusCode).toBe(429)
    expect(errorOf(sixth).code).toBe('ip_limit')

    // Another address is unaffected, and the window slides: 24 hours later the first five are out of it.
    expect((await register(registrationBody({ email: 'other@example.com' }), '203.0.113.8')).statusCode).toBe(202)
    t.clock.advance(24 * HOUR + 1000)
    expect((await register(registrationBody({ email: 'ip5@example.com' }), ip)).statusCode).toBe(202)
  })

  test('parallel registrations from one IP cannot exceed the daily limit', async () => {
    const results = await Promise.all(
      Array.from({ length: 9 }, (_, i) => register(registrationBody({ email: `p${i}@example.com` }), '203.0.113.9')),
    )
    expect(results.map((r) => r.statusCode).sort()).toEqual([202, 202, 202, 202, 202, 429, 429, 429, 429])
    expect(t.mailer.sent).toHaveLength(5)
  })

  test('two identical registrations at the same moment send one mail', async () => {
    const body = registrationBody()
    const results = await Promise.all([register(body), register(body)])
    expect(results.map((r) => r.statusCode).sort()).toEqual([202, 429])
    expect(errorOf(results.find((r) => r.statusCode === 429)!).code).toBe('resend_too_soon')
    expect(t.mailer.sent).toHaveLength(1)
  })

  test('resend within 60s is refused, after 61s allowed', async () => {
    const installId = randomUUID()
    expect((await register(registrationBody({ installId }))).statusCode).toBe(202)

    t.clock.advance(30_000)
    const tooSoon = await register(registrationBody({ installId }))
    expect(tooSoon.statusCode).toBe(429)
    expect(errorOf(tooSoon).code).toBe('resend_too_soon')
    expect(t.mailer.sent).toHaveLength(1)

    // The window is per email and install id: another install id on the same email is fine.
    expect((await register(registrationBody())).statusCode).toBe(202)

    t.clock.advance(31_000)
    expect((await register(registrationBody({ installId }))).statusCode).toBe(202)
    expect(t.mailer.sent).toHaveLength(3)
  })

  test('checks run in the documented order', async () => {
    const ipX = '198.51.100.9'
    const until = new Date(t.clock.now().getTime() + HOUR)

    // name before ban
    await ban({ email: 'banned@example.com', until })
    const badName = await register(registrationBody({ email: 'banned@example.com', ownerName: '' }))
    expect(errorOf(badName).code).toBe('invalid_name')

    // ban before IP limit: fill ipX, then a banned email from ipX is banned, not ip_limited
    for (let i = 0; i < 5; i++) {
      expect((await register(registrationBody({ email: `fill${i}@example.com` }), ipX)).statusCode).toBe(202)
    }
    const banned = await register(registrationBody({ email: 'banned@example.com' }), ipX)
    expect(errorOf(banned).code).toBe('banned')

    // IP limit before email limit
    const heldInstall = randomUUID()
    await insertStudent(t.db, { email: 'full@example.com', status: 'active', installId: heldInstall })
    await insertStudent(t.db, { email: 'full@example.com', status: 'active' })
    await insertStudent(t.db, { email: 'full@example.com', status: 'pending' })
    const ipLimited = await register(registrationBody({ email: 'full@example.com' }), ipX)
    expect(errorOf(ipLimited).code).toBe('ip_limit')

    // email limit before install seat
    const emailFull = await register(registrationBody({ email: 'full@example.com', installId: heldInstall }))
    expect(errorOf(emailFull).code).toBe('email_limit')
    const installHeld = await register(registrationBody({ email: 'free@example.com', installId: heldInstall }))
    expect(errorOf(installHeld).code).toBe('install_has_seat')

    // install seat before resend window
    const installId = randomUUID()
    expect((await register(registrationBody({ email: 'late@example.com', installId }))).statusCode).toBe(202)
    await insertStudent(t.db, { email: 'someone@example.com', status: 'active', installId })
    const seatFirst = await register(registrationBody({ email: 'late@example.com', installId }))
    expect(errorOf(seatFirst).code).toBe('install_has_seat')
  })

  test('unknown referrer is stored as null, known one is kept', async () => {
    const referrer = await insertStudent(t.db, { status: 'active' })

    const known = await registerOk({ referrerStudentId: referrer.id })
    const unknown = await registerOk({ referrerStudentId: 2_000_000_000 })

    const knownVerified = await verify(known.registrationId, known.code)
    const unknownVerified = await verify(unknown.registrationId, unknown.code)
    expect(knownVerified.statusCode).toBe(201)
    expect(unknownVerified.statusCode).toBe(201)

    const knownStudent = await t.db
      .selectFrom('students')
      .select('referrerId')
      .where('id', '=', knownVerified.json<{ studentId: number }>().studentId)
      .executeTakeFirstOrThrow()
    const unknownStudent = await t.db
      .selectFrom('students')
      .select('referrerId')
      .where('id', '=', unknownVerified.json<{ studentId: number }>().studentId)
      .executeTakeFirstOrThrow()
    expect(knownStudent.referrerId).toBe(referrer.id)
    expect(unknownStudent.referrerId).toBeNull()
  })

  test('a failed mail send removes the registration so the owner can retry at once', async () => {
    const installId = randomUUID()
    vi.spyOn(t.mailer, 'sendCode').mockRejectedValueOnce(new Error('smtp down'))

    const failed = await register(registrationBody({ installId }))
    expect(failed.statusCode).toBe(500)
    expect(errorOf(failed).code).toBe('internal_error')
    expect(await t.db.selectFrom('registrations').selectAll().execute()).toEqual([])

    expect((await register(registrationBody({ installId }))).statusCode).toBe(202)
  })

  test.each([
    ['a name over 64 characters', { ownerName: '阿'.repeat(65) }],
    ['an AI name over 64 characters', { aiName: 'x'.repeat(65) }],
    ['an email over 254 characters', { email: `${'a'.repeat(250)}@example.com` }],
    ['a plugin type over 64 characters', { plugin: { type: 't'.repeat(65), version: '1' } }],
    ['a plugin version over 64 characters', { plugin: { type: 't', version: '1'.repeat(65) } }],
    ['an empty plugin type', { plugin: { type: '', version: '1' } }],
    ['a malformed email', { email: 'not-an-email' }],
    ['a quoted email local part', { email: '"a b"@example.com' }],
    ['an email with a line break', { email: 'a@example.com\r\nBcc: x@example.net' }],
    ['a non-string email', { email: 5 }],
    ['an install id that is not a uuid', { installId: 'abc' }],
    ['an unknown division', { division: 'college' }],
    ['an unknown slot', { slot: 'night' }],
    ['a missing plugin', { plugin: undefined }],
    ['a referrer id of zero', { referrerStudentId: 0 }],
    ['a fractional referrer id', { referrerStudentId: 1.5 }],
    ['a referrer id beyond the integer column', { referrerStudentId: 2 ** 31 }],
  ])('rejects %s with 400 invalid_request', async (_label, overrides) => {
    const res = await register(registrationBody(overrides))
    expect(res.statusCode).toBe(400)
    expect(errorOf(res).code).toBe('invalid_request')
    expect(Value.Check(ErrorBody, res.json())).toBe(true)
    expect(t.mailer.sent).toEqual([])
  })

  test('rejects an unparseable body and an empty body with 400 invalid_request', async () => {
    const garbled = await t.app.inject({
      method: 'POST',
      url: '/v1/registrations',
      headers: { 'content-type': 'application/json' },
      payload: '{"email":',
    })
    expect(garbled.statusCode).toBe(400)
    expect(errorOf(garbled).code).toBe('invalid_request')

    const empty = await t.app.inject({ method: 'POST', url: '/v1/registrations' })
    expect(empty.statusCode).toBe(400)
    expect(errorOf(empty).code).toBe('invalid_request')
  })

  test('unknown routes answer in the standard error body', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/v1/nope' })
    expect(res.statusCode).toBe(404)
    expect(errorOf(res).code).toBe('not_found')
  })
})

describe('POST /v1/registrations/:id/verify', () => {
  test('verify with the right code returns key and pending status', async () => {
    const installId = randomUUID()
    const { registrationId, code } = await registerOk({ installId })
    const res = await verify(registrationId, code)

    expect(res.statusCode).toBe(201)
    const body = res.json<{ studentId: number; key: string; status: string }>()
    expect(Value.Check(VerifyResult, body)).toBe(true)
    expect(body).toEqual({ studentId: expect.any(Number), key: expect.stringMatching(/^ais_/), status: 'pending' })

    const student = await t.db.selectFrom('students').selectAll().where('id', '=', body.studentId).executeTakeFirstOrThrow()
    expect(student.keyHash).toBe(hashSecret(body.key))
    expect(JSON.stringify(student)).not.toContain(body.key)
    expect(student).toMatchObject({
      email: 'a@example.com',
      ownerName: '阿杰',
      aiName: '小鱼',
      division: 'junior',
      slot: 'evening',
      status: 'pending',
      classId: null,
      installId,
      pluginType: 'astrbot',
      pluginVersion: '0.1.0',
      referrerId: null,
      registrationIp: '127.0.0.1',
      assignedAt: null,
      lastAttendedAt: null,
      lastRenamedAt: null,
      lessonsAttended: 0,
    })
    expect(student.createdAt).toEqual(t.clock.now())

    const registration = await t.db
      .selectFrom('registrations')
      .select('verifiedAt')
      .where('id', '=', registrationId)
      .executeTakeFirstOrThrow()
    expect(registration.verifiedAt).toEqual(t.clock.now())
  })

  test('verifying twice returns already_verified', async () => {
    const { registrationId, code } = await registerOk()
    expect((await verify(registrationId, code)).statusCode).toBe(201)
    const again = await verify(registrationId, code)
    expect(again.statusCode).toBe(409)
    expect(errorOf(again).code).toBe('already_verified')
  })

  test('an unknown registration is not_found', async () => {
    const res = await verify(randomUUID(), '123456')
    expect(res.statusCode).toBe(404)
    expect(errorOf(res).code).toBe('not_found')
  })

  test('a registration id that is not a uuid is invalid_request', async () => {
    const res = await verify('nope', '123456')
    expect(res.statusCode).toBe(400)
    expect(errorOf(res).code).toBe('invalid_request')
  })

  test.each(['12345', '1234567', 'abcdef', '12 345', ''])('a code of %j is invalid_request', async (code) => {
    const { registrationId } = await registerOk()
    const res = await verify(registrationId, code)
    expect(res.statusCode).toBe(400)
    expect(errorOf(res).code).toBe('invalid_request')
    const row = await t.db.selectFrom('registrations').select('attempts').where('id', '=', registrationId).executeTakeFirstOrThrow()
    expect(row.attempts).toBe(0)
  })

  test('wrong code counts attempts; after 5 even the right code fails', async () => {
    const { registrationId, code } = await registerOk()
    for (let i = 1; i <= 5; i++) {
      const res = await verify(registrationId, wrongCodeFor(code))
      expect(res.statusCode).toBe(400)
      expect(errorOf(res).code).toBe('code_invalid')
      const row = await t.db.selectFrom('registrations').select('attempts').where('id', '=', registrationId).executeTakeFirstOrThrow()
      expect(row.attempts).toBe(i)
    }

    const res = await verify(registrationId, code)
    expect(res.statusCode).toBe(429)
    expect(errorOf(res).code).toBe('code_attempts_exceeded')
    // The wording is shared with the key-reset flow, so it must not tell anyone to register again.
    expect(errorOf(res).message).toBe('验证码错得太多次了，请重新获取。')
    expect(await t.db.selectFrom('students').selectAll().execute()).toEqual([])
  })

  test('expired code returns code_expired', async () => {
    const { registrationId, code } = await registerOk()
    t.clock.advance(11 * MINUTE)
    const res = await verify(registrationId, code)
    expect(res.statusCode).toBe(410)
    expect(errorOf(res).code).toBe('code_expired')
    expect(errorOf(res).message).toBe('验证码已经过期，请重新获取。')
  })

  test('the code is still good just before it expires and dead at the expiry time', async () => {
    const first = await registerOk()
    t.clock.advance(10 * MINUTE - 1)
    expect((await verify(first.registrationId, first.code)).statusCode).toBe(201)

    const second = await registerOk()
    t.clock.advance(10 * MINUTE)
    expect((await verify(second.registrationId, second.code)).statusCode).toBe(410)
  })

  test('the email limit is checked again at verification', async () => {
    const { registrationId, code } = await registerOk()
    for (let i = 0; i < 3; i++) await insertStudent(t.db, { email: 'a@example.com', status: 'active' })

    const res = await verify(registrationId, code)
    expect(res.statusCode).toBe(409)
    expect(errorOf(res).code).toBe('email_limit')
    expect(await t.db.selectFrom('students').select('id').where('email', '=', 'a@example.com').execute()).toHaveLength(3)
  })

  test('an install id that took a seat meanwhile gets install_has_seat', async () => {
    const installId = randomUUID()
    const { registrationId, code } = await registerOk({ installId })
    await insertStudent(t.db, { installId, status: 'active' })

    const res = await verify(registrationId, code)
    expect(res.statusCode).toBe(409)
    expect(errorOf(res).code).toBe('install_has_seat')
  })

  test('full slot puts the student on the waitlist', async () => {
    await useConfig({ slotCapacity: 2 })
    await insertStudent(t.db, { slot: 'evening', status: 'active' })
    await insertStudent(t.db, { slot: 'evening', status: 'active', division: 'senior' })

    const { registrationId, code } = await registerOk({ slot: 'evening' })
    const res = await verify(registrationId, code)
    expect(res.statusCode).toBe(201)
    expect(res.json()).toMatchObject({ status: 'waitlisted' })

    const student = await t.db
      .selectFrom('students')
      .select('status')
      .where('id', '=', res.json<{ studentId: number }>().studentId)
      .executeTakeFirstOrThrow()
    expect(student.status).toBe('waitlisted')
  })

  test('capacity counts pending, active and suspended students of that slot only', async () => {
    await useConfig({ slotCapacity: 4 })
    await insertStudent(t.db, { slot: 'evening', status: 'active' })
    await insertStudent(t.db, { slot: 'evening', status: 'pending' })
    await insertStudent(t.db, { slot: 'evening', status: 'suspended' })
    // Neither of these holds a counted seat, and morning students are another slot altogether.
    await insertStudent(t.db, { slot: 'evening', status: 'waitlisted' })
    await insertStudent(t.db, { slot: 'evening', status: 'dropped' })
    await insertStudent(t.db, { slot: 'morning', status: 'active' })
    await insertStudent(t.db, { slot: 'morning', status: 'active' })

    const first = await registerOk({ email: 'one@example.com', slot: 'evening' })
    expect(await verify(first.registrationId, first.code).then((r) => r.json())).toMatchObject({ status: 'pending' })

    const second = await registerOk({ email: 'two@example.com', slot: 'evening' })
    expect(await verify(second.registrationId, second.code).then((r) => r.json())).toMatchObject({ status: 'waitlisted' })

    const morning = await registerOk({ email: 'three@example.com', slot: 'morning' })
    expect(await verify(morning.registrationId, morning.code).then((r) => r.json())).toMatchObject({ status: 'pending' })
  })

  test('concurrent verifies for one install id yield one seat', async () => {
    const installId = randomUUID()
    const first = await registerOk({ installId })
    t.clock.advance(61_000)
    const second = await registerOk({ installId })
    expect(second.registrationId).not.toBe(first.registrationId)

    const results = await Promise.all([verify(first.registrationId, first.code), verify(second.registrationId, second.code)])
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409])
    expect(errorOf(results.find((r) => r.statusCode === 409)!).code).toBe('install_has_seat')

    const seats = await t.db.selectFrom('students').select('id').where('installId', '=', installId).execute()
    expect(seats).toHaveLength(1)
  })

  test('concurrent verifies cannot overshoot the slot capacity', async () => {
    await useConfig({ slotCapacity: 2 })
    const pending = []
    for (let i = 0; i < 5; i++) pending.push(await registerOk({ email: `c${i}@example.com` }))

    const results = await Promise.all(pending.map((p) => verify(p.registrationId, p.code)))
    expect(results.map((r) => r.statusCode)).toEqual([201, 201, 201, 201, 201])
    const statuses = results.map((r) => r.json<{ status: string }>().status).sort()
    expect(statuses).toEqual(['pending', 'pending', 'waitlisted', 'waitlisted', 'waitlisted'])
  })

  test('concurrent verifies cannot overshoot the email limit', async () => {
    const pending = []
    for (let i = 0; i < 5; i++) pending.push(await registerOk())

    const results = await Promise.all(pending.map((p) => verify(p.registrationId, p.code)))
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 201, 201, 409, 409])
    expect(await t.db.selectFrom('students').select('id').where('email', '=', 'a@example.com').execute()).toHaveLength(3)
  })

  test('concurrent wrong guesses cannot get past the attempt limit', async () => {
    const { registrationId, code } = await registerOk()
    const guesses = Array.from({ length: 20 }, (_, i) => String(i).padStart(6, '0')).filter((g) => g !== code)

    const results = await Promise.all(guesses.map((g) => verify(registrationId, g)))
    expect(results.filter((r) => r.statusCode === 400)).toHaveLength(5)
    expect(results.filter((r) => r.statusCode === 429)).toHaveLength(results.length - 5)
  })
})

describe('global rate limit', () => {
  test('exceeding the per-IP limit answers 429 rate_limited in the standard body', async () => {
    await useConfig({ httpRateLimitPerMinute: 3 })

    for (let i = 0; i < 3; i++) {
      expect((await register({})).statusCode).toBe(400)
    }
    const res = await register({})
    expect(res.statusCode).toBe(429)
    expect(errorOf(res).code).toBe('rate_limited')
    expect(Value.Check(ErrorBody, res.json())).toBe(true)

    // The limit is per IP.
    expect((await register({}, '203.0.113.50')).statusCode).toBe(400)
  })
})

describe('logging', () => {
  async function useLogger(stream: { write(line: string): void }) {
    await t.destroy()
    t = await buildTestApp({ logger: { level: 'info', stream } })
  }

  test('an unexpected error is logged at error level and the client gets 500 internal_error', async () => {
    const logs = captureLogs()
    await useLogger(logs.stream)
    vi.spyOn(t.mailer, 'sendCode').mockRejectedValueOnce(new Error('smtp down'))

    const res = await register(registrationBody())

    expect(res.statusCode).toBe(500)
    expect(errorOf(res).code).toBe('internal_error')
    expect(res.body).not.toContain('smtp down')
    const errors = logs.entries().filter((e) => e.level >= 50)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ err: { message: 'smtp down' }, msg: 'smtp down' })
  })

  test('client mistakes are not logged as errors', async () => {
    const logs = captureLogs()
    await useLogger(logs.stream)

    expect((await register({})).statusCode).toBe(400)
    expect((await register(registrationBody({ ownerName: '' }))).statusCode).toBe(400)
    expect((await t.app.inject({ method: 'GET', url: '/v1/nope' })).statusCode).toBe(404)

    expect(logs.entries().filter((e) => e.level >= 50)).toEqual([])
  })
})
