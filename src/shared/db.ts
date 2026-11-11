import { CamelCasePlugin, Kysely, PostgresDialect, sql } from 'kysely'
import { Migrator, type MigrationProvider } from 'kysely/migration'
import pg from 'pg'
import { DEFAULT_DATABASE_TIMEOUTS, type DatabaseTimeouts, type Division, type Slot } from './config.js'
import * as m0001 from './migrations/0001_init.js'
import * as m0002 from './migrations/0002_key_reset_decoys.js'
import * as m0003 from './migrations/0003_student_queue_time.js'
import * as m0004 from './migrations/0004_class_service.js'
import * as m0005 from './migrations/0005_school_rules_agreement.js'
import * as m0006 from './migrations/0006_ai_id.js'
import * as m0007 from './migrations/0007_llm.js'
import * as m0008 from './migrations/0008_admin_discipline.js'
import * as m0009 from './migrations/0009_llm_cached_tokens.js'
import * as m0010 from './migrations/0010_call_on_checks.js'
import * as m0011 from './migrations/0011_maintenance.js'
import * as m0012 from './migrations/0012_ops.js'
import type { Database } from './schema.js'

export type { Database, StudentStatus } from './schema.js'
export { MEMBER_STATUSES, SEAT_STATUSES } from './schema.js'

// pg turns a `date` into a Date at local midnight, which names a different day in other time zones. The school
// calendar has days, not instants, so dates are read as the `YYYY-MM-DD` text Postgres sends (and written as text).
const types: pg.CustomTypesConfig = {
  getTypeParser: (oid, format) =>
    oid === pg.types.builtins.DATE ? (text: string) => text : pg.types.getTypeParser(oid, format),
}

/**
 * Kysely over Postgres. TypeScript names are camelCase; tables and columns are snake_case. Every connection of the
 * pool has the statement and lock timeouts of `timeouts`, so a stuck query is cancelled instead of holding it.
 */
export function createDb(
  databaseUrl: string,
  timeouts: DatabaseTimeouts = DEFAULT_DATABASE_TIMEOUTS,
): Kysely<Database> {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    types,
    // Sent when each connection opens; 0 is not sent at all, which leaves the database's own setting.
    statement_timeout: timeouts.statementMs,
    lock_timeout: timeouts.lockMs,
  })
  // An idle client whose connection drops (say, the database restarts) emits 'error' on the pool.
  // Unhandled, that is an uncaught exception that crashes the process; the pool discards the dead client by itself.
  pool.on('error', (err) => console.error('Idle database connection failed', err))
  return new Kysely<Database>({
    dialect: new PostgresDialect({ pool }),
    // Only column names are renamed. Without this, the plugin also rewrites the keys inside a jsonb value on the way
    // out (matched_term would read back as matchedTerm) but not on the way in.
    plugins: [new CamelCasePlugin({ maintainNestedObjectKeys: true })],
  })
}

// Listed in code (not read from a directory) so it works unchanged from src, tsx and a bundle.
const provider: MigrationProvider = {
  async getMigrations() {
    return {
      '0001_init': m0001,
      '0002_key_reset_decoys': m0002,
      '0003_student_queue_time': m0003,
      '0004_class_service': m0004,
      '0005_school_rules_agreement': m0005,
      '0006_ai_id': m0006,
      '0007_llm': m0007,
      '0008_admin_discipline': m0008,
      '0009_llm_cached_tokens': m0009,
      '0010_call_on_checks': m0010,
      '0011_maintenance': m0011,
      '0012_ops': m0012,
    }
  },
}

/**
 * Runs the migrations not run yet, on one connection with no statement timeout: building an index on a big table may
 * take longer than any query of the services should, and a migration cancelled halfway would fail every start. The
 * lock timeout stays, so a migration waiting for a table that is in use gives up rather than queueing every query of
 * that table behind it.
 */
export async function migrateToLatest(db: Kysely<Database>): Promise<void> {
  const { error } = await db.connection().execute(async (conn) => {
    await sql`set statement_timeout = 0`.execute(conn)
    try {
      return await new Migrator({ db: conn, provider }).migrateToLatest()
    } finally {
      // Back to the pool's setting before the connection goes back to the pool.
      await sql`reset statement_timeout`.execute(conn)
    }
  })
  if (error) throw error
}

/**
 * Throws, naming them, when there are migrations the database has not run. For a service that does not migrate the
 * database itself (the class service: the registration service runs the migrations).
 */
export async function assertMigrationsUpToDate(db: Kysely<Database>): Promise<void> {
  const migrations = await new Migrator({ db, provider }).getMigrations()
  const pending = migrations.filter((m) => m.executedAt === undefined).map((m) => m.name)
  if (pending.length > 0) {
    throw new Error(
      `The database is not migrated to the latest version (pending: ${pending.join(', ')}). ` +
        'Start the registration service first: it runs the migrations.',
    )
  }
}

/** Takes a transaction-scoped advisory lock, so transactions touching the same key run one at a time. */
export async function lock(trx: Kysely<Database>, key: string): Promise<void> {
  await sql`select pg_advisory_xact_lock(hashtext(${key}))`.execute(trx)
}

/** The lock key for a slot: verify takes it to read slot capacity, and the nightly job takes it to promote the waitlist. */
export function slotLockKey(slot: Slot): string {
  return `slot:${slot}`
}

/**
 * The lock key for one day's lesson of a division: the lesson store takes it for every change to the lesson (an edit,
 * an approval), and the class runtime takes it to start teaching one, so a lesson never changes while a class begins
 * it.
 */
export function lessonLockKey(date: string, division: Division): string {
  return `lesson:${date}:${division}`
}
