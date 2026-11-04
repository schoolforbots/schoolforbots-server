import { sql, type Kysely } from 'kysely'
import { callOnThanks } from '../class/teacher.js'
import { PRIVACY_FLAG_RULE } from '../lessons/store.js'
import type { LlmPurpose } from '../llm/client.js'
import { inactivityCutoffDay, isLessonDay } from '../shared/calendar.js'
import { LLM_PURPOSES, type Division, type SchoolConfig } from '../shared/config.js'
import { addDaysToDate, atLocalTime, isDateText, isoWeekday, localDate } from '../shared/local-time.js'
import type { Database } from '../shared/schema.js'

// The numbers of the weekly review, all counted by code, over one week from Monday to Sunday in the school's time
// zone. Each is counted in the database, a grouped query or two per table. A session belongs to the week of its date;
// anything else (a message, a model call, a record) to the week its time falls in.
//
// - callOn: the `called_on` events of the week's sessions, and of them those with an answer; by the class's division
//   and by the plugin of the student called on (as the student has it now). The rate is answered / called.
// - questions: `total` is the questions the teacher took (kind `question`, not blocked). A segment is an answering
//   point the lesson reached (its `qa-{k}` step ran); it is `withAnswer` when the teacher answered an on-topic question
//   there (`qa-{k}#2`), else `without`.
// - reconnects: the connections to a session past the first (`attendance.connections - 1`), summed by the plugin of
//   the student (as the student has it now), most first.
// - lessons: `studyHallsForUnreviewed` is the days and divisions that held a study hall on a lesson day (Monday to
//   Friday, not on a break), when that division would have had a lesson: one per day and division, however many
//   classes the division has. The rest are the lesson versions made that week by change.
// - teacher: `llmFailures` the failed calls of the teacher's answers and comments; `refusals` every call the vendor
//   refused for its content, whatever its purpose; `fallbacks` the comments that were the template thanks (the model's
//   comment did not come, did not pass or was switched off); `blockedLines` the teacher's lines a check stopped.
// - moderation: the blocked lines by day and category; the rules of the word list and the phrase rules that blocked
//   the most; the rules marked as flagged wrongly in the review of the week's lessons (not the privacy mark, which no
//   rule stands behind); the chat lines the second layer stopped, the first `SECOND_LAYER_CHAT_SHOWN` of them (a
//   stored review keeps them by id only, see `StoredStats`).
// - students: `newcomers` are the students first put in a class that week: seated that week, and never back in the
//   queue since they registered (a student who re-enrolls joins it again). `cameBackForSecond` is those of them who
//   attended two sessions or more by the end of the week. `suspended` and `expelled` count the students given such a
//   penalty that week, less the ones revoked since. `dropped` is an estimate, as no record of a drop is kept: the
//   students now dropped, with no suspension date, whose last sign of life (last attendance, else being seated) fell
//   where the nightly jobs of the week would drop it for staying away, after the job of the day before the week.
//   A student who re-enrolled since is missed; one who left of their own accord at that time is counted.
// - cost: the spend of the week by purpose, and its total over the different students who attended a session.

/** How many of the chat lines the second layer stopped are listed. */
const SECOND_LAYER_CHAT_SHOWN = 200
/** How many of the rules that blocked the most are listed. */
const TOP_RULES = 20

const DIVISIONS: readonly Division[] = ['primary', 'junior', 'senior']

/** The kind of rule behind each category a rule can block for. */
export const RULE_KIND = { sensitive: 'word', injection: 'pattern' } as const

export interface WeeklyStats {
  weekStart: string
  callOn: {
    rate: number
    byDivision: Record<Division, { called: number; answered: number }>
    byPlugin: { type: string; version: string; called: number; answered: number }[]
  }
  questions: { total: number; segmentsWithAnswer: number; segmentsWithout: number }
  reconnects: { type: string; version: string; count: number }[]
  lessons: { studyHallsForUnreviewed: number; edits: number; segmentRewrites: number; lessonRewrites: number }
  teacher: { llmFailures: number; fallbacks: number; blockedLines: number; refusals: number }
  moderation: {
    byDay: { date: string; sensitive: number; injection: number; privacy: number; secondLayer: number }[]
    topRules: { rule: string; kind: 'word' | 'pattern'; count: number }[]
    falsePositiveMarks: string[]
    secondLayerChat: { messageId: number; text: string; at: string }[]
  }
  students: { newcomers: number; cameBackForSecond: number; dropped: number; suspended: number; expelled: number }
  cost: { byPurpose: Record<LlmPurpose, number>; perAttendee: number }
}

