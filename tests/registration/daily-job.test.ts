import { setTimeout as sleep } from 'node:timers/promises'
import { sql, type Kysely } from 'kysely'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { runDailyJob } from '../../src/registration/daily-job.js'
import { loadSchoolConfig, type Division, type SchoolConfig, type Slot } from '../../src/shared/config.js'
import { lock, slotLockKey } from '../../src/shared/db.js'
import type { Database } from '../../src/shared/schema.js'
import { createTestClock } from '../helpers/clock.js'
import { createTestDb } from '../helpers/db.js'
import { insertClass, insertStudent } from '../helpers/factories.js'

const HOUR = 60 * 60_000
const DAY = 24 * HOUR
const exampleConfig = loadSchoolConfig(new URL('../../config/school.example.json', import.meta.url).pathname)

let db: Kysely<Database>
let destroy: () => Promise<void>
let clock: ReturnType<typeof createTestClock>

beforeEach(async () => {
  ;({ db, destroy } = await createTestDb())
  clock = createTestClock(new Date('2026-11-03T00:00:00+08:00'))
})

afterEach(async () => {
  await destroy()
})

const job = (config: SchoolConfig = exampleConfig) => runDailyJob({ db, config, clock })

/** Member counts of the classes of one division and slot, ordered by class number. */
async function classSizes(division: Division, slot: Slot): Promise<number[]> {
  const rows = await db
    .selectFrom('classes as c')
    .leftJoin('students as s', 's.classId', 'c.id')
    .select(['c.classNo', (eb) => eb.fn.count('s.id').as('size')])
    .where('c.division', '=', division)
    .where('c.slot', '=', slot)
    .groupBy('c.classNo')
    .orderBy('c.classNo')
    .execute()
  return rows.map((r) => Number(r.size))
}

/** An hour before the clock time, which these tests keep at a local midnight: in the queue since yesterday evening. */
const lastEvening = () => new Date(clock.now().getTime() - HOUR)

/** Pending students who registered yesterday evening, so tonight's run places them. */
async function insertPending(n: number, p: { division?: Division; slot?: Slot } = {}) {
  for (let i = 0; i < n; i++) await insertStudent(db, { ...p, status: 'pending', createdAt: lastEvening() })
}

const statusOf = async (id: number) =>
  db.selectFrom('students').select(['status', 'classId', 'assignedAt']).where('id', '=', id).executeTakeFirstOrThrow()

test('spec five-day example through the database', async () => {
  const sizesAfterEachDay: number[][] = []
  for (const n of [120, 70, 10, 150, 40]) {
    await insertPending(n)
    await job()
    sizesAfterEachDay.push(await classSizes('junior', 'evening'))
    clock.advance(DAY)
  }
  expect(sizesAfterEachDay).toEqual([[120], [120, 70], [120, 80], [120, 100, 65, 65], [120, 100, 100, 70]])
})

test('running twice the same day changes nothing', async () => {
  await insertPending(130)
  expect(await job()).toEqual({ dropped: 0, promoted: 0, assigned: 130, classesCreated: 2 })
  const before = await classSizes('junior', 'evening')

  expect(await job()).toEqual({ dropped: 0, promoted: 0, assigned: 0, classesCreated: 0 })
  expect(await classSizes('junior', 'evening')).toEqual(before)
})

test('divisions and slots are assigned separately', async () => {
  await insertPending(3, { division: 'junior', slot: 'evening' })
  await insertPending(2, { division: 'primary', slot: 'morning' })
  expect(await job()).toEqual({ dropped: 0, promoted: 0, assigned: 5, classesCreated: 2 })

  const classes = await db.selectFrom('classes').select(['division', 'slot', 'classNo']).orderBy('id').execute()
  expect(classes).toHaveLength(2)
  expect(classes).toEqual(
    expect.arrayContaining([
      { division: 'junior', slot: 'evening', classNo: 1 },
      { division: 'primary', slot: 'morning', classNo: 1 },
    ]),
  )
  expect(await classSizes('junior', 'evening')).toEqual([3])
  expect(await classSizes('primary', 'morning')).toEqual([2])
})

