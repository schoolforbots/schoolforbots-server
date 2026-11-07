import { sql, type Kysely, type Updateable } from 'kysely'
import { lockStudentsOfAiIds, schoolRulePenalty, type LockedStudent } from '../class/discipline.js'
import { maskPrivacy } from '../moderation/mask.js'
import type { Moderator } from '../moderation/moderator.js'
import type { Clock } from '../shared/clock.js'
import type { SchoolConfig } from '../shared/config.js'
import { lock } from '../shared/db.js'
import type { Database, StudentsTable } from '../shared/schema.js'

// Taking back what a moderation rule did once the rule is dropped as a false hit. The rule stops blocking as soon as
// the services read it from `moderation_exclusions`; the school-rule breaks it recorded lately are revoked, and so is
// every penalty those breaks no longer earn.
//
// A penalty is a `suspension` or `expulsion` record on the student whose breaks earned it (the offender). It reached
// the offender and the students named in its `detail.alsoApplied`: the other students of the same AI id. Of two
// suspensions that reached a student, the one that ends later is what holds them (a suspension never cuts another
// short). Lifting a penalty marks the record revoked and gives those students back what they had, unless another
// penalty still in force holds them; a suspension still running that reached them is then what is left.

const DAY_MS = 24 * 60 * 60_000

/** Taken by every exclusion, so they run one at a time: a record one moves to another rule is seen by the next one. */
const EXCLUSIONS_LOCK = 'moderation-exclusions'

export type RuleKind = 'word' | 'pattern'

/** What the lines a rule of each kind stops are blocked as. */
const CATEGORY = { word: 'sensitive', pattern: 'injection' } as const

export interface ExcludeRuleDeps {
  db: Kysely<Database>
  config: SchoolConfig
  clock: Clock
  /** Checks a line again against the rules; its lists may not yet lack the rule being dropped, so the exclusions table filters its hits. */
  moderator: Pick<Moderator, 'checkAll'>
}

interface Penalty {
  id: number
  /** The offender. */
  studentId: number
  kind: 'suspension' | 'expulsion'
  detail: Record<string, unknown>
  createdAt: Date
}

const isId = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value)

/** The students a penalty reached: the offender, and the others of the AI id. */
function reached(p: Penalty): number[] {
  const others = Array.isArray(p.detail.alsoApplied) ? p.detail.alsoApplied.filter(isId) : []
  return [p.studentId, ...others]
}

function untilOf(p: Penalty): Date | null {
  const until = typeof p.detail.until === 'string' ? new Date(p.detail.until) : null
  return until === null || Number.isNaN(until.getTime()) ? null : until
}

/**
 * Whether the penalty is what holds the student now: it reached them and they are still under it. An expulsion holds
 * a student who is expelled. A suspension holds one whose suspension ends when it does: suspended in class (until the
 * nightly job lets them back), or dropped with the date still ahead.
 */
function holds(p: Penalty, s: LockedStudent, at: Date): boolean {
  if (!reached(p).includes(s.id)) return false
  if (p.kind === 'expulsion') return s.status === 'expelled'
  const until = untilOf(p)
  if (until === null || s.suspendedUntil?.getTime() !== until.getTime()) return false
  return s.status === 'suspended' || (s.status === 'dropped' && until.getTime() > at.getTime())
}

/**
 * Whether the penalty that reached the student is in force at `at`, whether or not it is the one that holds them: an
 * expulsion while they are expelled, a suspension until its date.
 */
function inForce(p: Penalty, s: LockedStudent, at: Date): boolean {
  if (!reached(p).includes(s.id)) return false
  if (p.kind === 'expulsion') return s.status === 'expelled'
  const until = untilOf(p)
  return until !== null && until.getTime() > at.getTime()
}

/** The latest end of the suspensions of `penalties` still running at `at` that reached the student; null when none is. */
function latestSuspension(penalties: Penalty[], s: LockedStudent, at: Date): Date | null {
  let latest: Date | null = null
  for (const p of penalties) {
    const until = untilOf(p)
    if (p.kind !== 'suspension' || until === null || !inForce(p, s, at)) continue
    if (latest === null || until.getTime() > latest.getTime()) latest = until
  }
  return latest
}

