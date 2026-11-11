import type { Kysely } from 'kysely'
import type { Static } from 'typebox'
import type { Summary as SummarySchema } from '../protocol/http.js'
import type { Clock } from '../shared/clock.js'
import type { SchoolConfig } from '../shared/config.js'
import { className } from '../shared/identity.js'
import { recordText } from '../shared/record-text.js'
import type { Database, DisciplineKind } from '../shared/schema.js'
import { namesOf } from './discipline.js'
import { CUT_SHORT } from './events.js'
import type { Hub } from './hub.js'
import { studyWeekTitles } from './planning.js'
import { callsOf, MalformedCallError, type Call } from './questions.js'
import type { ActiveSession } from './runtime.js'
import { callOnQuestion } from './teacher.js'

// The after-school summary: for each student who attended a session, what the owner is told about it. It is written
// once the lesson is over and kept in the summaries table, where the owner reads it through the registration service
// (`GET /v1/me/summaries`); a student still online gets it pushed as well.

type Summary = Static<typeof SummarySchema>

export interface SummaryDeps {
  db: Kysely<Database>
  config: SchoolConfig
  clock: Clock
  hub: Hub
  /** A program log line: numbers only, never what anyone said. */
  log?: (obj: object, msg: string) => void
}

/** The records a summary lists as the student's own criticisms: what they did, and what the teacher stopped. */
const CRITICISM_KINDS = [
  'initiations',
  'rounds',
  'school_rule',
  'privacy_block',
] as const satisfies readonly DisciplineKind[]

/**
 * The session's call-ons. Events that cannot be read are left out of the summaries (nobody is shown as called on)
 * rather than failing them: a failure would keep the session from ever closing. Only the session's number is logged.
 */
async function callsOfSession(deps: SummaryDeps, sessionId: number): Promise<Call[]> {
  try {
    return await callsOf(deps.db, sessionId)
  } catch (err) {
    if (!(err instanceof MalformedCallError)) throw err
    deps.log?.({ sessionId }, 'call-on events unreadable, summaries written without it')
    return []
  }
}

/** The teacher's line calling a student on, without the name: the lesson's own question. */
function bareQuestion(call: Call): string {
  const prefix = callOnQuestion(call.displayName, '')
  return call.question.startsWith(prefix) ? call.question.slice(prefix.length) : call.question
}

type TeacherAnswer = Summary['teacherAnswers'][number]

/** The session's `qa` events in segment order: what the teacher answered, and who asked it. */
async function teacherAnswersOf(db: Kysely<Database>, sessionId: number): Promise<TeacherAnswer[]> {
  const rows = await db
    .selectFrom('classEvents')
    .select('payload')
    .where('sessionId', '=', sessionId)
    .where('kind', '=', 'qa')
    .orderBy('seq')
    .execute()
  return rows
    .map(({ payload: p }) => ({
      segment: p.segment as number,
      askedBy: { studentId: p.studentId as number, displayName: p.displayName as string },
      question: p.question as string,
      answer: p.answer as string,
    }))
    .sort((a, b) => a.segment - b.segment)
}

