import { randomUUID } from 'node:crypto'
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import type { FastifyBaseLogger } from 'fastify'
import type { Kysely } from 'kysely'
import { Type, type Static } from 'typebox'
import { KeyResetAccepted, KeyResetRequest, KeyResetResult, KeyResetVerifyRequest } from '../protocol/http.js'
import { lock, type Database } from '../shared/db.js'
import { generateCode, generateStudentKey, hashSecret } from '../shared/secrets.js'
import type { RegistrationDeps } from './app.js'
import { ApiError } from './errors.js'
import { codeMatches, fail, normalizeEmail, type Outcome } from './verification.js'

const MINUTE_MS = 60_000
const DAY_MS = 24 * 60 * MINUTE_MS

const IdParams = Type.Object({ id: Type.String({ format: 'uuid' }) })

/** What `requestKeyReset` leaves to do once the request has been answered. */
interface PendingMail {
  email: string
  code: string
}

/**
 * A student who lost the key asks for a new one by student id and registration
 * email; a code goes to that mailbox, and entering it replaces the key.
 *
 * Anyone can call this, so nothing in the answers may tell whether a student id
 * and email belong together. A request that matches no student is stored as a
 * decoy (`student_id` null) that gets the same resend window, attempt limits and
 * expiry as a real one; only the mail, and the chance of success, are missing.
 */
export function keyResetRoutes(deps: RegistrationDeps): FastifyPluginAsyncTypebox {
  return async (app) => {
    // Mails still being sent after their request was answered. Closing the app waits for them.
    const pendingMails = new Set<Promise<void>>()
    app.addHook('onClose', async () => {
      await Promise.all(pendingMails)
    })

    app.post(
      '/v1/key-resets',
      { schema: { body: KeyResetRequest, response: { 202: KeyResetAccepted } } },
      async (request, reply) => {
        const { accepted, mail } = await requestKeyReset(deps, request.body)
        reply.status(202).send(accepted)

        // The mail is not awaited: waiting for the mail server would make a real
        // request slower than a decoy, and a mail failure would show in the answer.
        if (mail !== null) {
          const sending = sendResetMail(deps, mail, request.log)
          pendingMails.add(sending)
          void sending.finally(() => pendingMails.delete(sending))
        }
        return reply
      },
    )

    app.post(
      '/v1/key-resets/:id/verify',
      { schema: { params: IdParams, body: KeyResetVerifyRequest, response: { 200: KeyResetResult } } },
      async (request) => verifyKeyReset(deps, request.params.id, request.body.code),
    )
  }
}

/**
 * One lock per requested pair, shared by requests and verifications. Real and decoy
 * pairs are locked alike, so parallel calls cannot slip past the resend window or the daily cap.
 */
function pairLock(studentId: number, email: string): string {
  return `key-reset:${studentId}:${email}`
}

async function requestKeyReset(
  deps: RegistrationDeps,
  body: Static<typeof KeyResetRequest>,
): Promise<{ accepted: Static<typeof KeyResetAccepted>; mail: PendingMail | null }> {
  const { db, config, clock } = deps

  const email = normalizeEmail(body.email)
  const now = clock.now()
  const code = generateCode()
  const expiresAt = new Date(now.getTime() + config.verificationCode.ttlMinutes * MINUTE_MS)

  return db.transaction().execute(async (trx) => {
    // Serializes requests for one pair, so a burst of parallel requests
    // cannot all get past the resend check below, whichever kind they are.
    await lock(trx, pairLock(body.studentId, email))

    // The window belongs to the pair that was asked for and counts decoys too.
    const recent = await trx
      .selectFrom('keyResets')
      .select('id')
      .where('requestedStudentId', '=', body.studentId)
      .where('requestedEmail', '=', email)
      .where('createdAt', '>', new Date(now.getTime() - config.verificationCode.resendSeconds * 1000))
      .limit(1)
      .executeTakeFirst()
    if (recent !== undefined) throw new ApiError(429, 'resend_too_soon')

    const student = await trx
      .selectFrom('students')
      .select('id')
      .where('id', '=', body.studentId)
      .where('email', '=', email)
      .executeTakeFirst()

    // A decoy holds the hash of a random string: nobody is sent it, and no six-digit code matches it.
    const row = await trx
      .insertInto('keyResets')
      .values({
        studentId: student?.id ?? null,
        requestedStudentId: body.studentId,
        requestedEmail: email,
        codeHash: hashSecret(student === undefined ? randomUUID() : code),
        expiresAt,
        createdAt: now,
        usedAt: null,
      })
      .returning('id')
      .executeTakeFirstOrThrow()

    return {
      accepted: { resetId: row.id },
      mail: student === undefined ? null : { email, code },
    }
  })
}

