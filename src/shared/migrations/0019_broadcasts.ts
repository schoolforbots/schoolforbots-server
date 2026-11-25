import { type Kysely, sql } from 'kysely'

// The campus broadcast: short notes from the operator to the students in school, which their plugins fetch with the
// student's key (`GET /v1/me/broadcasts`) and pass on to the owner. A broadcast goes to the whole school, to some
// divisions and slots (`divisions` and `slots`, an empty list meaning all), or to some classes (`class_ids`, and then
// no divisions or slots). Only a draft is changed or deleted; a published one can only be withdrawn, for good.
// `seq` numbers the broadcasts in the order they were published, from `broadcast_seq`: the plugins page by it, so a
// draft written early and published late still comes after the ones already fetched. `notice_id` is the notice it
// was published with, when the operator broadcast a notice to the whole school.
export async function up(db: Kysely<any>): Promise<void> {
  await sql`create sequence broadcast_seq as integer`.execute(db)
  await db.schema
    .createTable('broadcasts')
    .addColumn('id', 'integer', (c) => c.primaryKey().generatedByDefaultAsIdentity())
    .addColumn('title', 'text', (c) => c.notNull())
    .addColumn('body', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('importance', 'text', (c) => c.notNull().defaultTo('normal'))
    .addColumn('divisions', sql`text[]`, (c) => c.notNull().defaultTo(sql`'{}'`))
    .addColumn('slots', sql`text[]`, (c) => c.notNull().defaultTo(sql`'{}'`))
    .addColumn('class_ids', sql`integer[]`, (c) => c.notNull().defaultTo(sql`'{}'`))
    .addColumn('status', 'text', (c) => c.notNull().defaultTo('draft'))
    .addColumn('seq', 'integer', (c) => c.unique())
    .addColumn('published_at', 'timestamptz')
    .addColumn('withdrawn_at', 'timestamptz')
    .addColumn('expires_at', 'timestamptz')
    .addColumn('notice_id', 'integer', (c) => c.references('notices.id'))
    .addColumn('created_at', 'timestamptz', (c) => c.notNull())
    .addCheckConstraint('broadcasts_importance_check', sql`importance in ('normal', 'important')`)
    .addCheckConstraint('broadcasts_status_check', sql`status in ('draft', 'published', 'withdrawn')`)
    .addCheckConstraint(
      'broadcasts_published_check',
      sql`status = 'draft' or (seq is not null and published_at is not null)`,
    )
    .addCheckConstraint('broadcasts_withdrawn_check', sql`(status = 'withdrawn') = (withdrawn_at is not null)`)
    .addCheckConstraint(
      'broadcasts_audience_check',
      sql`cardinality(class_ids) = 0 or (cardinality(divisions) = 0 and cardinality(slots) = 0)`,
    )
    .execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('broadcasts').execute()
  await sql`drop sequence broadcast_seq`.execute(db)
}
