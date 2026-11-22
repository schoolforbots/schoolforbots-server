import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import type { Selectable } from 'kysely'
import { Type, type Static } from 'typebox'
import { Notice, NoticeResult, NoticesResult } from '../protocol/http.js'
import type { Database } from '../shared/schema.js'
import type { RegistrationDeps } from './app.js'
import { ApiError } from './errors.js'
import { wholeNumber } from './records.js'

const MAX_PG_INTEGER = 2_147_483_647

// A query value is text; `wholeNumber` reads it. An id is a positive whole number in plain digits.
const NoticesQuery = Type.Object({ limit: Type.Optional(Type.String()) })
const NoticeParams = Type.Object({ id: Type.String({ pattern: '^[1-9][0-9]*$' }) })

/** How long a browser, or a cache on the way, may keep a notice answer. */
const CACHE_CONTROL = 'public, max-age=60'

const COLUMNS = ['id', 'title', 'body', 'kind', 'startsAt', 'endsAt', 'publishedAt', 'updatedAt'] as const
type NoticeRow = Pick<Selectable<Database['notices']>, (typeof COLUMNS)[number]>

/** The school's notices, to anyone: only the published ones. (No key needed, and nothing about a student.) */
export function noticeRoutes(deps: RegistrationDeps): FastifyPluginAsyncTypebox {
  return async (app) => {
    // Any site's web page may read these, errors and the rate limit included, as it may the calendar: see
    // `schoolRoutes` for why this is enough and safe.
    app.addHook('onRequest', async (_request, reply) => {
      reply.header('access-control-allow-origin', '*')
    })

    app.get(
      '/v1/notices',
      { schema: { querystring: NoticesQuery, response: { 200: NoticesResult } } },
      async (request, reply) => {
        const limit = wholeNumber(request.query.limit, { fallback: 20, min: 1, max: 50 })
        // One more than asked for, to tell whether there are more.
        const rows = await deps.db
          .selectFrom('notices')
          .select(COLUMNS)
          .where('status', '=', 'published')
          .orderBy('publishedAt', 'desc')
          .orderBy('id', 'desc')
          .limit(limit + 1)
          .execute()
        reply.header('cache-control', CACHE_CONTROL)
        return { notices: rows.slice(0, limit).map(published), more: rows.length > limit }
      },
    )

    app.get(
      '/v1/notices/:id',
      { schema: { params: NoticeParams, response: { 200: NoticeResult } } },
      async (request, reply) => {
        const id = Number(request.params.id)
        // Past what the column holds there is no such notice; the database would refuse the number.
        if (id > MAX_PG_INTEGER) throw new ApiError(404, 'not_found')
        const row = await deps.db
          .selectFrom('notices')
          .select(COLUMNS)
          .where('id', '=', id)
          .where('status', '=', 'published')
          .executeTakeFirst()
        if (row === undefined) throw new ApiError(404, 'not_found')
        reply.header('cache-control', CACHE_CONTROL)
        return { notice: published(row) }
      },
    )
  }
}

/** A published notice as the routes give it. */
function published(row: NoticeRow): Static<typeof Notice> {
  // A published notice always has its publishing time (the table's check says so).
  if (row.publishedAt === null) throw new Error(`Notice ${row.id} is published but has no published_at`)
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    kind: row.kind,
    window:
      row.kind === 'general'
        ? null
        : { startsAt: row.startsAt?.toISOString() ?? null, endsAt: row.endsAt?.toISOString() ?? null },
    publishedAt: row.publishedAt.toISOString(),
    updatedAt: row.updatedAt?.toISOString() ?? null,
  }
}