describe('the local day', () => {
  const beijing = (local: string) => new Date(`${local}+08:00`)

  test('a second run later the same local day changes nothing, even after more students registered that morning', async () => {
    clock.set(beijing('2026-11-03T00:00:05'))
    const classId = await insertClass(db, { classNo: 1 })
    // Last came 30 days ago at 05:00: kept today whatever the time of the run, dropped tomorrow.
    const fading = await insertStudent(db, {
      status: 'active',
      classId,
      assignedAt: beijing('2026-09-01T00:00:00'),
      lastAttendedAt: beijing('2026-10-04T05:00:00'),
    })
    for (let i = 0; i < 3; i++) await insertStudent(db, { status: 'pending', createdAt: beijing('2026-11-02T20:00:00') })
    expect(await job()).toEqual({ dropped: 0, promoted: 0, assigned: 3, classesCreated: 0 })
    const sizes = await classSizes('junior', 'evening')

    clock.set(beijing('2026-11-03T09:00:00'))
    const morning: { id: number }[] = []
    for (let i = 0; i < 2; i++) morning.push(await insertStudent(db, { status: 'pending', createdAt: beijing('2026-11-03T08:00:00') }))
    expect(await job()).toEqual({ dropped: 0, promoted: 0, assigned: 0, classesCreated: 0 })
    expect(await classSizes('junior', 'evening')).toEqual(sizes)
    expect(await statusOf(fading.id)).toMatchObject({ status: 'active', classId })
    for (const { id } of morning) expect(await statusOf(id)).toMatchObject({ status: 'pending', classId: null })

    // The next night places this morning's students and drops the one who stopped coming.
    clock.set(beijing('2026-11-04T00:00:05'))
    expect(await job()).toEqual({ dropped: 1, promoted: 0, assigned: 2, classesCreated: 0 })
    expect(await statusOf(fading.id)).toMatchObject({ status: 'dropped', classId: null })
  })

  test('a student who registered at 00:00:01 waits for the next night, even when that night\'s run starts late', async () => {
    const lastMinute = await insertStudent(db, { status: 'pending', createdAt: beijing('2026-11-02T23:59:59') })
    const justAfter = await insertStudent(db, { status: 'pending', createdAt: beijing('2026-11-03T00:00:01') })

    clock.set(beijing('2026-11-03T00:00:05'))
    expect(await job()).toMatchObject({ assigned: 1 })
    expect(await statusOf(lastMinute.id)).toMatchObject({ status: 'active', assignedAt: clock.now() })
    expect(await statusOf(justAfter.id)).toMatchObject({ status: 'pending', classId: null })

    clock.set(beijing('2026-11-04T00:00:00'))
    expect(await job()).toMatchObject({ assigned: 1 })
    expect(await statusOf(justAfter.id)).toMatchObject({ status: 'active', assignedAt: clock.now() })
  })

  test('dropping goes by local calendar date, not by the time of day of the run', async () => {
    const classId = await insertClass(db, { classNo: 1 })
    const neverCame = (assignedAt: Date) => insertStudent(db, { status: 'active', classId, assignedAt, lastAttendedAt: null })
    // Today is 3 November; 30 days before it is 4 October.
    const before = await neverCame(beijing('2026-10-03T23:59:59.999'))
    const startOfDay = await neverCame(beijing('2026-10-04T00:00:00'))
    const endOfDay = await neverCame(beijing('2026-10-04T23:59:00'))

    clock.set(beijing('2026-11-03T00:00:05'))
    expect(await job()).toMatchObject({ dropped: 1 })
    expect(await statusOf(before.id)).toMatchObject({ status: 'dropped' })

    // A rerun just before the day ends keeps the same cutoff.
    clock.set(beijing('2026-11-03T23:59:30'))
    expect(await job()).toMatchObject({ dropped: 0 })
    expect(await statusOf(startOfDay.id)).toMatchObject({ status: 'active' })
    expect(await statusOf(endOfDay.id)).toMatchObject({ status: 'active' })

    clock.set(beijing('2026-11-04T00:00:05'))
    expect(await job()).toMatchObject({ dropped: 2 })
    expect(await statusOf(startOfDay.id)).toMatchObject({ status: 'dropped' })
    expect(await statusOf(endOfDay.id)).toMatchObject({ status: 'dropped' })
  })

  test('the day is the configured timezone\'s, and 30 days are 30 calendar days there', async () => {
    const config = { ...exampleConfig, timezone: 'America/New_York' }
    // New York is on EST (UTC-5) in November and was on EDT (UTC-4) in October.
    // 23:30 on 2 November in New York is already 3 November in Beijing.
    const yesterday = await insertStudent(db, { status: 'pending', createdAt: new Date('2026-11-02T23:30:00-05:00') })
    const today = await insertStudent(db, { status: 'pending', createdAt: new Date('2026-11-03T00:00:01-05:00') })
    const classId = await insertClass(db, { classNo: 1, slot: 'morning' })
    const member = (assignedAt: Date) => insertStudent(db, { status: 'active', slot: 'morning', classId, assignedAt })
    // 30 days before 3 November is 4 October, whose midnight was 04:00 UTC. Counting 30 times 24 hours back
    // from this midnight (05:00 UTC) would end an hour later and drop `kept` too.
    const stale = await member(new Date('2026-10-03T23:00:00-04:00'))
    const kept = await member(new Date('2026-10-04T00:00:00-04:00'))

    clock.set(new Date('2026-11-03T08:00:00-05:00'))
    expect(await job(config)).toMatchObject({ dropped: 1, assigned: 1 })
    expect(await statusOf(yesterday.id)).toMatchObject({ status: 'active' })
    expect(await statusOf(today.id)).toMatchObject({ status: 'pending' })
    expect(await statusOf(stale.id)).toMatchObject({ status: 'dropped' })
    expect(await statusOf(kept.id)).toMatchObject({ status: 'active' })
  })
})

