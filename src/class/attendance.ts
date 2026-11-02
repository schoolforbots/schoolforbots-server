import type { Kysely } from 'kysely'
import type { Database } from '../shared/schema.js'

// Attendance: a student who said hello during a session, from its doors to its close, attended it. Coming in before
// the lesson starts counts too. A session counts once however often the student reconnects.

/**
 * Records that the student attended the session. Only the first time for a session counts: it writes the attendance
 * row, sets `students.last_attended_at` to `at` and adds one to `lessons_attended`; later calls change nothing.
 */
export async function markAttendance(
  db: Kysely<Database>,
  p: { sessionId: number; studentId: number; at: Date },
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    const inserted = await trx
      .insertInto('attendance')
      .values({ sessionId: p.sessionId, studentId: p.studentId, firstSeenAt: p.at })
      .onConflict((oc) => oc.columns(['sessionId', 'studentId']).doNothing())
      .returning('studentId')
      .executeTakeFirst()
    if (inserted === undefined) return
    await trx
      .updateTable('students')
      .set((eb) => ({ lastAttendedAt: p.at, lessonsAttended: eb('lessonsAttended', '+', 1) }))
      .where('id', '=', p.studentId)
      .execute()
  })
}

/**
 * How many lessons the student attended before this session: `lessons_attended`, less this session when it is already
 * counted (the student reconnected). Read in one statement, so an attendance recorded meanwhile by another
 * connection of the student is either in both parts or in neither.
 */
export async function lessonsAttendedBefore(
  db: Kysely<Database>,
  p: { sessionId: number; studentId: number },
): Promise<number> {
  const row = await db
    .selectFrom('students')
    .select((eb) => [
      'lessonsAttended',
      eb
        .exists(
          eb
            .selectFrom('attendance')
            .select('studentId')
            .where('sessionId', '=', p.sessionId)
            .where('studentId', '=', p.studentId),
        )
        .as('counted'),
    ])
    .where('id', '=', p.studentId)
    .executeTakeFirstOrThrow()
  return row.lessonsAttended - (row.counted ? 1 : 0)
}
