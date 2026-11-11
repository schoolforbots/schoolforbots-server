import type { Kysely } from 'kysely'
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { checkAlerts, diskUsedPercent, type AlertKind } from '../../src/ops/alerts.js'
import { MemoryMailer } from '../../src/registration/mailer.js'
import type { SchoolConfig } from '../../src/shared/config.js'
import type { Maintenance } from '../../src/shared/maintenance.js'
import type { Database, OpsEventKind } from '../../src/shared/schema.js'
import { exampleConfig } from '../helpers/app.js'
import { createTestClock } from '../helpers/clock.js'
import { createTestDb } from '../helpers/db.js'

let db: Kysely<Database>
let destroy: () => Promise<void>
beforeAll(async () => {
  ;({ db, destroy } = await createTestDb())
})
afterAll(() => destroy())
beforeEach(async () => {
  for (const table of ['opsEvents', 'serviceStarts', 'alertNotices', 'backupRuns', 'llmCalls'] as const) {
    await db.deleteFrom(table).execute()
  }
})

const NOW = new Date('2026-11-10T04:00:00Z')
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000)
const hoursAgo = (h: number) => minutesAgo(h * 60)

function setup(opts: { alerts?: Partial<SchoolConfig['alerts']>; operatorEmail?: string | null; maintenance?: Maintenance | null; disk?: number } = {}) {
  const base = exampleConfig()
  const config: SchoolConfig = { ...base, alerts: { ...base.alerts, ...opts.alerts } }
  const clock = createTestClock(NOW)
  const mailer = new MemoryMailer()
  const diskPercent = vi.fn(async () => opts.disk ?? 10)
  const deps = () => ({
    db,
    config,
    clock,
    mailer,
    operatorEmail: opts.operatorEmail === undefined ? 'ops@example.com' : opts.operatorEmail,
    maintenance: () => opts.maintenance ?? null,
    diskPercent,
  })
  return { config, clock, mailer, deps, check: () => checkAlerts(deps()) }
}

async function events(kind: OpsEventKind, times: Date[], service: 'registration' | 'class' = 'registration') {
  for (const at of times) await db.insertInto('opsEvents').values({ service, kind, at }).execute()
}
async function llmCalls(outcome: 'ok' | 'failed', times: Date[], httpStatus: number | null = null) {
  for (const createdAt of times) {
    await db
      .insertInto('llmCalls')
      .values({ purpose: 'lesson', provider: 'p', model: 'm', inputTokens: 0, outputTokens: 0, costYuan: 0, outcome, httpStatus, ms: 1, createdAt })
      .execute()
  }
}
async function starts(service: 'registration' | 'class', times: Date[]) {
  for (const startedAt of times) await db.insertInto('serviceStarts').values({ service, startedAt }).execute()
}
async function backup(ok: boolean, finishedAt: Date) {
  await db.insertInto('backupRuns').values({ finishedAt, ok }).execute()
}

/** One scenario per kind: `fire` puts the data just at the threshold, `almost` one short of it. */
const scenarios: Record<AlertKind, { alerts?: Partial<SchoolConfig['alerts']>; fire: () => Promise<void>; almost: () => Promise<void>; subject: RegExp; disk?: [number, number] }> = {
  internal_errors: {
    fire: async () => {
      await events('internal_error', Array.from({ length: 10 }, () => minutesAgo(1)), 'registration')
      await events('internal_error', Array.from({ length: 10 }, () => minutesAgo(2)), 'class')
    },
    almost: async () => {
      await events('internal_error', Array.from({ length: 19 }, () => minutesAgo(1)))
      await events('internal_error', [minutesAgo(6)]) // outside the 5 minutes
    },
    subject: /^【机器人网校】.*出错/,
  },
  llm_down: {
    fire: () => llmCalls('failed', [minutesAgo(1), minutesAgo(5), minutesAgo(9)]),
    almost: async () => {
      await llmCalls('failed', [minutesAgo(1), minutesAgo(5), minutesAgo(9)])
      await llmCalls('ok', [minutesAgo(3)])
      await llmCalls('failed', [minutesAgo(30)])
    },
    subject: /^【机器人网校】大模型连不上，已经 10 分钟$/,
  },
  llm_400: {
    fire: () => llmCalls('failed', Array.from({ length: 5 }, (_, i) => minutesAgo(10 + i * 10)), 400),
    almost: async () => {
      await llmCalls('failed', Array.from({ length: 4 }, (_, i) => minutesAgo(10 + i * 10)), 400)
      await llmCalls('failed', Array.from({ length: 5 }, () => minutesAgo(15)), 500)
      await llmCalls('failed', [minutesAgo(61)], 400)
    },
    subject: /^【机器人网校】.*400/,
  },
  mail_failed: {
    fire: () => events('mail_failed', [minutesAgo(1), minutesAgo(5), minutesAgo(10)]),
    almost: () => events('mail_failed', [minutesAgo(1), minutesAgo(5), minutesAgo(11)]),
    subject: /^【机器人网校】.*邮件/,
  },
  job_failed: {
    fire: () => events('job_failed', [hoursAgo(2)]),
    almost: () => events('job_failed', [hoursAgo(25)]),
    subject: /^【机器人网校】.*任务/,
  },
  restarts: {
    fire: () => starts('class', [minutesAgo(1), minutesAgo(5), minutesAgo(10)]),
    almost: async () => {
      await starts('class', [minutesAgo(1), minutesAgo(5), minutesAgo(11)])
      await starts('registration', [minutesAgo(2)])
      await starts('registration', [minutesAgo(3)])
    },
    subject: /^【机器人网校】上课服务.*重启/,
  },
  backup: {
    alerts: { backupExpected: true },
    fire: async () => {
      await backup(true, hoursAgo(27))
    },
    almost: async () => {
      await backup(true, hoursAgo(25))
    },
    subject: /^【机器人网校】备份/,
  },
  disk: {
    fire: async () => undefined,
    almost: async () => undefined,
    subject: /^【机器人网校】磁盘/,
    disk: [80, 79],
  },
}

