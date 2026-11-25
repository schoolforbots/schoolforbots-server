import { TypeBoxValidatorCompiler, type TypeBoxTypeProvider } from '@fastify/type-provider-typebox'
import type { FastifyPluginAsync } from 'fastify'
import { type Kysely, type Selectable, sql } from 'kysely'
import { Type, type Static } from 'typebox'
import { ApiError } from '../registration/errors.js'
import { audienceLabel, DIVISION_ORDER, SLOT_ORDER } from '../shared/broadcasts.js'
import type { Division, SchoolConfig, Slot } from '../shared/config.js'
import { MEMBER_STATUSES } from '../shared/db.js'
import { className } from '../shared/identity.js'
import type { BroadcastImportance, BroadcastStatus, Database } from '../shared/schema.js'
import type { AdminDeps } from './app.js'
import { storable, timeOf } from './notices.js'

// Writing the campus broadcasts: a draft is made, edited, published and withdrawn. Only a draft can be changed or
// deleted: a published broadcast may already have been fetched and passed on, so it is only ever withdrawn, for good.
// The students' side is `src/registration/broadcasts.ts`. The log names the broadcast's number and the action, never
// its title or body.

export const MAX_BROADCAST_TITLE = 40
export const MAX_BROADCAST_BODY = 1000

const NOT_FOUND = new ApiError(404, 'not_found')
const INVALID = new ApiError(400, 'invalid_request')

export interface BroadcastClass {
  id: number
  division: Division
  slot: Slot
  classNo: number
  name: string
}

export interface BroadcastView {
  id: number
  title: string
  body: string
  importance: BroadcastImportance
  divisions: Division[]
  slots: Slot[]
  classes: BroadcastClass[]
  /** Who it is addressed to, as the students' API puts it. */
  audience: string
  status: BroadcastStatus
  seq: number | null
  publishedAt: string | null
  withdrawnAt: string | null
  expiresAt: string | null
  noticeId: number | null
  createdAt: string
}

// Values are checked by hand with the rest, so every wrong one is the same 400.
const ClassRef = Type.Object(
  { division: Type.String(), slot: Type.String(), classNo: Type.Integer() },
  { additionalProperties: false },
)
const BroadcastBody = Type.Object(
  {
    title: Type.String(),
    body: Type.String(),
    importance: Type.String(),
    divisions: Type.Array(Type.String(), { maxItems: 3 }),
    slots: Type.Array(Type.String(), { maxItems: 3 }),
    classes: Type.Array(ClassRef, { maxItems: 50 }),
    expiresAt: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  },
  { additionalProperties: false },
)

interface Content {
  title: string
  body: string
  importance: BroadcastImportance
  divisions: Division[]
  slots: Slot[]
  classIds: number[]
  expiresAt: Date | null
}

/** The values given, each once and each one of `order`, put in that order; a 400 otherwise. */
function listOf<T extends string>(given: readonly string[], order: readonly T[]): T[] {
  if (new Set(given).size !== given.length || !given.every((g) => (order as readonly string[]).includes(g))) throw INVALID
  return order.filter((o) => given.includes(o))
}

/** The broadcast's content as it will be stored, or a 400 for anything the table or the page would refuse. */
async function contentOf(db: Kysely<Database>, body: Static<typeof BroadcastBody>): Promise<Content> {
  if (!storable(body.title) || !storable(body.body)) throw INVALID
  const title = body.title.trim()
  const titleLength = [...title].length
  if (titleLength < 1 || titleLength > MAX_BROADCAST_TITLE) throw INVALID
  if ([...body.body].length > MAX_BROADCAST_BODY) throw INVALID
  if (body.importance !== 'normal' && body.importance !== 'important') throw INVALID
  const divisions = listOf(body.divisions, DIVISION_ORDER)
  const slots = listOf(body.slots, SLOT_ORDER)
  // Classes, or divisions and slots: not both.
  if (body.classes.length > 0 && (divisions.length > 0 || slots.length > 0)) throw INVALID
  const classIds: number[] = []
  for (const c of body.classes) {
    const [division] = listOf([c.division], DIVISION_ORDER)
    const [slot] = listOf([c.slot], SLOT_ORDER)
    const row = await db
      .selectFrom('classes')
      .select('id')
      .where('division', '=', division!)
      .where('slot', '=', slot!)
      .where('classNo', '=', c.classNo)
      .executeTakeFirst()
    if (row === undefined || classIds.includes(row.id)) throw INVALID
    classIds.push(row.id)
  }
  return { title, body: body.body, importance: body.importance, divisions, slots, classIds, expiresAt: timeOf(body.expiresAt) }
}

