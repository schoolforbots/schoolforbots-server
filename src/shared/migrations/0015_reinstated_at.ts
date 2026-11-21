import type { Kysely } from 'kysely'

// When a suspended student was last let back into class: by the nightly job when the suspension ran out, or when the
// penalty was lifted. A suspended student has no lesson to come to, so staying away counts from here, not from the
// last lesson before the suspension. Null for a student never let back, the students already there included.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('students').addColumn('reinstated_at', 'timestamptz').execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('students').dropColumn('reinstated_at').execute()
}
