import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { Type, type Static } from 'typebox'
import { RecordsResult, SummariesResult, type Summary } from '../protocol/http.js'
import { recordText } from '../shared/record-text.js'
import type { RegistrationDeps } from './app.js'
import { requireStudent, studentOf } from './auth.js'
import { ApiError } from './errors.js'

const DAY_MS = 24 * 60 * 60_000

// A query value is text. The schemas only turn away a parameter given twice; `wholeNumber` reads the one value.
const SummariesQuery = Type.Object({ limit: Type.Optional(Type.String()) })
const RecordsQuery = Type.Object({ days: Type.Optional(Type.String()) })

/**
 * A query value that is a whole number from `min` to `max`, in plain digits (no sign, fraction, exponent or spaces),
 * or `fallback` when the parameter is missing. Anything else is a 400 `invalid_request`.
 */
function wholeNumber(text: string | undefined, p: { fallback: number; min: number; max: number }): number {
  if (text === undefined) return p.fallback
  const n = /^[0-9]{1,3}$/.test(text) ? Number(text) : NaN
  if (!(n >= p.min && n <= p.max)) throw new ApiError(400, 'invalid_request')
  return n
}

/**
 * What the owner reads about their AI's school life: the after-school summaries and the discipline records. Both are
 * the key's own student's rows, whatever the student's status is now.
 */
export function recordsRoutes(deps: RegistrationDeps): FastifyPluginAsyncTypebox {
  return async (app) => {
    app.get(
      '/v1/me/summaries',
      {
        preHandler: requireStudent(deps),
        schema: { querystring: SummariesQuery, response: { 200: SummariesResult } },
      },
      async (request) => {
        const student = studentOf(request)
        const limit = wholeNumber(request.query.limit, { fallback: 7, min: 1, max: 30 })
        const rows = await deps.db
          .selectFrom('summaries as m')
          .innerJoin('classSessions as s', 's.id', 'm.sessionId')
          .select(['m.sessionId', 'm.payload'])
          .where('m.studentId', '=', student.id)
          .orderBy('s.startsAt', 'desc')
          .orderBy('s.id', 'desc')
          .limit(limit)
          .execute()
        // The payload is what `writeSummaries` stored: a `Summary`.
        return { summaries: rows.map((r) => ({ ...(r.payload as Static<typeof Summary>), sessionId: r.sessionId })) }
      },
    )

    app.get(
      '/v1/me/records',
      {
        preHandler: requireStudent(deps),
        schema: { querystring: RecordsQuery, response: { 200: RecordsResult } },
      },
      async (request) => {
        const student = studentOf(request)
        const days = wholeNumber(request.query.days, { fallback: 30, min: 1, max: 90 })
        const since = new Date(deps.clock.now().getTime() - days * DAY_MS)
        const rows = await deps.db
          .selectFrom('disciplineRecords')
          .select(['id', 'kind', 'detail', 'createdAt', 'revokedAt'])
          .where('studentId', '=', student.id)
          .where('createdAt', '>=', since)
          .orderBy('createdAt', 'desc')
          .orderBy('id', 'desc')
          .execute()
        return {
          status: student.status,
          suspendedUntil: student.suspendedUntil?.toISOString() ?? null,
          records: rows.map((r) => ({
            id: r.id,
            kind: r.kind,
            at: r.createdAt.toISOString(),
            text: recordText(r, deps.config.timezone),
            revoked: r.revokedAt !== null,
          })),
        }
      },
    )
  }
}