function broadcastIdOf(params: unknown): number {
  const { id } = params as { id: string }
  if (!/^[1-9][0-9]{0,8}$/.test(id)) throw NOT_FOUND
  return Number(id)
}

async function viewsOf(
  db: Kysely<Database>,
  config: SchoolConfig,
  rows: Selectable<Database['broadcasts']>[],
): Promise<BroadcastView[]> {
  const ids = [...new Set(rows.flatMap((r) => r.classIds))]
  const classRows =
    ids.length === 0
      ? []
      : await db.selectFrom('classes').select(['id', 'division', 'slot', 'classNo']).where('id', 'in', ids).execute()
  const classes = new Map(classRows.map((c) => [c.id, { ...c, name: className(c.division, c.slot, c.classNo, config) }]))
  const names = new Map([...classes].map(([id, c]) => [id, c.name]))
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    body: r.body,
    importance: r.importance,
    divisions: r.divisions as Division[],
    slots: r.slots as Slot[],
    classes: r.classIds.flatMap((id) => classes.get(id) ?? []),
    audience: audienceLabel(r, names, config),
    status: r.status,
    seq: r.seq,
    publishedAt: r.publishedAt?.toISOString() ?? null,
    withdrawnAt: r.withdrawnAt?.toISOString() ?? null,
    expiresAt: r.expiresAt?.toISOString() ?? null,
    noticeId: r.noticeId,
    createdAt: r.createdAt.toISOString(),
  }))
}

/** The broadcast, locked for the rest of the transaction; a 404 when there is none. */
async function lockBroadcast(trx: Kysely<Database>, id: number) {
  const row = await trx.selectFrom('broadcasts').selectAll().where('id', '=', id).forUpdate().executeTakeFirst()
  if (row === undefined) throw NOT_FOUND
  return row
}

function wrongStatus(message: string): ApiError {
  return new ApiError(409, 'wrong_status', {}, message)
}

/**
 * Publishes a broadcast to the whole school with a notice's title and body, inside the caller's transaction: what the
 * notices page does when the operator asks to broadcast a notice as it is published. A title or body longer than a
 * broadcast takes is cut short.
 */
export async function broadcastNotice(
  trx: Kysely<Database>,
  notice: { id: number; title: string; body: string },
  importance: BroadcastImportance,
  now: Date,
): Promise<number> {
  const title = [...notice.title].slice(0, MAX_BROADCAST_TITLE).join('')
  const chars = [...notice.body]
  const body = chars.length > MAX_BROADCAST_BODY ? `${chars.slice(0, MAX_BROADCAST_BODY - 1).join('')}…` : notice.body
  const row = await trx
    .insertInto('broadcasts')
    .values({
      title,
      body,
      importance,
      status: 'published',
      seq: sql<number>`nextval('broadcast_seq')`,
      publishedAt: now,
      noticeId: notice.id,
      createdAt: now,
    })
    .returning('id')
    .executeTakeFirstOrThrow()
  return row.id
}

