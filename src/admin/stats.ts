import { TypeBoxValidatorCompiler, type TypeBoxTypeProvider } from '@fastify/type-provider-typebox'
import type { FastifyPluginAsync } from 'fastify'
import { sql, type Kysely } from 'kysely'
import { Type } from 'typebox'
import { monthSpend, schoolMonth } from '../llm/budget.js'
import type { LlmPurpose } from '../llm/client.js'
import type { ModerationCategory } from '../moderation/moderator.js'
import { LLM_PURPOSES, type Division, type SchoolConfig, type Slot } from '../shared/config.js'
import { addDaysToDate, atLocalTime, localDate, startOfLocalDay } from '../shared/local-time.js'
import type { Database } from '../shared/schema.js'
import { switchChanges, type SwitchName } from '../shared/switches.js'
import type { AdminDeps } from './app.js'
import { reviewQueue } from './lessons.js'

// The school-data page: yesterday's numbers next to the same day a week before, the reminders, and the daily curves.
// Every number is of a calendar day in the school's time zone, counted in the database: one grouped query per table
// over the whole span, whatever its length.
//
// - Students in class (DAU): the different students in `attendance` of the sessions held that day, also by slot.
// - Chat messages: every row of `messages`, of every kind. Blocked: not delivered and stopped by a check; the second
//   layer's count in the total but in none of the three categories.
// - Violations, suspensions and expulsions: the school-rule records and the penalties made that day, less the ones
//   revoked since: a revoked record was a false hit, so it is not counted, the school-rule records included.
// - New registrations: the registrations verified that day.
// - Model spend: the cost of the calls made that day, in yuan.

const SLOTS: readonly Slot[] = ['morning', 'afternoon', 'evening']
const CATEGORIES: readonly ModerationCategory[] = ['sensitive', 'injection', 'privacy']

export interface DayNumbers {
  date: string
  dau: number
  dauBySlot: Record<Slot, number>
  chat: number
  blocked: number
  blockedByCategory: Record<ModerationCategory, number>
  violations: number
  suspensions: number
  expulsions: number
  registrations: number
  /** Rounded to fen. */
  costYuan: number
}

export interface SeriesDay {
  date: string
  dauBySlot: Record<Slot, number>
  chat: number
  blockedByCategory: Record<ModerationCategory, number>
  /** Rounded to 4 decimal places, so the small purposes do not vanish from the curve. */
  costByPurpose: Record<LlmPurpose, number>
}

export interface DailyStats {
  yesterday: DayNumbers
  /** Null when that day comes before the school's opening day; every other day has its numbers, zeros included. */
  sameDayLastWeek: DayNumbers | null
  month: { costYuan: number; budgetYuan: number; overBudget: boolean }
  reminders: {
    /**
     * Lessons not approved whose day is still open: no class of the division has begun it and its doors have not
     * opened. `deadline` is when they open, and the day becomes a study hall if the lesson is still not approved.
     */
    unreviewed: { date: string; division: Division; deadline: string }[]
    /** Lessons of the queue that could not be made, from the day after the first failure (it is retried before). */
    generationFailed: { date: string; division: Division; attempts: number; lastError: string }[]
  }
  /** The `days` days up to yesterday, oldest first. */
  series: SeriesDay[]
  /** The switches changed over the days of `series`. */
  switchChanges: { name: SwitchName; on: boolean; at: string }[]
  /** The school's time zone (IANA): the clock the deadlines and the switch changes are read on. */
  timeZone: string
}

/** What one day holds before rounding. */
interface Tally {
  dau: number
  dauBySlot: Record<Slot, number>
  chat: number
  blocked: number
  blockedByCategory: Record<ModerationCategory, number>
  violations: number
  suspensions: number
  expulsions: number
  registrations: number
  costByPurpose: Record<string, number>
}

const emptyTally = (): Tally => ({
  dau: 0,
  dauBySlot: { morning: 0, afternoon: 0, evening: 0 },
  chat: 0,
  blocked: 0,
  blockedByCategory: { sensitive: 0, injection: 0, privacy: 0 },
  violations: 0,
  suspensions: 0,
  expulsions: 0,
  registrations: 0,
  costByPurpose: {},
})

const round = (n: number, places: number): number => {
  const factor = 10 ** places
  return Math.round(n * factor) / factor
}

