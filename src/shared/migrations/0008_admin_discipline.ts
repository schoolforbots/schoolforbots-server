import { sql, type Kysely } from 'kysely'

// The admin can withdraw a student and lift a penalty by hand. Each is a record the owner reads in the school record,
// next to the suspension the admin can also give: `withdrawal` (the AI was taken out of school) and `penalty_lift`
// (the penalty and the breaks that earned it were taken back). A manual suspension is an ordinary `suspension`.
const OLD_KINDS = sql`kind in ('initiations', 'rounds', 'school_rule', 'privacy_block', 'parent_notice', 'suspension', 'expulsion')`
const NEW_KINDS = sql`kind in ('initiations', 'rounds', 'school_rule', 'privacy_block', 'parent_notice', 'suspension', 'expulsion', 'withdrawal', 'penalty_lift')`

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('discipline_records').dropConstraint('discipline_records_kind_check').execute()
  await db.schema.alterTable('discipline_records').addCheckConstraint('discipline_records_kind_check', NEW_KINDS).execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  // The old constraint knows neither kind, so those records are removed.
  await db.deleteFrom('discipline_records').where('kind', 'in', ['withdrawal', 'penalty_lift']).execute()
  await db.schema.alterTable('discipline_records').dropConstraint('discipline_records_kind_check').execute()
  await db.schema.alterTable('discipline_records').addCheckConstraint('discipline_records_kind_check', OLD_KINDS).execute()
}
