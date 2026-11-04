import { TypeBoxValidatorCompiler, type TypeBoxTypeProvider } from '@fastify/type-provider-typebox'
import type { FastifyPluginAsync } from 'fastify'
import type { Kysely } from 'kysely'
import { Type } from 'typebox'
import { excludeRule } from '../discipline/revoke.js'
import { ApiError } from '../registration/errors.js'
import type { Database } from '../shared/schema.js'
import type { StoredSuggestions, WeeklySuggestions } from '../weekly/review.js'
import { isWeekStart, lastCompletedWeek, weeklyStats, type StoredStats, type WeeklyStats } from '../weekly/stats.js'
import type { AdminDeps } from './app.js'

// The weekly review page: a week's numbers and the model's suggestions, the rules dropped so far, and dropping one.
// A stored review names students' lines by id: they are read with it, and a line purged since (past the messages'
// retention) is left out. The log names the kind of a dropped rule and what dropping it took back, never the rule.

/** A line of a student's, as the page shows it. */
export interface ShownLine {
  messageId: number
  text: string
  at: string
}

/** A suggested rule as the page shows it: its examples are the lines themselves. */
export interface ShownRule extends Omit<WeeklySuggestions['removeRules'][number], 'examples'> {
  examples: ShownLine[]
}

export interface WeeklyPage {
  stats: WeeklyStats
  /** Null when the week has no review yet: its numbers are then counted as they stand. */
  suggestions: {
    removeRules: ShownRule[] | null
    directions: string[] | null
    failures: StoredSuggestions['failures']
  } | null
  /** Every rule dropped, the latest first. */
  exclusions: { kind: 'word' | 'pattern'; value: string; createdAt: string }[]
}

/** A stored review with the lines it names, the ones still kept. */
async function shown(
  db: Kysely<Database>,
  stats: StoredStats,
  s: StoredSuggestions,
): Promise<Pick<WeeklyPage, 'stats' | 'suggestions'>> {
  const named = [...stats.moderation.secondLayerChat, ...(s.removeRules ?? []).flatMap((r) => r.examples)]
  const ids = [...new Set(named)]
  const rows =
    ids.length === 0
      ? []
      : await db.selectFrom('messages').select(['id', 'text', 'createdAt']).where('id', 'in', ids).execute()
  const byId = new Map<number, ShownLine>()
  for (const l of rows) byId.set(l.id, { messageId: l.id, text: l.text, at: l.createdAt.toISOString() })
  const lines = (of: number[]) => of.flatMap((id) => byId.get(id) ?? [])
  return {
    stats: { ...stats, moderation: { ...stats.moderation, secondLayerChat: lines(stats.moderation.secondLayerChat) } },
    suggestions: {
      removeRules: s.removeRules?.map((r) => ({ ...r, examples: lines(r.examples) })) ?? null,
      directions: s.directions,
      failures: s.failures,
    },
  }
}

const NOT_A_MONDAY = '要看的一周从星期一算起，日期写成这一天，例如 2026-11-02。'
const EMPTY_RULE = '要停用的词或规则不能是空的。'

const WeeklyQuery = Type.Object({ weekStart: Type.Optional(Type.String({ pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' })) })
const ExclusionBody = Type.Object(
  {
    kind: Type.Union([Type.Literal('word'), Type.Literal('pattern')]),
    value: Type.String({ maxLength: 1000 }),
  },
  { additionalProperties: false },
)

export function weeklyRoutes(deps: AdminDeps): FastifyPluginAsync {
  const { db, config, clock } = deps

  return async (instance) => {
    const app = instance.withTypeProvider<TypeBoxTypeProvider>()
    app.setValidatorCompiler(TypeBoxValidatorCompiler)

    app.get('/weekly', { schema: { querystring: WeeklyQuery } }, async (request): Promise<WeeklyPage> => {
      const weekStart = request.query.weekStart ?? lastCompletedWeek(clock.now(), config.timezone)
      if (!isWeekStart(weekStart)) throw new ApiError(400, 'invalid_request', {}, NOT_A_MONDAY)
      const review = await db
        .selectFrom('weeklyReviews')
        .select(['stats', 'suggestions'])
        .where('weekStart', '=', weekStart)
        .executeTakeFirst()
      const exclusions = await db
        .selectFrom('moderationExclusions')
        .select(['kind', 'value', 'createdAt'])
        .orderBy('createdAt', 'desc')
        .orderBy('id', 'desc')
        .execute()
      const page =
        review === undefined
          ? { stats: await weeklyStats(db, config, weekStart), suggestions: null }
          : await shown(db, review.stats, review.suggestions)
      return {
        ...page,
        exclusions: exclusions.map((e) => ({ kind: e.kind, value: e.value, createdAt: e.createdAt.toISOString() })),
      }
    })

    app.get('/weekly/weeks', async () => {
      const rows = await db.selectFrom('weeklyReviews').select('weekStart').orderBy('weekStart', 'desc').execute()
      return { weeks: rows.map((r) => r.weekStart) }
    })

    app.post('/exclusions', { schema: { body: ExclusionBody } }, async (request) => {
      const { kind } = request.body
      const value = request.body.value.trim()
      if (value === '') throw new ApiError(400, 'invalid_request', {}, EMPTY_RULE)
      const { revoked, lifted } = await excludeRule({ db, config, clock }, kind, value)
      request.log.info({ kind, revoked, lifted: lifted.length }, 'rule excluded')
      return { revoked, lifted }
    })
  }
}
