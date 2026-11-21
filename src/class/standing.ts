import type { Kysely } from 'kysely'
import type { Static } from 'typebox'
import type { ClosingMessage } from '../protocol/ws.js'
import type { SchoolConfig } from '../shared/config.js'
import { MEMBER_STATUSES } from '../shared/db.js'
import { localMoment } from '../shared/local-time.js'
import type { Database, StudentStatus } from '../shared/schema.js'

// Whether a student's standing lets them be in class: the same rule at the door (connection.ts) and in the rounds of
// the students online (service.ts), so a student the door would turn away now is sent out of the lesson they are in.
// Only the student's own standing: the service stopping, maintenance and the time of day are each handled elsewhere.

type Closing = Static<typeof ClosingMessage>

/** What the class needs of a student to tell whether they may be in class. */
export interface ClassStanding {
  readonly status: StudentStatus
  readonly suspendedUntil: Date | null
  readonly classId: number | null
}

/** The standing of a student no longer on the students table: as one who withdrew. */
export const GONE_STANDING: ClassStanding = { status: 'dropped', suspendedUntil: null, classId: null }

/** What a student with no class is told, by status. */
function noClassMessage(status: StudentStatus): string {
  if (status === 'dropped') return '你已经退学，不在任何班级里了，重新报名分班后才能来上课。'
  if (status === 'expelled') return '你已经被开除，不在任何班级里了。'
  return '你还没有分班，分到班级后才能来上课。'
}

/**
 * Why the student's standing keeps them out of class now, as the `closing` that says so; null when it does not. A
 * suspension that has ended does not count (the student is as if active until the night puts the status back).
 * Suspended (`suspended`), then expelled (`expelled`), then in no class or not a member of one (withdrawn, waiting to
 * be placed: `session_over`), the message saying which.
 */
export function standingRefusal(s: ClassStanding, config: Pick<SchoolConfig, 'timezone'>, now: Date): Closing | null {
  const until = s.suspendedUntil
  if (s.status === 'suspended' && (until === null || until.getTime() > now.getTime())) {
    const message =
      until === null ? '你正在停课，暂时不能来上课。' : `你正在停课，${localMoment(until, config.timezone)} 以后才能回来上课。`
    return { type: 'closing', reason: 'suspended', message }
  }
  if (s.classId === null || !(MEMBER_STATUSES as readonly StudentStatus[]).includes(s.status)) {
    const reason = s.status === 'expelled' ? 'expelled' : 'session_over'
    return { type: 'closing', reason, message: noClassMessage(s.status) }
  }
  return null
}

/**
 * The standing of each of `studentIds` still on the students table, in one query by primary key: what the rounds of
 * the students online need. A student not on the table is not in the map.
 */
export async function standingsOf(
  db: Kysely<Database>,
  studentIds: readonly number[],
): Promise<Map<number, ClassStanding>> {
  if (studentIds.length === 0) return new Map()
  const rows = await db
    .selectFrom('students')
    .select(['id', 'status', 'suspendedUntil', 'classId'])
    // One array parameter, not a list of them: the same statement however many are online.
    .where((eb) => eb('id', '=', eb.fn.any(eb.val([...studentIds]))))
    .execute()
  return new Map(rows.map((r) => [r.id, { status: r.status, suspendedUntil: r.suspendedUntil, classId: r.classId }]))
}
