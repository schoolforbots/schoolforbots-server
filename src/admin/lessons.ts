import { TypeBoxValidatorCompiler, type TypeBoxTypeProvider } from '@fastify/type-provider-typebox'
import type { FastifyBaseLogger, FastifyPluginAsync } from 'fastify'
import { sql, type Kysely } from 'kysely'
import { Type } from 'typebox'
import { LessonFormatError } from '../lessons/format.js'
import { acceptPasted, regenerate, setTopic, TopicRefused, type GeneratorDeps } from '../lessons/generator.js'
import { buildLessonPrompt, lessonById, NotALessonDay } from '../lessons/prompts.js'
import {
  approve,
  confirmCallOn,
  contentOf,
  dayDecided,
  editPart,
  LessonHasFlags,
  LessonLocked,
  LessonNotFound,
  markFalsePositive,
  restoreVersion,
  StaleLessonVersion,
} from '../lessons/store.js'
import type { Llm } from '../llm/client.js'
import { LlmContentRefused, LlmTruncated, LlmUnavailable } from '../llm/provider.js'
import { ApiError } from '../registration/errors.js'
import { isLessonDay } from '../shared/calendar.js'
import type { Division, SchoolConfig } from '../shared/config.js'
import { addDaysToDate, isDateText, localDate } from '../shared/local-time.js'
import type { Database } from '../shared/schema.js'
import type { AdminDeps } from './app.js'

// The lesson review: the lessons of the days ahead and where each stands, one lesson with its versions, the changes a
// reviewer makes to it, the prompts to copy out and the replies pasted back in, and the topics given for single days.
// The lesson modules keep the rules; here their refusals become answers the page can show as they are, in Chinese.
// The log names lessons and actions only: never a lesson's text, a prompt, a reason or what was pasted.

const DIVISIONS: readonly Division[] = ['primary', 'junior', 'senior']

/** The largest value of an `integer` column: a larger id or version could not name a row. */
const MAX_INT = 2_147_483_647

/** A topic is said in a sentence; it goes into the prompt and the teacher's opening. */
const MAX_TOPIC_CHARS = 60
const MAX_REASON_CHARS = 1000
/** A whole lesson and the words a tool puts around it fit many times over. */
const MAX_PASTED_CHARS = 100_000

export type QueueStatus = 'approved' | 'flagged' | 'pending' | 'missing'

/** Where the lesson of one day and division stands. */
export interface QueueSlot {
  division: Division
  label: string
  /** `missing`: no lesson yet, to be made by the model or, in `manual` mode, pasted in. */
  status: QueueStatus
  /** The red marks the lesson has (0 without a lesson). */
  flags: number
  lessonId: number | null
  version: number | null
  /** The topic given for the day, which the lesson is made about. */
  topic: string | null
  /** The last failure to make the lesson, while it has not been made. */
  generationFailed: { attempts: number; lastError: string } | null
  /**
   * A class of the division has begun the day, with this lesson or a study hall: the first class decides for the
   * day, so the lesson can no longer be taught, or changed, for it.
   */
  locked: boolean
}

export interface QueueDay {
  date: string
  divisions: QueueSlot[]
}

/** The lesson days from today to `lessonGeneration.horizonDays` days after it, both included, in order. */
function queueDates(config: SchoolConfig, today: string): string[] {
  const dates: string[] = []
  for (let ahead = 0; ahead <= config.lessonGeneration.horizonDays; ahead++) {
    const date = addDaysToDate(today, ahead)
    if (isLessonDay(date, config)) dates.push(date)
  }
  return dates
}

/** Every lesson day from today to the horizon, oldest first, each with its three divisions. */
export async function reviewQueue(deps: Pick<AdminDeps, 'db' | 'config' | 'clock'>): Promise<QueueDay[]> {
  const { db, config, clock } = deps
  const dates = queueDates(config, localDate(clock.now(), config.timezone))
  if (dates.length === 0) return []

  const lessons = await db
    .selectFrom('lessons as l')
    .select(['l.id', 'l.date', 'l.division', 'l.version', 'l.approvedAt'])
    .select(sql<number>`jsonb_array_length(l.flags)`.as('flagCount'))
    .where('l.date', 'in', dates)
    .execute()
  const begun = await db
    .selectFrom('classSessions as s')
    .innerJoin('classes as c', 'c.id', 's.classId')
    .select(['s.date', 'c.division'])
    .distinct()
    .where('s.date', 'in', dates)
    .execute()
  const topics = await db
    .selectFrom('lessonTopics')
    .select(['date', 'division', 'topic'])
    .where('date', 'in', dates)
    .execute()
  const failures = await db
    .selectFrom('lessonGeneration')
    .select(['date', 'division', 'attempts', 'lastError'])
    .where('date', 'in', dates)
    .execute()

  const find = <T extends { date: string; division: Division }>(rows: T[], date: string, division: Division) =>
    rows.find((r) => r.date === date && r.division === division)
  return dates.map((date) => ({
    date,
    divisions: DIVISIONS.map((division): QueueSlot => {
      const lesson = find(lessons, date, division)
      const failure = find(failures, date, division)
      let status: QueueStatus = 'missing'
      if (lesson !== undefined) {
        status = lesson.approvedAt !== null ? 'approved' : lesson.flagCount > 0 ? 'flagged' : 'pending'
      }
      return {
        division,
        label: config.divisions[division].label,
        status,
        flags: lesson?.flagCount ?? 0,
        lessonId: lesson?.id ?? null,
        version: lesson?.version ?? null,
        topic: find(topics, date, division)?.topic ?? null,
        generationFailed: failure === undefined ? null : { attempts: failure.attempts, lastError: failure.lastError },
        locked: find(begun, date, division) !== undefined,
      }
    }),
  }))
}

