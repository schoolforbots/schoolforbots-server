import { sql, type Kysely } from 'kysely'

// The call-on questions of a lesson the reviewer should look at again, because a segment the question is based on was
// rewritten: `["review", "extension"]`, either, both or none. Kept on the lesson and, as a snapshot, on each version, so
// restoring a version brings its reminders back. Lessons from before this column have none.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('lessons')
    .addColumn('call_on_checks', 'jsonb', (c) => c.notNull().defaultTo(sql`'[]'::jsonb`))
    .execute()
  await db.schema
    .alterTable('lesson_versions')
    .addColumn('call_on_checks', 'jsonb', (c) => c.notNull().defaultTo(sql`'[]'::jsonb`))
    .execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('lesson_versions').dropColumn('call_on_checks').execute()
  await db.schema.alterTable('lessons').dropColumn('call_on_checks').execute()
}
