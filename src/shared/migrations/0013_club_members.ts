import type { Kysely } from 'kysely'

// The members of the clubs: one row per student and club, from the day they joined. Leaving deletes the row, so
// joining again starts a new `joined_at`.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('club_members')
    .addColumn('student_id', 'integer', (c) => c.notNull().references('students.id'))
    .addColumn('club', 'text', (c) => c.notNull())
    .addColumn('joined_at', 'timestamptz', (c) => c.notNull())
    .addPrimaryKeyConstraint('club_members_pkey', ['student_id', 'club'])
    .execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('club_members').execute()
}
