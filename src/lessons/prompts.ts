import type { Kysely, Selectable } from 'kysely'
import { SPECIAL_SUBJECT, subjectForDate } from '../class/planning.js'
import { fillPrompt, type PromptName, type PromptTemplate } from '../llm/prompts.js'
import { isLessonDay } from '../shared/calendar.js'
import type { Division, SchoolConfig } from '../shared/config.js'
import type { CallOnKind, CallOnQuestions, Database, LessonContent, LessonsTable } from '../shared/schema.js'
import {
  LessonFormatError,
  lessonText,
  MAX_CALL_ON_QUESTION_CHARS,
  MAX_GIST_CHARS,
  MAX_SEGMENT_TEXT_CHARS,
  MAX_TITLE_CHARS,
  PART_NAMES,
  parseLessonContent,
} from './format.js'
import { contentOf, LessonNotFound } from './store.js'

// The prompts that make and rewrite lessons, and the replies they ask for. The prompt is the same whether it goes to
// the model or is copied out to be pasted into another tool, and it ends with the exact reply format, which code owns:
// `applyReply` accepts exactly what `{{format}}` describes. Lesson texts and the reviewer's reason are written by the
// model and the reviewer, not by students, so they go into the prompt as they are.

/** What a prompt asks for: a new lesson, or a rewrite of a segment, the whole lesson or a call-on question. */
export type PromptKind = 'generate' | 'rewrite_segment' | 'rewrite_lesson' | 'rewrite_call_on'

export interface LessonPromptDeps {
  db: Kysely<Database>
  config: SchoolConfig
  prompts: Record<PromptName, PromptTemplate>
}

/**
 * Which lesson a prompt is for. A new lesson is the one of `date` and `division`; a rewrite is of lesson `lessonId`
 * (`date` and `division` are not read then), with the reviewer's `reason`, and the segment (`segmentIndex`, 0-based)
 * or the call-on question it rewrites.
 */
export interface LessonPromptTarget {
  date: string
  division: Division
  lessonId?: number
  segmentIndex?: number
  callOn?: 'review' | 'extension'
  reason?: string
}

/** A new lesson was asked for a day that has none: a weekend, a day of a break or a day before the opening. */
export class NotALessonDay extends Error {
  constructor(readonly date: string) {
    super(`${date} 不上课（周末、放假或还没开学），没有课可以生成`)
    this.name = 'NotALessonDay'
  }
}

/** How many titles of earlier lessons a prompt lists, the newest first. */
const PAST_TITLES_LIMIT = 200

const NO_TOPIC = '没有指定，由你按科目和学部选一个合适的主题'
const NO_PAST_TITLES = '（还没有）'
const CALL_ON_NAMES = { review: '复习题', extension: '引申题' } as const

const REPLY_ONLY = '只回复一个 JSON 对象，前后不要加任何说明。格式如下：'

/** The reply a new lesson or a rewritten one must be. */
function lessonFormat(config: SchoolConfig): string {
  const count = config.lesson.segmentMinutes.length
  return [
    REPLY_ONLY,
    '{"title": "课题", "segments": [{"text": "第 1 段的讲稿", "gist": "第 1 段的要点"}, …], "callOnQuestions": {"review": "复习题", "extension": "引申题"}}',
    `- title：课题，不超过 ${MAX_TITLE_CHARS} 个字。`,
    `- segments：正好 ${count} 项，按讲课的顺序排列。每一项的 text 是这一段的讲稿，不超过 ${MAX_SEGMENT_TEXT_CHARS} 个字；gist 是这一段的要点，一句话，不超过 ${MAX_GIST_CHARS} 个字。`,
    `- callOnQuestions：review 是复习题，extension 是引申题，各是一句话，不超过 ${MAX_CALL_ON_QUESTION_CHARS} 个字。`,
    '每个字段都必须是不为空的文字。',
  ].join('\n')
}

const SEGMENT_FORMAT = [
  REPLY_ONLY,
  '{"text": "这一段新的讲稿", "gist": "这一段的要点"}',
  `- text：不超过 ${MAX_SEGMENT_TEXT_CHARS} 个字。`,
  `- gist：一句话，不超过 ${MAX_GIST_CHARS} 个字。`,
].join('\n')

