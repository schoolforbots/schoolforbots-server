import type { Kysely } from 'kysely'
import type { Database } from '../shared/schema.js'
import { createModerator, type ExcludedRules, type ModerationData, type Moderator } from './moderator.js'

// The rules the services moderate with: the word list and the phrase rules of the data files, less the ones an
// operator has dropped. Dropped rules are kept in the database, so a change reaches both services within a few seconds
// and outlasts a restart.

/** How often the dropped rules are read when the caller does not say (the config's default switch refresh). */
const DEFAULT_REFRESH_MS = 5_000

export interface LiveModerator extends Moderator {
  /** Reads the dropped rules now. Never rejects: a failed read keeps the rules from the last good one. */
  refresh(): Promise<void>
  /** Ends the periodic refresh. */
  stop(): void
}

/** A program log: counts and error names only, never a rule. */
export interface RulesLog {
  info(obj: object, msg: string): void
  error(obj: object, msg: string): void
}

export interface LiveModeratorDeps {
  db: Kysely<Database>
  data: ModerationData
  log?: RulesLog
}

interface Rules {
  /** The dropped rules, as one string to tell a change by. */
  key: string
  moderator: Moderator
}

/**
 * A moderator that leaves out the rules dropped in the database. Reads them once before it returns, then every
 * `refreshMs`; the moderator is built again only when they changed. The timer is unref'd, so it never keeps the process
 * alive.
 *
 * The first read is not caught: a service that cannot tell which rules were dropped does not start, rather than block
 * again what was ruled a false hit and record it against students.
 */
export async function startLiveModerator(
  deps: LiveModeratorDeps,
  opts: { refreshMs?: number } = {},
): Promise<LiveModerator> {
  const { db, data, log } = deps
  const refreshMs = opts.refreshMs ?? DEFAULT_REFRESH_MS

  async function read(last: Rules | null): Promise<Rules> {
    const rows = await db.selectFrom('moderationExclusions').select(['kind', 'value']).execute()
    const key = rows
      .map((r) => JSON.stringify([r.kind, r.value]))
      .sort()
      .join('\n')
    if (last !== null && key === last.key) return last
    const excluded: ExcludedRules = { words: new Set(), patterns: new Set() }
    for (const r of rows) (r.kind === 'word' ? excluded.words : excluded.patterns).add(r.value)
    // Counts only: a rule is moderation data and stays out of the program log.
    log?.info({ words: excluded.words.size, patterns: excluded.patterns.size }, 'moderation rules rebuilt')
    return { key, moderator: createModerator(data, excluded) }
  }

  let rules = await read(null)
  let running: Promise<void> | null = null

  // A refresh still running when the next one is asked for is the one that answers it.
  function refresh(): Promise<void> {
    running ??= read(rules)
      .then((next) => {
        rules = next
      })
      .catch((err: unknown) => {
        // Only the error's name: its message can carry connection details.
        const name = err instanceof Error ? err.name : 'unknown'
        log?.error({ err: name }, 'moderation rules refresh failed, keeping the last ones')
      })
      .finally(() => {
        running = null
      })
    return running
  }

  const timer = setInterval(() => void refresh(), refreshMs)
  timer.unref()

  return {
    check: (text) => rules.moderator.check(text),
    refresh,
    stop: () => clearInterval(timer),
  }
}
