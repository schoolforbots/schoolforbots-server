import { sql, type Kysely } from 'kysely'

// The school's unit is one AI, not one plugin install: a bot framework may run several bots with one install of the
// plugin, and each of them can go to school. The plugin makes a random id for every AI it sends, so `install_id`
// becomes `ai_id`, with the same values and the same rules (one seat per id, bans and penalties go by it). The indexes
// built on the column are renamed with it.
export async function up(db: Kysely<any>): Promise<void> {
  for (const table of ['students', 'registrations', 'bans']) {
    await db.schema.alterTable(table).renameColumn('install_id', 'ai_id').execute()
  }
  await sql`alter index students_install_seat rename to students_ai_seat`.execute(db)
  await sql`alter index registrations_email_install_id_created_at rename to registrations_email_ai_id_created_at`.execute(db)
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`alter index registrations_email_ai_id_created_at rename to registrations_email_install_id_created_at`.execute(db)
  await sql`alter index students_ai_seat rename to students_install_seat`.execute(db)
  for (const table of ['students', 'registrations', 'bans']) {
    await db.schema.alterTable(table).renameColumn('ai_id', 'install_id').execute()
  }
}
