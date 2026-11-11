import type { Kysely } from 'kysely'
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  allMaintenanceDays,
  maintenanceDays,
  readMaintenance,
  setMaintenance,
  startMaintenanceWatch,
  type Maintenance,
} from '../../src/shared/maintenance.js'
import type { Database } from '../../src/shared/schema.js'
import { exampleConfig } from '../helpers/app.js'
import { createTestDb } from '../helpers/db.js'

let db: Kysely<Database>
let destroy: () => Promise<void>
const config = exampleConfig()
const T0 = new Date('2026-11-04T04:00:00Z')
const T1 = new Date('2026-11-04T05:00:00Z')
const T2 = new Date('2026-11-04T06:00:00Z')

beforeAll(async () => {
  ;({ db, destroy } = await createTestDb())
})
afterAll(() => destroy())
beforeEach(async () => {
  await db.deleteFrom('maintenancePeriods').execute()
})

describe('setMaintenance and readMaintenance', () => {
  test('nothing on to start with', async () => {
    expect(await readMaintenance(db)).toBeNull()
  })

  test('switching on opens a row, and what is read is what was written', async () => {
    await setMaintenance(db, { message: '升级中', expectedBackAt: T2 }, T0)
    expect(await readMaintenance(db)).toEqual({ message: '升级中', since: T0, expectedBackAt: T2 })
  })

  test('switching on again changes the message and expected time, not the start', async () => {
    await setMaintenance(db, { message: '升级中', expectedBackAt: T2 }, T0)
    await setMaintenance(db, { message: '再等等', expectedBackAt: null }, T1)
    expect(await readMaintenance(db)).toEqual({ message: '再等等', since: T0, expectedBackAt: null })
    expect(await db.selectFrom('maintenancePeriods').selectAll().execute()).toHaveLength(1)
  })

  test('two switch-ons at once leave exactly one open row', async () => {
    await Promise.all([
      setMaintenance(db, { message: '甲', expectedBackAt: null }, T0),
      setMaintenance(db, { message: '乙', expectedBackAt: null }, T1),
    ])
    const rows = await db.selectFrom('maintenancePeriods').select('endedAt').execute()
    expect(rows).toEqual([{ endedAt: null }])
  })

  test('switching off ends the row; off again does nothing', async () => {
    await setMaintenance(db, { message: '升级中', expectedBackAt: null }, T0)
    await setMaintenance(db, null, T1)
    expect(await readMaintenance(db)).toBeNull()
    await setMaintenance(db, null, T2)
    expect(await db.selectFrom('maintenancePeriods').select(['startedAt', 'endedAt']).execute()).toEqual([{ startedAt: T0, endedAt: T1 }])
    // A later period is a new row.
    await setMaintenance(db, { message: '又来', expectedBackAt: null }, T2)
    expect(await db.selectFrom('maintenancePeriods').selectAll().execute()).toHaveLength(2)
  })
})

