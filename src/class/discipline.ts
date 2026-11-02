import { sql, type Kysely, type SqlBool } from 'kysely'
import type { Clock } from '../shared/clock.js'
import type { SchoolConfig } from '../shared/config.js'
import { lock, MEMBER_STATUSES } from '../shared/db.js'
import { displayName } from '../shared/identity.js'
import type { Database, DisciplineKind, StudentStatus } from '../shared/schema.js'
import type { ActiveSession } from './runtime.js'
import * as teacher from './teacher.js'

// Discipline: what is written down during a lesson, what the teacher says about it as the lesson goes, and what
// follows from it once the lesson is over.
//
// During a lesson the chat engine only writes records (`record`). Class rules (`initiations`, `rounds`) and the school
// rule (`school_rule`) are recorded at most once per student and lesson. The teacher calls out each window's new
// records at the lesson's callout steps (`calloutsForWindow`), and after class `applyPenalties` looks at everyone who
// has a new record: the parent notice, the suspension, the expulsion.

const DAY_MS = 24 * 60 * 60_000

/** The kinds that are recorded at most once per student and lesson (the `discipline_once_per_lesson` index). */
const ONCE_PER_LESSON: readonly DisciplineKind[] = ['initiations', 'rounds', 'school_rule']

/** The records the penalties look at: what a student did, as opposed to what the school did about it. */
const OFFENCES: readonly DisciplineKind[] = ['initiations', 'rounds', 'school_rule']

export interface DisciplineEntry {
  studentId: number
  sessionId: number
  kind: DisciplineKind
  /** Kind-specific facts: `rounds` has `{ partnerId, partnerName }`, `suspension` has `{ until }`. */
  detail: Record<string, unknown>
  matchedTerm?: string | null
  at: Date
}

export interface DisciplineRecorder {
  /**
   * Writes a record. `initiations`, `rounds` and `school_rule` are written once per student and lesson: when the
   * student already has one of that kind in the session nothing is written and the result is false.
   * `trx` is a transaction or the database itself; a refused duplicate never aborts a transaction.
   */
  record(trx: Kysely<Database>, p: DisciplineEntry): Promise<boolean>
}

export const disciplineRecorder: DisciplineRecorder = {
  async record(trx, p) {
    // Conflicts are decided by the once-per-lesson index and by nothing else: `on conflict do nothing` with that
    // index as its target neither raises (which would abort the transaction) nor swallows any other violation.
    const written = await trx
      .insertInto('disciplineRecords')
      .values({
        studentId: p.studentId,
        sessionId: p.sessionId,
        kind: p.kind,
        detail: JSON.stringify(p.detail),
        matchedTerm: p.matchedTerm ?? null,
        createdAt: p.at,
        revokedAt: null,
      })
      .onConflict((oc) =>
        oc
          .columns(['studentId', 'sessionId', 'kind'])
          .where(sql<SqlBool>`kind in (${sql.join(ONCE_PER_LESSON.map((kind) => sql.lit(kind)))})`)
          .doNothing(),
      )
      .returning('id')
      .executeTakeFirst()
    return written !== undefined
  },
}

// ---- The teacher's callouts ----

const isId = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value)

/**
 * What the teacher says about the records of the session written in [from, to), as lines to broadcast; none when there
 * is nothing to say. Everyone who talked too much is one sentence; each pair who talked too long is one sentence, said
 * once though both of them have a record; a school-rule break is one sentence that names no one.
 *
 * It only reads, so a window asked about again gives the same lines.
 */