describe('dropping inactive students', () => {
  test('inactive for 31 days is dropped, 29 days is kept', async () => {
    const now = clock.now()
    const classId = await insertClass(db, { classNo: 1 })
    const member = (p: { lastAttendedAt: Date | null; assignedAt: Date }) =>
      insertStudent(db, { status: 'active', classId, createdAt: new Date(now.getTime() - 60 * DAY), ...p })

    const ago = (days: number) => new Date(now.getTime() - days * DAY)

    const stale = await member({ lastAttendedAt: ago(31), assignedAt: ago(40) })
    const fresh = await member({ lastAttendedAt: ago(29), assignedAt: ago(40) })
    const neverCame = await member({ lastAttendedAt: null, assignedAt: ago(31) })
    const newlyAssigned = await member({ lastAttendedAt: null, assignedAt: ago(29) })

    const report = await job()
    expect(report).toMatchObject({ dropped: 2, promoted: 0, assigned: 0, classesCreated: 0 })

    expect(await statusOf(stale.id)).toMatchObject({ status: 'dropped', classId: null })
    expect(await statusOf(neverCame.id)).toMatchObject({ status: 'dropped', classId: null })
    expect(await statusOf(fresh.id)).toMatchObject({ status: 'active', classId })
    expect(await statusOf(newlyAssigned.id)).toMatchObject({ status: 'active', classId })
  })

  test('the last attendance counts, not the assignment date; exactly 30 days is still kept', async () => {
    const now = clock.now()
    const classId = await insertClass(db, { classNo: 1 })
    const attendedRecently = await insertStudent(db, {
      status: 'active',
      classId,
      assignedAt: new Date(now.getTime() - 90 * DAY),
      lastAttendedAt: new Date(now.getTime() - 1 * DAY),
    })
    const onTheLine = await insertStudent(db, {
      status: 'active',
      classId,
      assignedAt: new Date(now.getTime() - 90 * DAY),
      lastAttendedAt: new Date(now.getTime() - 30 * DAY),
    })

    expect(await job()).toMatchObject({ dropped: 0 })
    expect(await statusOf(attendedRecently.id)).toMatchObject({ status: 'active' })
    expect(await statusOf(onTheLine.id)).toMatchObject({ status: 'active' })
  })

  test('only active students are dropped', async () => {
    const old = new Date(clock.now().getTime() - 90 * DAY)
    const classId = await insertClass(db, { classNo: 1 })
    const suspended = await insertStudent(db, { status: 'suspended', classId, assignedAt: old, lastAttendedAt: old })

    expect((await job()).dropped).toBe(0)
    expect(await statusOf(suspended.id)).toMatchObject({ status: 'suspended', classId })
  })

  test('the cutoff follows inactivityDropDays', async () => {
    const now = clock.now()
    const classId = await insertClass(db, { classNo: 1 })
    const s = await insertStudent(db, {
      status: 'active',
      classId,
      assignedAt: new Date(now.getTime() - 10 * DAY),
      lastAttendedAt: new Date(now.getTime() - 8 * DAY),
    })
    expect((await job({ ...exampleConfig, inactivityDropDays: 7 })).dropped).toBe(1)
    expect(await statusOf(s.id)).toMatchObject({ status: 'dropped', classId: null })
  })
})