/**
 * The numbers as a review stores them. The lines the second layer stopped are kept by id only: a review is kept for
 * good, a line only as long as the messages are, so a line purged since is no longer shown with the review.
 */
export type StoredStats = Omit<WeeklyStats, 'moderation'> & {
  moderation: Omit<WeeklyStats['moderation'], 'secondLayerChat'> & { secondLayerChat: number[] }
}

export function storedStats(stats: WeeklyStats): StoredStats {
  const { moderation } = stats
  const secondLayerChat = moderation.secondLayerChat.map((l) => l.messageId)
  return { ...stats, moderation: { ...moderation, secondLayerChat } }
}

/** The Monday of the last week that has ended by `now`, in the school's time zone. */
export function lastCompletedWeek(now: Date, timeZone: string): string {
  const today = localDate(now, timeZone)
  return addDaysToDate(today, -(isoWeekday(today) - 1) - 7)
}

/** Whether `date` is a real `YYYY-MM-DD` date that is a Monday. */
export function isWeekStart(date: string): boolean {
  return isDateText(date) && isoWeekday(date) === 1
}

interface Week {
  /** The Monday and the Sunday, as dates. */
  start: string
  end: string
  /** From the start of the Monday to the start of the next Monday, in the school's time zone. */
  from: Date
  to: Date
}

const round = (n: number, places: number): number => {
  const factor = 10 ** places
  return Math.round(n * factor) / factor
}

/** Code-point order, the same whatever the database's collation. */
const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

const count = () => sql<string>`count(*)`

async function callOnStats(db: Kysely<Database>, w: Week): Promise<WeeklyStats['callOn']> {
  const rows = await db
    .selectFrom('classEvents as e')
    .innerJoin('classSessions as s', 's.id', 'e.sessionId')
    .innerJoin('classes as c', 'c.id', 's.classId')
    .innerJoin('students as st', (join) => join.on(sql<boolean>`st.id = (e.payload->>'studentId')::int`))
    // The answer to call-on n is the step `answer-n` of the same session.
    .leftJoin('classEvents as a', (join) =>
      join
        .onRef('a.sessionId', '=', 'e.sessionId')
        .on(sql<boolean>`a.step = 'answer-' || substring(e.step from '^call-on-([0-9]+)#2$')`),
    )
    .select(['c.division', 'st.pluginType', 'st.pluginVersion', count().as('called')])
    .select(sql<string>`count(a.id)`.as('answered'))
    .where('s.date', '>=', w.start)
    .where('s.date', '<=', w.end)
    .where(sql<boolean>`e.step ~ '^call-on-[0-9]+#2$'`)
    .groupBy(['c.division', 'st.pluginType', 'st.pluginVersion'])
    .execute()

  const byDivision = Object.fromEntries(DIVISIONS.map((d) => [d, { called: 0, answered: 0 }])) as Record<
    Division,
    { called: number; answered: number }
  >
  const plugins = new Map<string, { type: string; version: string; called: number; answered: number }>()
  let called = 0
  let answered = 0
  for (const r of rows) {
    const [c, a] = [Number(r.called), Number(r.answered)]
    called += c
    answered += a
    byDivision[r.division].called += c
    byDivision[r.division].answered += a
    const key = JSON.stringify([r.pluginType, r.pluginVersion])
    const plugin = plugins.get(key) ?? { type: r.pluginType, version: r.pluginVersion, called: 0, answered: 0 }
    plugin.called += c
    plugin.answered += a
    plugins.set(key, plugin)
  }
  const byPlugin = [...plugins.values()].sort((x, y) => byText(x.type, y.type) || byText(x.version, y.version))
  return { rate: called === 0 ? 0 : round(answered / called, 4), byDivision, byPlugin }
}

