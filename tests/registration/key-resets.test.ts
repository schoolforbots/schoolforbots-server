import { randomUUID } from 'node:crypto'
import { sql } from 'kysely'
import { Value } from 'typebox/value'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { ErrorBody, KeyResetAccepted, KeyResetResult } from '../../src/protocol/http.js'
import { hashSecret } from '../../src/shared/secrets.js'
import { buildTestApp } from '../helpers/app.js'
import { insertStudent } from '../helpers/factories.js'
import { captureLogs } from '../helpers/logs.js'

type TestApp = Awaited<ReturnType<typeof buildTestApp>>

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
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

function resetIdOf(res: { json<T>(): T }) {
  return res.json<{ resetId: string }>().resetId
}

function wrongCodeFor(code: string): string {
  return code === '000000' ? '111111' : '000000'
}

/** What a caller can see of an answer: the status and the error code, if any. */
type Seen = [status: number, code: string | null]

function seen(res: { statusCode: number; json<T>(): T }): Seen {
  return [res.statusCode, res.statusCode >= 400 ? errorOf(res).code : null]
}

/** A student with this email and a reset request for it (sent in a different spelling) that has been answered with 202. */
async function resetOk(email = 'owner@example.com') {
  const student = await insertStudent(t.db, { email })
  const res = await requestReset({ studentId: student.id, email: ` ${email.toUpperCase()} ` })
  expect(res.statusCode).toBe(202)
  const code = t.mailer.sent.at(-1)!.code
  return { student, resetId: resetIdOf(res), code }
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

async function resetRows() {
  return t.db.selectFrom('keyResets').selectAll().execute()
}

async function keyHashOf(studentId: number) {
  return (await t.db.selectFrom('students').select('keyHash').where('id', '=', studentId).executeTakeFirstOrThrow()).keyHash
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => (resolve = r))
  return { promise, resolve }
}