/**
 * Runs after the answer has gone out and never throws. If the mail cannot be sent
 * the error is only logged. The reset stays exactly as it is, so a failed real reset
 * behaves like a decoy: it keeps its resend window (the owner asks again after
 * `resendSeconds`) and whatever guesses are made at it still count toward the daily cap.
 * Deleting it would let someone who holds the reset id start over during a mail outage.
 */
async function sendResetMail(deps: RegistrationDeps, mail: PendingMail, log: FastifyBaseLogger): Promise<void> {
  try {
    await deps.mailer.sendCode(mail.email, 'key_reset', mail.code)
  } catch (err) {
    log.error(err, 'could not send the key reset code')
  }
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

/**
 * Failed guesses at any reset requested for this pair in the last 24 hours. The cap is per
 * pair, not per student id: otherwise anyone who knows a (sequential) student id could use
 * up its cap with made-up emails and lock the owner out. Real resets only exist under the
 * matching pair, so guessing real codes stays capped.
 */
async function recentFailures(
  trx: Kysely<Database>,
  requestedStudentId: number,
  requestedEmail: string,
  now: Date,
): Promise<number> {
  const row = await trx
    .selectFrom('keyResets')
    .select((eb) => eb.fn.sum<string | null>('attempts').as('failures'))
    .where('requestedStudentId', '=', requestedStudentId)
    .where('requestedEmail', '=', requestedEmail)
    .where('createdAt', '>', new Date(now.getTime() - DAY_MS))
    .executeTakeFirstOrThrow()
  return Number(row.failures ?? 0)
}

async function verifyInTransaction(
  trx: Kysely<Database>,
  deps: RegistrationDeps,
  id: string,
  code: string,
  now: Date,
): Promise<Outcome<Static<typeof KeyResetResult>>> {
  const { verificationCode } = deps.config

  // The row lock serializes every guess at this reset, so parallel requests
  // cannot read the same attempt count and get more guesses than allowed.
  const reset = await trx.selectFrom('keyResets').selectAll().where('id', '=', id).forUpdate().executeTakeFirst()
  // An unknown id and a used one look like a wrong code, so ids reveal nothing.
  if (reset === undefined || reset.usedAt !== null) return fail(400, 'code_invalid')

  // The daily cap is summed over all resets of the pair, so guesses at
  // different resets of it must not read the sum at the same time.
  await lock(trx, pairLock(reset.requestedStudentId, reset.requestedEmail))

  // Decoys and real resets take every branch below alike.
  if (reset.attempts >= verificationCode.maxAttempts) return fail(429, 'code_attempts_exceeded')
  if (now.getTime() >= reset.expiresAt.getTime()) return fail(410, 'code_expired')
  // Over the cap the code is not looked at, and nothing is counted.
  const failures = await recentFailures(trx, reset.requestedStudentId, reset.requestedEmail, now)
  if (failures >= verificationCode.keyResetDailyFailureCap) return fail(429, 'code_attempts_exceeded')

  // A decoy has no student to give a key to, so it fails like a wrong code whatever is sent.
  const matches = codeMatches(reset.codeHash, code)
  if (reset.studentId === null || !matches) {
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