/** A lesson as the review page shows it: its content, red marks and false positives, and its versions, newest first. */
async function lessonDetail(db: Kysely<Database>, lessonId: number) {
  const row = await lessonById(db, lessonId)
  const versions = await db
    .selectFrom('lessonVersions')
    .select(['version', 'change', 'reason', 'segmentIndex', 'createdAt'])
    .where('lessonId', '=', lessonId)
    .orderBy('version', 'desc')
    .execute()
  return {
    id: row.id,
    date: row.date,
    division: row.division,
    subject: row.subject,
    title: row.title,
    topic: row.topic,
    source: row.source,
    version: row.version,
    approvedAt: row.approvedAt?.toISOString() ?? null,
    locked: await dayDecided(db, row.date, row.division),
    content: contentOf(row),
    flags: row.flags,
    falsePositives: row.falsePositives,
    callOnChecks: row.callOnChecks,
    versions: versions.map((v) => ({ ...v, createdAt: v.createdAt.toISOString() })),
  }
}

const CONTENT_REFUSED = '大模型以内容为由拒绝了这次重写，换个说法写理由再试，或者改用手动粘贴。'

const TRUNCATED = '大模型的回复太长，被截断了，可以再试一次，或者改用手动粘贴。'

/** A lesson module's refusal as the answer the page shows; anything else goes on as it is. */
function answerFor(err: unknown): unknown {
  if (err instanceof StaleLessonVersion) return new ApiError(409, 'stale_version')
  if (err instanceof LessonLocked) return new ApiError(409, 'lesson_locked')
  if (err instanceof LessonHasFlags) return new ApiError(409, 'lesson_has_flags', {}, err.message)
  if (err instanceof LessonFormatError) return new ApiError(422, 'lesson_format', {}, err.message)
  if (err instanceof TopicRefused) return new ApiError(422, 'topic_refused', {}, err.message)
  if (err instanceof NotALessonDay) return new ApiError(422, 'not_a_lesson_day', {}, err.message)
  if (err instanceof LessonNotFound) return new ApiError(404, 'not_found', {}, err.message)
  if (err instanceof LlmContentRefused) return new ApiError(503, 'llm_unavailable', {}, CONTENT_REFUSED)
  if (err instanceof LlmTruncated) return new ApiError(503, 'llm_unavailable', {}, TRUNCATED)
  if (err instanceof LlmUnavailable) return new ApiError(503, 'llm_unavailable')
  return err
}

/** Runs `work`; a lesson module's refusal comes out as its answer (see `answerFor`). */
async function answering<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (err) {
    throw answerFor(err)
  }
}

/**
 * In place of the model when none is set up for this run: pasting needs none, and a topic's lesson made in the
 * background fails as the model being out of reach (recorded like any failure). A rewrite is refused before this.
 */
const NO_MODEL: Llm = {
  async call() {
    throw new LlmUnavailable('No model is set up')
  },
  async recordManual() {},
}

/** A lesson number from a path; anything else names no lesson. */
function lessonIdOf(text: string): number {
  const id = /^[1-9][0-9]{0,9}$/.test(text) ? Number(text) : NaN
  if (!(id <= MAX_INT)) throw new ApiError(404, 'not_found')
  return id
}

/** A whole number from a query value already checked against `Count` (or missing); 400 when too large. */
function countOf(text: string | undefined): number | undefined {
  if (text === undefined) return undefined
  const n = Number(text)
  if (n > MAX_INT) throw new ApiError(400, 'invalid_request')
  return n
}

function checkDate(date: string): void {
  if (!isDateText(date)) throw new ApiError(400, 'invalid_request')
}

