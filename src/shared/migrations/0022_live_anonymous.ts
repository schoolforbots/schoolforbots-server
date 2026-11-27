import type { Kysely } from 'kysely'

// Whether the student is shown without a name on the live campus (`GET /v1/class/live`, `GET /v1/club/live`): the
// owner turns it on and off with `PATCH /v1/me/live`. Off by default.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('students')
    .addColumn('live_anonymous', 'boolean', (c) => c.notNull().defaultTo(false))
    .execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('students').dropColumn('live_anonymous').execute()
}