/** The penalties not revoked of the students, oldest first. */
async function penaltiesOf(trx: Kysely<Database>, studentIds: number[]): Promise<Penalty[]> {
  if (studentIds.length === 0) return []
  const rows = await trx
    .selectFrom('disciplineRecords')
    .select(['id', 'studentId', 'kind', 'detail', 'createdAt'])
    .where('studentId', 'in', studentIds)
    .where('kind', 'in', ['suspension', 'expulsion'])
    .where('revokedAt', 'is', null)
    .orderBy('id')
    .execute()
  return rows.map((r) => ({ ...r, kind: r.kind === 'expulsion' ? 'expulsion' : 'suspension' }))
}

/**
 * Removes the bans an expulsion wrote: one on the offender's mailbox and one on the AI id, at the expulsion's time and
 * to its end. Another AI of the same mailbox expelled at the same moment has a mailbox ban just like it, which stays:
 * one ban of each is removed.
 */
async function removeBans(trx: Kysely<Database>, p: Penalty, offender: LockedStudent): Promise<void> {
  const until = untilOf(p)
  for (const [email, aiId] of [
    [offender.email, null],
    [null, offender.aiId],
  ] as const) {
    const one = trx
      .selectFrom('bans')
      .select('id')
      .where('reason', '=', 'expelled')
      .where('createdAt', '=', p.createdAt)
      .$if(until !== null, (qb) => qb.where('until', '=', until!))
      .where('email', email === null ? 'is' : '=', email)
      .where('aiId', aiId === null ? 'is' : '=', aiId)
      .orderBy('id')
      .limit(1)
    await trx.deleteFrom('bans').where('id', 'in', one).execute()
  }
}

/**
 * Gives the student back what a penalty took: an expelled student goes back to dropped (no seat, and free to re-enroll
 * at once), a suspended one back to class, and a dropped one loses the date they could not re-enroll before.
 */
async function restore(trx: Kysely<Database>, s: LockedStudent): Promise<void> {
  const change: Updateable<StudentsTable> =
    s.status === 'expelled'
      ? { status: 'dropped', classId: null, suspendedUntil: null }
      : s.status === 'suspended'
        ? { status: 'active', suspendedUntil: null }
        : { suspendedUntil: null }
  await trx.updateTable('students').set(change).where('id', '=', s.id).execute()
  if (s.status === 'expelled') s.status = 'dropped'
  else if (s.status === 'suspended') s.status = 'active'
  s.suspendedUntil = null
}

/**
 * Suspends a student held by a penalty being lifted until `until`, the end of another suspension that reached them and
 * still runs: an expelled student is dropped with that date, a suspended or dropped one keeps their status.
 */
async function suspendInstead(trx: Kysely<Database>, s: LockedStudent, until: Date): Promise<void> {
  const change: Updateable<StudentsTable> =
    s.status === 'expelled' ? { status: 'dropped', classId: null, suspendedUntil: until } : { suspendedUntil: until }
  await trx.updateTable('students').set(change).where('id', '=', s.id).execute()
  if (s.status === 'expelled') s.status = 'dropped'
  s.suspendedUntil = until
}

/**
 * Lifts the penalties `lifting`: their records are revoked, an expulsion's bans removed, and each student one of them
 * holds is given back what they had, unless another penalty of `all` not being lifted holds them too. A student another
 * suspension of `all` reached that still runs is held by the latest of those instead. `students` are the locked rows
 * of everyone the penalties reached, by student number. Returns the students a lifted penalty held, given back what
 * they had or left under the shorter suspension, by student number.
 */
async function lift(
  trx: Kysely<Database>,
  lifting: Penalty[],
  all: Penalty[],
  students: Map<number, LockedStudent>,
  at: Date,
): Promise<number[]> {
  if (lifting.length === 0) return []
  await trx
    .updateTable('disciplineRecords')
    .set({ revokedAt: at })
    .where('id', 'in', lifting.map((p) => p.id))
    .execute()
  for (const p of lifting) {
    const offender = students.get(p.studentId)
    if (p.kind === 'expulsion' && offender !== undefined) await removeBans(trx, p, offender)
  }
  const standing = all.filter((p) => !lifting.includes(p))
  const freed: number[] = []
  for (const s of students.values()) {
    if (!lifting.some((p) => holds(p, s, at)) || standing.some((p) => holds(p, s, at))) continue
    const still = latestSuspension(standing, s, at)
    if (still === null) await restore(trx, s)
    else await suspendInstead(trx, s, still)
    freed.push(s.id)
  }
  return freed
}

