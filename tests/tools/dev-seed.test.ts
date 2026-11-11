import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import type WebSocket from 'ws'
import { hashSecret } from '../../src/shared/secrets.js'
import {
  databaseRefusal,
  DevSeedError,
  isLocalDatabaseUrl,
  seedClass,
  seedClasses,
  writeKeysFile,
} from '../../src/tools/dev-seed.js'
import { buildTestClassApp } from '../helpers/class-app.js'
import { insertClass } from '../helpers/factories.js'

/** A wall-clock time in Beijing (the example config's timezone) on Monday 2 November 2026. */
const at = (time: string) => new Date(`2026-11-02T${time}:00+08:00`)

describe('the local database check', () => {
  test.each([
    'postgres://school:school@localhost:5432/school',
    'postgresql://u:p@127.0.0.1:55432/db',
    'postgres://localhost/school',
    'postgres://u:p@localhost:5432/school?host=127.0.0.1&host=localhost',
  ])('lets the tool run on %s', (url) => {
    expect(isLocalDatabaseUrl(url)).toBe(true)
  })

  test.each([
    'postgres://school:school@db.example.com:5432/school',
    'postgres://u:p@localhost.example.com:5432/school',
    'postgres://u:p@127.0.0.2:5432/school',
    'postgres://u:p@10.0.0.5:5432/school',
    'postgres://u:p@[::1]:5432/school',
    'postgres://u:p@localhost:5432/school?host=db.example.com',
    // pg goes by the last `host` parameter; every one of them has to be local, and so does the URL's own host.
    'postgres://u:p@localhost:5432/school?host=localhost&host=db.example.com',
    'postgres://u:p@localhost:5432/school?host=db.example.com&host=localhost',
    'postgres://u:p@db.example.com:5432/school?host=localhost',
    // `localhost` here is the user name.
    'postgres://localhost@db.example.com/school',
    // No host at all: pg would go by PGHOST, or a local socket.
    'postgres:///school',
    '/var/run/postgresql school',
    'not a url',
  ])('refuses %s', (url) => {
    expect(isLocalDatabaseUrl(url)).toBe(false)
  })
})

describe('the database refusal', () => {
  const local = 'postgres://school:school@localhost:5432/school'
  const remote = 'postgres://u:secret@db:5432/school'

  test('accepts a local database and refuses a foreign one, naming only the host', () => {
    expect(databaseRefusal(local, {})).toBeNull()
    const refusal = databaseRefusal(remote, {})
    expect(refusal).toContain('db')
    expect(refusal).not.toContain('secret')
  })

  test('accepts the hosts DEV_SEED_ALLOWED_HOSTS lists (comma separated), and only those', () => {
    expect(databaseRefusal(remote, { DEV_SEED_ALLOWED_HOSTS: 'db' })).toBeNull()
    expect(databaseRefusal(remote, { DEV_SEED_ALLOWED_HOSTS: 'other, db ,' })).toBeNull()
    expect(databaseRefusal(remote, { DEV_SEED_ALLOWED_HOSTS: 'other' })).not.toBeNull()
    expect(databaseRefusal(remote, { DEV_SEED_ALLOWED_HOSTS: '' })).not.toBeNull()
    expect(databaseRefusal(remote, { DEV_SEED_ALLOWED_HOSTS: 'dbx' })).not.toBeNull()
    // Every host the URL names must be allowed, as with the local ones.
    expect(
      databaseRefusal('postgres://u:p@db:5432/school?host=evil', {
        DEV_SEED_ALLOWED_HOSTS: 'db',
      }),
    ).not.toBeNull()
    expect(
      databaseRefusal('postgres://u:p@localhost:5432/school?host=db', {
        DEV_SEED_ALLOWED_HOSTS: 'db',
      }),
    ).toBeNull()
  })

  test('refuses everything when NODE_ENV is production, a local database and a listed host included', () => {
    expect(databaseRefusal(local, { NODE_ENV: 'production' })).toContain('production')
    expect(
      databaseRefusal(remote, {
        NODE_ENV: 'production',
        DEV_SEED_ALLOWED_HOSTS: 'db',
      }),
    ).toContain('production')
  })
})

type Service = Awaited<ReturnType<typeof buildTestClassApp>>

let service: Service | undefined
const sockets: WebSocket[] = []

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.terminate()
  await service?.destroy()
  service = undefined
})

