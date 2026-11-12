import { sql, type Kysely } from 'kysely'
import type { Mailer } from '../registration/mailer.js'
import type { Clock } from '../shared/clock.js'
import type { SchoolConfig } from '../shared/config.js'
import { atLocalTime, localDate } from '../shared/local-time.js'
import type { Database } from '../shared/schema.js'

/** The school-calendar month (`YYYY-MM`, in the school's time zone) that `moment` falls in. */
export function schoolMonth(moment: Date, timeZone: string): string {
  return localDate(moment, timeZone).slice(0, 7)
}

function nextMonth(month: string): string {
  const [year, mon] = month.split('-').map(Number) as [number, number]
  return mon === 12 ? `${year + 1}-01` : `${year}-${String(mon + 1).padStart(2, '0')}`
}

/** What the model calls of a school-calendar month (`YYYY-MM`) cost, in yuan. */
export async function monthSpend(db: Kysely<Database>, month: string, timeZone: string): Promise<number> {
  const from = atLocalTime(`${month}-01`, '00:00', timeZone)
  const to = atLocalTime(`${nextMonth(month)}-01`, '00:00', timeZone)
  const row = await db
    .selectFrom('llmCalls')
    .select(sql<string>`coalesce(sum(cost_yuan), 0)`.as('total'))
    .where('createdAt', '>=', from)
    .where('createdAt', '<', to)
    .executeTakeFirstOrThrow()
  return Number(row.total)
}

/**
 * When this month's spend is over the budget, notes it in `budget_notices` and mails the operator, once per month.
 * Only the process whose insert wins sends the mail, so two services crossing the line together send one. A mail that
 * fails takes its row back out (and the error goes to the caller), so a later check sends it. Without an operator
 * address only the row is written.
 */
export async function checkBudget(deps: {
  db: Kysely<Database>
  config: SchoolConfig
  clock: Clock
  mailer: Mailer
  operatorEmail: string | null
}): Promise<'under' | 'notified' | 'already'> {
  const { db, config, clock, mailer, operatorEmail } = deps
  const now = clock.now()
  const month = schoolMonth(now, config.timezone)
  const budget = config.llm.monthlyBudgetYuan
  const spent = await monthSpend(db, month, config.timezone)
  if (spent <= budget) return 'under'

  const inserted = await db
    .insertInto('budgetNotices')
    .values({ month, notifiedAt: now })
    .onConflict((oc) => oc.column('month').doNothing())
    .returning('month')
    .executeTakeFirst()
  if (inserted === undefined) return 'already'

  if (operatorEmail !== null) {
    try {
      await mailer.sendNotice(
        operatorEmail,
        '机器人网校 · 大模型花费超出预算',
        `${month} 的大模型花费已达 ${spent.toFixed(2)} 元，超过本月预算 ${budget} 元。`,
        { template: 'budget', month, spent: spent.toFixed(2), budget: String(budget) },
      )
    } catch (err) {
      await db.deleteFrom('budgetNotices').where('month', '=', month).execute()
      throw err
    }
  }
  return 'notified'
}