const CALL_ON_FORMAT = [REPLY_ONLY, '{"question": "新的题目"}', `- question：一句话，不超过 ${MAX_CALL_ON_QUESTION_CHARS} 个字。`].join('\n')

/** How long each segment is read for, in minutes: the time to the next segment, or to the dismissal for the last. */
function segmentMinutesText(config: SchoolConfig): string {
  const { segmentMinutes, dismissalMinute } = config.lesson
  const ends = [...segmentMinutes.slice(1), dismissalMinute]
  const lengths = ends.map((end, i) => end - (segmentMinutes[i] ?? 0))
  return new Set(lengths).size === 1 ? String(lengths[0]) : `${lengths.join('、')}（依次对应各段）`
}

/** The call-on kinds in the order a page lists them. */
const CALL_ON_KINDS: readonly CallOnKind[] = ['review', 'extension']

/** What the review question asks about: the segments up to the review call-on. */
function reviewScope(config: SchoolConfig): string {
  const after = config.lesson.callOns.find((c) => c.kind === 'review')?.afterSegment
  if (after === undefined) return '这节课前面讲过的内容'
  return after === 1 ? '第 1 段' : `第 1 到第 ${after} 段`
}

/**
 * The call-on questions that are based on segment `segmentIndex` (0-based), among the ones the config has: a review
 * question after segment `a` is about segments 0 to a-1, an extension question after segment `a` about 0 to a (it leads
 * to the segment after it).
 */
export function callOnsCovering(callOns: SchoolConfig['lesson']['callOns'], segmentIndex: number): CallOnKind[] {
  const kinds = new Set<CallOnKind>()
  for (const { kind, afterSegment } of callOns) {
    if (segmentIndex < (kind === 'review' ? afterSegment : afterSegment + 1)) kinds.add(kind)
  }
  return CALL_ON_KINDS.filter((k) => kinds.has(k))
}

/** What the extension question leads to: the segment after the extension call-on. */
function extensionTarget(config: SchoolConfig): string {
  const after = config.lesson.callOns.find((c) => c.kind === 'extension')?.afterSegment
  if (after === undefined) return '从这节课讲过的内容出发，向外延伸一步'
  return `从前面讲过的内容出发，引出第 ${after + 1} 段要讲的内容`
}

/** The points of `lessonGeneration.direction`, on one line. */
const directionText = (config: SchoolConfig) =>
  config.lessonGeneration.direction.length === 0 ? '无' : config.lessonGeneration.direction.join('；')

/** The lesson as the reviewer reads it, for the model to see what it rewrites. */
function lessonAsText(content: LessonContent): string {
  const lines = [`标题：${content.title}`]
  content.segments.forEach((s, i) => lines.push('', `第 ${i + 1} 段：${s.text}`, `要点：${s.gist}`))
  if (content.callOnQuestions !== null) {
    lines.push('', `复习题：${content.callOnQuestions.review}`, `引申题：${content.callOnQuestions.extension}`)
  }
  return lines.join('\n')
}

/**
 * The titles of the lessons of a division and subject that a class taught or that are approved for a day still to be
 * decided, other than the one of `date`, newest first. A lesson approved for a day a study hall decided was never
 * taught, so it is not one of them.
 */
async function pastTitles(db: Kysely<Database>, p: { date: string; division: Division; subject: string }): Promise<string> {
  const rows = await db
    .selectFrom('lessons as l')
    .select('l.title')
    .where('l.division', '=', p.division)
    .where('l.subject', '=', p.subject)
    .where('l.approvedAt', 'is not', null)
    .where('l.date', '!=', p.date)
    .where((eb) =>
      eb.or([
        eb.exists(
          eb.selectFrom('classSessions as s').select('s.id').whereRef('s.lessonId', '=', 'l.id').where('s.kind', '=', 'lesson'),
        ),
        eb.not(
          eb.exists(
            eb
              .selectFrom('classSessions as s')
              .innerJoin('classes as c', 'c.id', 's.classId')
              .select('s.id')
              .whereRef('s.date', '=', 'l.date')
              .whereRef('c.division', '=', 'l.division'),
          ),
        ),
      ]),
    )
    .orderBy('l.date', 'desc')
    .limit(PAST_TITLES_LIMIT)
    .execute()
  return rows.length === 0 ? NO_PAST_TITLES : rows.map((r) => `- ${r.title}`).join('\n')
}