const DivisionName = Type.Union([Type.Literal('primary'), Type.Literal('junior'), Type.Literal('senior')])
// The shape only; whether it is a real day is checked with `checkDate`.
const DateText = Type.String({ pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' })
const Version = Type.Integer({ minimum: 1, maximum: MAX_INT })
const Index = Type.Integer({ minimum: 0, maximum: MAX_INT })
const LessonId = Type.Integer({ minimum: 1, maximum: MAX_INT })
const CallOn = Type.Union([Type.Literal('review'), Type.Literal('extension')])
const Reason = Type.String({ maxLength: MAX_REASON_CHARS })
const RewriteKind = Type.Union([
  Type.Literal('rewrite_segment'),
  Type.Literal('rewrite_lesson'),
  Type.Literal('rewrite_call_on'),
])
const PromptKindName = Type.Union([Type.Literal('generate'), RewriteKind])
// A query value is text: a whole number is written in plain digits.
const Count = Type.String({ pattern: '^(0|[1-9][0-9]{0,9})$' })

const noMore = { additionalProperties: false } as const
const Part = Type.Union([
  Type.Object({ part: Type.Literal('title') }, noMore),
  Type.Object({ part: Type.Literal('segment'), index: Index }, noMore),
  Type.Object({ part: Type.Literal('gist'), index: Index }, noMore),
  Type.Object({ part: Type.Literal('review') }, noMore),
  Type.Object({ part: Type.Literal('extension') }, noMore),
])

const PartsBody = Type.Object({ baseVersion: Version, part: Part, text: Type.String() }, noMore)
const RewriteBody = Type.Object(
  {
    baseVersion: Version,
    kind: RewriteKind,
    segmentIndex: Type.Optional(Index),
    callOn: Type.Optional(CallOn),
    reason: Reason,
  },
  noMore,
)
const RestoreBody = Type.Object({ baseVersion: Version, toVersion: Version }, noMore)
const FalsePositiveBody = Type.Object({ baseVersion: Version, rule: Type.String({ minLength: 1 }) }, noMore)
const CallOnOkBody = Type.Object({ baseVersion: Version, callOn: CallOn }, noMore)
const ApproveBody = Type.Object({ baseVersion: Version }, noMore)
const PasteBody = Type.Object(
  {
    date: DateText,
    division: DivisionName,
    kind: PromptKindName,
    lessonId: Type.Optional(LessonId),
    segmentIndex: Type.Optional(Index),
    callOn: Type.Optional(CallOn),
    reason: Type.Optional(Reason),
    baseVersion: Type.Optional(Version),
    pasted: Type.String({ maxLength: MAX_PASTED_CHARS }),
  },
  noMore,
)
const PromptQuery = Type.Object({
  kind: PromptKindName,
  date: DateText,
  division: DivisionName,
  lessonId: Type.Optional(Type.String({ pattern: '^[1-9][0-9]{0,9}$' })),
  segmentIndex: Type.Optional(Count),
  callOn: Type.Optional(CallOn),
  reason: Type.Optional(Reason),
})
const TopicParams = Type.Object({ date: DateText, division: DivisionName })
const TopicBody = Type.Object({ topic: Type.Union([Type.String(), Type.Null()]) }, noMore)

export function lessonRoutes(deps: AdminDeps): FastifyPluginAsync {
  const { db } = deps

  return async (instance) => {
    const app = instance.withTypeProvider<TypeBoxTypeProvider>()
    app.setValidatorCompiler(TypeBoxValidatorCompiler)

    const generator: GeneratorDeps = {
      db,
      config: deps.config,
      clock: deps.clock,
      moderator: deps.moderator,
      prompts: deps.prompts,
      llm: deps.llm ?? NO_MODEL,
      log: app.log,
    }

    /** Runs a change to lesson `lessonId`, notes it in the log and answers with the lesson as it is now. */
    async function change(log: FastifyBaseLogger, lessonId: number, action: string, work: () => Promise<unknown>) {
      await answering(work)
      const lesson = await answering(() => lessonDetail(db, lessonId))
      log.info({ lessonId, action, version: lesson.version }, 'lesson review')
      return lesson
    }

    // `today` is the school's calendar day: topics can be given from the day after it.
    app.get('/lessons/queue', async () => ({
      mode: deps.config.lessonGeneration.mode,
      today: localDate(deps.clock.now(), deps.config.timezone),
      callOns: deps.config.lesson.callOns.map((c) => ({ kind: c.kind, afterSegment: c.afterSegment })),
      days: await reviewQueue(deps),
    }))

    app.get('/lessons/:id', async (request) => {
      const { id } = request.params as { id: string }
      return answering(() => lessonDetail(db, lessonIdOf(id)))
    })

    app.put('/lessons/:id/parts', { schema: { body: PartsBody } }, async (request) => {
      const lessonId = lessonIdOf((request.params as { id: string }).id)
      const { baseVersion, part, text } = request.body
      return change(request.log, lessonId, 'edit', () => editPart(generator, lessonId, baseVersion, part, text))
    })

    app.post('/lessons/:id/rewrite', { schema: { body: RewriteBody } }, async (request) => {
      const lessonId = lessonIdOf((request.params as { id: string }).id)
      if (deps.llm === null) throw new ApiError(503, 'llm_unavailable')
      const { kind, ...target } = request.body
      return change(request.log, lessonId, kind, () => regenerate(generator, kind, { lessonId, ...target }))
    })

    app.post('/lessons/:id/restore', { schema: { body: RestoreBody } }, async (request) => {
      const lessonId = lessonIdOf((request.params as { id: string }).id)
      const { baseVersion, toVersion } = request.body
      return change(request.log, lessonId, 'restore', () => restoreVersion(generator, lessonId, baseVersion, toVersion))
    })

    app.post('/lessons/:id/false-positive', { schema: { body: FalsePositiveBody } }, async (request) => {
      const lessonId = lessonIdOf((request.params as { id: string }).id)
      const { baseVersion, rule } = request.body
      return change(request.log, lessonId, 'false_positive', () =>
        markFalsePositive(generator, lessonId, baseVersion, rule),
      )
    })

    app.post('/lessons/:id/call-on-ok', { schema: { body: CallOnOkBody } }, async (request) => {
      const lessonId = lessonIdOf((request.params as { id: string }).id)
      const { baseVersion, callOn } = request.body
      return change(request.log, lessonId, 'call_on_ok', () => confirmCallOn(generator, lessonId, baseVersion, callOn))
    })

    app.post('/lessons/:id/approve', { schema: { body: ApproveBody } }, async (request) => {
      const lessonId = lessonIdOf((request.params as { id: string }).id)
      return change(request.log, lessonId, 'approve', () => approve(generator, lessonId, request.body.baseVersion))
    })

    app.post('/lessons/paste', { schema: { body: PasteBody } }, async (request) => {
      const { pasted, ...target } = request.body
      checkDate(target.date)
      await answering(() => acceptPasted(generator, target, pasted))
      // A new lesson is the day's; a rewrite is of the lesson it names.
      let lessonId = target.lessonId
      if (target.kind === 'generate') {
        const row = await db
          .selectFrom('lessons')
          .select('id')
          .where('date', '=', target.date)
          .where('division', '=', target.division)
          .executeTakeFirst()
        lessonId = row?.id
      }
      if (lessonId === undefined) throw new ApiError(404, 'not_found')
      const lesson = await answering(() => lessonDetail(db, lessonId))
      request.log.info({ lessonId, action: `paste_${target.kind}`, version: lesson.version }, 'lesson review')
      return lesson
    })

    app.get('/prompts', { schema: { querystring: PromptQuery } }, async (request) => {
      const { kind, lessonId, segmentIndex, ...rest } = request.query
      checkDate(rest.date)
      const target = { ...rest, lessonId: countOf(lessonId), segmentIndex: countOf(segmentIndex) }
      const prompt = await answering(() => buildLessonPrompt(generator, kind, target))
      return { text: `${prompt.system}\n\n${prompt.user}` }
    })

    // The topics given for today and the days after it, any number of days ahead: the queue shows only its own days.
    app.get('/topics', async () => {
      const today = localDate(deps.clock.now(), deps.config.timezone)
      const rows = await db
        .selectFrom('lessonTopics')
        .select(['date', 'division', 'topic'])
        .where('date', '>=', today)
        .execute()
      const order = (r: { date: string; division: Division }) => `${r.date}/${DIVISIONS.indexOf(r.division)}`
      return { topics: rows.sort((a, b) => order(a).localeCompare(order(b))) }
    })

    app.put('/topics/:date/:division', { schema: { params: TopicParams, body: TopicBody } }, async (request) => {
      const { date, division } = request.params
      checkDate(date)
      const { topic } = request.body
      if (topic !== null) {
        const chars = [...topic.trim()].length
        if (chars > MAX_TOPIC_CHARS) {
          throw new ApiError(422, 'topic_refused', {}, `题目不能超过 ${MAX_TOPIC_CHARS} 个字，现在有 ${chars} 个字`)
        }
      }
      const result = await answering(() => setTopic(generator, date, division, topic))
      request.log.info({ date, division, result }, 'lesson topic')
      return { result }
    })
  }
}