/** Everything the summaries of a session have in common, and what differs from student to student. */
async function summariesOf(
  deps: SummaryDeps,
  session: ActiveSession,
  studentIds: number[],
): Promise<Map<number, Summary>> {
  const { db, config } = deps
  const { sessionId } = session

  const header = await db
    .selectFrom('classSessions as s')
    .innerJoin('classes as c', 'c.id', 's.classId')
    .leftJoin('lessons as l', 'l.id', 's.lessonId')
    .select(['s.date', 's.kind', 'c.division', 'c.slot', 'c.classNo', 'c.teacherPersonaId'])
    .select(['l.subject', 'l.title', 'l.segments'])
    .where('s.id', '=', sessionId)
    .executeTakeFirstOrThrow()
  // A teacher the config no longer lists still gets a name: the id is all that is left of them (as in the admission).
  const teacher = config.teacherPersonas.find((p) => p.id === header.teacherPersonaId)
  const lesson =
    header.kind === 'lesson' && header.subject !== null && header.title !== null && header.segments !== null
      ? {
          subject: header.subject,
          title: header.title,
          segments: header.segments.map((segment, i) => ({ index: i + 1, gist: segment.gist })),
        }
      : null
  const weekTitles =
    header.kind === 'study' ? await studyWeekTitles(db, config, { date: header.date, division: header.division }) : []

  // Who each student talked with: the lines that were delivered, a closing grace line included, whoever spoke.
  const lines = await db
    .selectFrom('messages')
    .select(['senderId', 'recipientId'])
    .distinct()
    .where('sessionId', '=', sessionId)
    .where('kind', 'in', ['chat', 'closing'])
    .where('delivered', '=', true)
    .where('recipientId', 'is not', null)
    .execute()
  const partners = new Map<number, Set<number>>()
  const talked = (studentId: number, other: number) => {
    const set = partners.get(studentId) ?? new Set<number>()
    partners.set(studentId, set.add(other))
  }
  for (const { senderId, recipientId } of lines) {
    if (recipientId === null) continue
    talked(senderId, recipientId)
    talked(recipientId, senderId)
  }
  const names = await namesOf(db, session, [...partners.keys()])

  const records = await db
    .selectFrom('disciplineRecords')
    .select(['studentId', 'kind', 'detail'])
    .where('sessionId', '=', sessionId)
    .where('studentId', 'in', studentIds)
    .where('kind', 'in', [...CRITICISM_KINDS])
    .where('revokedAt', 'is', null)
    .orderBy('createdAt')
    .orderBy('id')
    .execute()

  const calls = await callsOfSession(deps, sessionId)
  const teacherAnswers = await teacherAnswersOf(db, sessionId)
  // The session's marker of a lesson cut short by maintenance (see `cutShort` in runtime.ts).
  const cut = await db
    .selectFrom('classEvents')
    .select('id')
    .where('sessionId', '=', sessionId)
    .where('step', '=', CUT_SHORT)
    .executeTakeFirst()
  // A question the moderator stopped was never asked of the teacher, so it is left out; the rest are the student's own.
  const asked = await db
    .selectFrom('messages')
    .select(['senderId', 'text'])
    .where('sessionId', '=', sessionId)
    .where('kind', '=', 'question')
    .where('senderId', 'in', studentIds)
    .where('moderation', 'is', null)
    .orderBy('createdAt')
    .orderBy('id')
    .execute()

  return new Map(
    studentIds.map((studentId) => {
      // Nobody is called on twice in a session.
      const call = calls.find((c) => c.studentId === studentId)
      const chattedWith = [...(partners.get(studentId) ?? [])]
        .sort((a, b) => a - b)
        .flatMap((id) => {
          const displayName = names.get(id)
          return displayName === undefined ? [] : [{ studentId: id, displayName }]
        })
      const criticisms = records
        .filter((r) => r.studentId === studentId)
        .map((r) => ({
          kind: r.kind as (typeof CRITICISM_KINDS)[number],
          text: recordText(r, config.timezone),
        }))
      const summary: Summary = {
        date: header.date,
        kind: header.kind,
        className: className(header.division, header.slot, header.classNo, config),
        teacher: { name: teacher?.name ?? header.teacherPersonaId },
        lesson,
        weekTitles,
        teacherAnswers,
        myQuestions: asked
          .filter((q) => q.senderId === studentId)
          .map((q) => ({
            question: q.text,
            // The qa event carries no message id: a question is picked when the teacher answered this text of theirs.
            picked: teacherAnswers.some((t) => t.askedBy.studentId === studentId && t.question === q.text),
          })),
        calledOn:
          call === undefined
            ? null
            : { kind: call.kind, question: bareQuestion(call), answer: call.answer, comment: call.comment },
        chattedWith,
        criticisms,
        cutShort: cut !== undefined,
      }
      return [studentId, summary]
    }),
  )
}

/** A summary as stored. One written before summaries said whether the lesson was cut short was not. */
export function storedSummary(payload: Record<string, unknown>): Summary {
  return { cutShort: false, ...(payload as Omit<Summary, 'cutShort'> & { cutShort?: boolean }) }
}

/**
 * Writes a summary for every student who attended the session, and returns how many it wrote. It is written once per
 * student and session: a student who has one already is left as they are, so this can be run again for the same
 * session (after a crash) and writes only what is missing.
 *
 * When `live`, each attending student who is online is sent theirs, as stored (a run again sends what the owner will
 * read, not a fresh build); a session finished quietly pushes nothing, as nobody there is in it any more. A student who
 * was not online (or dropped off before the end) reads it afterwards.
 */
export async function writeSummaries(
  deps: SummaryDeps,
  session: ActiveSession,
  opts: { live: boolean },
): Promise<number> {
  const { db, clock, hub } = deps
  const { sessionId, classId } = session
  const attended = await db
    .selectFrom('attendance')
    .select('studentId')
    .where('sessionId', '=', sessionId)
    .orderBy('studentId')
    .execute()
  if (attended.length === 0) return 0

  const summaries = await summariesOf(deps, session, attended.map((a) => a.studentId))
  const now = clock.now()
  const written = await db
    .insertInto('summaries')
    .values(
      [...summaries].map(([studentId, summary]) => ({
        sessionId,
        studentId,
        payload: JSON.stringify(summary),
        createdAt: now,
      })),
    )
    .onConflict((oc) => oc.columns(['sessionId', 'studentId']).doNothing())
    .returning('studentId')
    .execute()

  if (opts.live) {
    const online = hub.online(classId).filter((studentId) => summaries.has(studentId))
    if (online.length > 0) {
      const stored = await db
        .selectFrom('summaries')
        .select(['studentId', 'payload'])
        .where('sessionId', '=', sessionId)
        .where('studentId', 'in', online)
        .orderBy('studentId')
        .execute()
      for (const { studentId, payload } of stored) {
        hub.send(studentId, { type: 'summary', sessionId, summary: storedSummary(payload) })
      }
    }
  }
  return written.length
}
