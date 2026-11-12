import type { Kysely } from 'kysely'
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { recordOpsEvent, recordStart } from '../../src/ops/events.js'
import { MemoryMailer, withMailFailures } from '../../src/registration/mailer.js'
import type { Database } from '../../src/shared/schema.js'
import { createTestDb } from '../helpers/db.js'

let db: Kysely<Database>
let destroy: () => Promise<void>
beforeAll(async () => {
  ;({ db, destroy } = await createTestDb())
})
afterAll(() => destroy())
beforeEach(async () => {
  await db.deleteFrom('opsEvents').execute()
  await db.deleteFrom('serviceStarts').execute()
})

const AT = new Date('2026-11-10T04:00:00Z')

test('recordStart writes a start row', async () => {
  await recordStart(db, 'class', AT)
  expect(await db.selectFrom('serviceStarts').select(['service', 'startedAt']).execute()).toEqual([{ service: 'class', startedAt: AT }])
})

describe('recordOpsEvent', () => {
  test('writes the event without making the caller wait', async () => {
    recordOpsEvent(db, { service: 'registration', kind: 'internal_error', at: AT })
    await vi.waitFor(async () => {
      expect(await db.selectFrom('opsEvents').select(['service', 'kind', 'at']).execute()).toEqual([
        { service: 'registration', kind: 'internal_error', at: AT },
      ])
    })
  })

  test('never throws when the database is broken, and logs one line without the error text', async () => {
    const { db: broken, destroy: end } = await createTestDb()
    await broken.destroy()
    const lines: unknown[] = []
    expect(() => recordOpsEvent(broken, { service: 'class', kind: 'job_failed', at: AT }, { error: (obj) => void lines.push(obj) })).not.toThrow()
    await vi.waitFor(() => expect(lines).toHaveLength(1))
    expect(() => recordOpsEvent(broken, { service: 'class', kind: 'job_failed', at: AT })).not.toThrow()
    await new Promise((r) => setTimeout(r, 50))
    await end().catch(() => undefined)
  })
})

describe('withMailFailures', () => {
  test('a failing sendCode calls back once and still throws; a good one does not call back', async () => {
    const inner = new MemoryMailer()
    const onFailure = vi.fn()
    const mailer = withMailFailures(inner, onFailure)
    await mailer.sendCode('a@example.com', 'register', '123456')
    expect(onFailure).not.toHaveBeenCalled()
    expect(inner.sent).toHaveLength(1)

    vi.spyOn(inner, 'sendCode').mockRejectedValueOnce(new Error('smtp down'))
    await expect(mailer.sendCode('a@example.com', 'register', '123456')).rejects.toThrow('smtp down')
    expect(onFailure).toHaveBeenCalledTimes(1)
  })

  test('sendNotice is not wrapped', async () => {
    const inner = new MemoryMailer()
    const onFailure = vi.fn()
    vi.spyOn(inner, 'sendNotice').mockRejectedValueOnce(new Error('smtp down'))
    await expect(withMailFailures(inner, onFailure).sendNotice('o@example.com', 's', 't', { template: 'alert', kind: 'k', time: 't' })).rejects.toThrow('smtp down')
    expect(onFailure).not.toHaveBeenCalled()
  })
})
