import type { FastifyBaseLogger } from 'fastify'
import { sql, type Kysely } from 'kysely'
import type { Llm } from '../llm/client.js'
import { extractJson, JsonNotFound } from '../llm/json.js'
import { LlmContentRefused, LlmUnavailable, type LlmResponse } from '../llm/provider.js'
import { isLessonDay, lessonDaysAhead, schoolDaysUntil } from '../shared/calendar.js'
import type { Division } from '../shared/config.js'
import { lessonLockKey, lock } from '../shared/db.js'
import { localDate } from '../shared/local-time.js'
import type { Database, LessonContent } from '../shared/schema.js'
import { LessonFormatError, parseLessonContent } from './format.js'
import {
  applyReply,
  lessonById,
  lessonSlot,
  newLessonPrompt,
  rewritePrompt,
  rewriteReason,
  topicOf,
  type LessonPromptDeps,
  type LessonPromptTarget,
  type PromptKind,
} from './prompts.js'
import {
  assertNotBegun,
  contentOf,
  hasBegun,
  LessonLocked,
  replaceContent,
  saveDraft,
  StaleLessonVersion,
  type LessonStoreDeps,
} from './store.js'

export { SPECIAL_SUBJECT } from '../class/planning.js'

// Making the lessons of the days ahead, by the model or pasted in by hand, the reviewer's rewrites, and the topics
// given for single days. The model is never waited on inside a transaction or under a lock other than the run's own:
// each lesson is stored by the lesson store in a short transaction of its own, once the model has answered.

export interface GeneratorDeps extends LessonStoreDeps, LessonPromptDeps {
  llm: Llm
  /** Gets the day, the division, the outcome and an error's name; never a prompt or a reply. */
  log?: Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>
}

export interface GenerationReport {
  generated: number
  failed: number
  /** Missing lessons left to be pasted in, in manual mode, as their deadline has not come. */
  waitingManual: number
}

/** A rewrite the reviewer asked for, of lesson `lessonId` as it was at `baseVersion`. */
export interface RewriteTarget {
  lessonId: number
  baseVersion: number
  reason: string
  /** The segment (0-based) of a `rewrite_segment`. */
  segmentIndex?: number
  /** The question of a `rewrite_call_on`. */
  callOn?: 'review' | 'extension'
}

/**
 * What was pasted in: a reply to the prompt of `kind` for that target. A rewrite names its `baseVersion`; a new lesson
 * names the version of the lesson it replaces, and none when the day had no lesson.
 */
export interface PastedTarget extends LessonPromptTarget {
  kind: PromptKind
  baseVersion?: number
}

/** A topic cannot be given for that day. The message says why, in Chinese. */
export class TopicRefused extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TopicRefused'
  }
}

const DIVISIONS: readonly Division[] = ['primary', 'junior', 'senior']

/** The session-level advisory lock a generation run holds, so that two runs never overlap. */
const GENERATION_LOCK_KEY = 'lesson-generation'

/** A whole lesson is long: more than the client's default room for a reply. */
const LESSON_MAX_OUTPUT_TOKENS = 8000

/**
 * A lesson call, new or rewritten, with the lesson generation timeout; a whole lesson (`whole`) also gets room for
 * its length.
 */
function callForLesson(
  deps: GeneratorDeps,
  prompt: { system: string; user: string },
  whole: boolean,
): Promise<LlmResponse> {
  return deps.llm.call('lesson', prompt, {
    json: true,
    maxOutputTokens: whole ? LESSON_MAX_OUTPUT_TOKENS : undefined,
    timeoutMs: deps.config.lessonGeneration.timeoutSeconds * 1000,
  })
}

const errorName = (err: unknown): string => (err instanceof Error ? err.constructor.name : typeof err)

const isExpectedFailure = (err: unknown): boolean =>
  err instanceof LlmUnavailable ||
  err instanceof LlmContentRefused ||
  err instanceof JsonNotFound ||
  err instanceof LessonFormatError ||
  err instanceof LessonLocked

/** Why making a lesson failed, in Chinese, for the admin. It never quotes the model's reply. */
function failureReason(err: unknown): string {
  if (err instanceof LlmContentRefused) return '大模型以内容为由拒绝了这次生成'
  if (err instanceof LlmUnavailable) return '大模型暂时不可用（超时、网络出错或服务繁忙）'
  if (err instanceof JsonNotFound) return '大模型的回复里没有找到 JSON'
  if (err instanceof LessonFormatError) return `大模型交回的课程格式不对：${err.message}`
  if (err instanceof LessonLocked) return err.message
  return '生成时程序出了错，错误名称记在服务日志里'
}

