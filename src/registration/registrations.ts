import { isIP } from 'node:net'
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import type { Kysely } from 'kysely'
import { Type, type Static } from 'typebox'
import { IsEmail } from 'typebox/format'
import {
  RegistrationAccepted,
  RegistrationRequest,
  VerifyRequest,
  VerifyResult,
} from '../protocol/http.js'
import { SEAT_STATUSES, lock, slotLockKey, type Database } from '../shared/db.js'
import { checkNames } from '../shared/identity.js'
import { generateCode, generateStudentKey, hashSecret } from '../shared/secrets.js'
import type { RegistrationDeps } from './app.js'
import { isInstallSeatViolation, seatsOfEmail, slotOccupancy } from './capacity.js'
import { ApiError } from './errors.js'
import { codeMatches, fail, normalizeEmail, type Outcome } from './verification.js'

const MINUTE_MS = 60_000
const DAY_MS = 24 * 60 * MINUTE_MS

const IdParams = Type.Object({ id: Type.String({ format: 'uuid' }) })

export function registrationRoutes(deps: RegistrationDeps): FastifyPluginAsyncTypebox {
  return async (app) => {
    app.post(
      '/v1/registrations',
      { schema: { body: RegistrationRequest, response: { 202: RegistrationAccepted } } },
      async (request, reply) => {
        const accepted = await createRegistration(deps, request.body, request.ip)
        return reply.status(202).send(accepted)
      },
    )

    app.post(
      '/v1/registrations/:id/verify',
      { schema: { params: IdParams, body: VerifyRequest, response: { 201: VerifyResult } } },
      async (request, reply) => {
        const result = await verifyRegistration(deps, request.params.id, request.body.code)
        return reply.status(201).send(result)
      },
    )
  }
}

/**
 * Quoted local parts and domain literals are legal in RFC 5322 but no real
 * mailbox uses them; refusing them also keeps line breaks out of the To header.
 */
