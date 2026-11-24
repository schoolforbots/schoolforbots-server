import { sql, type Kysely } from 'kysely'
import { CAPACITY_STATUSES } from '../registration/capacity.js'
import { inactivityCutoffDay } from '../shared/calendar.js'
import type { Division, SchoolConfig, Slot } from '../shared/config.js'
import { lastSeenAt, MEMBER_STATUSES } from '../shared/db.js'
import { addDaysToDate, atLocalTime, localDate, startOfLocalDay } from '../shared/local-time.js'
import { allMaintenanceDays } from '../shared/maintenance.js'
import type { Database, StudentStatus } from '../shared/schema.js'

// The school as it stands now, at the top of the school-data page: everyone ever registered, by status; the owners
// behind them, one an email address; today's sign-ups; each slot's seats, waitlist and classes; who has come lately
// and who the nightly job is about to drop; and the plugins the students in school use. Counted when the page asks.
//
// - In school: active or suspended (`MEMBER_STATUSES`), the students who keep a seat in a class.
// - Owners: the different email addresses (the school keeps them lower-cased), of the students in school and of all.
// - Today's sign-ups: the registrations started today (each sent a code) and those verified today.
// - A slot's seats: the students counted against `slotCapacity` (pending, active, suspended), as registration counts.
// - Came this week: the active students who attended a class from the start of the day six days before today on.
// - About to be dropped: the active students the nightly job would drop if they came to no class before it: tonight's
//   run, and the seven runs from tonight on (the last one counts every student the earlier ones would drop). The look-back skips breaks and the maintenance days on record, as the job's
//   does; null when the school has not been open long enough for the job to drop anyone by then.

const SLOTS: readonly Slot[] = ['morning', 'afternoon', 'evening']

export interface SchoolOverview {
  students: Record<StudentStatus, number> & { total: number }
  owners: { inSchool: number; all: number }
  signupsToday: { started: number; verified: number }
  slots: {
    slot: Slot
    /** Students counted against the capacity. */
    seated: number
    capacity: number
    waitlisted: number
    /** The classes of the slot by division, with the students in school in them. */
    classes: { division: Division; classes: number; students: number }[]
  }[]
  classSize: { standard: number; max: number }
  activity: {
    active: number
    cameThisWeek: number
    droppedTonight: number | null
    droppedWithinWeek: number | null
  }
  /** The plugins of the students in school, the most used first. */
  plugins: { pluginType: string; pluginVersion: string; students: number }[]
}

export async function schoolOverview(db: Kysely<Database>, config: SchoolConfig, now: Date): Promise<SchoolOverview> {
  const tz = config.timezone
  const today = localDate(now, tz)
  const count = () => sql<string>`count(*)`

  const byStatus = await db.selectFrom('students').select(['status', count().as('students')]).groupBy('status').execute()
  const students = { total: 0, pending: 0, waitlisted: 0, active: 0, suspended: 0, dropped: 0, expelled: 0 }
  for (const r of byStatus) {
    students[r.status] = Number(r.students)
    students.total += Number(r.students)
  }

  const owners = await db
    .selectFrom('students')
    .select([
      sql<string>`count(distinct lower(email)) filter (where status in (${sql.join([...MEMBER_STATUSES])}))`.as('inSchool'),
      sql<string>`count(distinct lower(email))`.as('all'),
    ])
    .executeTakeFirstOrThrow()

  const startOfToday = startOfLocalDay(now, tz)
  const signups = await db
    .selectFrom('registrations')
    .select([
      sql<string>`count(*) filter (where created_at >= ${startOfToday})`.as('started'),
      sql<string>`count(*) filter (where verified_at >= ${startOfToday})`.as('verified'),
    ])
    .where((eb) => eb.or([eb('createdAt', '>=', startOfToday), eb('verifiedAt', '>=', startOfToday)]))
    .executeTakeFirstOrThrow()

  const seats = await db
    .selectFrom('students')
    .select([
      'slot',
      sql<string>`count(*) filter (where status in (${sql.join([...CAPACITY_STATUSES])}))`.as('seated'),
      sql<string>`count(*) filter (where status = 'waitlisted')`.as('waitlisted'),
    ])
    .groupBy('slot')
    .execute()
  const classes = await db
    .selectFrom('classes as c')
    .leftJoin('students as s', (join) =>
      join.onRef('s.classId', '=', 'c.id').on('s.status', 'in', [...MEMBER_STATUSES]),
    )
    .select(['c.slot', 'c.division', sql<string>`count(distinct c.id)`.as('classes'), sql<string>`count(s.id)`.as('students')])
    .groupBy(['c.slot', 'c.division'])
    .execute()
  const divisions = Object.keys(config.divisions) as Division[]
  const slots = SLOTS.map((slot) => {
    const seat = seats.find((r) => r.slot === slot)
    return {
      slot,
      seated: Number(seat?.seated ?? 0),
      capacity: config.slotCapacity,
      waitlisted: Number(seat?.waitlisted ?? 0),
      classes: divisions.flatMap((division) => {
        const row = classes.find((r) => r.slot === slot && r.division === division)
        return row === undefined ? [] : [{ division, classes: Number(row.classes), students: Number(row.students) }]
      }),
    }
  })

  const weekAgo = startOfLocalDay(now, tz, 6)
  const skipped = await allMaintenanceDays(db, today, config)
  const droppedBy = async (runDay: string): Promise<number | null> => {
    const cut = inactivityCutoffDay(runDay, config.inactivityDropDays, config, skipped)
    if (cut === null) return null
    const row = await db
      .selectFrom('students')
      .select(count().as('students'))
      .where('status', '=', 'active')
      .where(lastSeenAt, '<', atLocalTime(cut, '00:00', tz))
      .executeTakeFirstOrThrow()
    return Number(row.students)
  }
  const activity = await db
    .selectFrom('students')
    .select([count().as('active'), sql<string>`count(*) filter (where last_attended_at >= ${weekAgo})`.as('came')])
    .where('status', '=', 'active')
    .executeTakeFirstOrThrow()

  const plugins = await db
    .selectFrom('students')
    .select(['pluginType', 'pluginVersion', count().as('students')])
    .where('status', 'in', [...MEMBER_STATUSES])
    .groupBy(['pluginType', 'pluginVersion'])
    .orderBy(sql`count(*)`, 'desc')
    .orderBy('pluginType')
    .orderBy('pluginVersion', 'desc')
    .execute()

  return {
    students,
    owners: { inSchool: Number(owners.inSchool), all: Number(owners.all) },
    signupsToday: { started: Number(signups.started), verified: Number(signups.verified) },
    slots,
    classSize: { standard: config.classSize.standard, max: config.classSize.max },
    activity: {
      active: Number(activity.active),
      cameThisWeek: Number(activity.came),
      // Tonight's run is tomorrow's (it runs at midnight); the seventh run from tonight is a week from today's.
      droppedTonight: await droppedBy(addDaysToDate(today, 1)),
      droppedWithinWeek: await droppedBy(addDaysToDate(today, 7)),
    },
    plugins: plugins.map((p) => ({ pluginType: p.pluginType, pluginVersion: p.pluginVersion, students: Number(p.students) })),
  }
}
