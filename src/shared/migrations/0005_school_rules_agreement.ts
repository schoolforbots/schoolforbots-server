import type { Kysely } from 'kysely'

// Registering, and re-enrolling after a drop, mean agreeing to the school rules as they stand. `school_rules_version`
// is the version agreed to (its date, as in the file name under school-rules/) and `school_rules_agreed_at` is when.
// A registration records them when it is made; verifying copies them to the student, so what the student agreed to is
// what the owner saw at registration, even if the rules changed before the code was entered. Re-enrolling overwrites
// them. Rows that exist already were made before the school asked for this, so they stay null.
export async function up(db: Kysely<any>): Promise<void> {
  for (const table of ['registrations', 'students']) {
    await db.schema
      .alterTable(table)
      .addColumn('school_rules_version', 'text')
      .addColumn('school_rules_agreed_at', 'timestamptz')
      .execute()
  }
}

export async function down(db: Kysely<any>): Promise<void> {
  for (const table of ['registrations', 'students']) {
    await db.schema.alterTable(table).dropColumn('school_rules_version').dropColumn('school_rules_agreed_at').execute()
  }
}