async function questionStats(db: Kysely<Database>, w: Week): Promise<WeeklyStats['questions']> {
  const taken = await db
    .selectFrom('messages')
    .select(count().as('total'))
    .where('kind', '=', 'question')
    .where('moderation', 'is', null)
    .where('createdAt', '>=', w.from)
    .where('createdAt', '<', w.to)
    .executeTakeFirstOrThrow()
  const points = await db
    .selectFrom('classEvents as e')
    .innerJoin('classSessions as s', 's.id', 'e.sessionId')
    .select([
      sql<string>`count(*) filter (where e.step ~ '^qa-[0-9]+$')`.as('segments'),
      sql<string>`count(*) filter (where e.step ~ '^qa-[0-9]+#2$')`.as('answered'),
    ])
    .where('s.date', '>=', w.start)
    .where('s.date', '<=', w.end)
    .where('e.step', 'like', 'qa-%')
    .executeTakeFirstOrThrow()
  const [segments, withAnswer] = [Number(points.segments), Number(points.answered)]
  return {
    total: Number(taken.total),
    segmentsWithAnswer: withAnswer,
    segmentsWithout: Math.max(segments - withAnswer, 0),
  }
}

async function reconnectStats(db: Kysely<Database>, w: Week): Promise<WeeklyStats['reconnects']> {
  const rows = await db
    .selectFrom('attendance as a')
    .innerJoin('classSessions as s', 's.id', 'a.sessionId')
    .innerJoin('students as st', 'st.id', 'a.studentId')
    .select(['st.pluginType', 'st.pluginVersion', sql<string>`sum(a.connections - 1)`.as('reconnects')])
    .where('s.date', '>=', w.start)
    .where('s.date', '<=', w.end)
    .groupBy(['st.pluginType', 'st.pluginVersion'])
    .execute()
  return rows
    .map((r) => ({ type: r.pluginType, version: r.pluginVersion, count: Number(r.reconnects) }))
    .sort((x, y) => y.count - x.count || byText(x.type, y.type) || byText(x.version, y.version))
}

async function lessonStats(db: Kysely<Database>, config: SchoolConfig, w: Week): Promise<WeeklyStats['lessons']> {
  const halls = await db
    .selectFrom('classSessions as s')
    .innerJoin('classes as c', 'c.id', 's.classId')
    .select(['s.date', 'c.division'])
    .distinct()
    .where('s.kind', '=', 'study')
    .where('s.date', '>=', w.start)
    .where('s.date', '<=', w.end)
    .execute()
  const versions = await db
    .selectFrom('lessonVersions')
    .select(['change', count().as('versions')])
    .where('change', 'in', ['edit', 'rewrite_segment', 'rewrite_lesson'])
    .where('createdAt', '>=', w.from)
    .where('createdAt', '<', w.to)
    .groupBy('change')
    .execute()
  const made = (change: string) => Number(versions.find((v) => v.change === change)?.versions ?? 0)
  return {
    studyHallsForUnreviewed: halls.filter((h) => isLessonDay(h.date, config)).length,
    edits: made('edit'),
    segmentRewrites: made('rewrite_segment'),
    lessonRewrites: made('rewrite_lesson'),
  }
}

async function teacherStats(db: Kysely<Database>, w: Week): Promise<WeeklyStats['teacher']> {
  const calls = await db
    .selectFrom('llmCalls')
    .select([
      sql<string>`count(*) filter (where outcome = 'failed' and purpose in ('answer', 'comment'))`.as('failures'),
      sql<string>`count(*) filter (where outcome = 'refused')`.as('refusals'),
    ])
    .where('createdAt', '>=', w.from)
    .where('createdAt', '<', w.to)
    .executeTakeFirstOrThrow()
  const fallbacks = await db
    .selectFrom('classEvents as e')
    .innerJoin('classSessions as s', 's.id', 'e.sessionId')
    .select(count().as('comments'))
    .where('s.date', '>=', w.start)
    .where('s.date', '<=', w.end)
    .where(sql<boolean>`e.step ~ '^comment-[0-9]+$'`)
    .where(sql<string>`e.payload->>'text'`, '=', callOnThanks())
    .executeTakeFirstOrThrow()
  const blocked = await db
    .selectFrom('teacherLineBlocks')
    .select(count().as('lines'))
    .where('createdAt', '>=', w.from)
    .where('createdAt', '<', w.to)
    .executeTakeFirstOrThrow()
  return {
    llmFailures: Number(calls.failures),
    fallbacks: Number(fallbacks.comments),
    blockedLines: Number(blocked.lines),
    refusals: Number(calls.refusals),
  }
}

