import { sql, type Kysely } from 'kysely'

// The tables behind the model: lessons made by it or pasted in (with their version history, topics and generation
// retries), what each call cost, the runtime switches, the word-list exclusions, the weekly review and the admin
// sessions. Like 0004, no column defaults to `now()`: the service passes every timestamp in from its clock.
export async function up(db: Kysely<any>): Promise<void> {
  // call_on_questions: { "review": string, "extension": string }, null for lessons made before the model.
  // flags: [{ "part": "title" | "segment" | "review" | "extension", "index": number | null, "rule": string }], the
  // places a lesson fails the checks and must be looked at. false_positives: the rules a reviewer said were wrong to
  // flag.
  await db.schema
    .alterTable('lessons')
    .addColumn('call_on_questions', 'jsonb')
    .addColumn('topic', 'text')
    .addColumn('source', 'text', (c) => c.notNull().defaultTo('import'))
    .addColumn('flags', 'jsonb', (c) => c.notNull().defaultTo(sql`'[]'::jsonb`))
    .addColumn('false_positives', 'jsonb', (c) => c.notNull().defaultTo(sql`'[]'::jsonb`))
    .addColumn('version', 'integer', (c) => c.notNull().defaultTo(1))
    .addColumn('updated_at', 'timestamptz')
    .execute()
  await db.schema
    .alterTable('lessons')
    .addCheckConstraint('lessons_source_check', sql`source in ('api', 'manual', 'import')`)
    .execute()

  // content: { title, subject, segments, call_on_questions } as of that version. No foreign key to lessons: a draft
  // lesson can be deleted while its history stays.
  await db.schema
    .createTable('lesson_versions')
    .addColumn('id', 'integer', (c) => c.primaryKey().generatedByDefaultAsIdentity())
    .addColumn('lesson_id', 'integer', (c) => c.notNull())
    .addColumn('version', 'integer', (c) => c.notNull())
    .addColumn('content', 'jsonb', (c) => c.notNull())
    .addColumn('change', 'text', (c) => c.notNull())
    .addColumn('segment_index', 'integer')
    .addColumn('reason', 'text')
    .addColumn('created_at', 'timestamptz', (c) => c.notNull())
    .addCheckConstraint(
      'lesson_versions_change_check',
      sql`change in ('generate', 'edit', 'rewrite_segment', 'rewrite_lesson', 'rewrite_call_on', 'restore', 'topic')`,
    )
    .execute()
  await db.schema.createIndex('lesson_versions_lesson_id').on('lesson_versions').column('lesson_id').execute()

  await db.schema
    .createTable('lesson_topics')
    .addColumn('date', 'date', (c) => c.notNull())
    .addColumn('division', sql`division`, (c) => c.notNull())
    .addColumn('topic', 'text', (c) => c.notNull())
    .addColumn('created_at', 'timestamptz', (c) => c.notNull())
    .addUniqueConstraint('lesson_topics_date_division', ['date', 'division'])
    .execute()

  await db.schema
    .createTable('lesson_generation')
    .addColumn('date', 'date', (c) => c.notNull())
    .addColumn('division', sql`division`, (c) => c.notNull())
    .addColumn('attempts', 'integer', (c) => c.notNull())
    .addColumn('first_failed_at', 'timestamptz', (c) => c.notNull())
    .addColumn('last_failed_at', 'timestamptz', (c) => c.notNull())
    .addColumn('last_error', 'text', (c) => c.notNull())
    .addUniqueConstraint('lesson_generation_date_division', ['date', 'division'])
    .execute()

  await db.schema
    .createTable('llm_calls')
    .addColumn('id', 'integer', (c) => c.primaryKey().generatedByDefaultAsIdentity())
    .addColumn('purpose', 'text', (c) => c.notNull())
    .addColumn('provider', 'text', (c) => c.notNull())
    .addColumn('model', 'text', (c) => c.notNull())
    .addColumn('input_tokens', 'integer', (c) => c.notNull())
    .addColumn('output_tokens', 'integer', (c) => c.notNull())
    .addColumn('cost_yuan', sql`numeric(12, 6)`, (c) => c.notNull())
    .addColumn('outcome', 'text', (c) => c.notNull())
    .addColumn('ms', 'integer', (c) => c.notNull())
    .addColumn('created_at', 'timestamptz', (c) => c.notNull())
    .addCheckConstraint('llm_calls_outcome_check', sql`outcome in ('ok', 'refused', 'failed', 'manual')`)
    .execute()
  await db.schema.createIndex('llm_calls_created_at').on('llm_calls').column('created_at').execute()

  // month: 'YYYY-MM', the month whose budget notice has gone out.
  await db.schema
    .createTable('budget_notices')
    .addColumn('month', 'text', (c) => c.primaryKey())
    .addColumn('notified_at', 'timestamptz', (c) => c.notNull())
    .execute()

  await db.schema
    .createTable('switches')
    .addColumn('name', 'text', (c) => c.primaryKey())
    .addColumn('on', 'boolean', (c) => c.notNull())
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull())
    .execute()
  await db.schema
    .createTable('switch_changes')
    .addColumn('id', 'integer', (c) => c.primaryKey().generatedByDefaultAsIdentity())
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('on', 'boolean', (c) => c.notNull())
    .addColumn('created_at', 'timestamptz', (c) => c.notNull())
    .execute()

  await db.schema
    .createTable('moderation_exclusions')
    .addColumn('id', 'integer', (c) => c.primaryKey().generatedByDefaultAsIdentity())
    .addColumn('kind', 'text', (c) => c.notNull())
    .addColumn('value', 'text', (c) => c.notNull())
    .addColumn('created_at', 'timestamptz', (c) => c.notNull())
    .addCheckConstraint('moderation_exclusions_kind_check', sql`kind in ('word', 'pattern')`)
    .addUniqueConstraint('moderation_exclusions_kind_value', ['kind', 'value'])
    .execute()

  await db.schema
    .createTable('weekly_reviews')
    .addColumn('week_start', 'date', (c) => c.primaryKey())
    .addColumn('stats', 'jsonb', (c) => c.notNull())
    .addColumn('suggestions', 'jsonb', (c) => c.notNull())
    .addColumn('created_at', 'timestamptz', (c) => c.notNull())
    .execute()

  await db.schema
    .createTable('admin_sessions')
    .addColumn('token_hash', 'text', (c) => c.primaryKey())
    .addColumn('expires_at', 'timestamptz', (c) => c.notNull())
    .addColumn('created_at', 'timestamptz', (c) => c.notNull())
    .execute()

  // One row per line the teacher would have said that failed the word list or the second layer. It never holds the
  // text; the weekly review counts them.
  await db.schema
    .createTable('teacher_line_blocks')
    .addColumn('id', 'integer', (c) => c.primaryKey().generatedByDefaultAsIdentity())
    .addColumn('session_id', 'integer', (c) => c.notNull().references('class_sessions.id'))
    .addColumn('purpose', 'text', (c) => c.notNull())
    .addColumn('layer', 'text', (c) => c.notNull())
    .addColumn('created_at', 'timestamptz', (c) => c.notNull())
    .addCheckConstraint('teacher_line_blocks_purpose_check', sql`purpose in ('answer', 'comment')`)
    .addCheckConstraint('teacher_line_blocks_layer_check', sql`layer in ('word_list', 'second_layer')`)
    .execute()

  // How many times the student connected to this class: the weekly review counts reconnects from it.
  await db.schema
    .alterTable('attendance')
    .addColumn('connections', 'integer', (c) => c.notNull().defaultTo(1))
    .execute()

  await db.schema.alterTable('messages').dropConstraint('messages_moderation_check').execute()
  await db.schema
    .alterTable('messages')
    .addCheckConstraint(
      'messages_moderation_check',
      sql`moderation in ('sensitive', 'injection', 'privacy', 'second_layer')`,
    )
    .execute()

  // `matched_term` now names the rule that hit: a word-list entry, or the wording of a rule for what the teacher says.
  await sql`comment on column messages.matched_term is 'The rule that hit: a word-list entry or the text of a phrase rule; null for a privacy hit'`.execute(db)
  await sql`comment on column discipline_records.matched_term is 'The rule that hit: a word-list entry or the text of a phrase rule; null for a privacy hit'`.execute(db)
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`comment on column discipline_records.matched_term is null`.execute(db)
  await sql`comment on column messages.matched_term is null`.execute(db)

  // The old constraint has no 'second_layer', so those rows are read as the nearest old category.
  await db.updateTable('messages').set({ moderation: 'sensitive' }).where('moderation', '=', 'second_layer').execute()
  await db.schema.alterTable('messages').dropConstraint('messages_moderation_check').execute()
  await db.schema
    .alterTable('messages')
    .addCheckConstraint('messages_moderation_check', sql`moderation in ('sensitive', 'injection', 'privacy')`)
    .execute()

  await db.schema.alterTable('attendance').dropColumn('connections').execute()
  for (const table of [
    'teacher_line_blocks',
    'admin_sessions',
    'weekly_reviews',
    'moderation_exclusions',
    'switch_changes',
    'switches',
    'budget_notices',
    'llm_calls',
    'lesson_generation',
    'lesson_topics',
    'lesson_versions',
  ]) {
    await db.schema.dropTable(table).execute()
  }
  await db.schema.alterTable('lessons').dropConstraint('lessons_source_check').execute()
  await db.schema
    .alterTable('lessons')
    .dropColumn('call_on_questions')
    .dropColumn('topic')
    .dropColumn('source')
    .dropColumn('flags')
    .dropColumn('false_positives')
    .dropColumn('version')
    .dropColumn('updated_at')
    .execute()
}
