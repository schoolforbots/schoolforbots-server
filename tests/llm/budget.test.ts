import type { Kysely } from 'kysely'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { checkBudget, monthSpend } from '../../src/llm/budget.js'
import { MemoryMailer } from '../../src/registration/mailer.js'
import type { Database } from '../../src/shared/schema.js'
import { exampleConfig } from '../helpers/app.js'
import { createTestClock } from '../helpers/clock.js'
import { createTestDb } from '../helpers/db.js'

let db: Kysely<Database>
let destroy: () => Promise<void>

beforeAll(async () => {
  ;({ db, destroy } = await createTestDb())
})
afterAll(() => destroy())

const base = exampleConfig()
const config = { ...base, llm: { ...base.llm, monthlyBudgetYuan: 10 } }

async function spend(yuan: number, at: Date) {
  await db
    .insertInto('llmCalls')
    .values({ purpose: 'lesson', provider: 'p', model: 'm', inputTokens: 0, outputTokens: 0, costYuan: yuan, outcome: 'ok', ms: 1, createdAt: at })
    .execute()
}

describe('budget', () => {
  test('months follow the school time zone, and the notice goes out once per month', async () => {
    await db.deleteFrom('llmCalls').execute()
    await db.deleteFrom('budgetNotices').execute()
    const mailer = new MemoryMailer()
    // 2026-10-31 16:00 UTC is already 1 November in Shanghai.
    const clock = createTestClock(new Date('2026-11-10T04:00:00Z'))
    const deps = { db, config, clock, mailer, operatorEmail: 'ops@example.com' }

    await spend(6, new Date('2026-10-31T15:59:00Z')) // October
    await spend(6, new Date('2026-10-31T16:00:00Z')) // November
    expect(await monthSpend(db, '2026-11', 'Asia/Shanghai')).toBe(6)
    expect(await monthSpend(db, '2026-10', 'Asia/Shanghai')).toBe(6)
    expect(await checkBudget(deps)).toBe('under')
    expect(mailer.notices).toEqual([])

    await spend(5, new Date('2026-11-05T00:00:00Z'))
    expect(await checkBudget(deps)).toBe('notified')
    expect(await checkBudget(deps)).toBe('already')
    expect(mailer.notices).toHaveLength(1)
    expect(mailer.notices[0]?.to).toBe('ops@example.com')
    expect(mailer.notices[0]?.text).toContain('11.00')
    expect(mailer.notices[0]?.text).toContain('10')

    // December: a fresh month, over the line again.
    clock.set(new Date('2026-12-02T04:00:00Z'))
    await spend(11, new Date('2026-12-01T04:00:00Z'))
    expect(await checkBudget(deps)).toBe('notified')
    expect(mailer.notices).toHaveLength(2)
    const rows = await db.selectFrom('budgetNotices').select('month').orderBy('month').execute()
    expect(rows.map((r) => r.month)).toEqual(['2026-11', '2026-12'])
  })

  test('two checks at once send one mail', async () => {
    await db.deleteFrom('llmCalls').execute()
    await db.deleteFrom('budgetNotices').execute()
    const mailer = new MemoryMailer()
    const clock = createTestClock(new Date('2027-01-10T04:00:00Z'))
    await spend(20, new Date('2027-01-05T00:00:00Z'))
    const deps = { db, config, clock, mailer, operatorEmail: 'ops@example.com' }
    const results = await Promise.all([checkBudget(deps), checkBudget(deps), checkBudget(deps)])
    expect(results.filter((r) => r === 'notified')).toHaveLength(1)
    expect(mailer.notices).toHaveLength(1)
  })

  test('without an operator email only the row is written', async () => {
    await db.deleteFrom('llmCalls').execute()
    await db.deleteFrom('budgetNotices').execute()
    const mailer = new MemoryMailer()
    const clock = createTestClock(new Date('2027-02-10T04:00:00Z'))
    await spend(20, new Date('2027-02-05T00:00:00Z'))
    expect(await checkBudget({ db, config, clock, mailer, operatorEmail: null })).toBe('notified')
    expect(mailer.notices).toEqual([])
    expect(await db.selectFrom('budgetNotices').select('month').execute()).toEqual([{ month: '2027-02' }])
  })
})
