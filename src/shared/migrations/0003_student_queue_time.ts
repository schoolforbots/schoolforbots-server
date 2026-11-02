import { sql, type Kysely } from 'kysely'

// `created_at` is when the student first registered and never changes. `queued_at` is when the student last joined
// the queue for a seat: the same moment at registration, and the moment of re-enrolling after a drop. The nightly job
// promotes the waitlist and fills classes in `queued_at` order, so a returner does not jump ahead of the students who
// verified while they were away.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('students').addColumn('queued_at', 'timestamptz').execute()

  // Rows that exist already have only ever queued once, at registration.
  await sql`update students set queued_at = created_at`.execute(db)

  await db.schema.alterTable('students').alterColumn('queued_at', (c) => c.setNotNull()).execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('students').dropColumn('queued_at').execute()
}
