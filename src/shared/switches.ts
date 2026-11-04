import type { Kysely } from 'kysely'
import type { FastifyBaseLogger } from 'fastify'
import type { Clock } from './clock.js'
import type { SchoolConfig } from './config.js'
import type { Database } from './schema.js'

export type SwitchName = 'teacherLlm' | 'secondLayerTeacher' | 'secondLayerChat'

export const SWITCH_NAMES: readonly SwitchName[] = ['teacherLlm', 'secondLayerTeacher', 'secondLayerChat']

export interface Switches {
  isOn(name: SwitchName): boolean
  /** Reads the database now. Never rejects: a failed read keeps the values from the last good one. */
  refresh(): Promise<void>
  /** Ends the periodic refresh. */
  stop(): void
}

export interface SwitchesDeps {
  db: Kysely<Database>
  config: Pick<SchoolConfig, 'switchDefaults' | 'switchRefreshSeconds'>
  clock: Clock
  log?: Pick<FastifyBaseLogger, 'error'>
}

export function isSwitchName(name: string): name is SwitchName {
  return (SWITCH_NAMES as readonly string[]).includes(name)
}

/**
 * The runtime switches both services read and an operator changes through the database. A switch with no row has
 * the value from the config. Reads once before it returns, then every `refreshMs`; the timer is unref'd, so it never
 * keeps the process alive.
 */
export async function startSwitches(deps: SwitchesDeps, opts: { refreshMs?: number } = {}): Promise<Switches> {
  const { db, config, log } = deps
  const refreshMs = opts.refreshMs ?? config.switchRefreshSeconds * 1000
  let values: Record<SwitchName, boolean> = { ...config.switchDefaults }
  let running: Promise<void> | null = null

  async function read(): Promise<void> {
    try {
      const rows = await db.selectFrom('switches').select(['name', 'on']).execute()
      const next = { ...config.switchDefaults }
      for (const row of rows) if (isSwitchName(row.name)) next[row.name] = row.on
      values = next
    } catch (err) {
      // Only the error's name: its message can carry connection details.
      log?.error({ err: err instanceof Error ? err.name : 'unknown' }, 'switch refresh failed, keeping the last values')
    }
  }

  // A refresh still running when the next one is asked for is the one that answers it.
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
    isOn: (name) => values[name],
    refresh,
    stop: () => clearInterval(timer),
  }
}

/** Sets a switch and records the change, together or not at all. */
export async function setSwitch(db: Kysely<Database>, name: SwitchName, on: boolean, at: Date): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await trx
      .insertInto('switches')
      .values({ name, on, updatedAt: at })
      .onConflict((oc) => oc.column('name').doUpdateSet({ on, updatedAt: at }))
      .execute()
    await trx.insertInto('switchChanges').values({ name, on, createdAt: at }).execute()
  })
}

/** The changes made from `from` (included) up to `to` (excluded), oldest first. */
export async function switchChanges(
  db: Kysely<Database>,
  from: Date,
  to: Date,
): Promise<{ name: SwitchName; on: boolean; at: Date }[]> {
  const rows = await db
    .selectFrom('switchChanges')
    .select(['name', 'on', 'createdAt'])
    .where('createdAt', '>=', from)
    .where('createdAt', '<', to)
    .orderBy('createdAt')
    .orderBy('id')
    .execute()
  return rows.filter((r) => isSwitchName(r.name)).map((r) => ({ name: r.name as SwitchName, on: r.on, at: r.createdAt }))
}
