import { sql, type Kysely } from 'kysely'
import { dropStaleMemberships } from '../club/members.js'
import { inactivityCutoffDay } from '../shared/calendar.js'
import type { Clock } from '../shared/clock.js'
import type { Division, SchoolConfig, Slot } from '../shared/config.js'
import { MEMBER_STATUSES, lastSeenAt, lock, slotLockKey, type Database } from '../shared/db.js'
import { allMaintenanceDays } from '../shared/maintenance.js'
import { displayName, nameKey } from '../shared/identity.js'
import { atLocalTime, localDate, startOfLocalDay } from '../shared/local-time.js'
import { assignClasses, type ClassState } from './assignment.js'
import { slotOccupancy } from './capacity.js'

/**
 * Held for the whole run of the nightly job and of the hourly assignment, so no two runs (say, from two server instances,
 * or the two jobs at midnight) ever overlap.
 */
const DAILY_JOB_LOCK = 4242001

// Fixed orders: slots are locked in this order, and classes are created in this order.
const SLOTS: readonly Slot[] = ['morning', 'afternoon', 'evening']
/** How long the records the alert mails count (events, starts, backup runs) are kept. */
const OPS_RETENTION_DAYS = 30

const DIVISIONS: readonly Division[] = ['primary', 'junior', 'senior']

export interface DailyJobReport {
  dropped: number
  promoted: number
  assigned: number
  classesCreated: number
  /** Suspended students whose suspension has ended and who are active again. */
  reinstated: number
  /** Chat messages deleted for being older than `messageRetentionDays`. */
  messagesPurged: number
  /** Club member rows deleted for no longer being current: the student left the school, or re-enrolled since. */
  clubMembersDropped: number
  /** Seats of club games whose IP was cleared for the game being older than `club.ipRetentionDays`. */
  clubIpsCleared: number
}

type Trx = Kysely<Database>

/**
 * The teacher of a new class, given how many classes the whole school had before it: the personas take turns, in the
 * order the config lists them.
 */
export function teacherPersonaFor(config: SchoolConfig, classesBefore: number): SchoolConfig['teacherPersonas'][number] {
  return config.teacherPersonas[classesBefore % config.teacherPersonas.length]!
}

/**
 * The nightly job, in one transaction: drop students who stopped coming, promote the waitlist into the freed
 * seats, put every pending student into a class (as the hourly assignment does), bring back the suspended
 * students whose suspension is over, delete the chat messages past their retention and the ops records (events,
 * service starts, backup runs) older than 30 days, delete the club memberships that are no longer current
 * (the student left the school, or re-enrolled since joining), and clear the IPs of the club games past their
 * retention (the games and their stats are kept).
 *
 * The rules that count days go by today's date in the school's timezone, not by the time of the run: a run that
 * starts late, or one that makes up for a missed midnight, does what the midnight run would have done, and running
 * it again later the same day drops and reinstates nobody more. Placing students goes by who is waiting at the time of
 * the run, as in the hourly assignment. Days on a break, and those before the opening day, do not count towards staying away.
 */
export async function runDailyJob(deps: { db: Kysely<Database>; config: SchoolConfig; clock: Clock }): Promise<DailyJobReport> {
  const { db, config, clock } = deps

  return db.transaction().execute(async (trx) => {
    await takeJobLocks(trx)

    // Read after the locks, so a run that had to wait still uses the time it actually runs at.
    const now = clock.now()
    // The day the last `inactivityDropDays` days that are not a holiday start on; none when the school has not been
    // open that many days yet, so nobody is dropped for staying away.
    // The days under maintenance are not counted either: nobody could come. The set covers every maintenance period on
    // record, because a look-back stretched by breaks can reach back any distance.
    const todayText = localDate(now, config.timezone)
    const skipped = await allMaintenanceDays(trx, todayText, config)
    const cutoffDay = inactivityCutoffDay(todayText, config.inactivityDropDays, config, skipped)
    const dropped = cutoffDay === null ? 0 : await dropInactive(trx, atLocalTime(cutoffDay, '00:00', config.timezone))
    const { promoted, assigned, classesCreated } = await placeWaiting(trx, config, now)
    const reinstated = await reinstateSuspended(trx, now)
    const messagesPurged = await purgeMessages(trx, startOfLocalDay(now, config.timezone, config.messageRetentionDays))
    await purgeOps(trx, new Date(now.getTime() - OPS_RETENTION_DAYS * 24 * 60 * 60_000))
    // After the drops above, so a student dropped tonight leaves the clubs tonight too.
    const clubMembersDropped = await dropStaleMemberships(trx)
    const clubIpsCleared = await clearClubIps(trx, startOfLocalDay(now, config.timezone, config.club.ipRetentionDays))
    return { dropped, promoted, assigned, classesCreated, reinstated, messagesPurged, clubMembersDropped, clubIpsCleared }
  })
}