/** Every day from `from` to `to` (both included), each with its numbers, zeros where nothing happened. */
async function tallies(db: Kysely<Database>, timeZone: string, from: string, to: string): Promise<Map<string, Tally>> {
  const days = new Map<string, Tally>()
  for (let day = from; day <= to; day = addDaysToDate(day, 1)) days.set(day, emptyTally())
  const dayOf = (date: string): Tally | undefined => days.get(date)

  const fromAt = atLocalTime(from, '00:00', timeZone)
  const toAt = atLocalTime(addDaysToDate(to, 1), '00:00', timeZone)
  // The school-time day of an instant. Queries group by it as their first column (`group by 1`): the time zone is a
  // parameter, and the same expression written twice would be two parameters Postgres cannot tell are equal.
  const localDay = (column: 'createdAt' | 'verifiedAt') =>
    sql<string>`to_char(${sql.ref(column)} at time zone ${timeZone}, 'YYYY-MM-DD')`
  const count = () => sql<string>`count(*)`

  const bySlot = await db
    .selectFrom('attendance as a')
    .innerJoin('classSessions as s', 's.id', 'a.sessionId')
    .select(['s.date', 's.slot', sql<string>`count(distinct a.student_id)`.as('students')])
    .where('s.date', '>=', from)
    .where('s.date', '<=', to)
    .groupBy(['s.date', 's.slot'])
    .execute()
  for (const r of bySlot) {
    const day = dayOf(r.date)
    if (day !== undefined) day.dauBySlot[r.slot] = Number(r.students)
  }
  const byDay = await db
    .selectFrom('attendance as a')
    .innerJoin('classSessions as s', 's.id', 'a.sessionId')
    .select(['s.date', sql<string>`count(distinct a.student_id)`.as('students')])
    .where('s.date', '>=', from)
    .where('s.date', '<=', to)
    .groupBy('s.date')
    .execute()
  for (const r of byDay) {
    const day = dayOf(r.date)
    if (day !== undefined) day.dau = Number(r.students)
  }

  const messages = await db
    .selectFrom('messages')
    .select([
      localDay('createdAt').as('day'),
      count().as('chat'),
      sql<string>`count(*) filter (where not delivered and moderation is not null)`.as('blocked'),
      sql<string>`count(*) filter (where not delivered and moderation = 'sensitive')`.as('sensitive'),
      sql<string>`count(*) filter (where not delivered and moderation = 'injection')`.as('injection'),
      sql<string>`count(*) filter (where not delivered and moderation = 'privacy')`.as('privacy'),
    ])
    .where('createdAt', '>=', fromAt)
    .where('createdAt', '<', toAt)
    .groupBy(sql`1`)
    .execute()
  for (const r of messages) {
    const day = dayOf(r.day)
    if (day === undefined) continue
    day.chat = Number(r.chat)
    day.blocked = Number(r.blocked)
    for (const category of CATEGORIES) day.blockedByCategory[category] = Number(r[category])
  }

  // Revoked records are left out of all three counts (see the definitions at the top).
  const records = await db
    .selectFrom('disciplineRecords')
    .select([localDay('createdAt').as('day'), 'kind', count().as('records')])
    .where('kind', 'in', ['school_rule', 'suspension', 'expulsion'])
    .where('revokedAt', 'is', null)
    .where('createdAt', '>=', fromAt)
    .where('createdAt', '<', toAt)
    .groupBy([sql`1`, 'kind'])
    .execute()
  for (const r of records) {
    const day = dayOf(r.day)
    if (day === undefined) continue
    if (r.kind === 'school_rule') day.violations = Number(r.records)
    else if (r.kind === 'suspension') day.suspensions = Number(r.records)
    else if (r.kind === 'expulsion') day.expulsions = Number(r.records)
  }

  const registrations = await db
    .selectFrom('registrations')
    .select([localDay('verifiedAt').as('day'), count().as('verified')])
    .where('verifiedAt', '>=', fromAt)
    .where('verifiedAt', '<', toAt)
    .groupBy(sql`1`)
    .execute()
  for (const r of registrations) {
    const day = dayOf(r.day)
    if (day !== undefined) day.registrations = Number(r.verified)
  }

  const costs = await db
    .selectFrom('llmCalls')
    .select([localDay('createdAt').as('day'), 'purpose', sql<string>`sum(cost_yuan)`.as('cost')])
    .where('createdAt', '>=', fromAt)
    .where('createdAt', '<', toAt)
    .groupBy([sql`1`, 'purpose'])
    .execute()
  for (const r of costs) {
    const day = dayOf(r.day)
    if (day !== undefined) day.costByPurpose[r.purpose] = Number(r.cost)
  }

  return days
}

function dayNumbers(date: string, tally: Tally): DayNumbers {
  const { costByPurpose, ...counts } = tally
  const cost = Object.values(costByPurpose).reduce((sum, c) => sum + c, 0)
  return { date, ...counts, costYuan: round(cost, 2) }
}