const sleep = (ms: number) => new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), ms))

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
      requestedStudentId: student.id,
      requestedEmail: 'owner@example.com',
      codeHash: hashSecret(t.mailer.sent[0]!.code),
      attempts: 0,
      usedAt: null,
    })
    expect(row.createdAt).toEqual(t.clock.now())
    expect(row.expiresAt).toEqual(new Date(t.clock.now().getTime() + 10 * MINUTE))
  })

  test('mismatched email still returns 202 but sends nothing', async () => {
    const student = await insertStudent(t.db, { email: 'owner@example.com' })

    const wrongEmail = await requestReset({ studentId: student.id, email: 'Someone.Else@example.com' })
    const unknownStudent = await requestReset({ studentId: student.id + 1000, email: 'owner@example.com' })

    for (const res of [wrongEmail, unknownStudent]) {
      expect(res.statusCode).toBe(202)
      expect(resetIdOf(res)).toMatch(UUID)
      expect(Value.Check(KeyResetAccepted, res.json())).toBe(true)
    }
    expect(resetIdOf(wrongEmail)).not.toBe(resetIdOf(unknownStudent))
    expect(t.mailer.sent).toEqual([])
  })

  test('a mismatched request is stored as a decoy with no student, so nothing about it stands out', async () => {
    const student = await insertStudent(t.db, { email: 'owner@example.com' })

    const wrongEmail = await requestReset({ studentId: student.id, email: ' Someone.Else@example.com ' })
    const unknownStudent = await requestReset({ studentId: student.id + 1000, email: 'owner@example.com' })

    expect(await resetRows()).toHaveLength(2)
    const decoy = await resetRow(resetIdOf(wrongEmail))
    expect(decoy).toMatchObject({
      studentId: null,
      requestedStudentId: student.id,
      requestedEmail: 'someone.else@example.com',
      attempts: 0,
      usedAt: null,
    })
    expect(decoy.codeHash).toMatch(/^[0-9a-f]{64}$/)
    expect(decoy.createdAt).toEqual(t.clock.now())
    expect(decoy.expiresAt).toEqual(new Date(t.clock.now().getTime() + 10 * MINUTE))
    const other = await resetRow(resetIdOf(unknownStudent))
    expect(other).toMatchObject({
      studentId: null,
      requestedStudentId: student.id + 1000,
      requestedEmail: 'owner@example.com',
    })
    // Each decoy holds the hash of a random code that nobody was sent.
    expect(other.codeHash).not.toBe(decoy.codeHash)
  })

  test('a repeat request for the same pair within 60s is refused, after 60s allowed, whether or not the pair matches', async () => {
    const student = await insertStudent(t.db, { email: 'owner@example.com' })
    const pairs = [
      { studentId: student.id, email: 'owner@example.com' }, // a real match
      { studentId: student.id, email: 'someone.else@example.com' }, // a decoy
      { studentId: student.id + 1000, email: 'owner@example.com' }, // a decoy for a student that does not exist
    ]
    for (const pair of pairs) expect((await requestReset(pair)).statusCode).toBe(202)
    const mailsAfterFirst = t.mailer.sent.length

    t.clock.advance(59_999)
    for (const pair of pairs) {
      const tooSoon = await requestReset({ ...pair, email: ` ${pair.email.toUpperCase()} ` })
      expect(tooSoon.statusCode).toBe(429)
      expect(errorOf(tooSoon).code).toBe('resend_too_soon')
      expect(Value.Check(ErrorBody, tooSoon.json())).toBe(true)
    }
    expect(t.mailer.sent).toHaveLength(mailsAfterFirst)
    expect(await resetRows()).toHaveLength(3)

    t.clock.advance(1)
    for (const pair of pairs) expect((await requestReset(pair)).statusCode).toBe(202)
    expect(await resetRows()).toHaveLength(6)
    expect(t.mailer.sent).toHaveLength(mailsAfterFirst + 1)
  })

  test('the resend window belongs to the pair: other emails and other students are not held back by it', async () => {
    const student = await insertStudent(t.db, { email: 'owner@example.com' })
    const other = await insertStudent(t.db, { email: 'owner@example.com' })

    // Someone guessing wrong emails for this student id does not block its real owner.
    expect((await requestReset({ studentId: student.id, email: 'guess1@example.com' })).statusCode).toBe(202)
    expect((await requestReset({ studentId: student.id, email: 'guess2@example.com' })).statusCode).toBe(202)
    expect((await requestReset({ studentId: student.id, email: 'owner@example.com' })).statusCode).toBe(202)
    expect((await requestReset({ studentId: other.id, email: 'owner@example.com' })).statusCode).toBe(202)
    expect(t.mailer.sent).toHaveLength(2)
  })

  test('a matching pair and a mismatched pair get the same answers, request by request', async () => {
    const real = await insertStudent(t.db, { email: 'owner@example.com' })
    const other = await insertStudent(t.db, { email: 'other@example.com' })

    /** Requests a reset, repeats at once, makes 5 wrong guesses then a 6th, waits out the code, then lets a second reset expire. */
    async function observe(pair: { studentId: number; email: string }): Promise<Seen[]> {
      const mailsBefore = t.mailer.sent.length
      const steps: Seen[] = []

      const first = await requestReset(pair)
      steps.push(seen(first))
      // A real pair got a code; for a decoy nobody did, so any code stands in for the right one.
      const right = t.mailer.sent.length > mailsBefore ? t.mailer.sent.at(-1)!.code : '000000'

      steps.push(seen(await requestReset(pair)))
      for (let i = 0; i < 5; i++) steps.push(seen(await verifyReset(resetIdOf(first), wrongCodeFor(right))))
      steps.push(seen(await verifyReset(resetIdOf(first), right)))
      t.clock.advance(11 * MINUTE)
      steps.push(seen(await verifyReset(resetIdOf(first), right)))

      const second = await requestReset(pair)
      steps.push(seen(second))
      t.clock.advance(11 * MINUTE)
      steps.push(seen(await verifyReset(resetIdOf(second), '123456')))
      return steps
    }

    const expected: Seen[] = [
      [202, null],
      [429, 'resend_too_soon'],
      ...Array.from({ length: 5 }, (): Seen => [400, 'code_invalid']),
      [429, 'code_attempts_exceeded'],
      [429, 'code_attempts_exceeded'],
      [202, null],
      [410, 'code_expired'],
    ]
    const matching = await observe({ studentId: real.id, email: 'owner@example.com' })
    expect(matching).toEqual(expected)
    expect(t.mailer.sent.map((m) => m.to)).toEqual(['owner@example.com', 'owner@example.com'])

    // A decoy goes through exactly the same steps: wrong email for a real student, and a student that does not exist.
    expect(await observe({ studentId: other.id, email: 'owner@example.com' })).toEqual(matching)
    expect(await observe({ studentId: other.id + 1000, email: 'owner@example.com' })).toEqual(matching)
    expect(t.mailer.sent).toHaveLength(2)
  })

  test('identical requests at the same moment send one mail, real or decoy', async () => {
    const student = await insertStudent(t.db, { email: 'owner@example.com' })
    await warmPool()

    for (const email of ['owner@example.com', 'someone.else@example.com']) {
      const body = { studentId: student.id, email }
      const results = await Promise.all(Array.from({ length: 8 }, () => requestReset(body)))
      expect(results.map((r) => r.statusCode).sort()).toEqual([202, 429, 429, 429, 429, 429, 429, 429])
      expect(errorOf(results.find((r) => r.statusCode === 429)!).code).toBe('resend_too_soon')
    }
    expect(t.mailer.sent).toHaveLength(1)
    expect(await resetRows()).toHaveLength(2)
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
    expect(await resetRows()).toEqual([])
  })
})

