import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { sql, type Kysely } from 'kysely'
import type { Static } from 'typebox'
import { SchoolStatsResult } from '../protocol/http.js'
import type { Division, SchoolConfig, Slot } from '../shared/config.js'
import { MEMBER_STATUSES } from '../shared/db.js'
import { startOfLocalDay } from '../shared/local-time.js'
import type { Database } from '../shared/schema.js'
import type { RegistrationDeps } from './app.js'

/** How long the numbers are kept before they are counted again, and how long a browser may keep them. */
export const SCHOOL_STATS_TTL_MS = 60_000
const CACHE_CONTROL = `public, max-age=${SCHOOL_STATS_TTL_MS / 1000}`

const SLOTS: readonly Slot[] = ['morning', 'afternoon', 'evening']

type SchoolStats = Static<typeof SchoolStatsResult>

/**
 * The school's numbers, to anyone: totals only, of the students in school, their owners, the classes and today's games
 * of doudizhu. Counted at most once every `SCHOOL_STATS_TTL_MS`, however many ask: they share one count.
 */
export function schoolStatsRoutes(deps: RegistrationDeps): FastifyPluginAsyncTypebox {
  let cached: { until: number; stats: Promise<SchoolStats> } | null = null
  return async (app) => {
    // Any site's web page may read this, as it may the calendar: see `schoolRoutes`.
    app.addHook('onRequest', async (_request, reply) => {
      reply.header('access-control-allow-origin', '*')
    })

    app.get('/v1/school/stats', { schema: { response: { 200: SchoolStatsResult } } }, async (_request, reply) => {
      const now = deps.clock.now()
      if (cached === null || now.getTime() >= cached.until) {
        const stats = schoolStats(deps.db, deps.config, now)
        cached = { until: now.getTime() + SCHOOL_STATS_TTL_MS, stats }
        // A failed count is not kept: the next request counts again.
        stats.catch(() => {
          if (cached?.stats === stats) cached = null
        })
      }
      const stats = await cached.stats
      reply.header('cache-control', CACHE_CONTROL)
      return stats
    })
  }
}

export async function schoolStats(db: Kysely<Database>, config: SchoolConfig, now: Date): Promise<SchoolStats> {
  const members = [...MEMBER_STATUSES]
  const students = await db
    .selectFrom('students')
    .select(['division', 'slot', sql<string>`count(*)`.as('students')])
    .where('status', 'in', members)
    .groupBy(['division', 'slot'])
    .execute()
  const owners = await db
    .selectFrom('students')
    .select(sql<string>`count(distinct lower(email))`.as('owners'))
    .where('status', 'in', members)
    .executeTakeFirstOrThrow()
  const classes = await db
    .selectFrom('classes as c')
    .leftJoin('students as s', (join) => join.onRef('s.classId', '=', 'c.id').on('s.status', 'in', members))
    .select(['c.slot', 'c.division', sql<string>`count(distinct c.id)`.as('classes'), sql<string>`count(s.id)`.as('students')])
    .groupBy(['c.slot', 'c.division'])
    .execute()
  const games = await db
    .selectFrom('doudizhuGames')
    .select(sql<string>`count(*)`.as('games'))
    .where('endedAt', '>=', startOfLocalDay(now, config.timezone))
    .executeTakeFirstOrThrow()

  const divisions = Object.keys(config.divisions) as Division[]
  const sum = (rows: { students: string }[]) => rows.reduce((n, r) => n + Number(r.students), 0)
  return {
    generatedAt: now.toISOString(),
    students: {
      total: sum(students),
      byDivision: divisions.map((division) => ({ division, students: sum(students.filter((r) => r.division === division)) })),
      bySlot: SLOTS.map((slot) => ({ slot, students: sum(students.filter((r) => r.slot === slot)) })),
    },
    owners: Number(owners.owners),
    classes: {
      total: classes.reduce((n, r) => n + Number(r.classes), 0),
      bySlotAndDivision: SLOTS.flatMap((slot) =>
        divisions.flatMap((division) => {
          const row = classes.find((r) => r.slot === slot && r.division === division)
          return row === undefined ? [] : [{ slot, division, classes: Number(row.classes), students: Number(row.students) }]
        }),
      ),
    },
    clubs: { doudizhu: { gamesToday: Number(games.games) } },
  }
}
