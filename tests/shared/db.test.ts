import { randomUUID } from 'node:crypto'
import { sql, type Kysely } from 'kysely'
import pg from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, inject, test, vi } from 'vitest'
import type { Database } from '../../src/shared/schema.js'
import { migrateToLatest } from '../../src/shared/db.js'
import { hashSecret } from '../../src/shared/secrets.js'
import { connectTo, createTestDb } from '../helpers/db.js'
import { insertClass, insertStudent } from '../helpers/factories.js'

describe('database schema', () => {
  let db: Kysely<Database>
  let destroy: () => Promise<void>

  beforeAll(async () => {
    ;({ db, destroy } = await createTestDb())
  })

  afterAll(async () => {
    await destroy()
  })

  test('migrations create all tables', async () => {
    const tables = (await db.introspection.getTables()).map((t) => t.name).sort()
    expect(tables).toEqual(
      expect.arrayContaining(['bans', 'classes', 'key_resets', 'registrations', 'rename_events', 'students']),
    )
  })

  test('one AI id can hold only one seat', async () => {
    const aiId = randomUUID()
    await insertStudent(db, { aiId, status: 'active' })
    await expect(insertStudent(db, { aiId, status: 'pending' })).rejects.toThrow(/students_ai_seat/)
  })

  test('dropped students free the AI id', async () => {
    const aiId = randomUUID()
    await insertStudent(db, { aiId, status: 'dropped' })
    await expect(insertStudent(db, { aiId, status: 'active' })).resolves.toBeTruthy()
  })

  test('migrating again is a no-op', async () => {
    await expect(migrateToLatest(db)).resolves.toBeUndefined()
  })

  test('a class number is unique within a division and slot', async () => {
    await insertClass(db, { division: 'senior', slot: 'morning', classNo: 1 })
    await expect(insertClass(db, { division: 'senior', slot: 'morning', classNo: 1 })).rejects.toThrow(
      /classes_division_slot_class_no/,
    )
    await expect(insertClass(db, { division: 'senior', slot: 'afternoon', classNo: 1 })).resolves.toEqual(
      expect.any(Number),
    )
  })

  test('insertStudent stores only the key hash and maps camelCase columns', async () => {
    const classId = await insertClass(db, { classNo: 7 })
    const { id, key } = await insertStudent(db, { classId, status: 'active' })
    expect(id).toEqual(expect.any(Number))

    const row = await db.selectFrom('students').selectAll().where('id', '=', id).executeTakeFirstOrThrow()
    expect(row.keyHash).toBe(hashSecret(key))
    expect(row).toMatchObject({ division: 'junior', slot: 'evening', status: 'active', classId, lessonsAttended: 0 })
    expect(row.createdAt).toBeInstanceOf(Date)
  })
})

// Rolling back means deploying an older image on a database a newer version has already migrated. Migrations only add,
// so the older version works on it; it must start rather than refuse the migrations it does not know.
describe('a database migrated by a newer version', () => {
  let db: Kysely<Database>
  let destroy: () => Promise<void>

  beforeAll(async () => {
    ;({ db, destroy } = await createTestDb())
  })

  afterAll(async () => {
    await destroy()
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await sql`delete from kysely_migration where name = '9999_future'`.execute(db)
  })

  const executed = async () =>
    (await sql<{ name: string }>`select name from kysely_migration order by name`.execute(db)).rows.map((r) => r.name)
  const newerRan = () =>
    sql`insert into kysely_migration (name, timestamp) values ('9999_future', ${new Date().toISOString()})`.execute(db)

  test('starts without migrating when every migration it knows has run, and logs the names it does not know', async () => {
    await newerRan()
    const before = await executed()
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    await expect(migrateToLatest(db)).resolves.toBeUndefined()
    expect(warned).toHaveBeenCalledTimes(1)
    expect(String(warned.mock.calls[0]![0])).toContain('9999_future')
    expect(await executed()).toEqual(before)
  })

  test('refuses to start, naming it, when a migration it knows has not run', async () => {
    await newerRan()
    const { rows } = await sql<{ timestamp: string }>`
      delete from kysely_migration where name = '0012_ops' returning timestamp`.execute(db)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      await expect(migrateToLatest(db)).rejects.toThrow(/0012_ops/)
      // It runs none of them: the newer version's migrations came after it, so it cannot be run in its place.
      expect(await executed()).not.toContain('0012_ops')
    } finally {
      await sql`insert into kysely_migration (name, timestamp) values ('0012_ops', ${rows[0]!.timestamp})`.execute(db)
    }
  })
})

