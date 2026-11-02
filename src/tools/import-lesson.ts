import { readFileSync } from 'node:fs'
import type { Kysely } from 'kysely'
import { subjectForDate } from '../class/planning.js'
import { systemClock, type Clock } from '../shared/clock.js'
import { loadEnv, loadSchoolConfig, type Division, type SchoolConfig } from '../shared/config.js'
import { createDb, lessonLockKey, lock } from '../shared/db.js'
import { isDateText, isoWeekday } from '../shared/local-time.js'
import { loadModerationData } from '../moderation/load.js'
import { createModerator, type ModerationCategory, type Moderator } from '../moderation/moderator.js'
import type { Database, LessonSegment } from '../shared/schema.js'
import { isEntryPoint } from './entry-point.js'

// `npm run lesson:import -- <file.json> [--approve]`: reads one lesson from a JSON file and stores it for its day and
// division. The file is `{ "date": "2026-11-04", "division": "junior", "title": "...", "subject": "...",
// "segments": [{ "text": "...", "gist": "..." }, ...] }`. The date is a weekday (the weekend has study halls at most);
// `subject` may be left out.

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
  title: string
  subject: string
  /** Whether the file named the subject, as opposed to it following from the date. */
  subjectGiven: boolean
  segments: LessonSegment[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A string with something in it, trimmed; null for anything else. */
function nonBlank(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

/** Checks the shape of the file and turns it into a lesson, or throws a `LessonImportError` naming what is wrong. */
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

  const title = nonBlank(input.title)
  if (title === null) throw new LessonImportError('title 必须是不为空的文字')

  const subjectGiven = input.subject !== undefined
  // Every weekday has a default subject.
  const subject = subjectGiven ? nonBlank(input.subject) : subjectForDate(date, config.timezone)
  if (subject === null) throw new LessonImportError('subject 必须是不为空的文字')

  const expected = config.lesson.segmentMinutes.length
  const raw = input.segments
  if (!Array.isArray(raw)) throw new LessonImportError('segments 必须是一个列表，每一项是 { text, gist }')
  if (raw.length !== expected) {
    throw new LessonImportError(
      `课程必须正好有 ${expected} 段（配置里 lesson.segmentMinutes 有 ${expected} 个时间点），文件里有 ${raw.length} 段`,
    )
  }
  const segments = raw.map((item: unknown, i): LessonSegment => {
    if (!isRecord(item)) throw new LessonImportError(`第 ${i + 1} 段必须是 { text, gist } 对象`)
    const text = nonBlank(item.text)
    if (text === null) throw new LessonImportError(`第 ${i + 1} 段的 text 必须是不为空的文字`)
    const gist = nonBlank(item.gist)
    if (gist === null) throw new LessonImportError(`第 ${i + 1} 段的 gist 必须是不为空的文字`)
    return { text, gist }
  })

  return { date, division: division as Division, title, subject, subjectGiven, segments }
}

const CATEGORY_NAMES: Record<ModerationCategory, string> = {
  sensitive: '敏感词',
  injection: '诱导话术',
  privacy: '个人隐私',
}

/**
 * Runs everything the students would read through the moderator. It names where each hit is and which category it
 * is in, never what matched, so that the operator's terminal does not become a copy of the word list.
 */
function blockedPlaces(moderator: Moderator, lesson: ParsedLesson): string[] {
  const places: [string, string][] = [['标题', lesson.title]]
  if (lesson.subjectGiven) places.push(['科目', lesson.subject])
  lesson.segments.forEach((s, i) => {
    places.push([`第 ${i + 1} 段正文`, s.text], [`第 ${i + 1} 段要点`, s.gist])
  })

  const blocked: string[] = []
  for (const [place, text] of places) {
    const result = moderator.check(text)
    if (result.verdict === 'blocked') blocked.push(`${place}（${CATEGORY_NAMES[result.category]}）`)
  }
  return blocked
}

/**
 * Stores a lesson, as a draft or approved. When the day and division already have a lesson, it is overwritten in
 * place (it keeps its number) and is a draft again unless approved now, since the approval was for the old text;
 * a lesson that a class has already begun is never overwritten. Throws a `LessonImportError` when the file is
 * refused, and nothing is written then.
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

  const now = opts.clock.now()
  const approvedAt = opts.approve ? now : null
  const segments = JSON.stringify(lesson.segments)

  const saved = await db.transaction().execute(async (trx) => {
    await lock(trx, lessonLockKey(lesson.date, lesson.division))
    // `for update` also holds off a class that is starting a session on this lesson right now: its foreign key
    // check waits for this transaction, and the check below then sees it.
    const existing = await trx
      .selectFrom('lessons')
      .select('id')
      .where('date', '=', lesson.date)
      .where('division', '=', lesson.division)
      .forUpdate()
      .executeTakeFirst()

    if (existing === undefined) {
      const row = await trx
        .insertInto('lessons')
        .values({
          date: lesson.date,
          division: lesson.division,
          subject: lesson.subject,
          title: lesson.title,
          segments,
          approvedAt,
          createdAt: now,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
      return { id: row.id, replaced: false }
    }

    const taught = await trx
      .selectFrom('classSessions')
      .select('id')
      .where('lessonId', '=', existing.id)
      .limit(1)
      .executeTakeFirst()
    if (taught !== undefined) {
      const label = config.divisions[lesson.division].label
      throw new LessonImportError(`${lesson.date} ${label}的课程已经开始上过了，不能覆盖（课程编号 ${existing.id}）`)
    }

    await trx
      .updateTable('lessons')
      .set({ subject: lesson.subject, title: lesson.title, segments, approvedAt })
      .where('id', '=', existing.id)
      .execute()
    return { id: existing.id, replaced: true }
  })

  return { lessonId: saved.id, subject: lesson.subject, replaced: saved.replaced, approved: opts.approve }
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
    const moderator = createModerator(loadModerationData(env.moderationDataDir))
    const db = createDb(env.databaseUrl)
    try {
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