describe('promoting the waitlist', () => {
  test('waitlist is promoted into freed seats and assigned the same night', async () => {
    const now = clock.now()
    const config = { ...exampleConfig, slotCapacity: 3 }
    const classId = await insertClass(db, { classNo: 1 })
    const recent = new Date(now.getTime() - 1 * DAY)
    await insertStudent(db, { status: 'active', classId, assignedAt: recent, lastAttendedAt: recent })
    await insertStudent(db, { status: 'active', classId, assignedAt: recent, lastAttendedAt: recent })
    await insertStudent(db, {
      status: 'active',
      classId,
      assignedAt: new Date(now.getTime() - 60 * DAY),
      lastAttendedAt: new Date(now.getTime() - 31 * DAY),
    })
    // Inserted latest-first, and with created_at the other way round: the order is by when each joined the queue
    // (queued_at), not by student number and not by when the student first registered.
    const second = await insertStudent(db, {
      status: 'waitlisted',
      createdAt: new Date(now.getTime() - 5 * DAY),
      queuedAt: new Date(now.getTime() - 1 * DAY),
    })
    const first = await insertStudent(db, {
      status: 'waitlisted',
      createdAt: new Date(now.getTime() - 4 * DAY),
      queuedAt: new Date(now.getTime() - 2 * DAY),
    })

    expect(await job(config)).toEqual({ dropped: 1, promoted: 1, assigned: 1, classesCreated: 0 })

    expect(await statusOf(first.id)).toMatchObject({ status: 'active', classId, assignedAt: now })
    expect(await statusOf(second.id)).toMatchObject({ status: 'waitlisted', classId: null, assignedAt: null })
  })

  test('seats are counted per slot and pending, active and suspended all occupy one', async () => {
    const config = { ...exampleConfig, slotCapacity: 3 }
    await insertStudent(db, { slot: 'evening', status: 'pending', createdAt: clock.now() })
    const classId = await insertClass(db, { classNo: 1 })
    await insertStudent(db, { slot: 'evening', status: 'suspended', classId, assignedAt: clock.now() })
    await insertStudent(db, { slot: 'evening', status: 'dropped', createdAt: clock.now() })
    const at = (ms: number) => new Date(lastEvening().getTime() + ms)
    const evening = await insertStudent(db, { slot: 'evening', status: 'waitlisted', createdAt: at(0) })
    const eveningLate = await insertStudent(db, { slot: 'evening', status: 'waitlisted', createdAt: at(1) })
    // The morning slot is empty, so its waitlist is promoted up to its own capacity.
    const morning: { id: number }[] = []
    for (let i = 0; i < 4; i++) {
      morning.push(await insertStudent(db, { slot: 'morning', status: 'waitlisted', createdAt: at(i) }))
    }

    // Evening has 2 seats taken of 3, so one is promoted; morning has 3 free seats.
    expect(await job(config)).toMatchObject({ dropped: 0, promoted: 4 })
    expect(await statusOf(evening.id)).toMatchObject({ status: 'active' })
    expect(await statusOf(eveningLate.id)).toMatchObject({ status: 'waitlisted' })
    const morningStatuses = await Promise.all(morning.map(async (s) => (await statusOf(s.id)).status))
    expect(morningStatuses).toEqual(['active', 'active', 'active', 'waitlisted'])
  })

  test('a full slot promotes nobody', async () => {
    const config = { ...exampleConfig, slotCapacity: 2 }
    await insertPending(2)
    const waiting = await insertStudent(db, { status: 'waitlisted', createdAt: clock.now() })

    expect(await job(config)).toMatchObject({ promoted: 0, assigned: 2 })
    expect(await statusOf(waiting.id)).toMatchObject({ status: 'waitlisted', classId: null })
  })
})

