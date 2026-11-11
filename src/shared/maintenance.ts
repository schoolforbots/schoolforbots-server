import type { Kysely } from 'kysely'
import type { FastifyBaseLogger } from 'fastify'
import { lessonSteps } from '../class/timeline.js'
import type { SchoolConfig, Slot } from './config.js'
import { lock } from './db.js'
import { addDaysToDate, atLocalTime, localDate } from './local-time.js'
import type { Database } from './schema.js'

/** The school is under maintenance: since when, what the operator says, and when it is expected to be back. */
export interface Maintenance {
  message: string
  since: Date
  expectedBackAt: Date | null
}

const SLOTS: readonly Slot[] = ['morning', 'afternoon', 'evening']

/** The maintenance now on, or null. */
export async function readMaintenance(db: Kysely<Database>): Promise<Maintenance | null> {
  const row = await db
    .selectFrom('maintenancePeriods')
    .select(['message', 'startedAt', 'expectedBackAt'])
    .where('endedAt', 'is', null)
    .executeTakeFirst()
  return row === undefined ? null : { message: row.message, since: row.startedAt, expectedBackAt: row.expectedBackAt }
}

/**
 * Switches maintenance on (a value) or off (null) at `at`. A value while it is on only changes the message and the
 * expected time; `since` stays. Off while it is off does nothing.
 */
export async function setMaintenance(
  db: Kysely<Database>,
  value: { message: string; expectedBackAt: Date | null } | null,
  at: Date,
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    // With no row open `for update` locks nothing, so two switch-ons would both insert: take a lock first.
    await lock(trx, 'maintenance')
    const open = await trx.selectFrom('maintenancePeriods').select('id').where('endedAt', 'is', null).forUpdate().executeTakeFirst()
    if (value === null) {
      if (open !== undefined) await trx.updateTable('maintenancePeriods').set({ endedAt: at }).where('id', '=', open.id).execute()
    } else if (open === undefined) {
      await trx.insertInto('maintenancePeriods').values({ ...value, startedAt: at }).execute()
    } else {
      await trx.updateTable('maintenancePeriods').set(value).where('id', '=', open.id).execute()
    }
  })
}

export interface MaintenanceWatch {
  current(): Maintenance | null
  /** Reads the database now. Never rejects: a failed read keeps the last good value. */
  refresh(): Promise<void>
  /** Called when maintenance starts, ends, or its message or expected time changes. */
  onChange(listener: (now: Maintenance | null) => void): void
  stop(): void
}

function same(a: Maintenance | null, b: Maintenance | null): boolean {
  if (a === null || b === null) return a === b
  return (
    a.message === b.message &&
    a.since.getTime() === b.since.getTime() &&
    a.expectedBackAt?.getTime() === b.expectedBackAt?.getTime()
  )
}

/** Like `startSwitches`: reads once before it returns, then every `refreshMs`, on an unref'd timer. */
export async function startMaintenanceWatch(
  deps: { db: Kysely<Database>; config: Pick<SchoolConfig, 'switchRefreshSeconds'>; log?: Pick<FastifyBaseLogger, 'error'> },
  opts: { refreshMs?: number } = {},
): Promise<MaintenanceWatch> {
  const { db, config, log } = deps
  const refreshMs = opts.refreshMs ?? config.switchRefreshSeconds * 1000
  let value: Maintenance | null = null
  const listeners: ((now: Maintenance | null) => void)[] = []
  let running: Promise<void> | null = null

  async function read(): Promise<void> {
    let next: Maintenance | null
    try {
      next = await readMaintenance(db)
    } catch (err) {
      // Only the error's name: its message can carry connection details.
      log?.error({ err: err instanceof Error ? err.name : 'unknown' }, 'maintenance refresh failed, keeping the last value')
      return
    }
    const changed = !same(value, next)
    value = next
    if (!changed) return
    for (const listener of listeners) {
      try {
        listener(next)
      } catch (err) {
        log?.error({ err: err instanceof Error ? err.name : 'unknown' }, 'a maintenance listener failed')
      }
    }
  }

  function refresh(): Promise<void> {
    running ??= read().finally(() => {
      running = null
    })
    return running
  }

  await refresh()
  const timer = setInterval(() => void refresh(), refreshMs)
  timer.unref()

  return {
    current: () => value,
    refresh,
    onChange: (listener) => void listeners.push(listener),
    stop: () => clearInterval(timer),
  }
}

/**
 * The days from `from` to `to` (inclusive, `YYYY-MM-DD` in the school's time zone) on which maintenance was on at some
 * time between a slot's doors opening and its close, for some slot: the days students could not have come to class.
 */
export async function maintenanceDays(
  db: Kysely<Database>,
  from: string,
  to: string,
  config: SchoolConfig,
): Promise<Set<string>> {
  const days = new Set<string>()
  if (from > to) return days
  const periods = await db.selectFrom('maintenancePeriods').select(['startedAt', 'endedAt']).execute()
  if (periods.length === 0) return days
  for (let day = from; day <= to; day = addDaysToDate(day, 1)) {
    const open = SLOTS.some((slot) => {
      const startsAt = atLocalTime(day, config.slots[slot].start, config.timezone)
      const steps = lessonSteps(startsAt, 'lesson', config.lesson, 1, config.teacherAi.answerLeadSeconds)
      const doorsAt = steps.find((s) => s.step === 'doors')?.at
      const closeAt = steps.find((s) => s.step === 'close')?.at
      if (doorsAt === undefined || closeAt === undefined) return false
      return periods.some(
        (p) => p.startedAt.getTime() < closeAt.getTime() && (p.endedAt === null || p.endedAt.getTime() > doorsAt.getTime()),
      )
    })
    if (open) days.add(day)
  }
  return days
}

/**
 * Every maintenance day up to `today`, from the earliest period on record. A look-back stretched by breaks can reach
 * back any distance, so the set is built from every period (the table is tiny), not from a fixed number of days.
 */
export async function allMaintenanceDays(db: Kysely<Database>, today: string, config: SchoolConfig): Promise<Set<string>> {
  const first = await db.selectFrom('maintenancePeriods').select('startedAt').orderBy('startedAt').limit(1).executeTakeFirst()
  if (first === undefined) return new Set()
  return maintenanceDays(db, localDate(first.startedAt, config.timezone), today, config)
}