describe('seedClass', () => {
  test('opens the next class of the division and slot, with active students past the probation', async () => {
    service = await buildTestClassApp()
    const { db, config, clock } = service
    const personas = config.teacherPersonas.map((p) => p.id)
    // Two classes before it: the new one is numbered after the highest of its division and slot, and its teacher is
    // the third persona, as the daily job would pick for the school's third class.
    await insertClass(db, { division: 'junior', slot: 'evening', classNo: 1 })
    await insertClass(db, { division: 'senior', slot: 'evening', classNo: 4 })

    const seeded = await seedClass(db, config, {
      division: 'junior',
      slot: 'evening',
      students: 3,
      clock,
    })

    const cls = await db.selectFrom('classes').selectAll().where('id', '=', seeded.classId).executeTakeFirstOrThrow()
    expect(cls).toMatchObject({
      division: 'junior',
      slot: 'evening',
      classNo: 2,
      teacherPersonaId: personas[2],
    })
    expect(cls.createdAt).toEqual(clock.now())
    expect(seeded.className).toBe('初中部·晚班·2 班')

    const rows = await db
      .selectFrom('students')
      .selectAll()
      .where('classId', '=', seeded.classId)
      .orderBy('id')
      .execute()
    expect(rows.map((r) => r.id)).toEqual(seeded.students.map((s) => s.studentId))
    expect(seeded.students.map((s) => s.displayName)).toEqual([
      '模拟主人1家的机器人1',
      '模拟主人2家的机器人2',
      '模拟主人3家的机器人3',
    ])
    rows.forEach((r, i) => {
      const n = i + 1
      expect(r).toMatchObject({
        ownerName: `模拟主人${n}`,
        aiName: `机器人${n}`,
        division: 'junior',
        slot: 'evening',
        status: 'active',
        // The example config's probation is 3 lessons: the seeded students are past it.
        lessonsAttended: 3,
        pluginType: 'sim',
        referrerId: null,
        lastAttendedAt: null,
        lastRenamedAt: null,
        suspendedUntil: null,
      })
      expect(r.email).toMatch(/@example\.invalid$/)
      // Only the hash is stored; the key itself is in the result, once.
      expect(r.keyHash).toBe(hashSecret(seeded.students[i]!.key))
      expect(seeded.students[i]!.key).toMatch(/^ais_[A-Za-z0-9_-]{43}$/)
      for (const time of [r.createdAt, r.queuedAt, r.assignedAt]) expect(time).toEqual(clock.now())
    })
    expect(new Set(rows.map((r) => r.aiId)).size).toBe(3)

    // Seeding again opens the class after it, with the next teacher, and with emails of its own.
    clock.advance(60_000)
    const again = await seedClass(db, config, {
      division: 'junior',
      slot: 'evening',
      students: 2,
      clock,
    })
    const next = await db.selectFrom('classes').selectAll().where('id', '=', again.classId).executeTakeFirstOrThrow()
    expect(next).toMatchObject({ classNo: 3, teacherPersonaId: personas[3] })
    const emails = await db.selectFrom('students').select('email').execute()
    expect(new Set(emails.map((e) => e.email)).size).toBe(5)
  })

  test('refuses more students than a class holds, and fewer than one, writing nothing', async () => {
    service = await buildTestClassApp()
    const { db, clock } = service
    const config = { ...service.config, classSize: { standard: 2, max: 3 } }

    for (const students of [4, 0, 1.5]) {
      await expect(
        seedClass(db, config, {
          division: 'junior',
          slot: 'evening',
          students,
          clock,
        }),
      ).rejects.toThrow(DevSeedError)
    }
    await expect(
      seedClass(db, config, {
        division: 'junior',
        slot: 'evening',
        students: 4,
        clock,
      }),
    ).rejects.toThrow('--students 必须是 1 到 3 之间的整数')
    expect(await db.selectFrom('classes').select('id').execute()).toEqual([])
    expect(await db.selectFrom('students').select('id').execute()).toEqual([])

    // A full class is fine.
    const seeded = await seedClass(db, config, {
      division: 'junior',
      slot: 'evening',
      students: 3,
      clock,
    })
    expect(seeded.students).toHaveLength(3)
  })

  test('writes the key file before the seeding commits, and seeds nothing when it cannot be written', async () => {
    service = await buildTestClassApp()
    const { db, config, clock } = service
    const dir = mkdtempSync(join(tmpdir(), 'dev-seed-'))
    try {
      // A directory where the file should be: it cannot be written.
      const unwritable = join(dir, 'keys.json')
      mkdirSync(unwritable)
      await expect(
        seedClass(db, config, {
          division: 'junior',
          slot: 'evening',
          students: 2,
          clock,
          keysFile: unwritable,
        }),
      ).rejects.toThrow()
      expect(await db.selectFrom('classes').select('id').execute()).toEqual([])
      expect(await db.selectFrom('students').select('id').execute()).toEqual([])

      const path = join(dir, '.sim', 'keys.json')
      const seeded = await seedClass(db, config, {
        division: 'junior',
        slot: 'evening',
        students: 2,
        clock,
        keysFile: path,
      })
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(seeded.students)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('seeded students connect with their key and are welcomed to the class', async () => {
    // Monday 19:00, before the evening doors.
    service = await buildTestClassApp()
    const { db, config, clock } = service
    const { students } = await seedClass(db, config, {
      division: 'junior',
      slot: 'evening',
      students: 2,
      clock,
    })
    const [first, second] = students
    if (first === undefined || second === undefined) throw new Error('Two students were seeded')

    // The evening doors open at 19:45.
    clock.set(at('19:50'))
    await service.runtime.tick()

    const welcomeOf = async (key: string) => {
      const received: Record<string, any>[] = []
      const ws = await service!.app.injectWS(
        '/v1/class',
        { headers: { authorization: `Bearer ${key}` } },
        {
          onInit: (socket) => void socket.on('message', (data) => void received.push(JSON.parse(String(data)))),
        },
      )
      sockets.push(ws)
      ws.send(
        JSON.stringify({
          id: 'h1',
          type: 'hello',
          protocol: 'v1',
          plugin: { type: 'sim', version: '0.0.0' },
          maxRounds: 3,
        }),
      )
      for (let waited = 0; received.length < 2; waited += 5) {
        if (waited > 5000) throw new Error(`Timed out waiting for the welcome: ${JSON.stringify(received)}`)
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      expect(received[0]).toEqual({ type: 'ack', id: 'h1', ok: true })
      return received[1]!
    }

    const welcome = await welcomeOf(first.key)
    expect(welcome).toMatchObject({
      type: 'welcome',
      student: {
        studentId: first.studentId,
        displayName: '模拟主人1家的机器人1',
      },
      class: { className: '初中部·晚班·1 班', teacher: { name: '老周' } },
      online: [],
      // Past the probation: they may start conversations from their first lesson.
      probation: false,
    })

    const theOther = await welcomeOf(second.key)
    expect(theOther).toMatchObject({
      student: {
        studentId: second.studentId,
        displayName: '模拟主人2家的机器人2',
      },
      online: [{ studentId: first.studentId, displayName: '模拟主人1家的机器人1' }],
      probation: false,
    })
  })
})

describe('seedClasses', () => {
  test('opens K classes of N students each and writes every key to the one file', async () => {
    service = await buildTestClassApp()
    const { db, config, clock } = service
    const dir = mkdtempSync(join(tmpdir(), 'dev-seed-'))
    try {
      const path = join(dir, 'keys.json')
      const seeded = await seedClasses(db, config, {
        division: 'junior',
        slot: 'evening',
        students: 2,
        classes: 3,
        clock,
        keysFile: path,
      })
      expect(seeded).toHaveLength(3)
      const classes = await db.selectFrom('classes').select(['id', 'classNo']).orderBy('classNo').execute()
      expect(classes.map((c) => c.classNo)).toEqual([1, 2, 3])
      expect(seeded.map((r) => r.classId)).toEqual(classes.map((c) => c.id))
      const students = await db.selectFrom('students').select(['id', 'classId']).execute()
      expect(students).toHaveLength(6)
      for (const result of seeded) expect(students.filter((s) => s.classId === result.classId)).toHaveLength(2)

      const written = JSON.parse(readFileSync(path, 'utf8')) as {
        studentId: number
        key: string
      }[]
      expect(written).toHaveLength(6)
      expect(written).toEqual(seeded.flatMap((r) => r.students))
      expect(new Set(written.map((w) => w.key)).size).toBe(6)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('seeds none of them when one is refused', async () => {
    service = await buildTestClassApp()
    const { db, config, clock } = service
    await expect(
      seedClasses(db, config, {
        division: 'junior',
        slot: 'evening',
        students: 0,
        classes: 2,
        clock,
      }),
    ).rejects.toThrow(DevSeedError)
    for (const classes of [0, 1.5, -1]) {
      await expect(
        seedClasses(db, config, {
          division: 'junior',
          slot: 'evening',
          students: 1,
          classes,
          clock,
        }),
      ).rejects.toThrow('--classes')
    }
    expect(await db.selectFrom('classes').select('id').execute()).toEqual([])
  })
})

describe('writeKeysFile', () => {
  let dir: string | undefined

  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
    dir = undefined
  })

  test('writes the student numbers and keys as JSON, making the directory, readable by the owner only', () => {
    dir = mkdtempSync(join(tmpdir(), 'dev-seed-'))
    const path = join(dir, 'nested', '.sim', 'keys.json')
    const students = [
      { studentId: 7, key: 'ais_a', displayName: '模拟主人1家的机器人1' },
      { studentId: 8, key: 'ais_b', displayName: '模拟主人2家的机器人2' },
    ]

    writeKeysFile(path, students)

    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(students)
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  test('tightens a file that was already there to the owner only', () => {
    dir = mkdtempSync(join(tmpdir(), 'dev-seed-'))
    const path = join(dir, 'keys.json')
    writeFileSync(path, '[]', { mode: 0o644 })

    writeKeysFile(path, [{ studentId: 7, key: 'ais_a', displayName: '模拟主人1家的机器人1' }])

    expect(statSync(path).mode & 0o777).toBe(0o600)
  })
})