export interface AssignmentReport {
  promoted: number
  assigned: number
  classesCreated: number
}

/**
 * The hourly assignment, in one transaction: promote the waitlist into the seats that are free, then put every pending
 * student into a class. The nightly job does the same after its drops, so at midnight only one of the two has anything
 * to do. A student placed after their slot's doors opened today starts on the next school day (see the admission).
 */
export async function runHourlyAssignment(deps: { db: Kysely<Database>; config: SchoolConfig; clock: Clock }): Promise<AssignmentReport> {
  const { db, config, clock } = deps
  return db.transaction().execute(async (trx) => {
    await takeJobLocks(trx)
    // Read after the locks, so a run that had to wait still uses the time it actually runs at.
    return placeWaiting(trx, config, clock.now())
  })
}

/** The job lock, then the same slot locks verify takes, so a verify cannot push a slot over its capacity while the waitlist is promoted. */
async function takeJobLocks(trx: Trx): Promise<void> {
  await sql`select pg_advisory_xact_lock(${sql.lit(DAILY_JOB_LOCK)})`.execute(trx)
  for (const slot of SLOTS) await lock(trx, slotLockKey(slot))
}

/** Promotes the waitlist, then places every student pending at `now`, those just promoted included. */
async function placeWaiting(trx: Trx, config: SchoolConfig, now: Date): Promise<AssignmentReport> {
  const promoted = await promoteWaitlist(trx, config)
  const { assigned, classesCreated } = await assignPending(trx, config, now, new Date(now.getTime() + 1))
  return { promoted, assigned, classesCreated }
}

/**
 * Local development only (`DEV_ASSIGN_ON_VERIFY=1`): put the pending students of one division and slot into a class
 * now, instead of at the next hour. The caller holds the slot's lock, as verify
 * and re-enroll do, the same lock the nightly job takes.
 */
export async function assignQueuedNow(
  trx: Trx,
  config: SchoolConfig,
  now: Date,
  division: Division,
  slot: Slot,
): Promise<{ assigned: number; classesCreated: number }> {
  return assignPending(trx, config, now, new Date(now.getTime() + 1), { division, slot })
}

/**
 * Active students not seen since before `cutoff`, the start of the local day that the last inactivityDropDays days
 * that are not a holiday began on, are dropped; a student who never came counts from assignment, and one let back after
 * a suspension from then, if later (see `lastSeenAt`).
 */
async function dropInactive(trx: Trx, cutoff: Date): Promise<number> {
  const result = await trx
    .updateTable('students')
    .set({ status: 'dropped', classId: null })
    .where('status', '=', 'active')
    .where(lastSeenAt, '<', cutoff)
    .executeTakeFirstOrThrow()
  return Number(result.numUpdatedRows)
}

/** Per slot, the students who have waited longest (by `queued_at`) take the seats that are free. */
async function promoteWaitlist(trx: Trx, config: SchoolConfig): Promise<number> {
  let promoted = 0
  for (const slot of SLOTS) {
    const free = config.slotCapacity - (await slotOccupancy(trx, slot))
    if (free <= 0) continue

    // The outer `status` is checked as well as the subquery's: the class service takes no slot lock, so a penalty can
    // drop or expel a waiting student after the subquery picked them, and the job must not undo it.
    const result = await trx
      .updateTable('students')
      .set({ status: 'pending' })
      .where('status', '=', 'waitlisted')
      .where(
        'id',
        'in',
        trx
          .selectFrom('students')
          .select('id')
          .where('slot', '=', slot)
          .where('status', '=', 'waitlisted')
          .orderBy('queuedAt')
          .orderBy('id')
          .limit(free),
      )
      .executeTakeFirstOrThrow()
    promoted += Number(result.numUpdatedRows)
  }
  return promoted
}

/**
 * Per division and slot, runs the assignment algorithm over the pending students who joined the queue before
 * `queuedBefore`, opening new classes as needed.
 */