describe('placing pending students', () => {
  test('pending students are placed in queue order, not by student number or first registration', async () => {
    const now = clock.now()
    const config = { ...exampleConfig, classSize: { standard: 2, max: 2 } }
    const classId = await insertClass(db, { classNo: 1 })
    const recent = new Date(now.getTime() - 1 * DAY)
    await insertStudent(db, { status: 'active', classId, assignedAt: recent, lastAttendedAt: recent })
    // One seat is left in class 1. The student who joined the queue first takes it, though the other has the lower
    // student number and registered first.
    const later = await insertStudent(db, {
      status: 'pending',
      createdAt: new Date(now.getTime() - 9 * DAY),
      queuedAt: new Date(now.getTime() - 1 * DAY),
    })
    const earlier = await insertStudent(db, {
      status: 'pending',
      createdAt: new Date(now.getTime() - 8 * DAY),
      queuedAt: new Date(now.getTime() - 3 * DAY),
    })

    expect(await job(config)).toMatchObject({ assigned: 2, classesCreated: 1 })
    expect((await statusOf(earlier.id)).classId).toBe(classId)
    expect((await statusOf(later.id)).classId).not.toBe(classId)
  })
})

describe('creating classes', () => {
  test('new classes cycle through teacher personas in creation order', async () => {
    const personas = exampleConfig.teacherPersonas.map((p) => p.id)
    // One student per class, so three students open three classes.
    const config = { ...exampleConfig, classSize: { standard: 1, max: 1 } }
    await insertPending(3)
    expect(await job(config)).toMatchObject({ assigned: 3, classesCreated: 3 })

    const classes = await db.selectFrom('classes').select(['classNo', 'teacherPersonaId']).orderBy('classNo').execute()
    expect(classes).toEqual([
      { classNo: 1, teacherPersonaId: personas[0] },
      { classNo: 2, teacherPersonaId: personas[1] },
      { classNo: 3, teacherPersonaId: personas[2] },
    ])
  })

  test('the persona rotation continues from the number of classes in the whole school', async () => {
    const personas = exampleConfig.teacherPersonas.map((p) => p.id)
    expect(personas.length).toBe(6)
    // 4 classes already exist, in other groups and in other nights.
    for (let no = 1; no <= 4; no++) await insertClass(db, { division: 'senior', slot: 'morning', classNo: no })
    const config = { ...exampleConfig, classSize: { standard: 1, max: 1 } }
    await insertPending(3)

    await job(config)
    const classes = await db
      .selectFrom('classes')
      .select(['classNo', 'teacherPersonaId'])
      .where('division', '=', 'junior')
      .orderBy('classNo')
      .execute()
    expect(classes.map((c) => c.teacherPersonaId)).toEqual([personas[4], personas[5], personas[0]])
  })

  test('one rotation runs across all divisions and slots in a night', async () => {
    const personas = exampleConfig.teacherPersonas.map((p) => p.id)
    await insertPending(1, { division: 'primary', slot: 'morning' })
    await insertPending(1, { division: 'junior', slot: 'afternoon' })
    await insertPending(1, { division: 'senior', slot: 'evening' })
    await job()

    const used = await db.selectFrom('classes').select('teacherPersonaId').execute()
    expect(used.map((c) => c.teacherPersonaId).sort()).toEqual(personas.slice(0, 3).sort())
  })

  test('a new class is numbered after the highest existing number of its group, and stamped with the clock', async () => {
    const now = clock.now()
    // Two full classes (standard size 1), with a gap in the numbering.
    for (const classNo of [1, 5]) {
      const classId = await insertClass(db, { classNo })
      await insertStudent(db, { status: 'active', classId, assignedAt: now, lastAttendedAt: now })
    }
    const config = { ...exampleConfig, classSize: { standard: 1, max: 2 } }
    await insertPending(3)

    expect(await job(config)).toMatchObject({ assigned: 3, classesCreated: 2 })
    const classes = await db.selectFrom('classes').select(['classNo', 'createdAt']).orderBy('classNo').execute()
    expect(classes.map((c) => c.classNo)).toEqual([1, 5, 6, 7])
    expect(classes[2]!.createdAt).toEqual(now)
    expect(classes[3]!.createdAt).toEqual(now)
  })

  test('students with the same display name land in different classes', async () => {
    for (let i = 0; i < 2; i++) {
      await insertStudent(db, { ownerName: '阿杰', aiName: '小鱼', status: 'pending', createdAt: lastEvening() })
    }
    expect(await job()).toMatchObject({ assigned: 2, classesCreated: 2 })
    // The second 阿杰家的小鱼 cannot share the first one's class, so a second class is opened.
    expect(await classSizes('junior', 'evening')).toEqual([1, 1])
  })
})

