import { describe, expect, test } from 'vitest'
import {
  LessonFormatError,
  LessonTooLong,
  MAX_CALL_ON_QUESTION_CHARS,
  MAX_GIST_CHARS,
  MAX_SEGMENT_TEXT_CHARS,
  MAX_TITLE_CHARS,
  parseLessonContent,
} from '../../src/lessons/format.js'
import type { SchoolConfig } from '../../src/shared/config.js'
import { exampleConfig } from '../helpers/app.js'

// The example config has five segments.
const config = exampleConfig()

const segments = (n = 5) => Array.from({ length: n }, (_, i) => ({ text: `第${i + 1}段正文`, gist: `第${i + 1}段要点` }))
const callOnQuestions = { review: '光从空气斜射进水里时，会往哪边偏？', extension: '为什么筷子插进水里看起来是弯的？' }

const lesson = (over: Record<string, unknown> = {}) => ({ title: '光的折射', segments: segments(), callOnQuestions, ...over })

const parse = (input: unknown, ctx: { subject?: string; callOnsOptional?: boolean } = {}, on: SchoolConfig = config) =>
  parseLessonContent(on, input, { subject: '科学', ...ctx })

/** The Chinese reason a lesson is refused with. */
function reason(input: unknown, ctx: { callOnsOptional?: boolean } = {}, on: SchoolConfig = config): string {
  let err: unknown = null
  try {
    parse(input, ctx, on)
  } catch (e) {
    err = e
  }
  expect(err).toBeInstanceOf(LessonFormatError)
  return (err as LessonFormatError).message
}

const withSegment = (n: number, segment: Record<string, unknown>) =>
  lesson({ segments: segments().map((s, i) => (i === n - 1 ? segment : s)) })

