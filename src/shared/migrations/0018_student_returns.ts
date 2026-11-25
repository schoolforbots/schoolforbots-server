import { sql, type Kysely } from 'kysely'

// The students who came back after they left school, one row each time, written as it happens:
//
// - `re_enroll`: a dropped student re-enrolled (`POST /v1/me/re-enroll`), with the same student number.
//   `previous_student_id` and `same_ip` are null.
// - `new_student`: a new student was registered with the email of a student who had already left (dropped or
//   expelled) when the new one was verified. `previous_student_id` is the one of them who registered last, and
//   `same_ip` whether the two registered from the same address.
//
// The students table keeps no time of leaving, so a new student whose email had a student leave only later is not a
// return, and cannot be told apart afterwards; that is why it is recorded at the time. The re-enrolls before this
// migration are kept in `queued_at` (later than `created_at` only after a re-enroll), so each student who re-enrolled
// gets one row, at their last re-enroll. The new students before it are not filled in.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('student_returns')
    .addColumn('id', 'integer', (c) => c.primaryKey().generatedByDefaultAsIdentity())
    .addColumn('student_id', 'integer', (c) => c.notNull().references('students.id'))
    .addColumn('kind', 'text', (c) => c.notNull())
    .addColumn('previous_student_id', 'integer', (c) => c.references('students.id'))
    .addColumn('same_ip', 'boolean')
    .addColumn('at', 'timestamptz', (c) => c.notNull())
    .addCheckConstraint(
      'student_returns_kind_check',
      sql`(kind = 're_enroll' and previous_student_id is null and same_ip is null)
        or (kind = 'new_student' and previous_student_id is not null and same_ip is not null)`,
    )
    .execute()
  await db.schema.createIndex('student_returns_at').on('student_returns').column('at').execute()

  await sql`
    insert into student_returns (student_id, kind, at)
    select id, 're_enroll', queued_at from students where queued_at > created_at order by id`.execute(db)
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('student_returns').execute()
}