export const broadcastRoutes =
  (deps: AdminDeps): FastifyPluginAsync =>
  async (instance) => {
    const app = instance.withTypeProvider<TypeBoxTypeProvider>()
    app.setValidatorCompiler(TypeBoxValidatorCompiler)
    const { db, clock, config } = deps

    const one = async (trx: Kysely<Database>, id: number): Promise<BroadcastView> => {
      const row = await trx.selectFrom('broadcasts').selectAll().where('id', '=', id).executeTakeFirstOrThrow()
      return (await viewsOf(trx, config, [row]))[0]!
    }

    /** Changes one broadcast in a transaction and gives it back as it is now, logging the action. */
    async function act(
      log: { info: (obj: object, msg: string) => void },
      id: number,
      action: string,
      change: (trx: Kysely<Database>, row: Selectable<Database['broadcasts']>) => Promise<void>,
    ): Promise<BroadcastView> {
      const broadcast = await db.transaction().execute(async (trx) => {
        await change(trx, await lockBroadcast(trx, id))
        return one(trx, id)
      })
      log.info({ broadcastId: id, action }, 'broadcast')
      return broadcast
    }

    // Newest first: a draft by when it was made, any other by when it was published.
    app.get('/broadcasts', async () => {
      const rows = await db
        .selectFrom('broadcasts')
        .selectAll()
        .orderBy(sql`coalesce(published_at, created_at)`, 'desc')
        .orderBy('id', 'desc')
        .execute()
      return { broadcasts: await viewsOf(db, config, rows) }
    })

    // The classes a broadcast can be addressed to: those with members, in the school's order.
    app.get('/broadcasts/classes', async () => {
      const rows = await db
        .selectFrom('classes as c')
        .select(['c.id', 'c.division', 'c.slot', 'c.classNo'])
        .where((eb) =>
          eb.exists(
            eb
              .selectFrom('students as s')
              .select('s.id')
              .whereRef('s.classId', '=', 'c.id')
              .where('s.status', 'in', [...MEMBER_STATUSES]),
          ),
        )
        .execute()
      const rank = (r: { division: Division; slot: Slot; classNo: number }) =>
        [DIVISION_ORDER.indexOf(r.division), SLOT_ORDER.indexOf(r.slot), r.classNo] as const
      rows.sort((a, b) => {
        const [x, y] = [rank(a), rank(b)]
        return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]
      })
      return {
        classes: rows.map((r): BroadcastClass => ({ ...r, name: className(r.division, r.slot, r.classNo, config) })),
      }
    })

    app.post('/broadcasts', { schema: { body: BroadcastBody } }, async (request): Promise<BroadcastView> => {
      const content = await contentOf(db, request.body)
      const row = await db
        .insertInto('broadcasts')
        .values({ ...content, createdAt: clock.now() })
        .returning('id')
        .executeTakeFirstOrThrow()
      request.log.info({ broadcastId: row.id, action: 'create' }, 'broadcast')
      return one(db, row.id)
    })

    // The whole content is sent each time. Only a draft is changed.
    app.put('/broadcasts/:id', { schema: { body: BroadcastBody } }, async (request): Promise<BroadcastView> => {
      const id = broadcastIdOf(request.params)
      const content = await contentOf(db, request.body)
      return act(request.log, id, 'edit', async (trx, row) => {
        if (row.status !== 'draft') throw wrongStatus('发布过的广播不能改，只能撤回。')
        await trx.updateTable('broadcasts').set(content).where('id', '=', id).execute()
      })
    })

    app.post('/broadcasts/:id/publish', async (request): Promise<BroadcastView> => {
      const id = broadcastIdOf(request.params)
      const now = clock.now()
      return act(request.log, id, 'publish', async (trx, row) => {
        if (row.status !== 'draft') throw wrongStatus('只有草稿才能发布。')
        if (row.expiresAt !== null && row.expiresAt.getTime() <= now.getTime()) {
          throw wrongStatus('截止时间已经过了，改一下再发布。')
        }
        await trx
          .updateTable('broadcasts')
          .set({ status: 'published', seq: sql<number>`nextval('broadcast_seq')`, publishedAt: now })
          .where('id', '=', id)
          .execute()
      })
    })

    app.post('/broadcasts/:id/withdraw', async (request): Promise<BroadcastView> => {
      const id = broadcastIdOf(request.params)
      return act(request.log, id, 'withdraw', async (trx, row) => {
        if (row.status !== 'published') throw wrongStatus('只有已发布的广播才能撤回。')
        await trx
          .updateTable('broadcasts')
          .set({ status: 'withdrawn', withdrawnAt: clock.now() })
          .where('id', '=', id)
          .execute()
      })
    })

    app.delete('/broadcasts/:id', async (request) => {
      const id = broadcastIdOf(request.params)
      await db.transaction().execute(async (trx) => {
        const row = await lockBroadcast(trx, id)
        if (row.status !== 'draft') throw wrongStatus('发布过的广播不能删除，只能撤回。')
        await trx.deleteFrom('broadcasts').where('id', '=', id).execute()
      })
      request.log.info({ broadcastId: id, action: 'delete' }, 'broadcast')
      return { ok: true }
    })
  }
