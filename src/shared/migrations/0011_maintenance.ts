import { sql, type Kysely } from 'kysely'

// Maintenance periods: one row each time the operator switches maintenance on, closed when it is switched off. The
// partial unique index lets at most one row be open at a time.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('maintenance_periods')
    .addColumn('id', 'serial', (c) => c.primaryKey())
    .addColumn('message', 'text', (c) => c.notNull())
    .addColumn('expected_back_at', 'timestamptz')
    .addColumn('started_at', 'timestamptz', (c) => c.notNull())
    .addColumn('ended_at', 'timestamptz')
    .execute()
  await sql`create unique index maintenance_periods_one_open on maintenance_periods ((true)) where ended_at is null`.execute(db)
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('maintenance_periods').execute()
}
