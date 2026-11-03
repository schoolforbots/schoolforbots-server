import { randomBytes } from 'node:crypto'
import type { Kysely } from 'kysely'
import pg from 'pg'
import { inject } from 'vitest'
import type { DatabaseTimeouts } from '../../src/shared/config.js'
import { createDb, migrateToLatest } from '../../src/shared/db.js'
import type { Database } from '../../src/shared/schema.js'

declare module 'vitest' {
  export interface ProvidedContext {
    pgUrl: string
  }
}

async function runAdmin(adminUrl: string, statement: string): Promise<void> {
  const client = new pg.Client({ connectionString: adminUrl })
  await client.connect()
  try {
    await client.query(statement)
  } finally {
    await client.end()
  }
}

/**
 * Creates a fresh database with a random name inside the test container, migrated unless `migrate` is false. Its
 * connections have the service's default timeouts, or `timeouts`. `url` reaches the same database, for a connection
 * of a test's own.
 */
export async function createTestDb(
  options: { timeouts?: DatabaseTimeouts; migrate?: boolean } = {},
): Promise<{ db: Kysely<Database>; url: string; destroy(): Promise<void> }> {
  const adminUrl = inject('pgUrl')
  const name = `t_${randomBytes(8).toString('hex')}`
  await runAdmin(adminUrl, `create database ${name}`)

  const url = new URL(adminUrl)
  url.pathname = `/${name}`
  const db = createDb(url.toString(), options.timeouts)
  try {
    if (options.migrate !== false) await migrateToLatest(db)
  } catch (err) {
    await db.destroy()
    await runAdmin(adminUrl, `drop database ${name} with (force)`)
    throw err
  }

  return {
    db,
    url: url.toString(),
    async destroy() {
      await db.destroy()
      await runAdmin(adminUrl, `drop database ${name} with (force)`)
    },
  }
}
