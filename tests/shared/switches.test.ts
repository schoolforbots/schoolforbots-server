import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { createDb } from '../../src/shared/db.js'
import type { Database } from '../../src/shared/schema.js'
import { setSwitch, startSwitches, switchChanges } from '../../src/shared/switches.js'
import type { Kysely } from 'kysely'
import { exampleConfig } from '../helpers/app.js'
import { createTestClock } from '../helpers/clock.js'
import { createTestDb } from '../helpers/db.js'

let db: Kysely<Database>
let url: string
let destroy: () => Promise<void>
const config = exampleConfig()
const clock = createTestClock(new Date('2026-11-04T04:00:00Z'))
const T0 = new Date('2026-11-04T04:00:00Z')

beforeAll(async () => {
  ;({ db, url, destroy } = await createTestDb())
})
afterAll(() => destroy())
beforeEach(async () => {
  await db.deleteFrom('switches').execute()
  await db.deleteFrom('switchChanges').execute()
})

describe('switches', () => {
  test('with no row, a switch has the config default', async () => {
    const s = await startSwitches({ db, config, clock })
    try {
      expect(s.isOn('teacherLlm')).toBe(true)
      expect(s.isOn('secondLayerTeacher')).toBe(true)
      expect(s.isOn('secondLayerChat')).toBe(false)
      expect(await db.selectFrom('switches').selectAll().execute()).toEqual([])
    } finally {
      s.stop()
    }
  })

  test('a change made through one instance is read by another on its next refresh', async () => {
    const a = await startSwitches({ db, config, clock })
    const b = await startSwitches({ db, config, clock })
    try {
      await setSwitch(db, 'secondLayerChat', true, T0)
      await setSwitch(db, 'teacherLlm', false, T0)
      expect(b.isOn('secondLayerChat')).toBe(false)
      await b.refresh()
      expect(b.isOn('secondLayerChat')).toBe(true)
      expect(b.isOn('teacherLlm')).toBe(false)
      expect(b.isOn('secondLayerTeacher')).toBe(true)
      // The other instance sees it too, and a second change to the same switch replaces the row.
      await setSwitch(db, 'secondLayerChat', false, new Date(T0.getTime() + 1000))
      await a.refresh()
      expect(a.isOn('secondLayerChat')).toBe(false)
      expect(await db.selectFrom('switches').selectAll().execute()).toHaveLength(2)
    } finally {
      a.stop()
      b.stop()
    }
  })

  test('every change is recorded, and read back by time range', async () => {
    await setSwitch(db, 'teacherLlm', false, new Date('2026-11-04T04:00:00Z'))
    await setSwitch(db, 'teacherLlm', true, new Date('2026-11-04T05:00:00Z'))
    await setSwitch(db, 'secondLayerChat', true, new Date('2026-11-04T06:00:00Z'))
    const got = await switchChanges(db, new Date('2026-11-04T04:30:00Z'), new Date('2026-11-04T06:00:00Z'))
    expect(got).toEqual([{ name: 'teacherLlm', on: true, at: new Date('2026-11-04T05:00:00Z') }])
    const all = await switchChanges(db, new Date('2026-11-04T00:00:00Z'), new Date('2026-11-05T00:00:00Z'))
    expect(all.map((c) => [c.name, c.on])).toEqual([
      ['teacherLlm', false],
      ['teacherLlm', true],
      ['secondLayerChat', true],
    ])
    const row = await db.selectFrom('switches').selectAll().where('name', '=', 'teacherLlm').executeTakeFirstOrThrow()
    expect(row.updatedAt).toEqual(new Date('2026-11-04T05:00:00Z'))
  })

  test('the database going away keeps the last values and logs only the error name', async () => {
    const own = createDb(url)
    await setSwitch(own, 'teacherLlm', false, T0)
    const errors: unknown[][] = []
    const s = await startSwitches({ db: own, config, clock, log: { error: (...a: unknown[]) => void errors.push(a) } })
    expect(s.isOn('teacherLlm')).toBe(false)
    await own.destroy()
    await expect(s.refresh()).resolves.toBeUndefined()
    s.stop()
    expect(s.isOn('teacherLlm')).toBe(false)
    expect(s.isOn('secondLayerTeacher')).toBe(true)
    expect(errors).toHaveLength(1)
    expect(JSON.stringify(errors[0])).not.toContain('destroyed')
    expect((errors[0]?.[0] as { err: string }).err).toBe('Error')
  })

  test('refreshes on its own every refreshMs, and stop() ends it', async () => {
    const s = await startSwitches({ db, config, clock }, { refreshMs: 20 })
    try {
      await setSwitch(db, 'secondLayerChat', true, T0)
      await vi.waitFor(() => expect(s.isOn('secondLayerChat')).toBe(true))
      s.stop()
      await setSwitch(db, 'secondLayerChat', false, T0)
      await new Promise((r) => setTimeout(r, 100))
      expect(s.isOn('secondLayerChat')).toBe(true)
    } finally {
      s.stop()
    }
  })

  test('a refresh asked for while one is running shares it instead of overlapping', async () => {
    const s = await startSwitches({ db, config, clock })
    try {
      const spy = vi.spyOn(db, 'selectFrom')
      await Promise.all([s.refresh(), s.refresh(), s.refresh()])
      expect(spy).toHaveBeenCalledTimes(1)
      spy.mockRestore()
    } finally {
      s.stop()
    }
  })
})