export async function calloutsForWindow(
  db: Kysely<Database>,
  session: ActiveSession,
  from: Date,
  to: Date,
): Promise<string[]> {
  // Everything up to `to`: whether a pair is new in this window depends on its earliest record.
  const rows = await db
    .selectFrom('disciplineRecords')
    .select(['studentId', 'kind', 'detail', 'createdAt'])
    .where('sessionId', '=', session.sessionId)
    .where('kind', 'in', [...OFFENCES])
    .where('revokedAt', 'is', null)
    .where('createdAt', '<', to)
    .orderBy('createdAt')
    .orderBy('id')
    .execute()
  const isNew = (r: { createdAt: Date }) => r.createdAt.getTime() >= from.getTime()

  const talkative = [...new Set(rows.filter((r) => r.kind === 'initiations' && isNew(r)).map((r) => r.studentId))]
  const schoolRule = rows.some((r) => r.kind === 'school_rule' && isNew(r))

  // A pair, by the unordered pair of student numbers: its first record names who is called first. The two records of
  // one event are written together, but if a window ends between them, the pair belongs to the window of the first.
  const pairs = new Map<string, { first: number; second: number; firstAt: Date; secondName: unknown }>()
  for (const r of rows) {
    if (r.kind !== 'rounds' || !isId(r.detail.partnerId)) continue
    const key = [r.studentId, r.detail.partnerId].sort((a, b) => a - b).join(':')
    if (!pairs.has(key)) {
      pairs.set(key, { first: r.studentId, second: r.detail.partnerId, firstAt: r.createdAt, secondName: r.detail.partnerName })
    }
  }
  const newPairs = [...pairs.values()].filter((p) => isNew({ createdAt: p.firstAt }))

  if (talkative.length === 0 && newPairs.length === 0 && !schoolRule) return []

  const names = await namesOf(db, session, [...talkative, ...newPairs.flatMap((p) => [p.first, p.second])])
  const lines: string[] = []
  // `calloutInitiations` is never given an empty list.
  if (talkative.length > 0) lines.push(teacher.calloutInitiations(talkative.map((id) => names.get(id)!)))
  for (const pair of newPairs) {
    const first = names.get(pair.first)
    const second = names.get(pair.second) ?? (typeof pair.secondName === 'string' ? pair.secondName : undefined)
    if (first !== undefined && second !== undefined) lines.push(teacher.calloutRounds(first, second))
  }
  if (schoolRule) lines.push(teacher.calloutSchoolRule())
  return lines
}

/** The display names of `ids`: from the session's members as they were at the doors, else from the student rows. */
export async function namesOf(
  db: Kysely<Database>,
  session: ActiveSession,
  ids: number[],
): Promise<Map<number, string>> {
  const snapshot = await db
    .selectFrom('classSessions')
    .select('members')
    .where('id', '=', session.sessionId)
    .executeTakeFirst()
  const names = new Map((snapshot?.members ?? []).map((m) => [m.studentId, m.displayName]))
  const missing = [...new Set(ids)].filter((id) => !names.has(id))
  if (missing.length > 0) {
    const students = await db.selectFrom('students').select(['id', 'ownerName', 'aiName']).where('id', 'in', missing).execute()
    for (const s of students) names.set(s.id, displayName(s.ownerName, s.aiName))
  }
  return names
}

// ---- Penalties after class ----

export interface PenaltyReport {
  /** The students suspended after this lesson. */
  suspended: number[]
  /** The students expelled after this lesson. */
  expelled: number[]
  /** The students whose parents were sent a notice after this lesson. */
  parentNotices: number[]
}

/**
 * After the lesson, for each student who has a new record in it (and is still in the class): when it broke the school
 * rule in this lesson, expels the student when the school-rule breaks of the last `expulsion.windowDays` days reach
 * `expulsion.schoolRuleCount`, otherwise suspends the student at `suspension.schoolRuleCount`; and, when it broke a
 * class rule in this lesson, whichever of those happened, records a parent notice when the class rules broken in the
 * last `parentNotice.windowDays` days reach `parentNotice.classRuleCount` and no notice has gone out in that time.
 * Records that were revoked never count. Everything is written in one transaction.
 *
 * The penalties are keyed by the session: a student the lesson has already suspended or expelled is not suspended
 * or expelled again by it, nor does a suspension get longer, and a lesson that has sent a notice sends no second one.
 * So this can be run again for the same lesson (after a crash) and changes nothing.
 */
