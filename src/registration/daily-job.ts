import { sql, type Kysely } from 'kysely'
import type { Clock } from '../shared/clock.js'
import type { Division, SchoolConfig, Slot } from '../shared/config.js'
import { MEMBER_STATUSES, lock, slotLockKey, type Database } from '../shared/db.js'
import { displayName } from '../shared/identity.js'
import { assignClasses, type ClassState } from './assignment.js'

const DAY_MS = 24 * 60 * 60_000

/** Held for the whole run, so two runs (say, from two server instances at midnight) never overlap. */
const DAILY_JOB_LOCK = 4242001

// Fixed orders: slots are locked in this order, and classes are created in this order.
const SLOTS: readonly Slot[] = ['morning', 'afternoon', 'evening']
const DIVISIONS: readonly Division[] = ['primary', 'junior', 'senior']

/** Statuses that count against a slot's capacity (the same set as in verify); waitlisted students wait outside it. */
const CAPACITY_STATUSES = ['pending', 'active', 'suspended'] as const

export interface DailyJobReport {
  dropped: number
  promoted: number
  assigned: number
  classesCreated: number
}

type Trx = Kysely<Database>

/**
 * The nightly job, in one transaction: drop students who stopped coming, promote the waitlist into the freed
 * seats, and put every pending student into a class. Running it again the same day changes nothing.
 */
export async function runDailyJob(deps: { db: Kysely<Database>; config: SchoolConfig; clock: Clock }): Promise<DailyJobReport> {
  const { db, config, clock } = deps

  return db.transaction().execute(async (trx) => {
    await sql`select pg_advisory_xact_lock(${sql.lit(DAILY_JOB_LOCK)})`.execute(trx)
    // The same slot locks verify takes, so a verify cannot push a slot over its capacity while the waitlist is promoted.
    for (const slot of SLOTS) await lock(trx, slotLockKey(slot))

    // Read after the locks, so a run that had to wait still uses the time it actually runs at.
    const now = clock.now()
    const dropped = await dropInactive(trx, config, now)
    const promoted = await promoteWaitlist(trx, config)
    const { assigned, classesCreated } = await assignPending(trx, config, now)
    return { dropped, promoted, assigned, classesCreated }
  })
}

/** Active students absent for more than inactivityDropDays are dropped; a student who never came counts from assignment. */
async function dropInactive(trx: Trx, config: SchoolConfig, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - config.inactivityDropDays * DAY_MS)
  const result = await trx
    .updateTable('students')
    .set({ status: 'dropped', classId: null })
    .where('status', '=', 'active')
    .where((eb) => eb.fn.coalesce('lastAttendedAt', 'assignedAt'), '<', cutoff)
    .executeTakeFirstOrThrow()
  return Number(result.numUpdatedRows)
}

/** Per slot, the earliest waitlisted students take the seats that are free. */
async function promoteWaitlist(trx: Trx, config: SchoolConfig): Promise<number> {
  let promoted = 0
  for (const slot of SLOTS) {
    const { count } = await trx
      .selectFrom('students')
      .select((eb) => eb.fn.countAll().as('count'))
      .where('slot', '=', slot)
      .where('status', 'in', [...CAPACITY_STATUSES])
      .executeTakeFirstOrThrow()
    const free = config.slotCapacity - Number(count)
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
          .orderBy('createdAt')
          .orderBy('id')
          .limit(free),
      )
      .executeTakeFirstOrThrow()
    promoted += Number(result.numUpdatedRows)
  }
  return promoted
}

/** Per division and slot, runs the assignment algorithm over the pending students, opening new classes as needed. */
async function assignPending(
  trx: Trx,
  config: SchoolConfig,
  now: Date,
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
        .orderBy('createdAt')
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
      const states: ClassState[] = classes.map((c) => ({
        classId: c.id,
        classNo: c.classNo,
        memberNames: members.filter((m) => m.classId === c.id).map((m) => displayName(m.ownerName, m.aiName)),
      }))

      const { placements, newClassCount } = assignClasses(
        states,
        pending.map((s) => ({ studentId: s.id, displayName: displayName(s.ownerName, s.aiName) })),
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
