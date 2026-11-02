import { CamelCasePlugin, Kysely, PostgresDialect, sql } from 'kysely'
import { Migrator, type MigrationProvider } from 'kysely/migration'
import pg from 'pg'
import * as m0001 from './migrations/0001_init.js'
import * as m0002 from './migrations/0002_key_reset_decoys.js'
import type { Database } from './schema.js'

export type { Database, StudentStatus } from './schema.js'
export { MEMBER_STATUSES, SEAT_STATUSES } from './schema.js'

/** Kysely over Postgres. TypeScript names are camelCase; tables and columns are snake_case. */
export function createDb(databaseUrl: string): Kysely<Database> {
  return new Kysely<Database>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: databaseUrl }) }),
    plugins: [new CamelCasePlugin()],
  })
}

// Listed in code (not read from a directory) so it works unchanged from src, tsx and a bundle.
const provider: MigrationProvider = {
  async getMigrations() {
    return { '0001_init': m0001, '0002_key_reset_decoys': m0002 }
  },
}

export async function migrateToLatest(db: Kysely<Database>): Promise<void> {
  const { error } = await new Migrator({ db, provider }).migrateToLatest()
  if (error) throw error
}

/** Takes a transaction-scoped advisory lock, so transactions touching the same key run one at a time. */
export async function lock(trx: Kysely<Database>, key: string): Promise<void> {
  await sql`select pg_advisory_xact_lock(hashtext(${key}))`.execute(trx)
}
