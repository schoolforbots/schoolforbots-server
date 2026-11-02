import { sql, type Kysely, type SqlBool } from 'kysely'

// The tables the class service writes to: the day's lesson, one session per class per day with its event log,
// attendance, the chat message log, discipline records and the take-home summaries. The `division` and `slot` enum
// types come from 0001. No column here defaults to `now()`: the service passes every timestamp in from its clock.
export async function up(db: Kysely<any>): Promise<void> {
  // Set when a suspension (停课) is served after a lesson; null for a student who is not suspended.
  await db.schema.alterTable('students').addColumn('suspended_until', 'timestamptz').execute()

  // segments: [{ "text": string, "gist": string }], one per segment of the lesson.
  await db.schema
    .createTable('lessons')
    .addColumn('id', 'integer', (c) => c.primaryKey().generatedByDefaultAsIdentity())
    .addColumn('date', 'date', (c) => c.notNull())
    .addColumn('division', sql`division`, (c) => c.notNull())
    .addColumn('subject', 'text', (c) => c.notNull())
    .addColumn('title', 'text', (c) => c.notNull())
    .addColumn('segments', 'jsonb', (c) => c.notNull())
    .addColumn('approved_at', 'timestamptz')
    .addColumn('created_at', 'timestamptz', (c) => c.notNull())
    .addUniqueConstraint('lessons_date_division', ['date', 'division'])
    .execute()

  // members: who was in the class when the door opened, [{ "studentId": number, "displayName": string }].
  await db.schema
    .createTable('class_sessions')
    .addColumn('id', 'integer', (c) => c.primaryKey().generatedByDefaultAsIdentity())
    .addColumn('class_id', 'integer', (c) => c.notNull().references('classes.id'))
    .addColumn('date', 'date', (c) => c.notNull())
    .addColumn('slot', sql`slot`, (c) => c.notNull())
    .addColumn('kind', 'text', (c) => c.notNull())
    .addColumn('lesson_id', 'integer', (c) => c.references('lessons.id'))
    .addColumn('starts_at', 'timestamptz', (c) => c.notNull())
    .addColumn('ends_at', 'timestamptz', (c) => c.notNull())
    .addColumn('dismissed_at', 'timestamptz')
    .addColumn('members', 'jsonb', (c) => c.notNull())
    .addCheckConstraint('class_sessions_kind_check', sql`kind in ('lesson', 'study')`)
    .addUniqueConstraint('class_sessions_class_id_date', ['class_id', 'date'])
    .execute()

  // The ordered log of what the teacher did in a session. `step` names the timeline step that wrote the event, so a
  // restarted service can tell which steps already ran.
  await db.schema
    .createTable('class_events')
    .addColumn('id', 'integer', (c) => c.primaryKey().generatedByDefaultAsIdentity())
    .addColumn('session_id', 'integer', (c) => c.notNull().references('class_sessions.id'))
    .addColumn('seq', 'integer', (c) => c.notNull())
    .addColumn('step', 'text', (c) => c.notNull())
    .addColumn('kind', 'text', (c) => c.notNull())
    .addColumn('payload', 'jsonb', (c) => c.notNull())
    .addColumn('created_at', 'timestamptz', (c) => c.notNull())
    .addUniqueConstraint('class_events_session_id_seq', ['session_id', 'seq'])
    .addUniqueConstraint('class_events_session_id_step', ['session_id', 'step'])
    .execute()

  await db.schema
    .createTable('attendance')
    .addColumn('session_id', 'integer', (c) => c.notNull().references('class_sessions.id'))
    .addColumn('student_id', 'integer', (c) => c.notNull().references('students.id'))
    .addColumn('first_seen_at', 'timestamptz', (c) => c.notNull())
    .addPrimaryKeyConstraint('attendance_pkey', ['session_id', 'student_id'])
    .execute()

  // The full chat log. `matched_term` holds the word-list entry or phrase a moderation hit matched; for a privacy hit
  // it stays null, so the number or address that matched is not kept apart from the message text.
  await db.schema
    .createTable('messages')
    .addColumn('id', 'integer', (c) => c.primaryKey().generatedByDefaultAsIdentity())
    .addColumn('session_id', 'integer', (c) => c.notNull().references('class_sessions.id'))
    .addColumn('class_id', 'integer', (c) => c.notNull())
    .addColumn('kind', 'text', (c) => c.notNull())
    .addColumn('conversation_id', 'text')
    .addColumn('sender_id', 'integer', (c) => c.notNull().references('students.id'))
    .addColumn('recipient_id', 'integer')
    .addColumn('text', 'text', (c) => c.notNull())
    .addColumn('moderation', 'text')
    .addColumn('matched_term', 'text')
    .addColumn('delivered', 'boolean', (c) => c.notNull())
    .addColumn('ip', sql`inet`)
    .addColumn('plugin_type', 'text', (c) => c.notNull())
    .addColumn('plugin_version', 'text', (c) => c.notNull())
    .addColumn('created_at', 'timestamptz', (c) => c.notNull())
    .addCheckConstraint('messages_kind_check', sql`kind in ('chat', 'question', 'answer', 'closing')`)
    .addCheckConstraint('messages_moderation_check', sql`moderation in ('sensitive', 'injection', 'privacy')`)
    .execute()
  await db.schema.createIndex('messages_session_id').on('messages').column('session_id').execute()
  await db.schema
    .createIndex('messages_sender_id_created_at')
    .on('messages')
    .columns(['sender_id', 'created_at'])
    .execute()
  await db.schema.createIndex('messages_created_at').on('messages').column('created_at').execute()

  await db.schema
    .createTable('discipline_records')
    .addColumn('id', 'integer', (c) => c.primaryKey().generatedByDefaultAsIdentity())
    .addColumn('student_id', 'integer', (c) => c.notNull().references('students.id'))
    .addColumn('session_id', 'integer', (c) => c.references('class_sessions.id'))
    .addColumn('kind', 'text', (c) => c.notNull())
    .addColumn('detail', 'jsonb', (c) => c.notNull())
    .addColumn('matched_term', 'text')
    .addColumn('created_at', 'timestamptz', (c) => c.notNull())
    .addColumn('revoked_at', 'timestamptz')
    .addCheckConstraint(
      'discipline_records_kind_check',
      sql`kind in ('initiations', 'rounds', 'school_rule', 'privacy_block', 'parent_notice', 'suspension', 'expulsion')`,
    )
    .execute()
  // A student is recorded at most once per lesson for each of these three; the other kinds may repeat.
  await db.schema
    .createIndex('discipline_once_per_lesson')
    .on('discipline_records')
    .columns(['student_id', 'session_id', 'kind'])
    .unique()
    .where(sql<SqlBool>`kind in ('initiations', 'rounds', 'school_rule')`)
    .execute()
  await db.schema
    .createIndex('discipline_records_student_id_created_at')
    .on('discipline_records')
    .columns(['student_id', 'created_at'])
    .execute()

  await db.schema
    .createTable('summaries')
    .addColumn('session_id', 'integer', (c) => c.notNull().references('class_sessions.id'))
    .addColumn('student_id', 'integer', (c) => c.notNull().references('students.id'))
    .addColumn('payload', 'jsonb', (c) => c.notNull())
    .addColumn('created_at', 'timestamptz', (c) => c.notNull())
    .addPrimaryKeyConstraint('summaries_pkey', ['session_id', 'student_id'])
    .execute()
  // The owner reads their own summaries newest first; the primary key leads with the session, so it cannot find them.
  await db.schema
    .createIndex('summaries_student_id_session_id')
    .on('summaries')
    .columns(['student_id', 'session_id'])
    .execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('summaries').execute()
  await db.schema.dropTable('discipline_records').execute()
  await db.schema.dropTable('messages').execute()
  await db.schema.dropTable('attendance').execute()
  await db.schema.dropTable('class_events').execute()
  await db.schema.dropTable('class_sessions').execute()
  await db.schema.dropTable('lessons').execute()
  await db.schema.alterTable('students').dropColumn('suspended_until').execute()
}
