import type { SchoolConfig } from '../shared/config.js'
import type { CallOnQuestions, LessonContent, LessonSegment } from '../shared/schema.js'

export type { CallOnQuestions, LessonContent, LessonSegment } from '../shared/schema.js'

// The shape of a lesson as it comes in: a model's reply, a pasted one or a lesson file. The limits are the format's,
// not the school's, so they are constants rather than config. Lengths count characters (code points): a character
// outside the Basic Multilingual Plane is one, like any other.

export const MAX_TITLE_CHARS = 40
export const MAX_SEGMENT_TEXT_CHARS = 800
export const MAX_GIST_CHARS = 60
export const MAX_CALL_ON_QUESTION_CHARS = 120

/** A lesson that is not in the format. The message says what is wrong and where, in Chinese, for the reviewer. */
export class LessonFormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LessonFormatError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** One text of a lesson, trimmed: refused when it is missing, not text, blank or longer than `max` characters. */
export function lessonText(value: unknown, what: string, max: number): string {
  if (value === undefined || value === null) throw new LessonFormatError(`${what}不能为空`)
  if (typeof value !== 'string') throw new LessonFormatError(`${what}必须是文字`)
  const text = value.trim()
  if (text === '') throw new LessonFormatError(`${what}不能为空`)
  const chars = [...text].length
  if (chars > max) throw new LessonFormatError(`${what}不能超过 ${max} 个字，现在有 ${chars} 个字`)
  return text
}

/** What a message calls each text of a lesson; the field names are there for whoever writes the JSON. */
export const PART_NAMES = {
  title: '标题（title）',
  /** `index` is 0-based. */
  segmentText: (index: number) => `第 ${index + 1} 段的正文（text）`,
  segmentGist: (index: number) => `第 ${index + 1} 段的要点（gist）`,
  review: '复习题（callOnQuestions.review）',
  extension: '引申题（callOnQuestions.extension）',
} as const

function parseCallOnQuestions(value: unknown, optional: boolean): CallOnQuestions | null {
  if ((value === undefined || value === null) && optional) return null
  if (!isRecord(value)) {
    throw new LessonFormatError('缺少点名题：callOnQuestions 必须是 { review, extension }，复习题和引申题两道都要有')
  }
  return {
    review: lessonText(value.review, PART_NAMES.review, MAX_CALL_ON_QUESTION_CHARS),
    extension: lessonText(value.extension, PART_NAMES.extension, MAX_CALL_ON_QUESTION_CHARS),
  }
}

/**
 * Checks a lesson against the format and returns it, its texts trimmed; throws a `LessonFormatError` naming the first
 * thing wrong. It has as many segments as `lesson.segmentMinutes` has, each with a text and a gist, and both call-on
 * questions; only `callOnsOptional` (the importer, for lesson files from before them) lets those be left out, and they
 * are null then. The subject is `ctx.subject`, whatever the input says.
 */
export function parseLessonContent(
  config: SchoolConfig,
  input: unknown,
  ctx: { subject: string; callOnsOptional?: boolean },
): LessonContent {
  if (!isRecord(input)) throw new LessonFormatError('课程内容必须是一个对象：{ title, segments, callOnQuestions }')

  const title = lessonText(input.title, PART_NAMES.title, MAX_TITLE_CHARS)

  const expected = config.lesson.segmentMinutes.length
  const raw = input.segments
  if (!Array.isArray(raw)) throw new LessonFormatError('正文 segments 必须是一个列表，每一项是 { text, gist }')
  if (raw.length !== expected) {
    throw new LessonFormatError(`课程必须正好有 ${expected} 段，这一份有 ${raw.length} 段`)
  }
  const segments = raw.map((item: unknown, i): LessonSegment => {
    if (!isRecord(item)) throw new LessonFormatError(`第 ${i + 1} 段必须是 { text, gist } 对象`)
    return {
      text: lessonText(item.text, PART_NAMES.segmentText(i), MAX_SEGMENT_TEXT_CHARS),
      gist: lessonText(item.gist, PART_NAMES.segmentGist(i), MAX_GIST_CHARS),
    }
  })

  const callOnQuestions = parseCallOnQuestions(input.callOnQuestions, ctx.callOnsOptional === true)
  return { title, subject: ctx.subject, segments, callOnQuestions }
}