async function recordFailure(deps: GeneratorDeps, date: string, division: Division, reason: string): Promise<void> {
  const now = deps.clock.now()
  await deps.db
    .insertInto('lessonGeneration')
    .values({ date, division, attempts: 1, firstFailedAt: now, lastFailedAt: now, lastError: reason })
    .onConflict((oc) =>
      oc.columns(['date', 'division']).doUpdateSet((eb) => ({
        attempts: eb('lessonGeneration.attempts', '+', 1),
        lastFailedAt: now,
        lastError: reason,
      })),
    )
    .execute()
}

async function clearFailure(db: Kysely<Database>, date: string, division: Division): Promise<void> {
  await db.deleteFrom('lessonGeneration').where('date', '=', date).where('division', '=', division).execute()
}

/**
 * Drops the failures of the days that have the lesson they need now (see `needsLesson`), however they got it: pasted
 * in, imported, or a topic taken away. A failure stays while its day still needs the lesson.
 */
async function dropSettledFailures(db: Kysely<Database>): Promise<void> {
  await db
    .deleteFrom('lessonGeneration')
    .where((outer) =>
      outer.exists(
        outer
          .selectFrom('lessons as l')
          .select('l.id')
          .whereRef('l.date', '=', 'lessonGeneration.date')
          .whereRef('l.division', '=', 'lessonGeneration.division')
          .where((eb) =>
            eb.not(
              eb.exists(
                eb
                  .selectFrom('lessonTopics as t')
                  .select('t.topic')
                  .whereRef('t.date', '=', 'l.date')
                  .whereRef('t.division', '=', 'l.division')
                  .whereRef('t.topic', 'is distinct from', 'l.topic'),
              ),
            ),
          ),
      ),
    )
    .execute()
}

/**
 * A day and division as generation sees it: the lesson there is (with its version and the topic it was made with) and
 * the topic given.
 */
interface SlotState {
  lesson: { id: number; version: number; topic: string | null } | undefined
  topic: string | null
}

async function slotState(db: Kysely<Database>, date: string, division: Division): Promise<SlotState> {
  const lesson = await db
    .selectFrom('lessons')
    .select(['id', 'version', 'topic'])
    .where('date', '=', date)
    .where('division', '=', division)
    .executeTakeFirst()
  return { lesson, topic: await topicOf(db, date, division) }
}

/**
 * Whether a day still needs its lesson made: it has none, or a topic was given for it that its lesson was not made
 * with. A lesson made with a topic that was taken away since stays as it is.
 */
const needsLesson = (slot: SlotState): boolean =>
  slot.lesson === undefined || (slot.topic !== null && slot.lesson.topic !== slot.topic)

/**
 * Has the model write the lesson of a day and division and stores it as a draft: a missing lesson (change
 * `generate`), or one made again for the topic given since (`topic`). A failure is written to `lesson_generation`; a
 * lesson stored clears it. Nothing is locked while the model writes, so the day may change meanwhile: what the model
 * wrote is dropped when the day's topic is no longer the one it wrote for, or when the day no longer needs the lesson
 * (one was pasted in, say), also when that happens between reading the day and storing the lesson. The next run makes
 * a lesson the day still needs.
 */
async function generateSlot(
  deps: GeneratorDeps,
  date: string,
  division: Division,
): Promise<'generated' | 'failed' | 'dropped'> {
  const { db, config, log } = deps
  try {
    const { prompt, subject, topic } = await newLessonPrompt(deps, date, division)
    const reply = await callForLesson(deps, prompt, true)
    const content = parseLessonContent(config, extractJson(reply.text), { subject })
    const now = await slotState(db, date, division)
    if (now.topic !== topic || !needsLesson(now)) {
      log?.info({ date, division, outcome: 'dropped' }, 'lesson generation')
      return 'dropped'
    }
    const change = now.lesson === undefined ? 'generate' : 'topic'
    const expectVersion = now.lesson?.version ?? null
    try {
      await saveDraft(deps, { date, division }, content, { source: 'api', change, topic, expectVersion })
    } catch (err) {
      if (!(err instanceof StaleLessonVersion)) throw err
      log?.info({ date, division, outcome: 'dropped' }, 'lesson generation')
      return 'dropped'
    }
    await clearFailure(db, date, division)
    log?.info({ date, division, outcome: 'generated' }, 'lesson generation')
    return 'generated'
  } catch (err) {
    await recordFailure(deps, date, division, failureReason(err))
    const fields = { date, division, outcome: 'failed', err: errorName(err) }
    if (isExpectedFailure(err)) log?.warn(fields, 'lesson generation')
    else log?.error(fields, 'lesson generation')
    return 'failed'
  }
}

/**
 * Makes the lessons the lesson days ahead (`lessonDaysAhead`) need, every division, one after another: the missing
 * ones, and the ones made before a topic was given for their day (unless a class has begun them). In `manual` mode
 * such a lesson is left to be pasted in until it is `manualDeadlineSchoolDays` school days away or less; then the
 * model makes it. Every run retries what failed before, and drops the failures of days that have their lesson now.
 * Only one run goes at a time: a run that finds another going does nothing.
 */
