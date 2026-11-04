import type { Kysely } from 'kysely'
import type { Division, SchoolConfig } from '../shared/config.js'
import { addDaysToDate, isoWeekday } from '../shared/local-time.js'
import type { Database } from '../shared/schema.js'

/** What a division does on a day: teach the day's lesson, or hold a study hall (自习). */
export type SessionPlan =
  | { kind: 'lesson'; lessonId: number; subject: string; title: string }
  /** `weekTitles` is what the week taught so far, for a weekend study hall to look back on; empty on other days. */
  | { kind: 'study'; weekTitles: string[] }

// Monday to Friday.
const WEEKDAY_SUBJECTS = ['语文', '数学', '英语', '科学', '人文'] as const

/**
 * The subject of a lesson on a topic given for its day (a topic lesson), in place of the day's own subject. The lesson
 * stores it like any subject, so the session and the opening read it from the lesson.
 */
export const SPECIAL_SUBJECT = '专题'

/**
 * The subject taught on a school day by default: Chinese, maths, English, science and humanities from Monday to
 * Friday, nothing at the weekend. A date names the same weekday in every time zone, so `timezone` does not change
 * the answer; it is part of the signature so that callers pass the school's zone along with the date.
 */
export function subjectForDate(date: string, timezone: string): string | null {
  return WEEKDAY_SUBJECTS[isoWeekday(date) - 1] ?? null
}

// Which days the school holds sessions on is the school calendar's to say (breaks and the opening day, as well as
// the weekend); the class service keeps asking planning for it.
export { isSchoolDay } from '../shared/calendar.js'

/**
 * The titles of the lessons a class taught from Monday to Friday of the week `date` is in, in date order. A lesson
 * approved for a day that was a study hall all the same was never taught, so it is not one of them.
 */
async function weekTitles(db: Kysely<Database>, p: { date: string; division: Division }): Promise<string[]> {
  const monday = addDaysToDate(p.date, 1 - isoWeekday(p.date))
  const rows = await db
    .selectFrom('lessons as l')
    .select('l.title')
    .where('l.division', '=', p.division)
    .where('l.date', '>=', monday)
    .where('l.date', '<=', addDaysToDate(monday, 4))
    .where((eb) =>
      eb.exists(
        eb.selectFrom('classSessions as s').select('s.id').whereRef('s.lessonId', '=', 'l.id').where('s.kind', '=', 'lesson'),
      ),
    )
    .orderBy('l.date')
    .execute()
  return rows.map((r) => r.title)
}

/**
 * What a study hall on `date` looks back on: the lesson titles of its week at the weekend (when the config has it so),
 * none on other days.
 */
export async function studyWeekTitles(
  db: Kysely<Database>,
  config: SchoolConfig,
  p: { date: string; division: Division },
): Promise<string[]> {
  const weekend = isoWeekday(p.date) >= 6
  return weekend && config.lesson.weekendStudy ? weekTitles(db, p) : []
}

async function studyPlan(
  db: Kysely<Database>,
  config: SchoolConfig,
  p: { date: string; division: Division },
): Promise<SessionPlan> {
  return { kind: 'study', weekTitles: await studyWeekTitles(db, config, p) }
}

/**
 * Decides whether a division teaches a lesson or holds a study hall on `date`.
 *
 * The first class of the division to begin that day decides for all of them, so the morning, afternoon and evening
 * classes get the same thing: a lesson approved after the morning class began a study hall is not taught later that
 * day. Before any class has begun, the day is a lesson if it is a weekday with an approved lesson, else a study hall.
 */
export async function planSession(
  db: Kysely<Database>,
  config: SchoolConfig,
  p: { date: string; division: Division },
): Promise<SessionPlan> {
  const decided = await db
    .selectFrom('classSessions as s')
    .innerJoin('classes as c', 'c.id', 's.classId')
    .leftJoin('lessons as l', 'l.id', 's.lessonId')
    .select(['s.kind', 's.lessonId', 'l.subject', 'l.title'])
    .where('s.date', '=', p.date)
    .where('c.division', '=', p.division)
    .orderBy('s.startsAt')
    .orderBy('s.id')
    .limit(1)
    .executeTakeFirst()

  if (decided !== undefined) {
    if (decided.kind === 'study') return studyPlan(db, config, p)
    if (decided.lessonId === null || decided.subject === null || decided.title === null) {
      throw new Error(`A lesson session on ${p.date} (${p.division}) names no lesson`)
    }
    return { kind: 'lesson', lessonId: decided.lessonId, subject: decided.subject, title: decided.title }
  }

  if (isoWeekday(p.date) <= 5) {
    const lesson = await db
      .selectFrom('lessons')
      .select(['id', 'subject', 'title'])
      .where('date', '=', p.date)
      .where('division', '=', p.division)
      .where('approvedAt', 'is not', null)
      .executeTakeFirst()
    if (lesson !== undefined) return { kind: 'lesson', lessonId: lesson.id, subject: lesson.subject, title: lesson.title }
  }
  return studyPlan(db, config, p)
}