async function moderationStats(db: Kysely<Database>, tz: string, w: Week): Promise<WeeklyStats['moderation']> {
  // Grouped by its ordinal: the time zone is a parameter (see the school-data stats).
  const days = await db
    .selectFrom('messages')
    .select([
      sql<string>`to_char(created_at at time zone ${tz}, 'YYYY-MM-DD')`.as('day'),
      sql<string>`count(*) filter (where moderation = 'sensitive')`.as('sensitive'),
      sql<string>`count(*) filter (where moderation = 'injection')`.as('injection'),
      sql<string>`count(*) filter (where moderation = 'privacy')`.as('privacy'),
      sql<string>`count(*) filter (where moderation = 'second_layer')`.as('layered'),
    ])
    .where('delivered', '=', false)
    .where('moderation', 'is not', null)
    .where('createdAt', '>=', w.from)
    .where('createdAt', '<', w.to)
    .groupBy(sql`1`)
    .execute()
  const byDay: WeeklyStats['moderation']['byDay'] = []
  for (let date = w.start; date <= w.end; date = addDaysToDate(date, 1)) {
    const r = days.find((d) => d.day === date)
    byDay.push({
      date,
      sensitive: Number(r?.sensitive ?? 0),
      injection: Number(r?.injection ?? 0),
      privacy: Number(r?.privacy ?? 0),
      secondLayer: Number(r?.layered ?? 0),
    })
  }

  const rules = await db
    .selectFrom('messages')
    .select(['moderation', 'matchedTerm', count().as('hits')])
    .where('delivered', '=', false)
    .where('moderation', 'in', ['sensitive', 'injection'])
    .where('matchedTerm', 'is not', null)
    .where('createdAt', '>=', w.from)
    .where('createdAt', '<', w.to)
    .groupBy(['moderation', 'matchedTerm'])
    .orderBy(sql`count(*)`, 'desc')
    .orderBy(sql`matched_term collate "C"`)
    .orderBy('moderation')
    .limit(TOP_RULES)
    .$narrowType<{ moderation: 'sensitive' | 'injection'; matchedTerm: string }>()
    .execute()

  const marks = await db
    .selectFrom('lessons')
    .select(sql<string>`jsonb_array_elements_text(false_positives)`.as('rule'))
    .distinct()
    .where('date', '>=', w.start)
    .where('date', '<=', w.end)
    .execute()

  const secondLayer = await db
    .selectFrom('messages')
    .select(['id', 'text', 'createdAt'])
    .where('kind', '=', 'chat')
    .where('moderation', '=', 'second_layer')
    .where('createdAt', '>=', w.from)
    .where('createdAt', '<', w.to)
    .orderBy('createdAt')
    .orderBy('id')
    .limit(SECOND_LAYER_CHAT_SHOWN)
    .execute()

  return {
    byDay,
    topRules: rules.map((r) => ({ rule: r.matchedTerm, kind: RULE_KIND[r.moderation], count: Number(r.hits) })),
    falsePositiveMarks: marks.map((m) => m.rule).filter((rule) => rule !== PRIVACY_FLAG_RULE).sort(byText),
    secondLayerChat: secondLayer.map((m) => ({ messageId: m.id, text: m.text, at: m.createdAt.toISOString() })),
  }
}