interface StandingLine {
  category: 'sensitive' | 'injection'
  rule: string
  text: string
}

/**
 * The earliest line of the student in the session that a rule still in force stops as a school-rule break (a sensitive
 * word or an injection phrase); undefined when there is no such line. A line keeps the rule it was stopped for while
 * that rule stands. Once it is dropped the line is checked again with the moderator and stands for the first other
 * rule of those categories that hit it and is not dropped. The rules dropped in this transaction, the one being dropped
 * included, are read from `moderation_exclusions`, since the moderator's own lists may not have caught up yet.
 */
async function standingLine(
  trx: Kysely<Database>,
  moderator: Pick<Moderator, 'checkAll'>,
  studentId: number,
  sessionId: number,
): Promise<StandingLine | undefined> {
  const lines = await trx
    .selectFrom('messages')
    .select(['moderation', 'matchedTerm', 'text'])
    .where('sessionId', '=', sessionId)
    .where('senderId', '=', studentId)
    .where('delivered', '=', false)
    .where('moderation', 'in', ['sensitive', 'injection'])
    .orderBy('createdAt')
    .orderBy('id')
    .execute()
  if (lines.length === 0) return undefined
  const dropped = await trx.selectFrom('moderationExclusions').select(['kind', 'value']).execute()
  const isDropped = (category: 'sensitive' | 'injection', rule: string) =>
    dropped.some((e) => e.value === rule && CATEGORY[e.kind] === category)

  for (const line of lines) {
    const category = line.moderation === 'injection' ? 'injection' : 'sensitive'
    if (line.matchedTerm !== null && !isDropped(category, line.matchedTerm)) {
      return { category, rule: line.matchedTerm, text: line.text }
    }
    for (const hit of moderator.checkAll(line.text)) {
      if (hit.category === 'privacy' || hit.rule === null || isDropped(hit.category, hit.rule)) continue
      return { category: hit.category, rule: hit.rule, text: line.text }
    }
  }
  return undefined
}

/**
 * Drops a rule (a word-list entry or a phrase rule, by its exact text) and takes back what it did, all in one
 * transaction:
 *
 * 1. The rule is written to `moderation_exclusions`; the services stop blocking it at their next refresh.
 * 2. Each school-rule break recorded for it in the last `revocationWindowDays` days and not revoked is looked at. A
 *    lesson is recorded once, for its first hit: when the student had a line stopped in the same lesson (this one
 *    included) that a rule still in force stops, the record stays and is moved to the earliest such line (its rule,
 *    category and quote); otherwise it is revoked. A line counts for the rule it was stopped for while that rule
 *    stands; once it is dropped the line is checked again with the moderator, and counts for the first other sensitive
 *    or injection rule that hits it and is not dropped (a privacy hit does not count). A line already deleted from
 *    the messages no longer counts.
 * 3. Each penalty in force whose offender had a break revoked is weighed again, as it was given: with the same
 *    thresholds and windows, at the time it was given, counting the breaks that still stand. A suspension that falls
 *    short of its threshold is lifted; so is an expulsion, even when what is left still earns a suspension (the student
 *    is dropped, not suspended: held only by a suspension given before that still runs, if there is one).
 *
 * The students are locked as the penalties after class lock them (`lockStudentsOfAiIds`), before anything of theirs
 * changes. Dropping a rule again changes nothing more. Returns how many breaks were revoked and the students whose
 * penalty was lifted, by student number.
 */