describe.each(Object.entries(scenarios) as [AlertKind, (typeof scenarios)[AlertKind]][])('%s', (kind, s) => {
  const make = (disk?: number) => setup({ alerts: s.alerts, disk })

  test('mails exactly at the threshold, and not one short of it', async () => {
    await s.almost()
    const quiet = make(s.disk?.[1])
    expect(await quiet.check()).toEqual([])
    expect(quiet.mailer.notices).toEqual([])

    await db.deleteFrom('opsEvents').execute()
    await db.deleteFrom('serviceStarts').execute()
    await db.deleteFrom('llmCalls').execute()
    await db.deleteFrom('backupRuns').execute()
    await s.fire()
    const loud = make(s.disk?.[0])
    expect(await loud.check()).toEqual([kind])
    expect(loud.mailer.notices).toHaveLength(1)
    const notice = loud.mailer.notices[0]!
    expect(notice.to).toBe('ops@example.com')
    expect(notice.subject).toMatch(s.subject)
    expect(notice.subject.startsWith('【机器人网校】')).toBe(true)
  })

  test('is not mailed again within the hour, and a new check (a restart) does not resend it', async () => {
    await s.fire()
    const first = make(s.disk?.[0])
    expect(await first.check()).toEqual([kind])
    first.clock.advance(59 * 60_000)
    expect(await first.check()).toEqual([])
    expect((await db.selectFrom('alertNotices').selectAll().where('kind', '=', kind).execute()).length).toBe(1)
    const restarted = make(s.disk?.[0])
    expect(await restarted.check()).toEqual([])
    expect(first.mailer.notices).toHaveLength(1)
    expect(restarted.mailer.notices).toHaveLength(0)

  })

  test('a failed mail gives the hour back, returns the error, and is tried again next time', async () => {
    await s.fire()
    const t = make(s.disk?.[0])
    vi.spyOn(t.mailer, 'sendNotice').mockRejectedValueOnce(new Error('smtp down'))
    await expect(t.check()).rejects.toThrow('smtp down')
    expect(await db.selectFrom('alertNotices').selectAll().where('kind', '=', kind).execute()).toEqual([])
    expect(await t.check()).toEqual([kind])
    expect(t.mailer.notices).toHaveLength(1)
  })

  test('without an operator address nothing is mailed and no notice row is taken', async () => {
    await s.fire()
    const t = setup({ alerts: s.alerts, disk: s.disk?.[0], operatorEmail: null })
    expect(await t.check()).toEqual([])
    expect(t.mailer.notices).toEqual([])
    expect(await db.selectFrom('alertNotices').selectAll().execute()).toEqual([])
  })
})