async function assignPending(
  trx: Trx,
  config: SchoolConfig,
  now: Date,
  queuedBefore: Date,
  only?: { division: Division; slot: Slot },
): Promise<{ assigned: number; classesCreated: number }> {
  const { count } = await trx
    .selectFrom('classes')
    .select((eb) => eb.fn.countAll().as('count'))
    .executeTakeFirstOrThrow()
  const classesBefore = Number(count)

  let assigned = 0
  let classesCreated = 0
  for (const division of only ? [only.division] : DIVISIONS) {
    for (const slot of only ? [only.slot] : SLOTS) {
      const pending = await trx
        .selectFrom('students')
        .select(['id', 'ownerName', 'aiName'])
        .where('division', '=', division)
        .where('slot', '=', slot)
        .where('status', '=', 'pending')
        .where('queuedAt', '<', queuedBefore)
        .orderBy('queuedAt')
        .orderBy('id')
        .execute()
      if (pending.length === 0) continue

      const classes = await trx
        .selectFrom('classes')
        .select(['id', 'classNo'])
        .where('division', '=', division)
        .where('slot', '=', slot)
        .orderBy('classNo')
        .execute()
      const members =
        classes.length === 0
          ? []
          : await trx
              .selectFrom('students')
              .select(['classId', 'ownerName', 'aiName'])
              .where('classId', 'in', classes.map((c) => c.id))
              .where('status', 'in', [...MEMBER_STATUSES])
              .execute()
      // assignClasses compares the names it is given as plain strings, so it gets the name keys: a newcomer whose name
      // only looks like a member's (Cyrillic о for Latin o) is kept out of that class too.
      const states: ClassState[] = classes.map((c) => ({
        classId: c.id,
        classNo: c.classNo,
        memberNames: members.filter((m) => m.classId === c.id).map((m) => nameKey(displayName(m.ownerName, m.aiName))),
      }))

      const { placements, newClassCount } = assignClasses(
        states,
        pending.map((s) => ({ studentId: s.id, displayName: nameKey(displayName(s.ownerName, s.aiName)) })),
        config.classSize,
      )

      // A student is seated only if they are still pending: the class service takes no slot lock, so a penalty can drop
      // or expel one of them after the list above was read, and the job must not undo it. What was written is counted.
      const seat = async (studentIds: number[], classId: number): Promise<number> => {
        if (studentIds.length === 0) return 0
        const result = await trx
          .updateTable('students')
          .set({ status: 'active', classId, assignedAt: now })
          .where('id', 'in', studentIds)
          .where('status', '=', 'pending')
          .executeTakeFirstOrThrow()
        return Number(result.numUpdatedRows)
      }

      const studentsByClass = new Map<number, number[]>()
      const studentsByNewClass = new Map<number, number[]>()
      for (const { studentId, target } of placements) {
        const byClass = target.kind === 'existing' ? studentsByClass : studentsByNewClass
        const key = target.kind === 'existing' ? target.classId : target.index
        byClass.set(key, [...(byClass.get(key) ?? []), studentId])
      }
      for (const [classId, studentIds] of studentsByClass) assigned += await seat(studentIds, classId)

      // A new class exists only if someone is seated in it: one whose students were all skipped is taken back, and
      // the next one takes its number and its teacher.
      let nextClassNo = (classes.at(-1)?.classNo ?? 0) + 1
      for (let index = 0; index < newClassCount; index++) {
        const persona = teacherPersonaFor(config, classesBefore + classesCreated)
        const row = await trx
          .insertInto('classes')
          .values({ division, slot, classNo: nextClassNo, teacherPersonaId: persona.id, createdAt: now })
          .returning('id')
          .executeTakeFirstOrThrow()
        const seated = await seat(studentsByNewClass.get(index) ?? [], row.id)
        if (seated === 0) {
          await trx.deleteFrom('classes').where('id', '=', row.id).execute()
          continue
        }
        nextClassNo++
        classesCreated++
        assigned += seated
      }
    }
  }
  return { assigned, classesCreated }
}

/**
 * Suspended students whose `suspended_until` has come are active again, with no date left over, stamped with the time
 * they came back. A suspended student with no date is left as it is.
 */
async function reinstateSuspended(trx: Trx, now: Date): Promise<number> {
  const result = await trx
    .updateTable('students')
    .set({ status: 'active', suspendedUntil: null, reinstatedAt: now })
    .where('status', '=', 'suspended')
    .where('suspendedUntil', '<=', now)
    .executeTakeFirstOrThrow()
  return Number(result.numUpdatedRows)
}

/** Deletes the chat messages written before `cutoff`, the start of the local day `messageRetentionDays` days ago. */
async function purgeMessages(trx: Trx, cutoff: Date): Promise<number> {
  const result = await trx.deleteFrom('messages').where('createdAt', '<', cutoff).executeTakeFirstOrThrow()
  return Number(result.numDeletedRows)
}

/**
 * Clears the IP of every seat of a club game that ended before `cutoff`, the start of the local day
 * `club.ipRetentionDays` days ago. The seat keeps everything else, and the game its record. A seat's `ended_at` is its
 * game's.
 */
async function clearClubIps(trx: Trx, cutoff: Date): Promise<number> {
  const result = await trx
    .updateTable('doudizhuGamePlayers')
    .set({ ip: null })
    .where('endedAt', '<', cutoff)
    .where('ip', 'is not', null)
    .executeTakeFirstOrThrow()
  return Number(result.numUpdatedRows)
}

/** Deletes the ops records written before `cutoff`. */
async function purgeOps(trx: Trx, cutoff: Date): Promise<void> {
  await trx.deleteFrom('opsEvents').where('at', '<', cutoff).execute()
  await trx.deleteFrom('serviceStarts').where('startedAt', '<', cutoff).execute()
  await trx.deleteFrom('backupRuns').where('finishedAt', '<', cutoff).execute()
}
