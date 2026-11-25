import { TypeBoxValidatorCompiler, type TypeBoxTypeProvider } from '@fastify/type-provider-typebox'
import type { FastifyPluginAsync } from 'fastify'
import { type Kysely, type Selectable, sql } from 'kysely'
import { Type, type Static } from 'typebox'
import { ApiError } from '../registration/errors.js'
import type { BroadcastImportance, Database, NoticeKind, NoticeStatus } from '../shared/schema.js'
import type { AdminDeps } from './app.js'
import { broadcastNotice } from './broadcasts.js'

// Writing the school's notices: a draft is made, edited, published, withdrawn and published again; only a draft can
// be deleted, so a notice that was ever out stays on record. `published_at` is set the first time it is published and
// only the admin's correction changes it; `updated_at` marks a notice changed after it was out. The public side is
// `src/registration/notices.ts`. The log names the notice's number and the action, never its title or body.

const MAX_TITLE = 60
const MAX_BODY = 4000

const NOT_FOUND = new ApiError(404, 'not_found')
const INVALID = new ApiError(400, 'invalid_request')

export interface NoticeView {
  id: number
  title: string
  body: string
  kind: NoticeKind
  startsAt: string | null
  endsAt: string | null
  status: NoticeStatus
  publishedAt: string | null
  updatedAt: string | null
  createdAt: string
}

// The kind is checked by hand with the rest, so every wrong value is the same 400.
const Fields = {
  title: Type.String(),
  body: Type.String(),
  kind: Type.String(),
  startsAt: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  endsAt: Type.Optional(Type.Union([Type.String(), Type.Null()])),
}
const CreateBody = Type.Object(Fields, { additionalProperties: false })
const EditBody = Type.Object(
  { ...Fields, publishedAt: Type.Optional(Type.String()) },
  { additionalProperties: false },
)

interface Content {
  title: string
  body: string
  kind: NoticeKind
  startsAt: Date | null
  endsAt: Date | null
}

/**
 * A full ISO 8601 date and time with its offset (`Z` or `+08:00`): one with no offset would be read in the server's
 * own time zone.
 */
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/

/** A time as the page sends it; absent or null is none; anything else, or a year the database cannot hold, a 400. */
export function timeOf(text: string | null | undefined): Date | null {
  if (text === undefined || text === null) return null
  if (!ISO_TIME.test(text)) throw INVALID
  const d = new Date(text)
  if (Number.isNaN(d.getTime())) throw INVALID
  const year = d.getUTCFullYear()
  if (year < 2000 || year > 9999) throw INVALID
  return d
}

/** Text the database can store as it is: no NUL, and no lone half of a surrogate pair (it would come back changed). */
export function storable(text: string): boolean {
  return !text.includes('\u0000') && !LONE_SURROGATE.test(text)
}
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

/** The notice's content as it will be stored, or a 400 for anything the table or the spec would refuse. */
function contentOf(body: Static<typeof CreateBody>): Content {
  if (!storable(body.title) || !storable(body.body)) throw INVALID
  const title = body.title.trim()
  const titleLength = [...title].length
  if (titleLength < 1 || titleLength > MAX_TITLE) throw INVALID
  if ([...body.body].length > MAX_BODY) throw INVALID
  const startsAt = timeOf(body.startsAt)
  const endsAt = timeOf(body.endsAt)
  if (body.kind === 'general') {
    if (startsAt !== null || endsAt !== null) throw INVALID
  } else if (body.kind === 'maintenance') {
    // Its start is always given; its end may be left out, and is after the start.
    if (startsAt === null) throw INVALID
    if (endsAt !== null && endsAt.getTime() <= startsAt.getTime()) throw INVALID
  } else {
    throw INVALID
  }
  return { title, body: body.body, kind: body.kind, startsAt, endsAt }
}

function sameTime(a: Date | null, b: Date | null): boolean {
  return a === null || b === null ? a === b : a.getTime() === b.getTime()
}

function changed(row: Content, next: Content): boolean {
  return (
    row.title !== next.title ||
    row.body !== next.body ||
    row.kind !== next.kind ||
    !sameTime(row.startsAt, next.startsAt) ||
    !sameTime(row.endsAt, next.endsAt)
  )
}

function noticeIdOf(params: unknown): number {
  const { id } = params as { id: string }
  if (!/^[1-9][0-9]{0,8}$/.test(id)) throw NOT_FOUND
  return Number(id)
}

function view(row: Selectable<Database['notices']>): NoticeView {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    kind: row.kind,
    startsAt: row.startsAt?.toISOString() ?? null,
    endsAt: row.endsAt?.toISOString() ?? null,
    status: row.status,
    publishedAt: row.publishedAt?.toISOString() ?? null,
    updatedAt: row.updatedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  }
}

/** The notice, locked for the rest of the transaction; a 404 when there is none. */
async function lockNotice(trx: Kysely<Database>, id: number) {
  const row = await trx.selectFrom('notices').selectAll().where('id', '=', id).forUpdate().executeTakeFirst()
  if (row === undefined) throw NOT_FOUND
  return row
}

