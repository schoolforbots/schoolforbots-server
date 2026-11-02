import { randomUUID } from 'node:crypto'
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import type { Kysely } from 'kysely'
import { Type, type Static } from 'typebox'
import { KeyResetAccepted, KeyResetRequest, KeyResetResult, KeyResetVerifyRequest } from '../protocol/http.js'
import type { Database } from '../shared/db.js'
import { generateCode, generateStudentKey, hashSecret } from '../shared/secrets.js'
import type { RegistrationDeps } from './app.js'
import { ApiError } from './errors.js'
import { codeMatches, fail, normalizeEmail, type Outcome } from './verification.js'

const MINUTE_MS = 60_000

const IdParams = Type.Object({ id: Type.String({ format: 'uuid' }) })

/**
 * A student who lost the key asks for a new one by student id and registration
 * email; a code goes to that mailbox, and entering it replaces the key.
 */
export function keyResetRoutes(deps: RegistrationDeps): FastifyPluginAsyncTypebox {
  return async (app) => {
    app.post(
      '/v1/key-resets',
      { schema: { body: KeyResetRequest, response: { 202: KeyResetAccepted } } },
      async (request, reply) => {
        const accepted = await requestKeyReset(deps, request.body)
        return reply.status(202).send(accepted)
      },
    )

    app.post(
      '/v1/key-resets/:id/verify',
      { schema: { params: IdParams, body: KeyResetVerifyRequest, response: { 200: KeyResetResult } } },
      async (request) => verifyKeyReset(deps, request.params.id, request.body.code),
    )
  }
}

async function requestKeyReset(
  deps: RegistrationDeps,
  body: Static<typeof KeyResetRequest>,
): Promise<Static<typeof KeyResetAccepted>> {
  const { db, config, mailer, clock } = deps

  const email = normalizeEmail(body.email)
  const now = clock.now()
  const code = generateCode()
  const expiresAt = new Date(now.getTime() + config.verificationCode.ttlMinutes * MINUTE_MS)

  const resetId = await db.transaction().execute(async (trx): Promise<string | null> => {
    // The row lock serializes requests for one student, so a burst of parallel
    // requests cannot all get past the resend check below.
    const student = await trx
      .selectFrom('students')
      .select('id')
      .where('id', '=', body.studentId)
      .where('email', '=', email)
      .forNoKeyUpdate()
      .executeTakeFirst()
    if (student === undefined) return null

    const recent = await trx
      .selectFrom('keyResets')
      .select('id')
      .where('studentId', '=', student.id)
      .where('createdAt', '>', new Date(now.getTime() - config.verificationCode.resendSeconds * 1000))
      .limit(1)
      .executeTakeFirst()
    if (recent !== undefined) throw new ApiError(429, 'resend_too_soon')

    const row = await trx
      .insertInto('keyResets')
      .values({ studentId: student.id, codeHash: hashSecret(code), expiresAt, createdAt: now, usedAt: null })
      .returning('id')
      .executeTakeFirstOrThrow()
    return row.id
  })

  // Anyone can ask, so a request that matches no student gets the same answer as
  // one that does: a made-up id that nothing is stored under, and no mail.
  if (resetId === null) return { resetId: randomUUID() }

  // Mail goes out after the commit, never while holding a connection and locks.
  // If it cannot be sent, the reset is withdrawn so it does not block a retry with resend_too_soon.
  try {
    await mailer.sendCode(email, 'key_reset', code)
  } catch (err) {
    await db.deleteFrom('keyResets').where('id', '=', resetId).execute()
    throw err
  }

  return { resetId }
}

async function verifyKeyReset(
  deps: RegistrationDeps,
  id: string,
  code: string,
): Promise<Static<typeof KeyResetResult>> {
  const now = deps.clock.now()

  const outcome = await deps.db.transaction().execute((trx) => verifyInTransaction(trx, deps, id, code, now))

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
): Promise<Outcome<Static<typeof KeyResetResult>>> {
  // The row lock serializes every guess at this reset, so parallel requests
  // cannot read the same attempt count and get more guesses than allowed.
  const reset = await trx.selectFrom('keyResets').selectAll().where('id', '=', id).forUpdate().executeTakeFirst()
  // An unknown id and a used one look like a wrong code, so ids reveal nothing.
  if (reset === undefined || reset.usedAt !== null) return fail(400, 'code_invalid')
  if (reset.attempts >= deps.config.verificationCode.maxAttempts) return fail(429, 'code_attempts_exceeded')
  if (now.getTime() >= reset.expiresAt.getTime()) return fail(410, 'code_expired')

  if (!codeMatches(reset.codeHash, code)) {
    await trx
      .updateTable('keyResets')
      .set((eb) => ({ attempts: eb('attempts', '+', 1) }))
      .where('id', '=', id)
      .execute()
    return fail(400, 'code_invalid')
  }

  // Only the hash of the new key is stored, which is what ends the old key's validity;
  // the key itself is returned once, here.
  const key = generateStudentKey()
  await trx.updateTable('students').set({ keyHash: hashSecret(key) }).where('id', '=', reset.studentId).execute()
  await trx.updateTable('keyResets').set({ usedAt: now }).where('id', '=', id).execute()

  return { ok: true, result: { key } }
}