describe('startMaintenanceWatch', () => {
  test('reads once before it returns, and tells the listener of each change but not of no change', async () => {
    await setMaintenance(db, { message: '升级中', expectedBackAt: null }, T0)
    const watch = await startMaintenanceWatch({ db, config }, { refreshMs: 3_600_000 })
    try {
      expect(watch.current()).toEqual({ message: '升级中', since: T0, expectedBackAt: null })
      const seen: (Maintenance | null)[] = []
      watch.onChange((m) => seen.push(m))

      await watch.refresh()
      expect(seen).toEqual([])

      await setMaintenance(db, { message: '改了', expectedBackAt: T2 }, T1)
      await watch.refresh()
      expect(seen).toEqual([{ message: '改了', since: T0, expectedBackAt: T2 }])

      await setMaintenance(db, null, T1)
      await watch.refresh()
      expect(seen).toHaveLength(2)
      expect(seen[1]).toBeNull()
      expect(watch.current()).toBeNull()

      await setMaintenance(db, { message: '再来', expectedBackAt: null }, T2)
      await watch.refresh()
      expect(seen).toHaveLength(3)
      expect(watch.current()?.message).toBe('再来')
    } finally {
      watch.stop()
    }
  })

  test('a failed read keeps the last value and calls no listener', async () => {
    await setMaintenance(db, { message: '升级中', expectedBackAt: null }, T0)
    const error = vi.fn()
    const watch = await startMaintenanceWatch({ db, config, log: { error } }, { refreshMs: 3_600_000 })
    try {
      const listener = vi.fn()
      watch.onChange(listener)
      const spy = vi.spyOn(db, 'selectFrom').mockImplementation(() => {
        throw new Error('connection lost')
      })
      await watch.refresh()
      spy.mockRestore()
      expect(watch.current()?.message).toBe('升级中')
      expect(listener).not.toHaveBeenCalled()
      expect(error).toHaveBeenCalledTimes(1)
    } finally {
      watch.stop()
    }
  })

  test('refreshes on its own timer', async () => {
    const watch = await startMaintenanceWatch({ db, config }, { refreshMs: 20 })
    try {
      await setMaintenance(db, { message: '升级中', expectedBackAt: null }, T0)
      await vi.waitFor(() => expect(watch.current()?.message).toBe('升级中'))
    } finally {
      watch.stop()
    }
  })
})

describe('maintenanceDays', () => {
  // School time is UTC+8. The evening class is at 20:00 with the doors opening 15 minutes before; it is over at the
  // dismissal (minute 30) plus the closing grace.
  const at = (local: string) => new Date(`${local}+08:00`)
  const period = (from: string, to: string | null) =>
    db.insertInto('maintenancePeriods').values({ message: 'm', expectedBackAt: null, startedAt: at(from), endedAt: to === null ? null : at(to) }).execute()

  test('a day counts when the maintenance was on between a slot\'s doors and its close', async () => {
    await period('2026-11-03T20:10:00', '2026-11-03T20:20:00')
    expect([...(await maintenanceDays(db, '2026-11-01', '2026-11-10', config))]).toEqual(['2026-11-03'])
  })

  test('maintenance only in the small hours counts for no day', async () => {
    await period('2026-11-03T03:00:00', '2026-11-03T03:30:00')
    expect((await maintenanceDays(db, '2026-11-01', '2026-11-10', config)).size).toBe(0)
  })

  test('maintenance across midnight counts both days when a class falls in each', async () => {
    await period('2026-11-03T20:00:00', '2026-11-04T10:05:00')
    expect([...(await maintenanceDays(db, '2026-11-01', '2026-11-10', config))].sort()).toEqual(['2026-11-03', '2026-11-04'])
  })

  test('a period still on counts the days from its start; days after `to` are left out', async () => {
    await period('2026-11-03T19:00:00', null)
    expect([...(await maintenanceDays(db, '2026-11-01', '2026-11-05', config))].sort()).toEqual([
      '2026-11-03',
      '2026-11-04',
      '2026-11-05',
    ])
    expect([...(await maintenanceDays(db, '2026-11-01', '2026-11-03', config))]).toEqual(['2026-11-03'])
  })

  test('a day before `from` is not looked at', async () => {
    await period('2026-11-03T20:10:00', '2026-11-03T20:20:00')
    expect((await maintenanceDays(db, '2026-11-04', '2026-11-10', config)).size).toBe(0)
  })

  test('allMaintenanceDays starts from the earliest period on record', async () => {
    expect((await allMaintenanceDays(db, '2026-11-10', config)).size).toBe(0)
    await period('2026-09-03T20:10:00', '2026-09-03T20:20:00')
    await period('2026-11-03T20:10:00', '2026-11-03T20:20:00')
    expect([...(await allMaintenanceDays(db, '2026-11-10', config))].sort()).toEqual(['2026-09-03', '2026-11-03'])
  })
})
