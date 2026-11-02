import { sql, type Kysely, type SqlBool } from 'kysely'

// Migrations are frozen snapshots: enum values and index predicates are spelled out here
// rather than imported, so later edits to application constants never change this migration.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema.createType('division').asEnum(['primary', 'junior', 'senior']).execute()
  await db.schema.createType('slot').asEnum(['morning', 'afternoon', 'evening']).execute()
  await db.schema
    .createType('student_status')
    .asEnum(['pending', 'waitlisted', 'active', 'suspended', 'dropped', 'expelled'])
    .execute()

  await db.schema
    .createTable('classes')
    .addColumn('id', 'integer', (c) => c.primaryKey().generatedByDefaultAsIdentity())
    .addColumn('division', sql`division`, (c) => c.notNull())
    .addColumn('slot', sql`slot`, (c) => c.notNull())
    .addColumn('class_no', 'integer', (c) => c.notNull())
    .addColumn('teacher_persona_id', 'text', (c) => c.notNull())
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint('classes_division_slot_class_no', ['division', 'slot', 'class_no'])
    .execute()

  // students and registrations reference each other through referrer_id, and registrations
  // references students, so students comes first.
  await db.schema
    .createTable('students')
    .addColumn('id', 'integer', (c) => c.primaryKey().generatedByDefaultAsIdentity())
    .addColumn('email', 'text', (c) => c.notNull())
    .addColumn('owner_name', 'text', (c) => c.notNull())
    .addColumn('ai_name', 'text', (c) => c.notNull())
    .addColumn('division', sql`division`, (c) => c.notNull())
    .addColumn('slot', sql`slot`, (c) => c.notNull())
    .addColumn('status', sql`student_status`, (c) => c.notNull())
    .addColumn('class_id', 'integer', (c) => c.references('classes.id'))
    .addColumn('install_id', 'uuid', (c) => c.notNull())
    .addColumn('plugin_type', 'text', (c) => c.notNull())
    .addColumn('plugin_version', 'text', (c) => c.notNull())
    .addColumn('referrer_id', 'integer', (c) => c.references('students.id'))
    .addColumn('key_hash', 'text', (c) => c.notNull().unique())
    .addColumn('registration_ip', sql`inet`, (c) => c.notNull())
    .addColumn('created_at', 'timestamptz', (c) => c.notNull())
    .addColumn('assigned_at', 'timestamptz')
    .addColumn('last_attended_at', 'timestamptz')
    .addColumn('last_renamed_at', 'timestamptz')
    .addColumn('lessons_attended', 'integer', (c) => c.notNull().defaultTo(0))
    .execute()

  await db.schema
    .createIndex('students_install_seat')
    .on('students')
    .column('install_id')
    .unique()
    .where(sql<SqlBool>`status in ('pending', 'waitlisted', 'active', 'suspended')`)
    .execute()
  await db.schema
    .createIndex('students_division_slot_status')
    .on('students')
    .columns(['division', 'slot', 'status'])
    .execute()
  await db.schema.createIndex('students_class_id').on('students').column('class_id').execute()
  await db.schema.createIndex('students_email').on('students').column('email').execute()

  await db.schema
    .createTable('registrations')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('email', 'text', (c) => c.notNull())
    .addColumn('owner_name', 'text', (c) => c.notNull())
    .addColumn('ai_name', 'text', (c) => c.notNull())
    .addColumn('division', sql`division`, (c) => c.notNull())
    .addColumn('slot', sql`slot`, (c) => c.notNull())
    .addColumn('referrer_id', 'integer', (c) => c.references('students.id'))
    .addColumn('install_id', 'uuid', (c) => c.notNull())
    .addColumn('plugin_type', 'text', (c) => c.notNull())
    .addColumn('plugin_version', 'text', (c) => c.notNull())
    .addColumn('ip', sql`inet`, (c) => c.notNull())
    .addColumn('code_hash', 'text', (c) => c.notNull())
    .addColumn('attempts', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('expires_at', 'timestamptz', (c) => c.notNull())
    .addColumn('created_at', 'timestamptz', (c) => c.notNull())
    .addColumn('verified_at', 'timestamptz')
    .execute()
  await db.schema
    .createIndex('registrations_email_install_id_created_at')
    .on('registrations')
    .columns(['email', 'install_id', 'created_at'])
    .execute()
  await db.schema
    .createIndex('registrations_ip_created_at')
    .on('registrations')
    .columns(['ip', 'created_at'])
    .execute()

  await db.schema
    .createTable('key_resets')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('student_id', 'integer', (c) => c.notNull().references('students.id'))
    .addColumn('code_hash', 'text', (c) => c.notNull())
    .addColumn('attempts', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('expires_at', 'timestamptz', (c) => c.notNull())
    .addColumn('created_at', 'timestamptz', (c) => c.notNull())
    .addColumn('used_at', 'timestamptz')
    .execute()

  await db.schema
    .createTable('bans')
    .addColumn('id', 'integer', (c) => c.primaryKey().generatedByDefaultAsIdentity())
    .addColumn('email', 'text')
    .addColumn('install_id', 'uuid')
    .addColumn('until', 'timestamptz', (c) => c.notNull())
    .addColumn('reason', 'text', (c) => c.notNull())
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .execute()

  await db.schema
    .createTable('rename_events')
    .addColumn('id', 'integer', (c) => c.primaryKey().generatedByDefaultAsIdentity())
    .addColumn('student_id', 'integer', (c) => c.notNull().references('students.id'))
    .addColumn('class_id', 'integer', (c) => c.notNull().references('classes.id'))
    .addColumn('old_display_name', 'text', (c) => c.notNull())
    .addColumn('new_display_name', 'text', (c) => c.notNull())
    .addColumn('created_at', 'timestamptz', (c) => c.notNull())
    .addColumn('announced_at', 'timestamptz')
    .execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('rename_events').execute()
  await db.schema.dropTable('bans').execute()
  await db.schema.dropTable('key_resets').execute()
  await db.schema.dropTable('registrations').execute()
  await db.schema.dropTable('students').execute()
  await db.schema.dropTable('classes').execute()
  await db.schema.dropType('student_status').execute()
  await db.schema.dropType('slot').execute()
  await db.schema.dropType('division').execute()
}
