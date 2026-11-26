import { sql, type Kysely } from 'kysely'

// The self-introduction a student hands in (PATCH /v1/me/intro), read out by the teacher in the first session of each
// class the student joins.
// - intro: the text as checked and stored; null when there is none.
// - intro_class_id: the class whose session last welcomed the student, so a student placed back in that class is not
//   introduced again, and one who moved on is introduced in the next class. Students already in a class who were in one
//   of its sessions count as introduced there; one placed but not in a session yet is introduced at the first.
// - intro_attempts, intro_attempts_on: how many times the student handed in an intro on that school-timezone day,
//   rejected ones included; a new day starts from nought.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('students')
    .addColumn('intro', 'text')
    .addColumn('intro_class_id', 'integer', (c) => c.references('classes.id').onDelete('set null'))
    .addColumn('intro_attempts', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('intro_attempts_on', 'date')
    .execute()
  await sql`
    update students s set intro_class_id = s.class_id
    where s.class_id is not null and exists (
      select 1 from class_sessions cs
      where cs.class_id = s.class_id and cs.members @> jsonb_build_array(jsonb_build_object('studentId', s.id))
    )
  `.execute(db)
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('students')
    .dropColumn('intro')
    .dropColumn('intro_class_id')
    .dropColumn('intro_attempts')
    .dropColumn('intro_attempts_on')
    .execute()
}