describe('connection pool', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  test('a connection dropped while idle is logged, not thrown', async () => {
    const { db, destroy } = await createTestDb()
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      // Leave one idle client in the pool, then kill it from the server side, like a database restart does.
      const { rows } = await sql<{ name: string }>`select current_database() as name`.execute(db)
      const name = rows[0]!.name
      const admin = new pg.Client({ connectionString: inject('pgUrl') })
      await admin.connect()
      try {
        await admin.query('select pg_terminate_backend(pid) from pg_stat_activity where datname = $1', [name])
      } finally {
        await admin.end()
      }

      // Without a pool error listener the idle client's error is an uncaught exception that crashes the process.
      await vi.waitFor(() => expect(logged).toHaveBeenCalledWith(expect.any(String), expect.any(Error)))

      // The pool replaces the dead client, so the next query still works.
      await expect(sql`select 1 as ok`.execute(db)).resolves.toBeTruthy()
    } finally {
      await destroy()
    }
  })
})

describe('timeouts', () => {
  const setting = async (db: Kysely<Database>, name: 'statement_timeout' | 'lock_timeout') =>
    (await sql<{ value: string }>`select current_setting(${name}) as value`.execute(db)).rows[0]?.value

  test('every connection has the default statement and lock timeouts', async () => {
    const { db, destroy } = await createTestDb()
    try {
      expect(await setting(db, 'statement_timeout')).toBe('30s')
      expect(await setting(db, 'lock_timeout')).toBe('10s')
    } finally {
      await destroy()
    }
  })

  test('a statement running past the statement timeout is cancelled, and the connection stays usable', async () => {
    const { db, destroy } = await createTestDb({ timeouts: { statementMs: 200, lockMs: 100 } })
    try {
      await expect(sql`select pg_sleep(2)`.execute(db)).rejects.toThrow(/statement timeout/)
      await expect(sql`select 1 as ok`.execute(db)).resolves.toBeTruthy()
    } finally {
      await destroy()
    }
  })

  test('a statement waiting for a lock past the lock timeout gives up', async () => {
    const { db, url, destroy } = await createTestDb({ timeouts: { statementMs: 5000, lockMs: 100 } })
    const holder = await connectTo(url)
    try {
      const { id } = await insertStudent(db, { status: 'active' })
      await holder.query('begin')
      await holder.query('select id from students where id = $1 for update', [id])

      const started = Date.now()
      await expect(
        db.transaction().execute((trx) => trx.selectFrom('students').select('id').where('id', '=', id).forUpdate().execute()),
      ).rejects.toThrow(/lock timeout/)
      expect(Date.now() - started).toBeLessThan(2000)
    } finally {
      await holder.end()
      await destroy()
    }
  })

  test('0 sets no timeout', async () => {
    const { db, destroy } = await createTestDb({ timeouts: { statementMs: 0, lockMs: 0 } })
    try {
      expect(await setting(db, 'statement_timeout')).toBe('0')
      expect(await setting(db, 'lock_timeout')).toBe('0')
    } finally {
      await destroy()
    }
  })

  test('migrations run with no statement timeout, and the connection gets the pool setting back', async () => {
    const { db, url, destroy } = await createTestDb({ timeouts: { statementMs: 300, lockMs: 100 }, migrate: false })
    // Kysely's migration lock (see its PostgresAdapter), held for longer than the statement timeout: the migration
    // waits for it, which its statement would not survive under a statement timeout.
    const holder = await connectTo(url)
    try {
      await holder.query('select pg_advisory_lock(3853314791062309107)')
      const migrated = migrateToLatest(db)
      await new Promise((resolve) => setTimeout(resolve, 1000))
      await holder.query('select pg_advisory_unlock(3853314791062309107)')
      await expect(migrated).resolves.toBeUndefined()

      const tables = (await db.introspection.getTables()).map((t) => t.name)
      expect(tables).toContain('students')
      // The pool has one connection now, the one the migrations ran on.
      expect(await setting(db, 'statement_timeout')).toBe('300ms')
    } finally {
      await holder.end()
      await destroy()
    }
  })
})