function seriesDay(date: string, tally: Tally): SeriesDay {
  const costByPurpose = Object.fromEntries(
    LLM_PURPOSES.map((purpose) => [purpose, round(tally.costByPurpose[purpose] ?? 0, 4)]),
  ) as Record<LlmPurpose, number>
  const { dauBySlot, chat, blockedByCategory } = tally
  return { date, dauBySlot, chat, blockedByCategory, costByPurpose }
}

/**
 * When the doors of a division's first class of a day open: of the first slot `slots` (the slots the division has
 * classes in), or of the school's first slot when it has none. A lesson not approved by then is not taught that day:
 * the first class of a division decides for the day, and it holds a study hall instead.
 */
function doorsOf(date: string, slots: readonly Slot[], config: SchoolConfig): Date {
  const first = (slots.length > 0 ? slots : SLOTS).map((slot) => config.slots[slot].start).reduce((a, b) => (a < b ? a : b))
  const start = atLocalTime(date, first, config.timezone)
  return new Date(start.getTime() - config.lesson.doorsOpenMinutesBefore * 60_000)
}

/** The school-data page for the last `days` days up to yesterday. */
export async function dailyStats(deps: Pick<AdminDeps, 'db' | 'config' | 'clock'>, days: number): Promise<DailyStats> {
  const { db, config, clock } = deps
  const tz = config.timezone
  const now = clock.now()
  const today = localDate(now, tz)
  const yesterday = addDaysToDate(today, -1)
  const lastWeek = addDaysToDate(yesterday, -7)
  const first = addDaysToDate(yesterday, -(days - 1))
  const all = await tallies(db, tz, lastWeek < first ? lastWeek : first, yesterday)
  const tallyOf = (date: string): Tally => all.get(date) ?? emptyTally()

  const openingDay = config.calendar?.openingDay
  const spend = await monthSpend(db, schoolMonth(now, tz), tz)
  const budget = config.llm.monthlyBudgetYuan

  const queue = await reviewQueue(deps)
  const slots = queue.flatMap((day) => day.divisions.map((slot) => ({ date: day.date, ...slot })))
  const classSlots = await db.selectFrom('classes').select(['division', 'slot']).distinct().execute()
  const unreviewed = slots.flatMap((s) => {
    const meets = classSlots.filter((c) => c.division === s.division).map((c) => c.slot)
    const deadline = doorsOf(s.date, meets, config)
    if (s.status === 'approved' || s.locked || deadline.getTime() <= now.getTime()) return []
    return [{ date: s.date, division: s.division, deadline: deadline.toISOString() }]
  })
  // A failure is retried every `retryMinutes`; it is worth a reminder once it has lasted into a new day.
  const lasting =
    queue.length === 0
      ? []
      : await db
          .selectFrom('lessonGeneration')
          .select(['date', 'division'])
          .where('date', 'in', queue.map((day) => day.date))
          .where('firstFailedAt', '<', startOfLocalDay(now, tz))
          .execute()
  const generationFailed = slots.flatMap((s) =>
    s.generationFailed === null || !lasting.some((f) => f.date === s.date && f.division === s.division)
      ? []
      : [{ date: s.date, division: s.division, ...s.generationFailed }],
  )

  const series: SeriesDay[] = []
  for (let day = first; day <= yesterday; day = addDaysToDate(day, 1)) series.push(seriesDay(day, tallyOf(day)))

  const changes = await switchChanges(db, atLocalTime(first, '00:00', tz), atLocalTime(today, '00:00', tz))

  return {
    yesterday: dayNumbers(yesterday, tallyOf(yesterday)),
    sameDayLastWeek: openingDay !== undefined && lastWeek < openingDay ? null : dayNumbers(lastWeek, tallyOf(lastWeek)),
    month: { costYuan: round(spend, 2), budgetYuan: budget, overBudget: spend > budget },
    reminders: { unreviewed, generationFailed },
    series,
    switchChanges: changes.map((c) => ({ name: c.name, on: c.on, at: c.at.toISOString() })),
    timeZone: tz,
  }
}

const DailyQuery = Type.Object({ days: Type.Union([Type.Literal('7'), Type.Literal('30'), Type.Literal('90')]) })

export function statsRoutes(deps: AdminDeps): FastifyPluginAsync {
  return async (instance) => {
    const app = instance.withTypeProvider<TypeBoxTypeProvider>()
    app.setValidatorCompiler(TypeBoxValidatorCompiler)

    app.get('/stats/daily', { schema: { querystring: DailyQuery } }, async (request) =>
      dailyStats(deps, Number(request.query.days)),
    )
  }
}
