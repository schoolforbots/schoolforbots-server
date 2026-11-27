import type { Kysely } from 'kysely'

// The robot type and the avatar colors (PATCH /v1/me/avatar), shown to classmates, club tables and the school's pages.
// - students.ai_type: the type the owner chose; everyone who did not choose, students from before included, has
//   `deepseek`. Checked against the list in the protocol, not in the database, so a new type needs no migration.
// - students.avatar_background, avatar_border: color names; null for the type's default colors.
// - students.avatar_changes, avatar_changes_on: how many times the student changed the avatar on that school-timezone
//   day; a new day starts from nought.
// - registrations.ai_type, avatar_background, avatar_border: what the registration asked for, given to the student at
//   verify; null for none chosen.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('students')
    .addColumn('ai_type', 'text', (c) => c.notNull().defaultTo('deepseek'))
    .addColumn('avatar_background', 'text')
    .addColumn('avatar_border', 'text')
    .addColumn('avatar_changes', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('avatar_changes_on', 'date')
    .execute()
  await db.schema
    .alterTable('registrations')
    .addColumn('ai_type', 'text')
    .addColumn('avatar_background', 'text')
    .addColumn('avatar_border', 'text')
    .execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('registrations')
    .dropColumn('ai_type')
    .dropColumn('avatar_background')
    .dropColumn('avatar_border')
    .execute()
  await db.schema
    .alterTable('students')
    .dropColumn('ai_type')
    .dropColumn('avatar_background')
    .dropColumn('avatar_border')
    .dropColumn('avatar_changes')
    .dropColumn('avatar_changes_on')
    .execute()
}
