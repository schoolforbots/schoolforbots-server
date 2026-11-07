import { sql, type Kysely } from 'kysely'

// Of a call's input tokens, how many the vendor served from its cache; they are charged at a lower price. Calls
// recorded before this column existed did not say, so they count as 0.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('llm_calls')
    .addColumn('cached_input_tokens', 'integer', (col) => col.notNull().defaultTo(sql`0`))
    .execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('llm_calls').dropColumn('cached_input_tokens').execute()
}
