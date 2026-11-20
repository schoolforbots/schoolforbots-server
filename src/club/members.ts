import type { Kysely } from 'kysely'
import type { Static } from 'typebox'
import type { ClubId } from '../protocol/club.js'
import type { Database } from '../shared/db.js'

// The club members table. Membership is the row alone: whether a member may play now (not suspended, still at the
// school) is for the club service to check against the student's status. The registration service decides who may
// join (`src/registration/clubs.ts`), and the nightly job takes out the students who left the school.

export type Club = Static<typeof ClubId>

/** When the student joined the club, null when they are not a member. */
export async function joinedAt(db: Kysely<Database>, studentId: number, club: Club): Promise<Date | null> {
  const row = await db
    .selectFrom('clubMembers')
    .select('joinedAt')
    .where('studentId', '=', studentId)
    .where('club', '=', club)
    .executeTakeFirst()
  return row?.joinedAt ?? null
}

export async function isMember(db: Kysely<Database>, studentId: number, club: Club): Promise<boolean> {
  return (await joinedAt(db, studentId, club)) !== null
}

/**
 * Makes the student a member from `now`, and gives the moment they joined: `now`, or the earlier one when they are a
 * member already (joining twice changes nothing). Whether they may join is the caller's to check.
 */
export async function join(db: Kysely<Database>, studentId: number, club: Club, now: Date): Promise<Date> {
  await db
    .insertInto('clubMembers')
    .values({ studentId, club, joinedAt: now })
    .onConflict((oc) => oc.columns(['studentId', 'club']).doNothing())
    .execute()
  const at = await joinedAt(db, studentId, club)
  if (at === null) throw new Error(`student ${studentId} is not a member of ${club} right after joining`)
  return at
}

/** Takes the student out of the club; nothing happens when they are not a member. */
export async function leave(db: Kysely<Database>, studentId: number, club: Club): Promise<void> {
  await db.deleteFrom('clubMembers').where('studentId', '=', studentId).where('club', '=', club).execute()
}

/** Which of `studentIds` are members of the club, in one query. */
export async function membersAmong(db: Kysely<Database>, studentIds: readonly number[], club: Club): Promise<Set<number>> {
  if (studentIds.length === 0) return new Set()
  const rows = await db
    .selectFrom('clubMembers')
    .select('studentId')
    .where('club', '=', club)
    .where('studentId', 'in', [...studentIds])
    .execute()
  return new Set(rows.map((r) => r.studentId))
}

/**
 * Takes the students who have left the school (dropped or expelled) out of every club, and says how many memberships
 * that ended. Suspended students keep theirs.
 */
export async function dropNonStudents(db: Kysely<Database>): Promise<number> {
  const result = await db
    .deleteFrom('clubMembers')
    .where('studentId', 'in', db.selectFrom('students').select('id').where('status', 'in', ['dropped', 'expelled']))
    .executeTakeFirstOrThrow()
  return Number(result.numDeletedRows)
}
