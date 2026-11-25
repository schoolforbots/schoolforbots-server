import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { sql } from 'kysely'
import { Type } from 'typebox'
import { BroadcastsResult } from '../protocol/http.js'
import { audienceLabel, BROADCAST_DAYS, classNamesOf } from '../shared/broadcasts.js'
import { SEAT_STATUSES } from '../shared/db.js'
import type { StudentStatus } from '../shared/schema.js'
import type { RegistrationDeps } from './app.js'
import { requireStudent, studentOf } from './auth.js'
import { ApiError } from './errors.js'
import { wholeNumber } from './records.js'

const MAX_PG_INTEGER = 2_147_483_647
const DAY_MS = 24 * 60 * 60_000

// A query value is text. `after` is a `seq`: 0, or a positive whole number in plain digits.
const BroadcastsQuery = Type.Object({ after: Type.Optional(Type.String()), limit: Type.Optional(Type.String()) })

function afterOf(text: string | undefined): number {
  if (text === undefined) return 0
  if (!/^(0|[1-9][0-9]{0,14})$/.test(text)) throw new ApiError(400, 'invalid_request')
  // Past what the column holds there is nothing after it.
  return Math.min(Number(text), MAX_PG_INTEGER)
}

/**
 * The campus broadcasts, to the students they are addressed to (`GET /v1/me/broadcasts`): published, not withdrawn,
 * not past their expiry, and published within the last `BROADCAST_DAYS` days, oldest first by `seq`. A student in a
 * class gets those to the whole school, to their division and slot, and to their class; one waiting for a class or a
 * seat gets all but those to a class. A student who has left the school gets none: 409 `wrong_status`.
 */
export function broadcastRoutes(deps: RegistrationDeps): FastifyPluginAsyncTypebox {
  return async (app) => {
    app.get(
      '/v1/me/broadcasts',
      { preHandler: requireStudent(deps), schema: { querystring: BroadcastsQuery, response: { 200: BroadcastsResult } } },
      async (request) => {
        const student = studentOf(request)
        if (!(SEAT_STATUSES as readonly StudentStatus[]).includes(student.status)) throw new ApiError(409, 'wrong_status')
        const after = afterOf(request.query.after)
        const limit = wholeNumber(request.query.limit, { fallback: 20, min: 1, max: 50 })
        const now = deps.clock.now()

        // One more than asked for, to tell whether there are more.
        const rows = await deps.db
          .selectFrom('broadcasts')
          .select(['id', 'seq', 'title', 'body', 'importance', 'divisions', 'slots', 'classIds', 'publishedAt', 'expiresAt'])
          .where('status', '=', 'published')
          .where('seq', '>', after)
          .where('publishedAt', '>', new Date(now.getTime() - BROADCAST_DAYS * DAY_MS))
          .where((eb) => eb.or([eb('expiresAt', 'is', null), eb('expiresAt', '>', now)]))
          .where((eb) =>
            eb.or([
              eb.and([
                eb(sql`cardinality(class_ids)`, '=', 0),
                eb.or([eb(sql`cardinality(divisions)`, '=', 0), eb(sql`${student.division}`, '=', sql`any(divisions)`)]),
                eb.or([eb(sql`cardinality(slots)`, '=', 0), eb(sql`${student.slot}`, '=', sql`any(slots)`)]),
              ]),
              ...(student.classId === null ? [] : [eb(sql`${student.classId}::integer`, '=', sql`any(class_ids)`)]),
            ]),
          )
          .orderBy('seq')
          .limit(limit + 1)
          .execute()

        const given = rows.slice(0, limit)
        const classes = await classNamesOf(deps.db, given.flatMap((r) => r.classIds), deps.config)
        return {
          broadcasts: given.map((r) => {
            // A published broadcast always has both (the table's checks say so).
            if (r.seq === null || r.publishedAt === null) throw new Error(`Broadcast ${r.id} is published but has no seq`)
            return {
              id: r.id,
              seq: r.seq,
              title: r.title,
              body: r.body,
              importance: r.importance,
              audience: audienceLabel(r, classes, deps.config),
              publishedAt: r.publishedAt.toISOString(),
              expiresAt: r.expiresAt?.toISOString() ?? null,
            }
          }),
          more: rows.length > limit,
        }
      },
    )
  }
}
