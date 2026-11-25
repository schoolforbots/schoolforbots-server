import type { Kysely } from 'kysely'

// When the student last changed their division or slot (PATCH /v1/me/placement), for the cooldown between two changes.
// Null for a student who never did, the students already there included.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('students').addColumn('last_moved_at', 'timestamptz').execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('students').dropColumn('last_moved_at').execute()
}