test('assigned students become active with assignedAt = now', async () => {
  const a = await insertStudent(db, { status: 'pending', createdAt: lastEvening() })
  const b = await insertStudent(db, { status: 'pending', createdAt: lastEvening(), division: 'senior', slot: 'morning' })

  expect(await job()).toEqual({ dropped: 0, promoted: 0, assigned: 2, classesCreated: 2 })
  const now = clock.now()
  for (const { id } of [a, b]) {
    const s = await statusOf(id)
    expect(s).toMatchObject({ status: 'active', assignedAt: now })
    expect(s.classId).toEqual(expect.any(Number))
  }
})

describe('locking', () => {
  // Holds a lock in an open transaction while a job runs; the job must wait for it.
  async function jobWaitsFor(holdLock: (trx: Kysely<Database>) => Promise<void>) {
    let release!: () => void
    const released = new Promise<void>((resolve) => (release = resolve))
    let locked!: () => void
    const isLocked = new Promise<void>((resolve) => (locked = resolve))
    const holder = db.transaction().execute(async (trx) => {
      await holdLock(trx)
      locked()
      await released
    })
    await isLocked

    let finished = false
    const running = job().then((report) => {
      finished = true
      return report
    })
    await sleep(300)
    const finishedWhileLocked = finished
    release()
    await holder
    return { finishedWhileLocked, report: await running }
  }

  test.each(['morning', 'afternoon', 'evening'] as const)('the job waits for a verify holding the %s slot lock', async (slot) => {
    const { finishedWhileLocked, report } = await jobWaitsFor((trx) => lock(trx, slotLockKey(slot)))
    expect(finishedWhileLocked).toBe(false)
    expect(report).toEqual({ dropped: 0, promoted: 0, assigned: 0, classesCreated: 0 })
  })

  test('the job waits for another job holding the job lock', async () => {
    const { finishedWhileLocked } = await jobWaitsFor(async (trx) => {
      await sql`select pg_advisory_xact_lock(4242001)`.execute(trx)
    })
    expect(finishedWhileLocked).toBe(false)
  })
})