export async function generateMissing(deps: GeneratorDeps): Promise<GenerationReport> {
  const report: GenerationReport = { generated: 0, failed: 0, waitingManual: 0 }
  // The lock belongs to one pooled connection for the whole run, outside any transaction, so it holds up nothing but
  // another run. The run's own reads and writes go through the pool.
  return deps.db.connection().execute(async (conn) => {
    const key = GENERATION_LOCK_KEY
    const taken = await sql<{ locked: boolean }>`select pg_try_advisory_lock(hashtext(${key})) as locked`.execute(conn)
    if (taken.rows[0]?.locked !== true) {
      deps.log?.info({ outcome: 'busy' }, 'lesson generation already running')
      return report
    }
    try {
      const { config, clock, db } = deps
      const { mode, manualDeadlineSchoolDays } = config.lessonGeneration
      const today = localDate(clock.now(), config.timezone)
      await dropSettledFailures(db)
      for (const date of lessonDaysAhead(today, config)) {
        for (const division of DIVISIONS) {
          // Read for each lesson in turn: one may have been pasted in while the model wrote the one before.
          const slot = await slotState(db, date, division)
          if (!needsLesson(slot)) continue
          // A lesson a class has begun does not change.
          if (slot.lesson !== undefined && (await hasBegun(db, slot.lesson.id))) continue
          if (mode === 'manual' && schoolDaysUntil(today, date, config) > manualDeadlineSchoolDays) {
            report.waitingManual += 1
            continue
          }
          const outcome = await generateSlot(deps, date, division)
          if (outcome === 'generated') report.generated += 1
          else if (outcome === 'failed') report.failed += 1
        }
      }
      return report
    } finally {
      await sql`select pg_advisory_unlock(hashtext(${key}))`.execute(conn)
    }
  })
}

/** The rewritten lesson a model's reply makes; a reply that will not do is a `LessonFormatError` saying why. */
function rewriteOf(
  deps: GeneratorDeps,
  kind: Exclude<PromptKind, 'generate'>,
  current: LessonContent,
  replyText: string,
  target: RewriteTarget,
): LessonContent {
  try {
    return applyReply(deps.config, kind, current, extractJson(replyText), target)
  } catch (err) {
    if (err instanceof JsonNotFound) throw new LessonFormatError('大模型的回复里没有找到 JSON')
    if (err instanceof LessonFormatError) throw new LessonFormatError(`大模型交回的内容格式不对：${err.message}`)
    throw err
  }
}

/**
 * Has the model rewrite a segment, a call-on question or the whole lesson, as the reviewer asked and for the reason
 * they gave, and saves the result as the lesson's next version. The version is checked before the model is called
 * (`StaleLessonVersion`, and `LessonLocked` once a class has begun the lesson) and again when the result is saved, so
 * a save made meanwhile is not overwritten. The model's failures (`LlmUnavailable`, `LlmContentRefused`) go to the
 * caller, as does a reply that will not do (`LessonFormatError`).
 */
export async function regenerate(
  deps: GeneratorDeps,
  kind: Exclude<PromptKind, 'generate'>,
  target: RewriteTarget,
): Promise<{ version: number }> {
  const lesson = await lessonById(deps.db, target.lessonId)
  if (lesson.version !== target.baseVersion) throw new StaleLessonVersion(lesson.id)
  await assertNotBegun(deps.db, lesson.id)
  const prompt = await rewritePrompt(deps, kind, lesson, target)
  const reply = await callForLesson(deps, prompt, kind === 'rewrite_lesson')
  const content = rewriteOf(deps, kind, contentOf(lesson), reply.text, target)
  const saved = await replaceContent(deps, lesson.id, target.baseVersion, content, {
    change: kind,
    reason: rewriteReason(target.reason),
    segmentIndex: kind === 'rewrite_segment' ? target.segmentIndex : undefined,
  })
  return { version: saved.version }
}

/**
 * Takes a reply pasted in by hand, as a whole: the JSON object in it is found among whatever words surround it, then
 * checked like a model's reply. A new lesson is stored as a draft (source `manual`) with the day's topic, unless the
 * day has moved on from what the page showed (`baseVersion`, none for no lesson): then `StaleLessonVersion`. A rewrite
 * replaces its part of the lesson as it was at `baseVersion`. Counted as a manual call. A reply that will not do is a
 * `LessonFormatError` saying why, in Chinese.
 */
