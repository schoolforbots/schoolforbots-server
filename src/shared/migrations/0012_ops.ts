import { sql, type Kysely } from 'kysely'

// What the alert mails to the operator count: service starts, internal errors and failures, the times a mail was last
// sent for each kind of alert, and the backup runs (written by the backup script). Plus the HTTP status of a failed
// model call.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('service_starts')
    .addColumn('id', 'serial', (c) => c.primaryKey())
    .addColumn('service', 'text', (c) => c.notNull())
    .addColumn('started_at', 'timestamptz', (c) => c.notNull())
    .execute()
  await db.schema.createIndex('service_starts_started_at').on('service_starts').column('started_at').execute()

  await db.schema
    .createTable('ops_events')
    .addColumn('id', 'serial', (c) => c.primaryKey())
    .addColumn('service', 'text', (c) => c.notNull())
    .addColumn('kind', 'text', (c) => c.notNull().check(sql`kind in ('internal_error', 'mail_failed', 'job_failed')`))
    .addColumn('at', 'timestamptz', (c) => c.notNull())
    .execute()
  await db.schema.createIndex('ops_events_kind_at').on('ops_events').columns(['kind', 'at']).execute()

  await db.schema
    .createTable('alert_notices')
    .addColumn('kind', 'text', (c) => c.primaryKey())
    .addColumn('last_sent_at', 'timestamptz', (c) => c.notNull())
    .execute()

  await db.schema
    .createTable('backup_runs')
    .addColumn('id', 'serial', (c) => c.primaryKey())
    .addColumn('finished_at', 'timestamptz', (c) => c.notNull())
    .addColumn('ok', 'boolean', (c) => c.notNull())
    .execute()

  await db.schema.alterTable('llm_calls').addColumn('http_status', 'integer').execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('llm_calls').dropColumn('http_status').execute()
  await db.schema.dropTable('backup_runs').execute()
  await db.schema.dropTable('alert_notices').execute()
  await db.schema.dropTable('ops_events').execute()
  await db.schema.dropTable('service_starts').execute()
}