/** The placeholders every lesson prompt that writes a whole lesson fills. */
async function wholeLessonVars(
  deps: LessonPromptDeps,
  p: { date: string; division: Division; subject: string; topic: string | null },
): Promise<Record<string, string>> {
  const { config } = deps
  return {
    division: config.divisions[p.division].label,
    subject: p.subject,
    topic: p.topic ?? NO_TOPIC,
    direction: directionText(config),
    pastTitles: await pastTitles(deps.db, p),
    segmentCount: String(config.lesson.segmentMinutes.length),
    segmentMinutes: segmentMinutesText(config),
    reviewScope: reviewScope(config),
    extensionTarget: extensionTarget(config),
    format: lessonFormat(config),
  }
}

/** The topic given for a day and division, or null. */
export async function topicOf(db: Kysely<Database>, date: string, division: Division): Promise<string | null> {
  const row = await db
    .selectFrom('lessonTopics')
    .select('topic')
    .where('date', '=', date)
    .where('division', '=', division)
    .executeTakeFirst()
  return row?.topic ?? null
}

/**
 * What the lesson of a day and division is made for: the topic given for it (read now), and the subject,
 * `SPECIAL_SUBJECT` with a topic, else the day's own. Throws `NotALessonDay` for a day without lessons.
 */
export async function lessonSlot(
  deps: Pick<LessonPromptDeps, 'db' | 'config'>,
  date: string,
  division: Division,
): Promise<{ subject: string; topic: string | null }> {
  const subject = isLessonDay(date, deps.config) ? subjectForDate(date, deps.config.timezone) : null
  if (subject === null) throw new NotALessonDay(date)
  const topic = await topicOf(deps.db, date, division)
  return { subject: topic === null ? subject : SPECIAL_SUBJECT, topic }
}

/** The prompt for the lesson of a day and division, with what it is made for (see `lessonSlot`). */
export async function newLessonPrompt(
  deps: LessonPromptDeps,
  date: string,
  division: Division,
): Promise<{ prompt: { system: string; user: string }; subject: string; topic: string | null }> {
  const slot = await lessonSlot(deps, date, division)
  const vars = await wholeLessonVars(deps, { date, division, ...slot })
  return { prompt: fillPrompt(deps.prompts['lesson-generate'], vars), ...slot }
}

type LessonRow = Selectable<LessonsTable>

/** The lesson `lessonId`; throws `LessonNotFound`. */
export async function lessonById(db: Kysely<Database>, lessonId: number): Promise<LessonRow> {
  const row = await db.selectFrom('lessons').selectAll().where('id', '=', lessonId).executeTakeFirst()
  if (row === undefined) throw new LessonNotFound(`没有编号 ${lessonId} 的课程`)
  return row
}

/** The reviewer's reason for a rewrite, trimmed; a rewrite without one is refused. */
export function rewriteReason(reason: string | undefined): string {
  const text = reason?.trim() ?? ''
  if (text === '') throw new LessonFormatError('重写要写上理由')
  return text
}

/** The segment a segment rewrite is of (0-based), checked against the lesson. */
function segmentIndexOf(content: LessonContent, index: number | undefined): number {
  const count = content.segments.length
  if (index === undefined || !Number.isInteger(index) || index < 0) {
    throw new LessonFormatError(`重写哪一段：段号必须是 0 到 ${count - 1} 的整数`)
  }
  if (index >= count) throw new LessonFormatError(`没有第 ${index + 1} 段，这节课只有 ${count} 段`)
  return index
}

/** The call-on question a call-on rewrite is of, and the lesson's questions; the lesson must have them. */
function callOnOf(
  content: LessonContent,
  callOn: 'review' | 'extension' | undefined,
): { which: 'review' | 'extension'; questions: CallOnQuestions } {
  if (callOn !== 'review' && callOn !== 'extension') throw new LessonFormatError('要说明重写复习题还是引申题')
  if (content.callOnQuestions === null) throw new LessonFormatError('这节课没有点名题，没有可重写的题目')
  return { which: callOn, questions: content.callOnQuestions }
}

