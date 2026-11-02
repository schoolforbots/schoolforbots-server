import { randomBytes } from 'node:crypto'
import type { Kysely } from 'kysely'
import pg from 'pg'
import { inject } from 'vitest'
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

/** Creates a fresh, migrated database with a random name inside the test container. */
export async function createTestDb(): Promise<{ db: Kysely<Database>; destroy(): Promise<void> }> {
  const adminUrl = inject('pgUrl')
  const name = `t_${randomBytes(8).toString('hex')}`
  await runAdmin(adminUrl, `create database ${name}`)

  const url = new URL(adminUrl)
  url.pathname = `/${name}`
  const db = createDb(url.toString())
  try {
    await migrateToLatest(db)
  } catch (err) {
    await db.destroy()
    await runAdmin(adminUrl, `drop database ${name} with (force)`)
    throw err
  }

  return {
    db,
    async destroy() {
      await db.destroy()
      await runAdmin(adminUrl, `drop database ${name} with (force)`)
    },
  }
}
