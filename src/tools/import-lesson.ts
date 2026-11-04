import { readFileSync } from 'node:fs'
import type { Kysely } from 'kysely'
import { subjectForDate } from '../class/planning.js'
import { LessonFormatError, parseLessonContent } from '../lessons/format.js'
import {
  approve as approveLesson,
  LessonHasFlags,
  LessonLocked,
  saveDraft,
  StaleLessonVersion,
} from '../lessons/store.js'
import { systemClock, type Clock } from '../shared/clock.js'
import { loadEnv, loadSchoolConfig, type Division, type SchoolConfig } from '../shared/config.js'
import { createDb } from '../shared/db.js'
import { isDateText, isoWeekday } from '../shared/local-time.js'
import { loadModerationData } from '../moderation/load.js'
import type { ModerationCategory, Moderator } from '../moderation/moderator.js'
import { startLiveModerator } from '../moderation/rules.js'
import type { Database, LessonContent } from '../shared/schema.js'
import { isEntryPoint } from './entry-point.js'

// `npm run lesson:import -- <file.json> [--approve]`: reads one lesson from a JSON file and stores it for its day and
// division. The file is `{ "date": "2026-11-04", "division": "junior", "title": "...", "subject": "...",
// "segments": [{ "text": "...", "gist": "..." }, ...], "callOnQuestions": { "review": "...", "extension": "..." } }`.
// The date is a weekday (the weekend has study halls at most); `subject` may be left out, and so may
// `callOnQuestions`: a lesson without them calls on nobody. The lesson is checked like any other (see
// `parseLessonContent`) and stored through the lesson store, as a new version when the day already has one.

/** An import that was refused. The message says why, in Chinese, for the person running the command. */
export class LessonImportError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LessonImportError'
  }
}

export interface ImportOptions {
  /** Approve the lesson for teaching; without it the lesson is stored as a draft that no class teaches. */
  approve: boolean
  /** The source of `createdAt` and `approvedAt`. */
  clock: Clock
}

export interface ImportResult {
  lessonId: number
  subject: string
  /** The day and division already had a lesson, and this one took its place. */
  replaced: boolean
  approved: boolean
}

