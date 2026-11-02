import { sql, type Kysely } from 'kysely'
import type { Clock } from '../shared/clock.js'
import type { Division, SchoolConfig, Slot } from '../shared/config.js'
import { MEMBER_STATUSES, lock, slotLockKey, type Database } from '../shared/db.js'
import { displayName, nameKey } from '../shared/identity.js'
import { startOfLocalDay } from '../shared/local-time.js'
import { assignClasses, type ClassState } from './assignment.js'
import { slotOccupancy } from './capacity.js'

/** Held for the whole run, so two runs (say, from two server instances at midnight) never overlap. */
const DAILY_JOB_LOCK = 4242001

// Fixed orders: slots are locked in this order, and classes are created in this order.
const SLOTS: readonly Slot[] = ['morning', 'afternoon', 'evening']
const DIVISIONS: readonly Division[] = ['primary', 'junior', 'senior']

export interface DailyJobReport {
  dropped: number
  promoted: number
  assigned: number
  classesCreated: number
}

type Trx = Kysely<Database>

/**
 * The nightly job, in one transaction: drop students who stopped coming, promote the waitlist into the freed
 * seats, and put the pending students who joined the queue before today into a class.
 *
 * Both rules go by today's date in the school's timezone, not by the time of the run: a run that starts late, or
 * one that makes up for a missed midnight, does what the midnight run would have done, and running it again later
 * the same day changes nothing more. Students who join the queue today wait for tomorrow's run (报名当天待分班).
 */
export async function runDailyJob(deps: { db: Kysely<Database>; config: SchoolConfig; clock: Clock }): Promise<DailyJobReport> {
  const { db, config, clock } = deps

  return db.transaction().execute(async (trx) => {
    await sql`select pg_advisory_xact_lock(${sql.lit(DAILY_JOB_LOCK)})`.execute(trx)
    // The same slot locks verify takes, so a verify cannot push a slot over its capacity while the waitlist is promoted.
    for (const slot of SLOTS) await lock(trx, slotLockKey(slot))

    // Read after the locks, so a run that had to wait still uses the time it actually runs at.
    const now = clock.now()
    const today = startOfLocalDay(now, config.timezone)
    const dropped = await dropInactive(trx, startOfLocalDay(now, config.timezone, config.inactivityDropDays))
    const promoted = await promoteWaitlist(trx, config)
    const { assigned, classesCreated } = await assignPending(trx, config, now, today)
    return { dropped, promoted, assigned, classesCreated }
  })
}

/**
 * Active students not seen since before `cutoff`, the start of the local day inactivityDropDays calendar days ago,
 * are dropped; a student who never came counts from assignment.
 */
async function dropInactive(trx: Trx, cutoff: Date): Promise<number> {
  const result = await trx
    .updateTable('students')
    .set({ status: 'dropped', classId: null })
    .where('status', '=', 'active')
    .where((eb) => eb.fn.coalesce('lastAttendedAt', 'assignedAt'), '<', cutoff)
    .executeTakeFirstOrThrow()
  return Number(result.numUpdatedRows)
}

/** Per slot, the students who have waited longest (by `queued_at`) take the seats that are free. */
async function promoteWaitlist(trx: Trx, config: SchoolConfig): Promise<number> {
  let promoted = 0
  for (const slot of SLOTS) {
    const free = config.slotCapacity - (await slotOccupancy(trx, slot))
    if (free <= 0) continue

    const result = await trx
      .updateTable('students')
      .set({ status: 'pending' })
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
 * `today` (the start of the local day), opening new classes as needed.
 */
async function assignPending(
  trx: Trx,
  config: SchoolConfig,
  now: Date,
  today: Date,
): Promise<{ assigned: number; classesCreated: number }> {
  const { count } = await trx
    .selectFrom('classes')
    .select((eb) => eb.fn.countAll().as('count'))
    .executeTakeFirstOrThrow()
  const classesBefore = Number(count)

  let assigned = 0
  let classesCreated = 0
  for (const division of DIVISIONS) {
    for (const slot of SLOTS) {
      const pending = await trx
        .selectFrom('students')
        .select(['id', 'ownerName', 'aiName'])
        .where('division', '=', division)
        .where('slot', '=', slot)
        .where('status', '=', 'pending')
        .where('queuedAt', '<', today)
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

      const highestClassNo = classes.at(-1)?.classNo ?? 0
      const newClassIds: number[] = []
      for (let i = 0; i < newClassCount; i++) {
        const persona = config.teacherPersonas[(classesBefore + classesCreated) % config.teacherPersonas.length]!
        const row = await trx
          .insertInto('classes')
          .values({ division, slot, classNo: highestClassNo + 1 + i, teacherPersonaId: persona.id, createdAt: now })
          .returning('id')
          .executeTakeFirstOrThrow()
        newClassIds.push(row.id)
        classesCreated++
      }

      const studentsByClass = new Map<number, number[]>()
      for (const { studentId, target } of placements) {
        const classId = target.kind === 'existing' ? target.classId : newClassIds[target.index]!
        studentsByClass.set(classId, [...(studentsByClass.get(classId) ?? []), studentId])
      }
      for (const [classId, studentIds] of studentsByClass) {
        await trx
          .updateTable('students')
          .set({ status: 'active', classId, assignedAt: now })
          .where('id', 'in', studentIds)
          .execute()
      }
      assigned += placements.length
    }
  }
  return { assigned, classesCreated }
}