describe('POST /v1/key-resets: the mail goes out after the reply', () => {
  const owner = { email: 'owner@example.com' }

  test('a slow mailer does not delay the 202', async () => {
    const student = await insertStudent(t.db, owner)
    const gate = deferred()
    const send = vi.spyOn(t.mailer, 'sendCode').mockImplementationOnce(() => gate.promise)

    try {
      const res = await Promise.race([requestReset({ studentId: student.id, ...owner }), sleep(3000)])

      expect(res).not.toBe('timeout')
      expect((res as { statusCode: number }).statusCode).toBe(202)
      expect(send).toHaveBeenCalledOnce()
      expect(send).toHaveBeenCalledWith('owner@example.com', 'key_reset', expect.stringMatching(/^\d{6}$/))
      expect(await resetRows()).toHaveLength(1)
    } finally {
      gate.resolve()
    }
  })

  test('a mail that cannot be sent still gets 202, is logged, and the reset is withdrawn', async () => {
    const logs = captureLogs()
    await t.destroy()
    t = await buildTestApp({ logger: { level: 'info', stream: logs.stream } })
    const student = await insertStudent(t.db, owner)
    const body = { studentId: student.id, ...owner }
    vi.spyOn(t.mailer, 'sendCode').mockRejectedValueOnce(new Error('smtp down'))

    const res = await requestReset(body)
    expect(res.statusCode).toBe(202)
    expect(Value.Check(KeyResetAccepted, res.json())).toBe(true)

    // The row goes once the background send has failed.
    await vi.waitFor(async () => expect(await resetRows()).toEqual([]))
    const errors = logs.entries().filter((e) => e.level >= 50)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ err: { message: 'smtp down' } })
    expect(res.body).not.toContain('smtp down')

    // The owner can ask again at once.
    expect((await requestReset(body)).statusCode).toBe(202)
    expect(t.mailer.sent).toHaveLength(1)
  })

  test('closing the app waits for a mail that is still being sent', async () => {
    const student = await insertStudent(t.db, owner)
    const gate = deferred()
    vi.spyOn(t.mailer, 'sendCode').mockImplementationOnce(() => gate.promise)
    try {
      await requestReset({ studentId: student.id, ...owner })

      let closed = false
      const closing = t.app.close().then(() => {
        closed = true
      })
      expect(await Promise.race([closing, sleep(100)])).toBe('timeout')
      expect(closed).toBe(false)

      gate.resolve()
      await closing
      expect(closed).toBe(true)
    } finally {
      gate.resolve()
    }
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
    // The wording is shared with registration, so it must not tell anyone to register again.
    expect(errorOf(res).message).toBe('验证码错得太多次了，请重新获取。')
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
    expect(errorOf(expiredRes).message).toBe('验证码已经过期，请重新获取。')
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
    const again = await requestReset({ studentId: student.id, email: 'owner@example.com' })
    expect(again.statusCode).toBe(202)
    const secondKey = (await verifyReset(resetIdOf(again), t.mailer.sent.at(-1)!.code)).json<{ key: string }>().key

    expect((await getMe(firstKey)).statusCode).toBe(401)
    expect((await getMe(secondKey)).statusCode).toBe(200)
  })

  test('a decoy can never be verified, not even by a code that happens to hash the same', async () => {
    const student = await insertStudent(t.db, { email: 'owner@example.com' })
    const decoyId = resetIdOf(await requestReset({ studentId: student.id, email: 'someone.else@example.com' }))
    // Make the decoy's stored hash the hash of a code the caller can send, as if a guess had hit it.
    await t.db.updateTable('keyResets').set({ codeHash: hashSecret('123456') }).where('id', '=', decoyId).execute()
    const before = await keyHashOf(student.id)

    const res = await verifyReset(decoyId, '123456')
    expect(seen(res)).toEqual([400, 'code_invalid'])
    expect((await resetRow(decoyId)).attempts).toBe(1)
    expect((await resetRow(decoyId)).usedAt).toBeNull()
    expect(await keyHashOf(student.id)).toBe(before)
    expect((await getMe(student.key)).statusCode).toBe(200)
  })
})

