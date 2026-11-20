import { sql, type Expression, type Kysely, type SqlBool } from 'kysely'
import type { Static } from 'typebox'
import type { ClubId } from '../protocol/club.js'
import type { Database } from '../shared/db.js'
import { MEMBER_STATUSES, type StudentStatus } from '../shared/schema.js'

// The club members table. A row counts as a membership only while it is current (see `current`): the student is still
// at the school (active or suspended), and joined in their present time there. A row left behind by a student who
// withdrew or was expelled counts for nothing from that moment, and the nightly job deletes it; one from before a
// re-enrolment counts for nothing either, so a student who comes back joins again. Whether a member may play now (not
// suspended) is for the club service to check against the student's status. The registration service decides who may
// join (`src/registration/clubs.ts`).

export type Club = Static<typeof ClubId>

/**
 * Whether the `club_members` row `m`, joined to its student `s`, is a current membership: the student is in a class
 * (active or suspended) and joined no earlier than they last joined the queue. Re-enrolling sets `queued_at` anew (and
 * registering sets it first), so a membership from before a withdrawal ends with it.
 */
function current(): Expression<SqlBool> {
  // In brackets, so that `not` taken of it applies to the whole of it.
  return sql<SqlBool>`(s.status in (${sql.join([...MEMBER_STATUSES])}) and m.joined_at >= s.queued_at)`
}

/** The current memberships of the club, `m` joined to their students `s`. */
function currentMembers(db: Kysely<Database>, club: Club) {
  return db
    .selectFrom('clubMembers as m')
    .innerJoin('students as s', 's.id', 'm.studentId')
    .where('m.club', '=', club)
    .where(current())
}

/** When the student joined the club, null when they are not a current member. */
export async function joinedAt(db: Kysely<Database>, studentId: number, club: Club): Promise<Date | null> {
  const row = await currentMembers(db, club).select('m.joinedAt').where('m.studentId', '=', studentId).executeTakeFirst()
  return row?.joinedAt ?? null
}

export async function isMember(db: Kysely<Database>, studentId: number, club: Club): Promise<boolean> {
  return (await joinedAt(db, studentId, club)) !== null
}

/**
 * Makes the student a member from `now`: a row left from a membership that is no longer current is started again at
 * `now`. Whether they may join, and whether they are a current member already, is the caller's to check.
 */
export async function join(db: Kysely<Database>, studentId: number, club: Club, now: Date): Promise<Date> {
  await db
    .insertInto('clubMembers')
    .values({ studentId, club, joinedAt: now })
    .onConflict((oc) => oc.columns(['studentId', 'club']).doUpdateSet({ joinedAt: now }))
    .execute()
  return now
}

/** Takes the student out of the club; nothing happens when they are not a member. */
export async function leave(db: Kysely<Database>, studentId: number, club: Club): Promise<void> {
  await db.deleteFrom('clubMembers').where('studentId', '=', studentId).where('club', '=', club).execute()
}

/** Which of `studentIds` are current members of the club, in one query. */
export async function membersAmong(db: Kysely<Database>, studentIds: readonly number[], club: Club): Promise<Set<number>> {
  if (studentIds.length === 0) return new Set()
  const rows = await currentMembers(db, club).select('m.studentId').where('m.studentId', 'in', [...studentIds]).execute()
  return new Set(rows.map((r) => r.studentId))
}

/**
 * The owners' emails of the current members of the club among `studentIds`, by student number, in one query: what an
 * invitation needs to know of the ones it names. One who is not a current member is not among them.
 */
export async function memberEmails(
  db: Kysely<Database>,
  studentIds: readonly number[],
  club: Club,
): Promise<Map<number, string>> {
  if (studentIds.length === 0) return new Map()
  const rows = await currentMembers(db, club)
    .select(['m.studentId', 's.email'])
    .where('m.studentId', 'in', [...studentIds])
    .execute()
  return new Map(rows.map((r) => [r.studentId, r.email]))
}

/**
 * Deletes every row of every club that is not a current membership (the student withdrew, was expelled, or re-enrolled
 * since joining), and says how many went. Suspended members keep theirs.
 */
export async function dropStaleMemberships(db: Kysely<Database>): Promise<number> {
  const result = await db
    .deleteFrom('clubMembers as m')
    .using('students as s')
    .whereRef('s.id', '=', 'm.studentId')
    .where((eb) => eb.not(current()))
    .executeTakeFirstOrThrow()
  return Number(result.numDeletedRows)
}

/** What the club needs of a student to tell whether they may stay: their standing, and whether they are a member. */
export interface StudentStanding {
  readonly status: StudentStatus
  readonly suspendedUntil: Date | null
  /** Null when the student is in no class (or in one with no division yet), as the door counts it. */
  readonly classId: number | null
  readonly member: boolean
}

/** The standing of a student no longer on the students table: as one who withdrew. */
export const GONE_STANDING: StudentStanding = { status: 'dropped', suspendedUntil: null, classId: null, member: false }

/**
 * The standing of each of `studentIds` still on the students table, and whether they are a current member of the
 * club, in one query: what the club service's rounds of the students online need. A student not on the table is not
 * in the map.
 */
export async function standingsAmong(
  db: Kysely<Database>,
  studentIds: readonly number[],
  club: Club,
): Promise<Map<number, StudentStanding>> {
  if (studentIds.length === 0) return new Map()
  const rows = await db
    .selectFrom('students as s')
    .leftJoin('classes as c', 'c.id', 's.classId')
    .leftJoin('clubMembers as m', (j) => j.onRef('m.studentId', '=', 's.id').on('m.club', '=', club))
    .select([
      's.id',
      's.status',
      's.suspendedUntil',
      's.classId',
      'c.division',
      // No row of the club makes `current()` null, which counts as not a member.
      sql<boolean>`coalesce(${current()}, false)`.as('member'),
    ])
    .where('s.id', 'in', [...studentIds])
    .execute()
  return new Map(
    rows.map((r) => [
      r.id,
      {
        status: r.status,
        suspendedUntil: r.suspendedUntil,
        classId: r.division === null ? null : r.classId,
        member: r.member,
      },
    ]),
  )
}
