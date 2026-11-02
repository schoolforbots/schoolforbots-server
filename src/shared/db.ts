import { CamelCasePlugin, Kysely, PostgresDialect, sql } from 'kysely'
import { Migrator, type MigrationProvider } from 'kysely/migration'
import pg from 'pg'
import type { Slot } from './config.js'
import * as m0001 from './migrations/0001_init.js'
import * as m0002 from './migrations/0002_key_reset_decoys.js'
import * as m0003 from './migrations/0003_student_queue_time.js'
import type { Database } from './schema.js'

export type { Database, StudentStatus } from './schema.js'
export { MEMBER_STATUSES, SEAT_STATUSES } from './schema.js'

/** Kysely over Postgres. TypeScript names are camelCase; tables and columns are snake_case. */
export function createDb(databaseUrl: string): Kysely<Database> {
  const pool = new pg.Pool({ connectionString: databaseUrl })
  // An idle client whose connection drops (say, the database restarts) emits 'error' on the pool.
  // Unhandled, that is an uncaught exception that crashes the process; the pool discards the dead client by itself.
  pool.on('error', (err) => console.error('Idle database connection failed', err))
  return new Kysely<Database>({
    dialect: new PostgresDialect({ pool }),
    plugins: [new CamelCasePlugin()],
  })
}

// Listed in code (not read from a directory) so it works unchanged from src, tsx and a bundle.
const provider: MigrationProvider = {
  async getMigrations() {
    return { '0001_init': m0001, '0002_key_reset_decoys': m0002, '0003_student_queue_time': m0003 }
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

/** The lock key for a slot: verify takes it to read slot capacity, and the nightly job takes it to promote the waitlist. */
export function slotLockKey(slot: Slot): string {
  return `slot:${slot}`
}
