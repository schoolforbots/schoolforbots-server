import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export type PromptName =
  | 'lesson-generate'
  | 'lesson-rewrite-segment'
  | 'lesson-rewrite'
  | 'lesson-rewrite-call-on'
  | 'teacher-answer'
  | 'teacher-comment'
  | 'second-layer'
  | 'weekly-false-positives'
  | 'weekly-reasons'
  | 'word-list-tidy'

export interface PromptTemplate {
  system: string
  user: string
}

const LESSON = ['division', 'subject', 'topic', 'direction', 'pastTitles', 'segmentCount', 'segmentMinutes', 'reviewScope', 'extensionTarget', 'format']

/**
 * The placeholders each prompt may use. A listed placeholder may be left out of a file, except `format`: code fills it
 * with the exact reply shape its parser accepts, so a prompt that lists it must contain it.
 */
export const PROMPT_PLACEHOLDERS: Record<PromptName, readonly string[]> = {
  'lesson-generate': LESSON,
  'lesson-rewrite': [...LESSON, 'currentLesson', 'reason'],
  'lesson-rewrite-segment': ['division', 'subject', 'title', 'currentLesson', 'segmentIndex', 'segmentText', 'reason', 'direction', 'format'],
  'lesson-rewrite-call-on': ['division', 'subject', 'title', 'currentLesson', 'callOnKind', 'currentQuestion', 'scope', 'reason', 'direction', 'format'],
  'teacher-answer': ['teacherName', 'teacherPersona', 'segmentText', 'questions', 'maxChars', 'format'],
  'teacher-comment': ['teacherName', 'teacherPersona', 'callOnKind', 'question', 'answer', 'segmentText', 'maxChars'],
  'second-layer': ['source', 'items', 'format'],
  'weekly-false-positives': ['groups', 'format'],
  'weekly-reasons': ['reasons', 'format'],
  'word-list-tidy': ['words', 'format'],
}

const SYSTEM_MARK = '--- system ---'
const USER_MARK = '--- user ---'
const PLACEHOLDER = /\{\{(\w+)\}\}/g

function parseFile(name: PromptName, file: string, text: string): PromptTemplate {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/)
  const sys = lines.findIndex((l) => l.trim() === SYSTEM_MARK)
  const usr = lines.findIndex((l) => l.trim() === USER_MARK)
  if (sys === -1 || usr === -1 || usr < sys) {
    throw new Error(`提示词 ${name}（${file}）必须依次包含 "${SYSTEM_MARK}" 和 "${USER_MARK}" 两行`)
  }
  const template = {
    system: lines.slice(sys + 1, usr).join('\n').trim(),
    user: lines.slice(usr + 1).join('\n').trim(),
  }
  const allowed = PROMPT_PLACEHOLDERS[name]
  const used = new Set<string>()
  for (const part of [template.system, template.user]) for (const m of part.matchAll(PLACEHOLDER)) used.add(m[1] ?? '')
  for (const p of used) {
    if (!allowed.includes(p)) throw new Error(`提示词 ${name}（${file}）用了未知的占位符 {{${p}}}，可用的有：${allowed.join('、')}`)
  }
  if (allowed.includes('format') && !used.has('format')) {
    throw new Error(`提示词 ${name}（${file}）必须包含 {{format}}，程序在这里填入回复格式`)
  }
  return template
}

/** Reads `<name>.md`, or `<name>.example.md` (with a stderr warning) when it is missing. */
export function loadPrompts(dir: string): Record<PromptName, PromptTemplate> {
  const out = {} as Record<PromptName, PromptTemplate>
  for (const name of Object.keys(PROMPT_PLACEHOLDERS) as PromptName[]) {
    const real = join(dir, `${name}.md`)
    let file = real
    if (!existsSync(real)) {
      file = join(dir, `${name}.example.md`)
      if (!existsSync(file)) throw new Error(`提示词 ${name} 缺失：既没有 ${real}，也没有 ${file}`)
      process.stderr.write(`[prompts] 未找到 ${real}，改用示例文件 ${file}（只是通用示例，部署前请放入真实提示词）\n`)
    }
    out[name] = parseFile(name, file, readFileSync(file, 'utf8'))
  }
  return out
}

/**
 * Fills all placeholders in one pass, so a value that looks like `{{…}}` is not expanded again. A placeholder the
 * template uses but the caller did not supply is a bug in the caller, so it throws.
 */
export function fillPrompt(t: PromptTemplate, vars: Record<string, string>): { system: string; user: string } {
  const fill = (s: string) =>
    s.replace(PLACEHOLDER, (_, name: string) => {
      const v = Object.hasOwn(vars, name) ? vars[name] : undefined
      if (v === undefined) throw new Error(`提示词用到了占位符 {{${name}}}，但调用方没有提供`)
      return v
    })
  return { system: fill(t.system), user: fill(t.user) }
}

const OPENERS = '[{<〔【「『《〈［｛＜﹝〖〘〚⟦⟨'
const CLOSERS = ']}>〕】」』》〉］｝＞﹞〗〙〛⟧⟩'

/**
 * Makes one student-written value safe to place inside a delimited data block of a prompt. Callers apply it to each
 * student value (a question, an answer, a blocked message, a reason) before building `{{questions}}`, `{{answer}}`,
 * `{{items}}`, `{{reasons}}` or `{{groups}}`, so the value cannot close the block or start a forged numbered entry.
 *
 * Every bracket form (ASCII, full-width, CJK corner and angle brackets) becomes a full-width parenthesis, which
 * templates must not use as a delimiter, so this works whatever delimiter characters a real prompt picks. All line
 * breaks and runs of whitespace become a single space. `maxChars`, when given, cuts the result by code points.
 */
export function neutralizeStudentText(s: string, maxChars?: number): string {
  let out = ''
  for (const ch of s) out += OPENERS.includes(ch) || ch === '(' ? '（' : CLOSERS.includes(ch) || ch === ')' ? '）' : ch
  out = out.replace(/\s+/gu, ' ').trim()
  return maxChars === undefined ? out : [...out].slice(0, maxChars).join('')
}