async function studentStats(db: Kysely<Database>, config: SchoolConfig, w: Week): Promise<WeeklyStats['students']> {
  const newcomers = await db
    .selectFrom('students as st')
    .select([
      count().as('seated'),
      sql<string>`count(*) filter (where (
        select count(*) from attendance a join class_sessions s on s.id = a.session_id
        where a.student_id = st.id and s.date <= ${w.end}
      ) >= 2)`.as('second'),
    ])
    .where('st.assignedAt', '>=', w.from)
    .where('st.assignedAt', '<', w.to)
    .whereRef('st.queuedAt', '=', 'st.createdAt')
    .executeTakeFirstOrThrow()

  // The nightly job of a day drops the students last seen before its cutoff (see the daily job): those the week's
  // jobs dropped were last seen before the cutoff of Sunday's job, and not before that of the job the day before.
  const cutoff = (day: string): Date | null => {
    const cut = inactivityCutoffDay(day, config.inactivityDropDays, config)
    return cut === null ? null : atLocalTime(cut, '00:00', config.timezone)
  }
  const upper = cutoff(w.end)
  const lower = cutoff(addDaysToDate(w.start, -1))
  let dropped = 0
  if (upper !== null) {
    const lastSeen = sql<Date>`coalesce(last_attended_at, assigned_at)`
    const row = await db
      .selectFrom('students')
      .select(count().as('students'))
      .where('status', '=', 'dropped')
      .where('suspendedUntil', 'is', null)
      .where(lastSeen, '<', upper)
      .$if(lower !== null, (q) => q.where(lastSeen, '>=', lower!))
      .executeTakeFirstOrThrow()
    dropped = Number(row.students)
  }

  const penalties = await db
    .selectFrom('disciplineRecords')
    .select(['kind', sql<string>`count(distinct student_id)`.as('students')])
    .where('kind', 'in', ['suspension', 'expulsion'])
    .where('revokedAt', 'is', null)
    .where('createdAt', '>=', w.from)
    .where('createdAt', '<', w.to)
    .groupBy('kind')
    .execute()
  const penalised = (kind: string) => Number(penalties.find((p) => p.kind === kind)?.students ?? 0)

  return {
    newcomers: Number(newcomers.seated),
    cameBackForSecond: Number(newcomers.second),
    dropped,
    suspended: penalised('suspension'),
    expelled: penalised('expulsion'),
  }
}

async function costStats(db: Kysely<Database>, w: Week): Promise<WeeklyStats['cost']> {
  const costs = await db
    .selectFrom('llmCalls')
    .select(['purpose', sql<string>`sum(cost_yuan)`.as('cost')])
    .where('createdAt', '>=', w.from)
    .where('createdAt', '<', w.to)
    .groupBy('purpose')
    .execute()
  const attendees = await db
    .selectFrom('attendance as a')
    .innerJoin('classSessions as s', 's.id', 'a.sessionId')
    .select(sql<string>`count(distinct a.student_id)`.as('students'))
    .where('s.date', '>=', w.start)
    .where('s.date', '<=', w.end)
    .executeTakeFirstOrThrow()
  const total = costs.reduce((sum, c) => sum + Number(c.cost), 0)
  const students = Number(attendees.students)
  // Rounded to 4 decimal places, so the small purposes do not vanish.
  const byPurpose = Object.fromEntries(
    LLM_PURPOSES.map((purpose) => [purpose, round(Number(costs.find((c) => c.purpose === purpose)?.cost ?? 0), 4)]),
  ) as Record<LlmPurpose, number>
  return { byPurpose, perAttendee: students === 0 ? 0 : round(total / students, 4) }
}

/** The numbers of the week that starts on the Monday `weekStart`. */
export async function weeklyStats(db: Kysely<Database>, config: SchoolConfig, weekStart: string): Promise<WeeklyStats> {
  if (!isWeekStart(weekStart)) throw new Error(`A week starts on a Monday, not on ${weekStart}`)
  const tz = config.timezone
  const w: Week = {
    start: weekStart,
    end: addDaysToDate(weekStart, 6),
    from: atLocalTime(weekStart, '00:00', tz),
    to: atLocalTime(addDaysToDate(weekStart, 7), '00:00', tz),
  }
  return {
    weekStart,
    callOn: await callOnStats(db, w),
    questions: await questionStats(db, w),
    reconnects: await reconnectStats(db, w),
    lessons: await lessonStats(db, config, w),
    teacher: await teacherStats(db, w),
    moderation: await moderationStats(db, tz, w),
    students: await studentStats(db, config, w),
    cost: await costStats(db, w),
  }
}