interface ParsedLesson {
  date: string
  division: Division
  /** Whether the file named the subject, as opposed to it following from the date. */
  subjectGiven: boolean
  content: LessonContent
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A string with something in it, trimmed; null for anything else. */
function nonBlank(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

/** Checks the file and turns it into a lesson, or throws a `LessonImportError` naming what is wrong. */
function parseLesson(config: SchoolConfig, input: unknown): ParsedLesson {
  if (!isRecord(input)) throw new LessonImportError('课程文件的内容必须是一个对象：{ date, division, title, segments }')

  const { date, division } = input
  if (typeof date !== 'string' || !isDateText(date)) {
    throw new LessonImportError('date 必须是真实存在的日期，写成 YYYY-MM-DD，例如 2026-11-04')
  }
  // A weekend is a study hall looking back on the week, or a holiday: a lesson for it would never be taught.
  if (isoWeekday(date) >= 6) {
    throw new LessonImportError(`${date} 是周末，周末不上新课（只上自习，回顾这一周的课），请换成周一到周五的日期`)
  }
  const divisions = Object.keys(config.divisions)
  if (typeof division !== 'string' || !Object.hasOwn(config.divisions, division)) {
    throw new LessonImportError(`division 必须是 ${divisions.join('、')} 之一`)
  }

  const subjectGiven = input.subject !== undefined
  // Every weekday has a default subject.
  const subject = subjectGiven ? nonBlank(input.subject) : subjectForDate(date, config.timezone)
  if (subject === null) throw new LessonImportError('subject 必须是不为空的文字')

  let content: LessonContent
  try {
    // Lesson files from before the call-on questions have none.
    content = parseLessonContent(config, input, { subject, callOnsOptional: true })
  } catch (err) {
    if (err instanceof LessonFormatError) throw new LessonImportError(err.message)
    throw err
  }
  return { date, division: division as Division, subjectGiven, content }
}

const CATEGORY_NAMES: Record<ModerationCategory, string> = {
  sensitive: '敏感词',
  injection: '诱导话术',
  privacy: '个人隐私',
}

/**
 * Runs everything the students would read through the moderator. It names where each hit is and which category it
 * is in, never what matched, so that the operator's terminal does not become a copy of the word list.
 *
 * The importer refuses such a lesson outright, rather than storing it with red marks to be reviewed.
 */
function blockedPlaces(moderator: Moderator, lesson: ParsedLesson): string[] {
  const { content } = lesson
  const places: [string, string][] = [['标题', content.title]]
  if (lesson.subjectGiven) places.push(['科目', content.subject])
  content.segments.forEach((s, i) => {
    places.push([`第 ${i + 1} 段正文`, s.text], [`第 ${i + 1} 段要点`, s.gist])
  })
  if (content.callOnQuestions !== null) {
    places.push(['复习题', content.callOnQuestions.review], ['引申题', content.callOnQuestions.extension])
  }

  const blocked: string[] = []
  for (const [place, text] of places) {
    const result = moderator.check(text)
    if (result.verdict === 'blocked') blocked.push(`${place}（${CATEGORY_NAMES[result.category]}）`)
  }
  return blocked
}

/**
 * Stores a lesson, as a draft or approved. When the day and division already have a lesson, the file becomes its next
 * version (it keeps its number) and it is a draft again unless approved now, since the approval was for the old text;
 * a lesson that a class has already begun is never overwritten. Throws a `LessonImportError` when the file is refused,
 * and nothing is written then; when only the approval is refused, the lesson stays stored as a draft, and the message
 * says so.
 */
export async function importLesson(
  db: Kysely<Database>,
  config: SchoolConfig,
  moderator: Moderator,
  input: unknown,
  opts: ImportOptions,
): Promise<ImportResult> {
  const lesson = parseLesson(config, input)

  const blocked = blockedPlaces(moderator, lesson)
  if (blocked.length > 0) {
    throw new LessonImportError(`内容没有通过审核，已拒绝导入：\n${blocked.map((b) => `  ${b}`).join('\n')}`)
  }

  const deps = { db, clock: opts.clock, moderator }
  const { date, division, content } = lesson
  try {
    // The tool keeps its own rule: only a lesson a class has taught is never overwritten (see `LockRule`).
    const lockedWhen = 'lesson_taught'
    const saved = await saveDraft(deps, { date, division }, content, { source: 'import', change: 'generate', lockedWhen })
    // Approved separately, so a lesson some other change got to in between stays a draft (`StaleLessonVersion`).
    if (opts.approve) await approveLesson(deps, saved.lessonId, saved.version, { lockedWhen })
    // A new lesson starts at version 1; one that was there already moves past it.
    return { lessonId: saved.lessonId, subject: content.subject, replaced: saved.version > 1, approved: opts.approve }
  } catch (err) {
    if (err instanceof LessonLocked) {
      const label = config.divisions[division].label
      throw new LessonImportError(`${date} ${label}的课程已经开始上过了，不能覆盖（课程编号 ${err.lessonId}）`)
    }
    if (err instanceof LessonHasFlags) {
      throw new LessonImportError(`课程已存成草稿，但还有 ${err.count} 处红笔标记，不能直接审批（课程编号 ${err.lessonId}）`)
    }
    if (err instanceof StaleLessonVersion) {
      throw new LessonImportError(`课程已存成草稿，但在审批前被别处改过了，没有审批（课程编号 ${err.lessonId}）`)
    }
    throw err
  }
}

const USAGE = '用法：npm run lesson:import -- <课程文件.json> [--approve]'

/** Reads the file the operator named. Only says that it could not be read or parsed, never what is in it. */
function readLessonFile(path: string): unknown {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (err) {
    const code = err instanceof Error && 'code' in err ? `（${String(err.code)}）` : ''
    throw new LessonImportError(`读不了文件 ${path}${code}`)
  }
  try {
    return JSON.parse(text.replace(/^﻿/, ''))
  } catch {
    // The parser's own message quotes a piece of the text, which is not for the log.
    throw new LessonImportError(`${path} 不是合法的 JSON，请检查括号、逗号和引号`)
  }
}

/** Returns the process exit code: 0 when the lesson was stored, 1 when it was refused or something failed. */
async function main(argv: string[]): Promise<number> {
  const approve = argv.includes('--approve')
  const paths = argv.filter((arg) => arg !== '--approve')
  const path = paths[0]
  if (path === undefined || paths.length > 1 || path.startsWith('--')) {
    console.error(USAGE)
    return 1
  }

  try {
    const input = readLessonFile(path)
    const env = loadEnv(process.env)
    const config = loadSchoolConfig(env.configPath)
    const data = loadModerationData(env.moderationDataDir)
    const db = createDb(env.databaseUrl, env.databaseTimeouts)
    try {
      // The word list less the rules an operator dropped, as the services have it. Read once: the import is over
      // long before they could change.
      const moderator = await startLiveModerator({ db, data })
      moderator.stop()
      const result = await importLesson(db, config, moderator, input, { approve, clock: systemClock })
      console.log(`课程已导入，课程编号 ${result.lessonId}${result.replaced ? '（覆盖了这一天这个学部原来的课程）' : ''}`)
      console.log(
        result.approved
          ? '状态：已审批，可以上课'
          : '状态：草稿，还没有审批，班级不会上它。确认无误后，加 --approve 再导入一次即可审批',
      )
    } finally {
      await db.destroy()
    }
    return 0
  } catch (err) {
    if (err instanceof LessonImportError) {
      console.error(`导入失败：${err.message}`)
    } else {
      console.error('导入失败', err)
    }
    return 1
  }
}

if (isEntryPoint(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error('导入失败', err)
      process.exit(1)
    },
  )
}