/** The prompt to rewrite part or all of `lesson`. A whole-lesson rewrite keeps the lesson's own subject and topic. */
export async function rewritePrompt(
  deps: LessonPromptDeps,
  kind: Exclude<PromptKind, 'generate'>,
  lesson: LessonRow,
  target: Pick<LessonPromptTarget, 'segmentIndex' | 'callOn' | 'reason'>,
): Promise<{ system: string; user: string }> {
  const { config, prompts } = deps
  const content = contentOf(lesson)
  const reason = rewriteReason(target.reason)
  const shared = {
    division: config.divisions[lesson.division].label,
    subject: lesson.subject,
    title: lesson.title,
    currentLesson: lessonAsText(content),
    reason,
    direction: directionText(config),
  }
  switch (kind) {
    case 'rewrite_lesson': {
      const vars = await wholeLessonVars(deps, lesson)
      return fillPrompt(prompts['lesson-rewrite'], { ...vars, ...shared })
    }
    case 'rewrite_segment': {
      const index = segmentIndexOf(content, target.segmentIndex)
      return fillPrompt(prompts['lesson-rewrite-segment'], {
        ...shared,
        segmentIndex: String(index + 1),
        segmentText: content.segments[index]?.text ?? '',
        format: SEGMENT_FORMAT,
      })
    }
    case 'rewrite_call_on': {
      const { which, questions } = callOnOf(content, target.callOn)
      return fillPrompt(prompts['lesson-rewrite-call-on'], {
        ...shared,
        callOnKind: CALL_ON_NAMES[which],
        currentQuestion: questions[which],
        scope: which === 'review' ? reviewScope(config) : extensionTarget(config),
        format: CALL_ON_FORMAT,
      })
    }
  }
}

/**
 * The prompt for a new lesson, or for a rewrite of part or all of one, as sent to the model and as copied out to be
 * pasted elsewhere. A rewrite needs `lessonId` and a `reason`, and the segment or call-on question it is of; one
 * without is refused with a `LessonFormatError`.
 */
export async function buildLessonPrompt(
  deps: LessonPromptDeps,
  kind: PromptKind,
  target: LessonPromptTarget,
): Promise<{ system: string; user: string }> {
  if (kind === 'generate') return (await newLessonPrompt(deps, target.date, target.division)).prompt
  if (target.lessonId === undefined) throw new LessonFormatError('重写要说明是哪节课')
  return rewritePrompt(deps, kind, await lessonById(deps.db, target.lessonId), target)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The lesson `current` becomes with `reply`, the JSON object of a reply to a `kind` rewrite prompt: a whole new
 * lesson, or `current` with the segment or call-on question of `target` replaced. Throws a `LessonFormatError` saying
 * what is wrong with the reply. The subject stays the lesson's. (A new lesson's reply is read by `parseLessonContent`.)
 */
export function applyReply(
  config: SchoolConfig,
  kind: Exclude<PromptKind, 'generate'>,
  current: LessonContent,
  reply: unknown,
  target: Pick<LessonPromptTarget, 'segmentIndex' | 'callOn'>,
): LessonContent {
  if (kind === 'rewrite_lesson') return parseLessonContent(config, reply, { subject: current.subject })
  if (!isRecord(reply)) throw new LessonFormatError('回复必须是一个 JSON 对象')
  if (kind === 'rewrite_segment') {
    const index = segmentIndexOf(current, target.segmentIndex)
    const segment = {
      text: lessonText(reply.text, PART_NAMES.segmentText(index), MAX_SEGMENT_TEXT_CHARS),
      gist: lessonText(reply.gist, PART_NAMES.segmentGist(index), MAX_GIST_CHARS),
    }
    return { ...current, segments: current.segments.map((s, i) => (i === index ? segment : s)) }
  }
  const { which, questions } = callOnOf(current, target.callOn)
  const question = lessonText(reply.question, PART_NAMES[which], MAX_CALL_ON_QUESTION_CHARS)
  return { ...current, callOnQuestions: { ...questions, [which]: question } }
}