describe('parseLessonContent', () => {
  test('returns the lesson with the subject it was asked for, trimmed', () => {
    const content = parse(
      lesson({
        title: '  光的折射 ',
        subject: '美术',
        segments: segments().map((s, i) => (i === 0 ? { text: '\n第一行\n\n第三行 ', gist: ' 要点 ' } : s)),
        callOnQuestions: { review: ` ${callOnQuestions.review}\n`, extension: callOnQuestions.extension },
      }),
    )
    expect(content).toEqual({
      title: '光的折射',
      subject: '科学',
      segments: [{ text: '第一行\n\n第三行', gist: '要点' }, ...segments().slice(1)],
      callOnQuestions,
    })
  })

  test.each([3, 4, 6])('refuses %i segments when the school has 5', (n) => {
    const message = reason(lesson({ segments: segments(n) }))
    expect(message).toContain('5 段')
    expect(message).toContain(`${n} 段`)
  })

  test('the number of segments follows lesson.segmentMinutes', () => {
    const three: SchoolConfig = { ...config, lesson: { ...config.lesson, segmentMinutes: [10, 20, 25] } }
    expect(parse(lesson({ segments: segments(3) }), {}, three).segments).toHaveLength(3)
    expect(reason(lesson(), {}, three)).toContain('3 段')
  })

  test.each([
    ['not an object', '光的折射', /对象/],
    ['an array', [], /对象/],
    ['no title', lesson({ title: undefined }), /标题/],
    ['a blank title', lesson({ title: ' \n ' }), /标题.*不能为空/],
    ['a title that is a number', lesson({ title: 7 }), /标题/],
    ['segments that are not a list', lesson({ segments: 'a' }), /segments/],
    ['a segment that is not an object', lesson({ segments: [1, 2, 3, 4, 5] }), /第 1 段/],
    ['a segment with no text', withSegment(3, { gist: '要点' }), /第 3 段的正文.*不能为空/],
    ['a segment with a blank text', withSegment(3, { text: '  ', gist: '要点' }), /第 3 段的正文.*不能为空/],
    ['a segment with a blank gist', withSegment(5, { text: '正文', gist: '' }), /第 5 段的要点.*不能为空/],
    ['a segment with a gist that is a number', withSegment(5, { text: '正文', gist: 1 }), /第 5 段的要点/],
  ])('refuses %s, saying where', (_name, input, pattern) => {
    expect(reason(input)).toMatch(pattern)
  })

  describe('lengths, counted in characters', () => {
    const over = (max: number) => '字'.repeat(max + 1)
    // One character that takes two UTF-16 code units: a limit counts it once.
    const wide = (max: number) => '𠀀'.repeat(max)

    test('a title up to 40 characters', () => {
      expect(MAX_TITLE_CHARS).toBe(40)
      expect(parse(lesson({ title: wide(40) })).title).toBe(wide(40))
      expect(reason(lesson({ title: over(40) }))).toMatch(/标题.*40 个字.*41 个字/)
    })

    test('a segment text up to 800 characters', () => {
      expect(MAX_SEGMENT_TEXT_CHARS).toBe(800)
      expect(parse(withSegment(2, { text: wide(800), gist: '要点' })).segments[1]?.text).toBe(wide(800))
      expect(reason(withSegment(2, { text: over(800), gist: '要点' }))).toMatch(/第 2 段的正文.*800 个字.*801 个字/)
    })

    test('a gist up to 60 characters', () => {
      expect(MAX_GIST_CHARS).toBe(60)
      expect(parse(withSegment(4, { text: '正文', gist: wide(60) })).segments[3]?.gist).toBe(wide(60))
      expect(reason(withSegment(4, { text: '正文', gist: over(60) }))).toMatch(/第 4 段的要点.*60 个字.*61 个字/)
    })

    test('a call-on question up to 120 characters', () => {
      expect(MAX_CALL_ON_QUESTION_CHARS).toBe(120)
      const review = wide(120)
      expect(parse(lesson({ callOnQuestions: { ...callOnQuestions, review } })).callOnQuestions?.review).toBe(review)
      expect(reason(lesson({ callOnQuestions: { ...callOnQuestions, extension: over(120) } }))).toMatch(
        /引申题.*120 个字.*121 个字/,
      )
    })

    test('the spaces around a text do not count', () => {
      expect(parse(lesson({ title: ` ${'字'.repeat(40)} ` })).title).toHaveLength(40)
    })

    test('every text too long is named, in the order of the lesson, with where it is in the reply', () => {
      let err: unknown = null
      try {
        parse(
          lesson({
            title: over(40),
            segments: segments().map((s, i) => (i === 2 ? { text: over(800), gist: over(60) } : s)),
            callOnQuestions: { ...callOnQuestions, extension: over(120) },
          }),
        )
      } catch (e) {
        err = e
      }
      expect(err).toBeInstanceOf(LessonTooLong)
      expect((err as LessonTooLong).parts).toEqual([
        { path: ['title'], name: '标题（title）', chars: 41, max: 40 },
        { path: ['segments', 2, 'text'], name: '第 3 段的正文（text）', chars: 801, max: 800 },
        { path: ['segments', 2, 'gist'], name: '第 3 段的要点（gist）', chars: 61, max: 60 },
        { path: ['callOnQuestions', 'extension'], name: '引申题（callOnQuestions.extension）', chars: 121, max: 120 },
      ])
      expect((err as LessonTooLong).message).toBe(
        '标题（title）不能超过 40 个字，现在有 41 个字；第 3 段的正文（text）不能超过 800 个字，现在有 801 个字；' +
          '第 3 段的要点（gist）不能超过 60 个字，现在有 61 个字；引申题（callOnQuestions.extension）不能超过 120 个字，现在有 121 个字',
      )
    })

    test('any other fault comes before the lengths', () => {
      const both = lesson({ title: over(40), segments: segments(4) })
      expect(() => parse(both)).toThrow(LessonFormatError)
      expect(() => parse(both)).not.toThrow(LessonTooLong)
      expect(reason(lesson({ title: over(40), callOnQuestions: { review: '复习' } }))).toMatch(/引申题.*不能为空/)
    })
  })

  describe('the call-on questions', () => {
    test.each([
      ['none', lesson({ callOnQuestions: undefined }), /点名题/],
      ['null', lesson({ callOnQuestions: null }), /点名题/],
      ['not an object', lesson({ callOnQuestions: '复习题' }), /点名题/],
      ['no review question', lesson({ callOnQuestions: { extension: callOnQuestions.extension } }), /复习题.*不能为空/],
      ['a blank extension question', lesson({ callOnQuestions: { ...callOnQuestions, extension: ' ' } }), /引申题.*不能为空/],
    ])('are both needed: refuses %s', (_name, input, pattern) => {
      expect(reason(input)).toMatch(pattern)
    })

    test('may be left out where they are optional (the importer), and are null then', () => {
      expect(parse(lesson({ callOnQuestions: undefined }), { callOnsOptional: true }).callOnQuestions).toBeNull()
      expect(parse(lesson({ callOnQuestions: null }), { callOnsOptional: true }).callOnQuestions).toBeNull()
    })

    test('are checked all the same when an optional pair is given', () => {
      expect(parse(lesson(), { callOnsOptional: true }).callOnQuestions).toEqual(callOnQuestions)
      expect(reason(lesson({ callOnQuestions: { review: '复习' } }), { callOnsOptional: true })).toMatch(/引申题/)
    })
  })
})