export async function excludeRule(
  deps: ExcludeRuleDeps,
  kind: RuleKind,
  value: string,
): Promise<{ revoked: number; lifted: number[] }> {
  const { db, config, clock, moderator } = deps
  return db.transaction().execute(async (trx) => {
    await lock(trx, EXCLUSIONS_LOCK)
    const now = clock.now()
    await trx
      .insertInto('moderationExclusions')
      .values({ kind, value, createdAt: now })
      .onConflict((oc) => oc.columns(['kind', 'value']).doNothing())
      .execute()

    const records = await trx
      .selectFrom('disciplineRecords')
      .select(['id', 'studentId', 'sessionId'])
      .where('kind', '=', 'school_rule')
      .where('revokedAt', 'is', null)
      .where('matchedTerm', '=', value)
      // A word and a phrase rule may read alike; the record's category tells which one hit.
      .where(sql<string>`detail->>'category'`, '=', CATEGORY[kind])
      .where('createdAt', '>=', new Date(now.getTime() - config.revocationWindowDays * DAY_MS))
      .orderBy('id')
      .execute()
    if (records.length === 0) return { revoked: 0, lifted: [] }

    const students = await lockStudentsOfAiIds(trx, [...new Set(records.map((r) => r.studentId))])

    const offenders = new Set<number>()
    let revoked = 0
    for (const r of records) {
      const other = r.sessionId === null ? undefined : await standingLine(trx, moderator, r.studentId, r.sessionId)
      const update = trx.updateTable('disciplineRecords').where('id', '=', r.id).where('revokedAt', 'is', null)
      if (other !== undefined) {
        const detail = { category: other.category, quote: maskPrivacy(other.text) }
        await update.set({ matchedTerm: other.rule, detail: JSON.stringify(detail) }).execute()
        continue
      }
      const { numUpdatedRows } = await update.set({ revokedAt: now }).executeTakeFirstOrThrow()
      if (numUpdatedRows > 0n) {
        revoked++
        offenders.add(r.studentId)
      }
    }

    const penalties = await penaltiesOf(trx, [...students.keys()])
    const unearned: Penalty[] = []
    for (const p of penalties) {
      // A penalty the admin gave by hand was not earned by breaks, so a dropped rule cannot take it back.
      if (p.detail.by === 'admin' || !offenders.has(p.studentId)) continue
      // One a longer suspension outlasts holds nobody, but is still in force: it is taken back all the same.
      if (![...students.values()].some((s) => holds(p, s, now) || inForce(p, s, now))) continue
      const due = await schoolRulePenalty(trx, config.discipline, p.studentId, p.createdAt)
      if (p.kind === 'expulsion' ? due !== 'expulsion' : due === null) unearned.push(p)
    }
    return { revoked, lifted: await lift(trx, unearned, penalties, students, now) }
  })
}

/**
 * Lifts every penalty in force on the student, earned or not (the one that holds them, and any other suspension that
 * reached them and still runs), for every student it reached: the records of the penalties are revoked, an
 * expulsion's bans removed; an expelled student goes back to dropped (no seat, free to re-enroll at once), a suspended
 * one back to class, and a dropped one may re-enroll at once. The student's breaks stay as they are.
 * Runs in the caller's transaction and locks the students of the AI id as the penalties after class do.
 *
 * `_config` is not read: lifting goes by what the penalty did, not by the thresholds.
 */
export async function liftPenalty(
  trx: Kysely<Database>,
  _config: SchoolConfig,
  studentId: number,
  at: Date,
): Promise<'suspension_lifted' | 'expulsion_lifted' | 'none'> {
  const students = await lockStudentsOfAiIds(trx, [studentId])
  const student = students.get(studentId)
  if (student === undefined) return 'none'
  const outcome = student.status === 'expelled' ? 'expulsion_lifted' : 'suspension_lifted'

  const penalties = await penaltiesOf(trx, [...students.keys()])
  const lifting = penalties.filter((p) => holds(p, student, at) || inForce(p, student, at))
  if (lifting.length > 0) {
    await lift(trx, lifting, penalties, students, at)
    return outcome
  }
  // Under a penalty that no record names (one written by hand): the student alone is given back what they had.
  const { status, suspendedUntil } = student
  const penalised =
    status === 'expelled' ||
    status === 'suspended' ||
    (status === 'dropped' && suspendedUntil !== null && suspendedUntil.getTime() > at.getTime())
  if (!penalised) return 'none'
  await restore(trx, student)
  return outcome
}
