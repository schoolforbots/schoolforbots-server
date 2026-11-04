import { TypeBoxValidatorCompiler, type TypeBoxTypeProvider } from '@fastify/type-provider-typebox'
import type { FastifyPluginAsync } from 'fastify'
import type { Kysely } from 'kysely'
import { Type } from 'typebox'
import { excludeRule } from '../discipline/revoke.js'
import { ApiError } from '../registration/errors.js'
import type { Database } from '../shared/schema.js'
import type { StoredSuggestions, WeeklySuggestions } from '../weekly/review.js'
import { isWeekStart, lastCompletedWeek, weeklyStats, type WeeklyStats } from '../weekly/stats.js'
import type { AdminDeps } from './app.js'

// The weekly review page: a week's numbers and the model's suggestions, the rules dropped so far, and dropping one.
// The log names the kind of a dropped rule and what dropping it took back, never the rule.

/** A suggested rule as the page shows it: its examples are the lines themselves (a line purged since is left out). */
export interface ShownRule extends Omit<WeeklySuggestions['removeRules'][number], 'examples'> {
  examples: { messageId: number; text: string; at: string }[]
}

export interface WeeklyPage {
  stats: WeeklyStats
  /** Null when the week has no review yet: its numbers are then counted as they stand. */
  suggestions: { removeRules: ShownRule[] | null; directions: string[] | null } | null
  /** Every rule dropped, the latest first. */
  exclusions: { kind: 'word' | 'pattern'; value: string; createdAt: string }[]
}

/** The stored suggestions with the lines of their examples. */
async function shown(db: Kysely<Database>, s: StoredSuggestions): Promise<NonNullable<WeeklyPage['suggestions']>> {
  if (s.removeRules === null) return { removeRules: null, directions: s.directions }
  const ids = [...new Set(s.removeRules.flatMap((r) => r.examples))]
  const lines =
    ids.length === 0
      ? []
      : await db.selectFrom('messages').select(['id', 'text', 'createdAt']).where('id', 'in', ids).execute()
  const byId = new Map(lines.map((l) => [l.id, { messageId: l.id, text: l.text, at: l.createdAt.toISOString() }]))
  return {
    removeRules: s.removeRules.map((r) => ({ ...r, examples: r.examples.flatMap((id) => byId.get(id) ?? []) })),
    directions: s.directions,
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
      return {
        stats: review?.stats ?? (await weeklyStats(db, config, weekStart)),
        suggestions: review === undefined ? null : await shown(db, review.suggestions),
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