export async function acceptPasted(deps: GeneratorDeps, target: PastedTarget, pasted: string): Promise<{ version: number }> {
  let reply: unknown
  try {
    reply = extractJson(pasted)
  } catch (err) {
    if (err instanceof JsonNotFound) throw new LessonFormatError('没有在粘贴的内容里找到 JSON')
    throw err
  }

  let version: number
  if (target.kind === 'generate') {
    const { date, division } = target
    const { subject, topic } = await lessonSlot(deps, date, division)
    const content = parseLessonContent(deps.config, reply, { subject })
    const expectVersion = target.baseVersion ?? null
    ;({ version } = await saveDraft(deps, { date, division }, content, { source: 'manual', change: 'generate', topic, expectVersion }))
    await clearFailure(deps.db, date, division)
  } else {
    if (target.lessonId === undefined) throw new LessonFormatError('重写要说明是哪节课')
    if (target.baseVersion === undefined) throw new LessonFormatError('重写要带上复制提示词时这节课的版本号')
    const reason = rewriteReason(target.reason)
    const lesson = await lessonById(deps.db, target.lessonId)
    if (lesson.version !== target.baseVersion) throw new StaleLessonVersion(lesson.id)
    const content = applyReply(deps.config, target.kind, contentOf(lesson), reply, target)
    ;({ version } = await replaceContent(deps, lesson.id, target.baseVersion, content, {
      change: target.kind,
      reason,
      segmentIndex: target.kind === 'rewrite_segment' ? target.segmentIndex : undefined,
    }))
  }
  await deps.llm.recordManual('lesson')
  return { version }
}

/**
 * Gives a lesson day after today a topic for one division, or takes it away (`null`; a lesson made with it stays as
 * it is). A topic is refused (`TopicRefused`) for today, a day gone by and a day without lessons. With no lesson yet,
 * the topic waits for the lesson to be made. A lesson already there, unless it has that topic, is made again with it:
 * in `api` mode it goes back to review at once (approval cleared, version moved on, content kept until the new one
 * comes) and the model makes it in the background ('regenerating'; a failure is written to `lesson_generation` and
 * retried by `generateMissing`); in `manual` mode the lesson is taken back to waiting for one to be pasted in (its
 * versions are kept). Once a class has begun the lesson, `LessonLocked`.
 */
export async function setTopic(
  deps: GeneratorDeps,
  date: string,
  division: Division,
  topic: string | null,
): Promise<'stored' | 'regenerating'> {
  const { db, config, clock } = deps
  if (topic === null) {
    await db.deleteFrom('lessonTopics').where('date', '=', date).where('division', '=', division).execute()
    return 'stored'
  }
  const text = topic.trim()
  if (text === '') throw new TopicRefused('题目不能为空')
  // Today's lesson is not made again: generation looks at the days after today only.
  const today = localDate(clock.now(), config.timezone)
  if (date === today) throw new TopicRefused('今天的课已经定了，只能给明天以后的上学日指定题目')
  if (date < today) throw new TopicRefused(`${date} 已经过去了，不能再指定题目`)
  if (!isLessonDay(date, config)) throw new TopicRefused(`${date} 不上课（周末、放假或还没开学），不能指定题目`)

  const outcome = await db.transaction().execute(async (trx) => {
    // The lesson's lock, which every change to the lesson takes: no class begins the lesson meanwhile.
    await lock(trx, lessonLockKey(date, division))
    const lesson = await trx
      .selectFrom('lessons')
      .select(['id', 'topic'])
      .where('date', '=', date)
      .where('division', '=', division)
      .forUpdate()
      .executeTakeFirst()
    if (lesson !== undefined) await assertNotBegun(trx, lesson.id)
    const now = clock.now()
    await trx
      .insertInto('lessonTopics')
      .values({ date, division, topic: text, createdAt: now })
      .onConflict((oc) => oc.columns(['date', 'division']).doUpdateSet({ topic: text, createdAt: now }))
      .execute()
    if (lesson === undefined || lesson.topic === text) return 'stored' as const
    if (config.lessonGeneration.mode === 'manual') {
      // Its versions stay: they name the lesson without a foreign key.
      await trx.deleteFrom('lessons').where('id', '=', lesson.id).execute()
      return 'stored' as const
    }
    // Back to review now, so the lesson the topic replaces is never taught while the new one is being made, and a tab
    // still showing it is stale. The content is not changed yet, so no version is kept.
    await trx
      .updateTable('lessons')
      .set((eb) => ({ approvedAt: null, version: eb('version', '+', 1), updatedAt: now }))
      .where('id', '=', lesson.id)
      .execute()
    return 'regenerating' as const
  })

  if (outcome === 'regenerating') {
    // The model may take a minute; the caller does not wait for it. A failure is recorded by generateSlot itself.
    void generateSlot(deps, date, division).catch((err: unknown) =>
      deps.log?.error({ date, division, outcome: 'failed', err: errorName(err) }, 'lesson generation'),
    )
  }
  return outcome
}
