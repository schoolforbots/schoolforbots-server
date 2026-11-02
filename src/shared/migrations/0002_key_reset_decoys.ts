import { sql, type Kysely } from 'kysely'

// A key-reset request that names no real student (wrong email or unknown id) is stored too, as a
// "decoy" with student_id null. It then looks like a real one in every later answer: the resend
// window, the attempt limits and the expiry all apply to it, so a caller cannot tell from the
// answers whether the pair they tried matched an account.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('key_resets')
    .addColumn('requested_student_id', 'integer')
    .addColumn('requested_email', 'text')
    .execute()

  // Rows that exist already were all real: what they requested is the student and email they belong to.
  await sql`
    update key_resets
    set requested_student_id = student_id,
        requested_email = (select email from students where students.id = key_resets.student_id)`.execute(db)

  await db.schema.alterTable('key_resets').alterColumn('requested_student_id', (c) => c.setNotNull()).execute()
  await db.schema.alterTable('key_resets').alterColumn('requested_email', (c) => c.setNotNull()).execute()
  await db.schema.alterTable('key_resets').alterColumn('student_id', (c) => c.dropNotNull()).execute()

  // Serves both per-pair lookups by time: the resend window and the daily failure count.
  await db.schema
    .createIndex('key_resets_requested_pair_created_at')
    .on('key_resets')
    .columns(['requested_student_id', 'requested_email', 'created_at'])
    .execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropIndex('key_resets_requested_pair_created_at').execute()
  await sql`delete from key_resets where student_id is null`.execute(db)
  await db.schema.alterTable('key_resets').alterColumn('student_id', (c) => c.setNotNull()).execute()
  await db.schema.alterTable('key_resets').dropColumn('requested_email').execute()
  await db.schema.alterTable('key_resets').dropColumn('requested_student_id').execute()
}
