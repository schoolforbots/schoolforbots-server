import { type Kysely, sql } from 'kysely'

// The school's notices, written on the admin pages and read by anyone through `GET /v1/notices`. Only a `maintenance`
// notice has a window, and always its start (`starts_at`); its end (`ends_at`) may be left out, and is after the start. `published_at` is when it was first published, kept when it is
// withdrawn and published again; a notice that has ever been out has one. `updated_at` is set only when a published
// notice is changed.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('notices')
    .addColumn('id', 'integer', (c) => c.primaryKey().generatedByDefaultAsIdentity())
    .addColumn('title', 'text', (c) => c.notNull())
    .addColumn('body', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('kind', 'text', (c) => c.notNull())
    .addColumn('starts_at', 'timestamptz')
    .addColumn('ends_at', 'timestamptz')
    .addColumn('status', 'text', (c) => c.notNull().defaultTo('draft'))
    .addColumn('published_at', 'timestamptz')
    .addColumn('updated_at', 'timestamptz')
    .addColumn('created_at', 'timestamptz', (c) => c.notNull())
    .addCheckConstraint('notices_kind_check', sql`kind in ('general', 'maintenance')`)
    .addCheckConstraint('notices_status_check', sql`status in ('draft', 'published', 'withdrawn')`)
    .addCheckConstraint('notices_published_at_check', sql`status = 'draft' or published_at is not null`)
    .addCheckConstraint(
      'notices_window_check',
      sql`(kind = 'maintenance' and starts_at is not null and (ends_at is null or ends_at > starts_at))
        or (kind = 'general' and starts_at is null and ends_at is null)`,
    )
    .execute()
  // The published notices, newest first, a page at a time.
  await db.schema
    .createIndex('notices_status_published_at')
    .on('notices')
    .columns(['status', 'published_at desc', 'id desc'])
    .execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('notices').execute()
}