describe('daily cap on failed key-reset guesses', () => {
  const CAP = 20

  // These tests make well over 60 requests, more than the default per-minute limit allows.
  beforeEach(async () => {
    await t.destroy()
    t = await buildTestApp({ config: { httpRateLimitPerMinute: 10_000 } })
  })

  /** Requests a reset for this pair and makes `wrong` wrong guesses at it. Returns the reset id and the real code, if one was mailed. */
  async function guessAt(pair: { studentId: number; email: string }, wrong: number) {
    const mailsBefore = t.mailer.sent.length
    const res = await requestReset(pair)
    expect(res.statusCode).toBe(202)
    const code = t.mailer.sent.length > mailsBefore ? t.mailer.sent.at(-1)!.code : '000000'
    for (let i = 0; i < wrong; i++) expect(seen(await verifyReset(resetIdOf(res), wrongCodeFor(code)))).toEqual([400, 'code_invalid'])
    return { resetId: resetIdOf(res), code }
  }

  test('failures add up across the reset requests of one student id; a day later the code works again', async () => {
    const student = await insertStudent(t.db, { email: 'owner@example.com' })
    const bystander = await insertStudent(t.db, { email: 'bystander@example.com' })
    const pair = { studentId: student.id, email: 'owner@example.com' }
    const t0 = t.clock.now().getTime()

    // 5 resets with 4 wrong guesses each: below the limit of 5 per reset, but CAP failures in all.
    for (let i = 0; i < CAP / 4; i++) {
      await guessAt(pair, 4)
      t.clock.advance(61_000)
    }

    const sixth = await guessAt(pair, 0)
    const refused = await verifyReset(sixth.resetId, sixth.code)
    expect(refused.statusCode).toBe(429)
    expect(errorOf(refused).code).toBe('code_attempts_exceeded')
    expect(errorOf(refused).message).toBe('验证码错得太多次了，请重新获取。')
    // The code was not even looked at: nothing was used up and the key is as it was.
    expect(await resetRow(sixth.resetId)).toMatchObject({ attempts: 0, usedAt: null })
    expect((await getMe(student.key)).statusCode).toBe(200)

    // The cap is per student id: someone else is not affected.
    const other = await guessAt({ studentId: bystander.id, email: 'bystander@example.com' }, 0)
    expect((await verifyReset(other.resetId, other.code)).statusCode).toBe(200)

    // Still in force just before the first failures are a day old...
    t.clock.set(new Date(t0 + DAY - 1))
    const stillRefused = await guessAt(pair, 0)
    expect((await verifyReset(stillRefused.resetId, stillRefused.code)).statusCode).toBe(429)

    // ...and gone once all of them are.
    t.clock.set(new Date(t0 + 4 * 61_000 + DAY + 1))
    const later = await guessAt(pair, 0)
    const ok = await verifyReset(later.resetId, later.code)
    expect(ok.statusCode).toBe(200)
    expect((await getMe(ok.json<{ key: string }>().key)).statusCode).toBe(200)
    expect((await getMe(student.key)).statusCode).toBe(401)
  })

  test('failures on decoys count like failures on real resets, and the answer is the same for both', async () => {
    const student = await insertStudent(t.db, { email: 'owner@example.com' })

    // Four reset requests, two for the student's real email and two for emails that are not: CAP failures in all.
    await guessAt({ studentId: student.id, email: 'guess1@example.com' }, 5)
    await guessAt({ studentId: student.id, email: 'guess2@example.com' }, 5)
    await guessAt({ studentId: student.id, email: 'owner@example.com' }, 5)
    t.clock.advance(61_000)
    await guessAt({ studentId: student.id, email: 'owner@example.com' }, 5)

    t.clock.advance(61_000)
    const real = await guessAt({ studentId: student.id, email: 'owner@example.com' }, 0)
    const decoy = await guessAt({ studentId: student.id, email: 'guess3@example.com' }, 0)
    expect(seen(await verifyReset(real.resetId, real.code))).toEqual([429, 'code_attempts_exceeded'])
    expect(seen(await verifyReset(decoy.resetId, '123456'))).toEqual([429, 'code_attempts_exceeded'])
    expect((await resetRow(real.resetId)).usedAt).toBeNull()
  })

  test('concurrent guesses at different resets of one student id cannot get past the cap', async () => {
    const student = await insertStudent(t.db, { email: 'owner@example.com' })
    // Six resets of 5 guesses each would be 30 failures; only CAP may be let through.
    const resets = []
    for (let i = 0; i < 6; i++) {
      resets.push(resetIdOf(await requestReset({ studentId: student.id, email: `guess${i}@example.com` })))
    }
    await warmPool()

    const results = await Promise.all(resets.flatMap((id) => Array.from({ length: 5 }, () => verifyReset(id, '123456'))))

    expect(results.filter((r) => r.statusCode === 400)).toHaveLength(CAP)
    expect(results.filter((r) => r.statusCode === 429)).toHaveLength(30 - CAP)
    const failures = (await resetRows()).reduce((sum, r) => sum + r.attempts, 0)
    expect(failures).toBe(CAP)
  })

  test('an expired reset says expired even when the cap is reached, and a decoy answers the same', async () => {
    const real = await insertStudent(t.db, { email: 'owner@example.com' })
    const pairs = [
      { studentId: real.id, email: 'owner@example.com' },
      { studentId: real.id + 1000, email: 'owner@example.com' },
    ]
    const observed: Seen[][] = []
    for (const pair of pairs) {
      // Burn the cap for this student id first, then look at a fresh reset that is live and one that has expired.
      for (let i = 0; i < CAP / 5; i++) {
        await guessAt(pair, 5)
        t.clock.advance(61_000)
      }
      const live = await guessAt(pair, 0)
      const lapsed = await guessAt({ ...pair, email: `x${pair.studentId}@example.com` }, 0)
      t.clock.advance(11 * MINUTE)
      const fresh = await guessAt(pair, 0)
      observed.push([
        seen(await verifyReset(fresh.resetId, fresh.code)), // cap
        seen(await verifyReset(live.resetId, live.code)), // expired
        seen(await verifyReset(lapsed.resetId, '123456')), // expired
      ])
    }
    expect(observed[0]).toEqual([
      [429, 'code_attempts_exceeded'],
      [410, 'code_expired'],
      [410, 'code_expired'],
    ])
    expect(observed[1]).toEqual(observed[0])
  })
})