export async function applyPenalties(
  db: Kysely<Database>,
  config: SchoolConfig,
  clock: Clock,
  session: ActiveSession,
): Promise<PenaltyReport> {
  const { suspension, expulsion, parentNotice } = config.discipline
  const { sessionId } = session

  return db.transaction().execute(async (trx) => {
    await lock(trx, `penalties:${sessionId}`)
    const now = clock.now()
    const since = (days: number) => new Date(now.getTime() - days * DAY_MS)
    const report: PenaltyReport = { suspended: [], expelled: [], parentNotices: [] }

    const count = async (studentId: number, kinds: DisciplineKind[], days: number): Promise<number> => {
      const { total } = await trx
        .selectFrom('disciplineRecords')
        .select((eb) => eb.fn.countAll().as('total'))
        .where('studentId', '=', studentId)
        .where('kind', 'in', kinds)
        .where('revokedAt', 'is', null)
        .where('createdAt', '>=', since(days))
        .executeTakeFirstOrThrow()
      return Number(total)
    }

    // What each student broke in this lesson: only a school-rule break in it can bring a suspension or an expulsion,
    // only a class-rule break in it a parent notice. Class rules never add up into a suspension.
    const offences = await trx
      .selectFrom('disciplineRecords')
      .select(['studentId', 'kind'])
      .distinct()
      .where('sessionId', '=', sessionId)
      .where('kind', 'in', [...OFFENCES])
      .where('revokedAt', 'is', null)
      .orderBy('studentId')
      .execute()
    const involved = new Map<number, Set<DisciplineKind>>()
    for (const { studentId, kind } of offences) {
      involved.set(studentId, (involved.get(studentId) ?? new Set()).add(kind))
    }

    for (const [studentId, kinds] of involved) {
      // In student-number order, so two runs that overlap take the rows in the same order.
      const student = await trx
        .selectFrom('students')
        .select(['id', 'email', 'installId', 'status'])
        .where('id', '=', studentId)
        .forUpdate()
        .executeTakeFirst()
      if (student === undefined || !(MEMBER_STATUSES as readonly StudentStatus[]).includes(student.status)) continue

      const punished = await trx
        .selectFrom('disciplineRecords')
        .select('id')
        .where('studentId', '=', studentId)
        .where('sessionId', '=', sessionId)
        .where('kind', 'in', ['suspension', 'expulsion'])
        .limit(1)
        .executeTakeFirst()
      if (kinds.has('school_rule') && punished === undefined) {
        if ((await count(studentId, ['school_rule'], expulsion.windowDays)) >= expulsion.schoolRuleCount) {
          const until = new Date(now.getTime() + expulsion.banDays * DAY_MS)
          await trx
            .updateTable('students')
            .set({ status: 'expelled', classId: null, suspendedUntil: null })
            .where('id', '=', studentId)
            .execute()
          // The mailbox and the installation are both banned, so a new registration from either is refused.
          await trx
            .insertInto('bans')
            .values([
              { email: student.email, installId: null, until, reason: 'expelled', createdAt: now },
              { email: null, installId: student.installId, until, reason: 'expelled', createdAt: now },
            ])
            .execute()
          await disciplineRecorder.record(trx, {
            studentId,
            sessionId,
            kind: 'expulsion',
            detail: { until: until.toISOString() },
            at: now,
          })
          report.expelled.push(studentId)
        } else if ((await count(studentId, ['school_rule'], suspension.windowDays)) >= suspension.schoolRuleCount) {
          const until = new Date(now.getTime() + suspension.days * DAY_MS)
          await trx
            .updateTable('students')
            .set({ status: 'suspended', suspendedUntil: until })
            .where('id', '=', studentId)
            .execute()
          await disciplineRecorder.record(trx, {
            studentId,
            sessionId,
            kind: 'suspension',
            detail: { until: until.toISOString() },
            at: now,
          })
          report.suspended.push(studentId)
        }
      }

      if (!kinds.has('initiations') && !kinds.has('rounds')) continue
      const classRules = await count(studentId, ['initiations', 'rounds'], parentNotice.windowDays)
      if (classRules >= parentNotice.classRuleCount) {
        const notified = await trx
          .selectFrom('disciplineRecords')
          .select('id')
          .where('studentId', '=', studentId)
          .where('kind', '=', 'parent_notice')
          .where((eb) =>
            eb.or([
              eb('sessionId', '=', sessionId),
              eb.and([eb('createdAt', '>=', since(parentNotice.windowDays)), eb('revokedAt', 'is', null)]),
            ]),
          )
          .limit(1)
          .executeTakeFirst()
        if (notified === undefined) {
          await disciplineRecorder.record(trx, {
            studentId,
            sessionId,
            kind: 'parent_notice',
            detail: { classRuleCount: classRules, windowDays: parentNotice.windowDays },
            at: now,
          })
          report.parentNotices.push(studentId)
        }
      }
    }
    return report
  })
}