function isPlainEmail(email: string): boolean {
  return IsEmail(email) && !/["[\]\s]/u.test(email)
}

async function countRows(query: { executeTakeFirstOrThrow(): Promise<{ count: string | number | bigint }> }) {
  return Number((await query.executeTakeFirstOrThrow()).count)
}

async function createRegistration(
  deps: RegistrationDeps,
  body: Static<typeof RegistrationRequest>,
  rawIp: string,
): Promise<Static<typeof RegistrationAccepted>> {
  const { db, config, moderator, mailer, clock } = deps

  // The schema stage: a mailbox address has to look like one once trimmed, and
  // the client address has to be something the inet column accepts.
  const email = normalizeEmail(body.email)
  const ip = rawIp.split('%')[0] ?? rawIp // drop an IPv6 zone id
  if (!isPlainEmail(email) || isIP(ip) === 0) throw new ApiError(400, 'invalid_request')

  const names = checkNames(body.ownerName, body.aiName, { maxChars: config.nameMaxChars, moderator })
  if (!names.ok) throw new ApiError(400, 'invalid_name', { part: names.part, reason: names.reason })

  const now = clock.now()
  const code = generateCode()
  const expiresAt = new Date(now.getTime() + config.verificationCode.ttlMinutes * MINUTE_MS)

  const registrationId = await db.transaction().execute(async (trx) => {
    // Serializes registrations from one address, so a burst of parallel requests cannot all slip under the limits.
    await lock(trx, `ip:${ip}`)

    const ban = await trx
      .selectFrom('bans')
      .select('id')
      .where('until', '>', now)
      .where((eb) => eb.or([eb(eb.fn('lower', ['email']), '=', email), eb('installId', '=', body.installId)]))
      .limit(1)
      .executeTakeFirst()
    if (ban !== undefined) throw new ApiError(403, 'banned')

    const fromIp = await countRows(
      trx
        .selectFrom('registrations')
        .select((eb) => eb.fn.countAll().as('count'))
        .where('ip', '=', ip)
        .where('createdAt', '>', new Date(now.getTime() - DAY_MS)),
    )
    if (fromIp >= config.registrationsPerIpPerDay) throw new ApiError(429, 'ip_limit')

    if ((await seatsOfEmail(trx, email)) >= config.maxStudentsPerEmail) throw new ApiError(409, 'email_limit')

    const seat = await trx
      .selectFrom('students')
      .select('id')
      .where('installId', '=', body.installId)
      .where('status', 'in', [...SEAT_STATUSES])
      .limit(1)
      .executeTakeFirst()
    if (seat !== undefined) throw new ApiError(409, 'install_has_seat')

    const pending = await trx
      .selectFrom('registrations')
      .select('id')
      .where('email', '=', email)
      .where('installId', '=', body.installId)
      .where('verifiedAt', 'is', null)
      .where('createdAt', '>', new Date(now.getTime() - config.verificationCode.resendSeconds * 1000))
      .limit(1)
      .executeTakeFirst()
    if (pending !== undefined) throw new ApiError(429, 'resend_too_soon')

    // An unknown referrer is not an error; it is just not recorded.
    const referrer =
      body.referrerStudentId === undefined
        ? undefined
        : await trx.selectFrom('students').select('id').where('id', '=', body.referrerStudentId).executeTakeFirst()

    const row = await trx
      .insertInto('registrations')
      .values({
        email,
        ownerName: names.ownerName,
        aiName: names.aiName,
        division: body.division,
        slot: body.slot,
        referrerId: referrer?.id ?? null,
        installId: body.installId,
        pluginType: body.plugin.type,
        pluginVersion: body.plugin.version,
        ip,
        codeHash: hashSecret(code),
        expiresAt,
        createdAt: now,
        verifiedAt: null,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    return row.id
  })

  // Mail goes out after the commit, never while holding a connection and locks.
  // If it cannot be sent, the registration is withdrawn: it must not use up the
  // address's daily quota or block a retry with resend_too_soon.
  try {
    await mailer.sendCode(email, 'register', code)
  } catch (err) {
    await db.deleteFrom('registrations').where('id', '=', registrationId).execute()
    throw err
  }

  return { registrationId, expiresAt: expiresAt.toISOString() }
}

type VerifyOutcome = Outcome<Static<typeof VerifyResult>>

async function verifyRegistration(
  deps: RegistrationDeps,
  id: string,
  code: string,
): Promise<Static<typeof VerifyResult>> {
  const now = deps.clock.now()

  let outcome: VerifyOutcome
  try {
    outcome = await deps.db.transaction().execute((trx) => verifyInTransaction(trx, deps, id, code, now))
  } catch (err) {
    if (isInstallSeatViolation(err)) throw new ApiError(409, 'install_has_seat')
    throw err
  }

  // Failures are returned as values and thrown only here, after the transaction
  // has committed: a wrong code must keep its attempts + 1.
  if (!outcome.ok) throw outcome.error
  return outcome.result
}

async function verifyInTransaction(
  trx: Kysely<Database>,
  deps: RegistrationDeps,
  id: string,
  code: string,
  now: Date,
): Promise<VerifyOutcome> {
  const { config } = deps

  // The row lock serializes every guess at this registration, so parallel
  // requests cannot read the same attempt count and get more guesses than allowed.
  const registration = await trx.selectFrom('registrations').selectAll().where('id', '=', id).forUpdate().executeTakeFirst()
  if (registration === undefined) return fail(404, 'not_found')
  if (registration.verifiedAt !== null) return fail(409, 'already_verified')
  if (registration.attempts >= config.verificationCode.maxAttempts) return fail(429, 'code_attempts_exceeded')
  if (now.getTime() >= registration.expiresAt.getTime()) return fail(410, 'code_expired')

  if (!codeMatches(registration.codeHash, code)) {
    await trx
      .updateTable('registrations')
      .set((eb) => ({ attempts: eb('attempts', '+', 1) }))
      .where('id', '=', id)
      .execute()
    return fail(400, 'code_invalid')
  }

  // Lock order is always email, then slot. Seat counts are read under these
  // locks, so concurrent verifies cannot overshoot a limit.
  await lock(trx, `email:${registration.email}`)
  if ((await seatsOfEmail(trx, registration.email)) >= config.maxStudentsPerEmail) return fail(409, 'email_limit')

  await lock(trx, slotLockKey(registration.slot))
  const status = (await slotOccupancy(trx, registration.slot)) >= config.slotCapacity ? 'waitlisted' : 'pending'

  // Only the hash of the key is stored; the key itself is returned once, here.
  const key = generateStudentKey()
  const student = await trx
    .insertInto('students')
    .values({
      email: registration.email,
      ownerName: registration.ownerName,
      aiName: registration.aiName,
      division: registration.division,
      slot: registration.slot,
      status,
      classId: null,
      installId: registration.installId,
      pluginType: registration.pluginType,
      pluginVersion: registration.pluginVersion,
      referrerId: registration.referrerId,
      keyHash: hashSecret(key),
      registrationIp: registration.ip,
      createdAt: now,
      queuedAt: now,
      assignedAt: null,
      lastAttendedAt: null,
      lastRenamedAt: null,
    })
    .returning('id')
    .executeTakeFirstOrThrow()

  await trx.updateTable('registrations').set({ verifiedAt: now }).where('id', '=', id).execute()

  return { ok: true, result: { studentId: student.id, key, status } }
}
