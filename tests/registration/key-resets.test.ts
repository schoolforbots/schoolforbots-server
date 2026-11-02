import { randomUUID } from 'node:crypto'
import { Value } from 'typebox/value'
import { sql } from 'kysely'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { ErrorBody, KeyResetAccepted, KeyResetResult } from '../../src/protocol/http.js'
import { hashSecret } from '../../src/shared/secrets.js'
import { buildTestApp } from '../helpers/app.js'
import { insertStudent } from '../helpers/factories.js'

type TestApp = Awaited<ReturnType<typeof buildTestApp>>

const MINUTE = 60_000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

let t: TestApp

beforeEach(async () => {
  t = await buildTestApp()
})

afterEach(async () => {
  await t.destroy()
})

function requestReset(body: unknown) {
  return t.app.inject({ method: 'POST', url: '/v1/key-resets', payload: body as object })
}

function verifyReset(resetId: string, code: string) {
  return t.app.inject({ method: 'POST', url: `/v1/key-resets/${resetId}/verify`, payload: { code } })
}

function getMe(key: string) {
  return t.app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${key}` } })
}

function errorOf(res: { json<T>(): T }) {
  return res.json<{ error: { code: string; message: string } }>().error
}

function wrongCodeFor(code: string): string {
  return code === '000000' ? '111111' : '000000'
}

/** A student with this email and a reset request for it (sent in a different spelling) that has been answered with 202. */
async function resetOk(email = 'owner@example.com') {
  const student = await insertStudent(t.db, { email })
  const res = await requestReset({ studentId: student.id, email: ` ${email.toUpperCase()} ` })
  expect(res.statusCode).toBe(202)
  const { resetId } = res.json<{ resetId: string }>()
  const code = t.mailer.sent.at(-1)!.code
  return { student, resetId, code }
}

/**
 * Opens every pooled connection up front. Otherwise parallel requests queue behind
 * connection setup and finish one by one, and a missing lock would go unnoticed.
 */
async function warmPool() {
  await Promise.all(Array.from({ length: 10 }, () => sql`select pg_sleep(0.1)`.execute(t.db)))
}

async function resetRow(resetId: string) {
  return t.db.selectFrom('keyResets').selectAll().where('id', '=', resetId).executeTakeFirstOrThrow()
}

async function keyHashOf(studentId: number) {
  return (await t.db.selectFrom('students').select('keyHash').where('id', '=', studentId).executeTakeFirstOrThrow()).keyHash
}

describe('POST /v1/key-resets', () => {
  test('matching student id and email sends a key_reset code', async () => {
    const student = await insertStudent(t.db, { email: 'owner@example.com' })

    // The email is normalized (trimmed, lower-cased) before it is compared.
    const res = await requestReset({ studentId: student.id, email: ' Owner@Example.com ' })
    expect(res.statusCode).toBe(202)
    const body = res.json<{ resetId: string }>()
    expect(Object.keys(body)).toEqual(['resetId'])
    expect(body.resetId).toMatch(UUID)
    expect(Value.Check(KeyResetAccepted, body)).toBe(true)

    expect(t.mailer.sent).toEqual([{ to: 'owner@example.com', purpose: 'key_reset', code: expect.stringMatching(/^\d{6}$/) }])

    const row = await resetRow(body.resetId)
    expect(row).toMatchObject({
      studentId: student.id,
      codeHash: hashSecret(t.mailer.sent[0]!.code),
      attempts: 0,
      usedAt: null,
    })
    expect(row.createdAt).toEqual(t.clock.now())
    expect(row.expiresAt).toEqual(new Date(t.clock.now().getTime() + 10 * MINUTE))
  })

  test('mismatched email still returns 202 but sends nothing', async () => {
    const student = await insertStudent(t.db, { email: 'owner@example.com' })

    const wrongEmail = await requestReset({ studentId: student.id, email: 'someone.else@example.com' })
    const unknownStudent = await requestReset({ studentId: student.id + 1000, email: 'owner@example.com' })

    for (const res of [wrongEmail, unknownStudent]) {
      expect(res.statusCode).toBe(202)
      const { resetId } = res.json<{ resetId: string }>()
      expect(resetId).toMatch(UUID)
      expect(Value.Check(KeyResetAccepted, res.json())).toBe(true)
    }
    expect(wrongEmail.json<{ resetId: string }>().resetId).not.toBe(unknownStudent.json<{ resetId: string }>().resetId)
    expect(t.mailer.sent).toEqual([])
    expect(await t.db.selectFrom('keyResets').selectAll().execute()).toEqual([])
  })

  test('a mismatched request leaves no trace, so it never trips the resend window and cannot be verified', async () => {
    const student = await insertStudent(t.db, { email: 'owner@example.com' })

    for (let i = 0; i < 3; i++) {
      expect((await requestReset({ studentId: student.id, email: 'someone.else@example.com' })).statusCode).toBe(202)
    }
    const fake = await requestReset({ studentId: student.id, email: 'someone.else@example.com' })
    const fakeVerify = await verifyReset(fake.json<{ resetId: string }>().resetId, '123456')
    expect(fakeVerify.statusCode).toBe(400)
    expect(errorOf(fakeVerify).code).toBe('code_invalid')

    // The real owner is not held back by the failed guesses above.
    expect((await requestReset({ studentId: student.id, email: 'owner@example.com' })).statusCode).toBe(202)
    expect(t.mailer.sent).toHaveLength(1)
  })

  test('a repeat request within 60s is refused, after 60s allowed', async () => {
    const student = await insertStudent(t.db, { email: 'owner@example.com' })
    const body = { studentId: student.id, email: 'owner@example.com' }
    expect((await requestReset(body)).statusCode).toBe(202)

    t.clock.advance(59_999)
    const tooSoon = await requestReset(body)
    expect(tooSoon.statusCode).toBe(429)
    expect(errorOf(tooSoon).code).toBe('resend_too_soon')
    expect(Value.Check(ErrorBody, tooSoon.json())).toBe(true)
    expect(t.mailer.sent).toHaveLength(1)
    expect(await t.db.selectFrom('keyResets').select('id').execute()).toHaveLength(1)

    // The window is per student: another student on the same email is not held back.
    const other = await insertStudent(t.db, { email: 'owner@example.com' })
    expect((await requestReset({ studentId: other.id, email: 'owner@example.com' })).statusCode).toBe(202)

    t.clock.advance(1)
    expect((await requestReset(body)).statusCode).toBe(202)
    expect(t.mailer.sent).toHaveLength(3)
  })

  test('identical requests at the same moment send one mail', async () => {
    const student = await insertStudent(t.db, { email: 'owner@example.com' })
    const body = { studentId: student.id, email: 'owner@example.com' }

    await warmPool()

    const results = await Promise.all(Array.from({ length: 8 }, () => requestReset(body)))
    expect(results.map((r) => r.statusCode).sort()).toEqual([202, 429, 429, 429, 429, 429, 429, 429])
    expect(errorOf(results.find((r) => r.statusCode === 429)!).code).toBe('resend_too_soon')
    expect(t.mailer.sent).toHaveLength(1)
    expect(await t.db.selectFrom('keyResets').select('id').execute()).toHaveLength(1)
  })

  test('a failed mail send removes the reset so the owner can retry at once', async () => {
    const student = await insertStudent(t.db, { email: 'owner@example.com' })
    const body = { studentId: student.id, email: 'owner@example.com' }
    vi.spyOn(t.mailer, 'sendCode').mockRejectedValueOnce(new Error('smtp down'))

    const failed = await requestReset(body)
    expect(failed.statusCode).toBe(500)
    expect(errorOf(failed).code).toBe('internal_error')
    expect(await t.db.selectFrom('keyResets').selectAll().execute()).toEqual([])

    expect((await requestReset(body)).statusCode).toBe(202)
  })

  test.each([
    ['a missing email', { studentId: 1 }],
    ['a missing student id', { email: 'owner@example.com' }],
    ['a student id of zero', { studentId: 0, email: 'owner@example.com' }],
    ['a fractional student id', { studentId: 1.5, email: 'owner@example.com' }],
    ['a student id beyond the integer column', { studentId: 2 ** 31, email: 'owner@example.com' }],
    ['a student id given as a string', { studentId: '1', email: 'owner@example.com' }],
    ['an empty email', { studentId: 1, email: '' }],
    ['an email over 254 characters', { studentId: 1, email: `${'a'.repeat(250)}@example.com` }],
    ['a non-string email', { studentId: 1, email: 5 }],
  ])('rejects %s with 400 invalid_request', async (_label, body) => {
    const res = await requestReset(body)
    expect(res.statusCode).toBe(400)
    expect(errorOf(res).code).toBe('invalid_request')
    expect(Value.Check(ErrorBody, res.json())).toBe(true)
    expect(t.mailer.sent).toEqual([])
  })
})

describe('POST /v1/key-resets/:id/verify', () => {
  test('verified reset issues a new key and kills the old one', async () => {
    const { student, resetId, code } = await resetOk()
    expect((await getMe(student.key)).statusCode).toBe(200)

    t.clock.advance(3 * MINUTE)
    const res = await verifyReset(resetId, code)
    expect(res.statusCode).toBe(200)
    const body = res.json<{ key: string }>()
    expect(Object.keys(body)).toEqual(['key'])
    expect(body.key).toMatch(/^ais_[A-Za-z0-9_-]{43}$/)
    expect(body.key).not.toBe(student.key)
    expect(Value.Check(KeyResetResult, body)).toBe(true)

    const oldKey = await getMe(student.key)
    expect(oldKey.statusCode).toBe(401)
    expect(errorOf(oldKey).code).toBe('unauthorized')
    const newKey = await getMe(body.key)
    expect(newKey.statusCode).toBe(200)
    expect(newKey.json()).toMatchObject({ studentId: student.id })

    // Only the hash is stored, and the reset is marked used at the clock's time.
    expect(await keyHashOf(student.id)).toBe(hashSecret(body.key))
    expect((await resetRow(resetId)).usedAt).toEqual(t.clock.now())
  })

  test('reset code cannot be reused', async () => {
    const { student, resetId, code } = await resetOk()
    const first = await verifyReset(resetId, code)
    expect(first.statusCode).toBe(200)
    const issued = first.json<{ key: string }>().key

    const again = await verifyReset(resetId, code)
    expect(again.statusCode).toBe(400)
    expect(errorOf(again).code).toBe('code_invalid')
    expect(Value.Check(ErrorBody, again.json())).toBe(true)

    // The second try changed nothing: the key issued the first time is still the one in force.
    expect(await keyHashOf(student.id)).toBe(hashSecret(issued))
    expect((await getMe(issued)).statusCode).toBe(200)
  })

  test('verifications of one reset at the same moment issue one key', async () => {
    const { student, resetId, code } = await resetOk()

    await warmPool()

    const results = await Promise.all(Array.from({ length: 8 }, () => verifyReset(resetId, code)))
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 400, 400, 400, 400, 400, 400, 400])
    const issued = results.find((r) => r.statusCode === 200)!.json<{ key: string }>().key
    expect(await keyHashOf(student.id)).toBe(hashSecret(issued))
  })

  test('unknown reset id → 400 code_invalid', async () => {
    const res = await verifyReset(randomUUID(), '123456')
    expect(res.statusCode).toBe(400)
    expect(errorOf(res).code).toBe('code_invalid')
    expect(Value.Check(ErrorBody, res.json())).toBe(true)
  })

  test('a reset id that is not a uuid is invalid_request', async () => {
    const res = await verifyReset('not-a-uuid', '123456')
    expect(res.statusCode).toBe(400)
    expect(errorOf(res).code).toBe('invalid_request')
  })

  test.each([
    ['a five-digit code', '12345'],
    ['a seven-digit code', '1234567'],
    ['a code with letters', '12345a'],
    ['an empty code', ''],
  ])('rejects %s with 400 invalid_request and does not count an attempt', async (_label, code) => {
    const { resetId } = await resetOk()
    const res = await verifyReset(resetId, code)
    expect(res.statusCode).toBe(400)
    expect(errorOf(res).code).toBe('invalid_request')
    expect((await resetRow(resetId)).attempts).toBe(0)
  })

  test('wrong code counts attempts and leaves the key alone; after 5 even the right code fails', async () => {
    const { student, resetId, code } = await resetOk()
    const before = await keyHashOf(student.id)

    for (let i = 1; i <= 5; i++) {
      const res = await verifyReset(resetId, wrongCodeFor(code))
      expect(res.statusCode).toBe(400)
      expect(errorOf(res).code).toBe('code_invalid')
      expect((await resetRow(resetId)).attempts).toBe(i)
    }

    const res = await verifyReset(resetId, code)
    expect(res.statusCode).toBe(429)
    expect(errorOf(res).code).toBe('code_attempts_exceeded')
    expect(Value.Check(ErrorBody, res.json())).toBe(true)

    expect(await keyHashOf(student.id)).toBe(before)
    expect((await resetRow(resetId)).usedAt).toBeNull()
    expect((await getMe(student.key)).statusCode).toBe(200)
  })

  test('the right code still works after a few wrong ones', async () => {
    const { resetId, code } = await resetOk()
    for (let i = 0; i < 4; i++) expect((await verifyReset(resetId, wrongCodeFor(code))).statusCode).toBe(400)
    expect((await verifyReset(resetId, code)).statusCode).toBe(200)
  })

  test('concurrent wrong guesses cannot get past the attempt limit', async () => {
    const { resetId, code } = await resetOk()
    const guesses = Array.from({ length: 20 }, (_, i) => String(i).padStart(6, '0')).filter((g) => g !== code)

    const results = await Promise.all(guesses.map((g) => verifyReset(resetId, g)))
    expect(results.filter((r) => r.statusCode === 400)).toHaveLength(5)
    expect(results.filter((r) => r.statusCode === 429)).toHaveLength(results.length - 5)
  })

  test('expired reset code → 410, too many attempts → 429', async () => {
    const expired = await resetOk()
    t.clock.advance(11 * MINUTE)
    const expiredRes = await verifyReset(expired.resetId, expired.code)
    expect(expiredRes.statusCode).toBe(410)
    expect(errorOf(expiredRes).code).toBe('code_expired')
    expect(Value.Check(ErrorBody, expiredRes.json())).toBe(true)
    // An expired code changes nothing: the old key is still in force.
    expect((await getMe(expired.student.key)).statusCode).toBe(200)
    expect((await resetRow(expired.resetId)).usedAt).toBeNull()

    const guessed = await resetOk('other@example.com')
    for (let i = 0; i < 5; i++) await verifyReset(guessed.resetId, wrongCodeFor(guessed.code))
    const guessedRes = await verifyReset(guessed.resetId, guessed.code)
    expect(guessedRes.statusCode).toBe(429)
    expect(errorOf(guessedRes).code).toBe('code_attempts_exceeded')
  })

  test('the code is still good just before it expires and dead at the expiry time', async () => {
    const first = await resetOk()
    t.clock.advance(10 * MINUTE - 1)
    expect((await verifyReset(first.resetId, first.code)).statusCode).toBe(200)

    const second = await resetOk('second@example.com')
    t.clock.advance(10 * MINUTE)
    expect((await verifyReset(second.resetId, second.code)).statusCode).toBe(410)
  })

  test('a new request after a completed reset issues a code that works', async () => {
    const { student, resetId, code } = await resetOk()
    const firstKey = (await verifyReset(resetId, code)).json<{ key: string }>().key

    t.clock.advance(MINUTE)
    expect((await requestReset({ studentId: student.id, email: 'owner@example.com' })).statusCode).toBe(202)
    const secondResetId = (await t.db.selectFrom('keyResets').select('id').where('usedAt', 'is', null).executeTakeFirstOrThrow()).id
    const secondKey = (await verifyReset(secondResetId, t.mailer.sent.at(-1)!.code)).json<{ key: string }>().key

    expect((await getMe(firstKey)).statusCode).toBe(401)
    expect((await getMe(secondKey)).statusCode).toBe(200)
  })
})