/** The importance to broadcast a notice with as it is published, from the publish request's body; null for none. */
function broadcastOf(body: unknown): BroadcastImportance | null {
  if (body === undefined || body === null) return null
  if (typeof body !== 'object' || Array.isArray(body)) throw INVALID
  const keys = Object.keys(body)
  if (keys.some((k) => k !== 'broadcast')) throw INVALID
  const value = (body as { broadcast?: unknown }).broadcast
  if (value === undefined || value === null) return null
  if (value !== 'normal' && value !== 'important') throw INVALID
  return value
}

function wrongStatus(message: string): ApiError {
  return new ApiError(409, 'wrong_status', {}, message)
}

export const noticeRoutes = (deps: AdminDeps): FastifyPluginAsync => async (instance) => {
  const app = instance.withTypeProvider<TypeBoxTypeProvider>()
  app.setValidatorCompiler(TypeBoxValidatorCompiler)
  const { db, clock } = deps

  /** Changes one notice in a transaction and gives it back as it is now, logging the action. */
  async function act(
    log: { info: (obj: object, msg: string) => void },
    id: number,
    action: string,
    change: (trx: Kysely<Database>, row: Selectable<Database['notices']>) => Promise<void>,
  ): Promise<NoticeView> {
    const notice = await db.transaction().execute(async (trx) => {
      await change(trx, await lockNotice(trx, id))
      return view(await trx.selectFrom('notices').selectAll().where('id', '=', id).executeTakeFirstOrThrow())
    })
    log.info({ noticeId: id, action }, 'notice')
    return notice
  }

  // Newest first: a draft by when it was made, any other by when it was first published.
  app.get('/notices', async () => {
    const rows = await db
      .selectFrom('notices')
      .selectAll()
      .orderBy(sql`coalesce(published_at, created_at)`, 'desc')
      .orderBy('id', 'desc')
      .execute()
    return { notices: rows.map(view) }
  })

  app.post('/notices', { schema: { body: CreateBody } }, async (request): Promise<NoticeView> => {
    const content = contentOf(request.body)
    const row = await db
      .insertInto('notices')
      .values({ ...content, createdAt: clock.now() })
      .returningAll()
      .executeTakeFirstOrThrow()
    request.log.info({ noticeId: row.id, action: 'create' }, 'notice')
    return view(row)
  })

  // The whole content is sent each time. `publishedAt` corrects when a notice that was out was published (a notice
  // put out late, say); it is not a change to what the notice says, so it alone does not mark it updated.
  app.put('/notices/:id', { schema: { body: EditBody } }, async (request): Promise<NoticeView> => {
    const id = noticeIdOf(request.params)
    const content = contentOf(request.body)
    const now = clock.now()
    let publishedAt: Date | undefined
    if (request.body.publishedAt !== undefined) {
      publishedAt = timeOf(request.body.publishedAt) ?? undefined
      if (publishedAt === undefined || publishedAt.getTime() > now.getTime()) throw INVALID
    }
    return act(request.log, id, 'edit', async (trx, row) => {
      if (publishedAt !== undefined && row.status === 'draft') {
        throw wrongStatus('草稿还没发布过，没有发布时间可以改。')
      }
      const updatedAt = row.status !== 'draft' && changed(row, content) ? now : row.updatedAt
      await trx
        .updateTable('notices')
        .set({ ...content, updatedAt, ...(publishedAt === undefined ? {} : { publishedAt }) })
        .where('id', '=', id)
        .execute()
    })
  })

  // With `{ "broadcast": "normal" | "important" }`, the notice is also broadcast to the whole school, with that
  // importance, in the same transaction. No body, or no `broadcast`, publishes the notice alone.
  app.post('/notices/:id/publish', async (request): Promise<NoticeView> => {
    const id = noticeIdOf(request.params)
    const broadcast = broadcastOf(request.body)
    return act(request.log, id, 'publish', async (trx, row) => {
      if (row.status === 'published') throw wrongStatus('这条公告已经发布了。')
      const now = clock.now()
      // Published again after being withdrawn, it keeps the time it first went out.
      await trx
        .updateTable('notices')
        .set({ status: 'published', publishedAt: row.publishedAt ?? now })
        .where('id', '=', id)
        .execute()
      if (broadcast !== null) {
        const broadcastId = await broadcastNotice(trx, row, broadcast, now)
        request.log.info({ broadcastId, noticeId: id, action: 'publish' }, 'broadcast')
      }
    })
  })

  app.post('/notices/:id/withdraw', async (request): Promise<NoticeView> => {
    const id = noticeIdOf(request.params)
    return act(request.log, id, 'withdraw', async (trx, row) => {
      if (row.status !== 'published') throw wrongStatus('只有已发布的公告才能撤下。')
      await trx.updateTable('notices').set({ status: 'withdrawn' }).where('id', '=', id).execute()
    })
  })

  app.delete('/notices/:id', async (request) => {
    const id = noticeIdOf(request.params)
    await db.transaction().execute(async (trx) => {
      const row = await lockNotice(trx, id)
      if (row.status !== 'draft') throw wrongStatus('发布过的公告不能删除，只能撤下。')
      await trx.deleteFrom('notices').where('id', '=', id).execute()
    })
    request.log.info({ noticeId: id, action: 'delete' }, 'notice')
    return { ok: true }
  })
}