describe('repeating after an hour', () => {
  test('a kind still over its threshold an hour later is mailed again', async () => {
    const t = setup({ disk: 95 })
    expect(await t.check()).toEqual(['disk'])
    t.clock.advance(59 * 60_000)
    expect(await t.check()).toEqual([])
    t.clock.advance(60_000)
    expect(await t.check()).toEqual(['disk'])
    expect(t.mailer.notices).toHaveLength(2)
  })

  test('repeatAfterMinutes comes from the config', async () => {
    const t = setup({ disk: 95, alerts: { repeatAfterMinutes: 5 } })
    expect(await t.check()).toEqual(['disk'])
    t.clock.advance(5 * 60_000)
    expect(await t.check()).toEqual(['disk'])
  })

  test('two checks at once send one mail', async () => {
    const t = setup({ disk: 95 })
    const results = await Promise.all([t.check(), t.check(), t.check()])
    expect(results.flat()).toEqual(['disk'])
    expect(t.mailer.notices).toHaveLength(1)
  })
})

describe('job_failed', () => {
  test('counts only what happened since the last mail of the kind, and says how many', async () => {
    await events('job_failed', [hoursAgo(5), hoursAgo(4)])
    const t = setup()
    expect(await t.check()).toEqual(['job_failed'])
    expect(t.mailer.notices[0]?.subject).toContain('2')
    t.clock.advance(2 * 60 * 60_000)
    expect(await t.check()).toEqual([])
    await events('job_failed', [new Date(NOW.getTime() + 90 * 60_000)])
    t.clock.advance(60 * 60_000)
    expect(await t.check()).toEqual(['job_failed'])
    expect(t.mailer.notices[1]?.subject).toContain('1')
  })
})

describe('maintenance', () => {
  const maintenance: Maintenance = { message: '升级', since: minutesAgo(30), expectedBackAt: null }

  test('only backup and disk are checked: internal errors are not mailed, disk is', async () => {
    await events('internal_error', Array.from({ length: 30 }, () => minutesAgo(1)))
    await events('job_failed', [minutesAgo(1)])
    await starts('class', [minutesAgo(1), minutesAgo(2), minutesAgo(3)])
    await llmCalls('failed', [minutesAgo(1), minutesAgo(2), minutesAgo(3)])
    const t = setup({ maintenance, disk: 90, alerts: { backupExpected: true } })
    expect((await t.check()).sort()).toEqual(['backup', 'disk'])
    expect(t.mailer.notices.map((n) => n.subject).some((s) => s.includes('出错'))).toBe(false)
  })
})

describe('backup', () => {
  test('with backupExpected false, no backup at all is nothing', async () => {
    const t = setup({ alerts: { backupExpected: false } })
    expect(await t.check()).toEqual([])
  })

  test('with backupExpected true and no run at all, it is mailed', async () => {
    const t = setup({ alerts: { backupExpected: true } })
    expect(await t.check()).toEqual(['backup'])
  })

  test('a failed latest run is mailed even though an ok one is recent', async () => {
    await backup(true, hoursAgo(5))
    await backup(false, hoursAgo(1))
    const t = setup({ alerts: { backupExpected: true } })
    expect(await t.check()).toEqual(['backup'])
    expect(t.mailer.notices[0]?.subject).toContain('失败')
  })

  test('a recent ok run after a failed one is fine', async () => {
    await backup(false, hoursAgo(5))
    await backup(true, hoursAgo(1))
    const t = setup({ alerts: { backupExpected: true } })
    expect(await t.check()).toEqual([])
  })
})

describe('what the mails say', () => {
  test('how many times and since when in school time, and no address or IP', async () => {
    await events('internal_error', Array.from({ length: 20 }, () => new Date('2026-11-10T03:58:00Z')))
    const t = setup()
    await t.check()
    const { subject, text } = t.mailer.notices[0]!
    expect(subject + text).toContain('20')
    expect(text).toContain('11月10日 11:58')
    expect(subject + text).not.toMatch(/@|\d+\.\d+\.\d+\.\d+/)
  })

  test('one kind failing to send does not stop the others, but the error is still returned', async () => {
    await events('job_failed', [hoursAgo(1)])
    const t = setup({ disk: 95 })
    vi.spyOn(t.mailer, 'sendNotice').mockRejectedValueOnce(new Error('smtp down'))
    await expect(t.check()).rejects.toThrow('smtp down')
    expect(t.mailer.notices).toHaveLength(1)
    expect(await db.selectFrom('alertNotices').select('kind').execute()).toEqual([{ kind: 'disk' }])
  })
})

test('diskUsedPercent reads the file system and answers between 0 and 100', async () => {
  const percent = await diskUsedPercent('/')
  expect(percent).toBeGreaterThanOrEqual(0)
  expect(percent).toBeLessThanOrEqual(100)
})
