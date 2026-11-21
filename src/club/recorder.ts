import type { Kysely } from 'kysely'
import { recordOpsEvent } from '../ops/events.js'
import type { Clock } from '../shared/clock.js'
import type { Database } from '../shared/schema.js'
import type { DoudizhuGameOptions } from './doudizhu-game.js'
import type { DoudizhuGameEntry } from './doudizhu-record.js'
import { doudizhuStatsSummary } from './doudizhu-stats.js'

// Stores the finished games of doudizhu in the background (`doudizhu_games` and `doudizhu_game_players`), so the room
// logic never waits for the database: a game hands its entry to `enqueue`, which returns at once and never throws.
//
// - Each game is written in one transaction, both tables. Games are written independently of each other: one that
//   keeps failing does not hold back the others.
// - A write that fails is tried again 1 s, 5 s and 30 s later (`retryDelaysMs`). After the last failure the game is
//   lost to the database: an `internal_error` is noted for the alert mails (`recordOpsEvent`, service `club`), and
//   the error log gets the whole record, so an operator can store it by hand. What is logged is the entry without
//   the seats' addresses (`ip`), which are stored only and appear nowhere else, not even in the logs; and of the
//   error, its name and code only (a message can carry connection details).
// - A write that is tried again after it may have gone through (the connection dropped after the commit) finds the
//   game stored already: when the stored game is the same one (room and start), it is done; another game under the
//   same number is an error, tried again and in the end logged like any other.
// - `drain(timeoutMs)` (the service stopping, after the games being played have been finished) waits for every game
//   handed over to be written, its retries too, but no longer than `timeoutMs`. What is still not written then is
//   given up at once, as after the last failure (noted and logged in full), and its retries stop: the process is
//   about to exit, and a record that only waits for a retry would be lost without a word. Before it resolves, it
//   waits for the notes of the games given up (these and any before) to be written, at most `ALERT_WAIT_MS` more of
//   real time: the service closes the database right after, and a note not written by then would never be.
//
// A game's number comes from the club service (`DoudizhuGameOptions.firstGameId`): it goes on from the largest stored
// (`nextGameId`), so a number is never taken twice across restarts. A game lost when the process crashes leaves a gap.

export interface RecorderLog {
  error(obj: unknown, msg?: string): void
}

export interface RecorderDeps {
  db: Kysely<Database>
  /** For the `at` of the ops event noted when a game is lost. */
  clock: Clock
  log: RecorderLog
  /** Waits `ms`; a real timer (that never keeps the process alive) when absent. */
  sleep?: (ms: number) => Promise<void>
  /** The waits before each retry; 1 s, 5 s, 30 s when absent. */
  retryDelaysMs?: readonly number[]
}

export interface Recorder {
  /** Hands over a finished game to be stored. Returns at once; never throws. */
  enqueue(entry: DoudizhuGameEntry): void
  /** Resolves once every game handed over is written or given up, or after `timeoutMs` (see above); never rejects. */
  drain(timeoutMs: number): Promise<void>
  /** How many games are handed over and neither written nor given up yet. */
  pending(): number
}

export const RETRY_DELAYS_MS: readonly number[] = [1000, 5000, 30_000]

/** How long `drain` waits, at most, for the `internal_error` notes of the games given up (see the top of this file). */
export const ALERT_WAIT_MS = 1000

/** The number the club service's next game has: one more than the largest stored, 1 when none is. */
export async function nextGameId(db: Kysely<Database>): Promise<number> {
  const row = await db
    .selectFrom('doudizhuGames')
    .select((eb) => eb.fn.max('gameId').as('last'))
    .executeTakeFirst()
  return (row?.last ?? 0) + 1
}

const realSleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms).unref()
  })

/** What is logged of an error: its name, and the database's code when it has one. Never its message. */
function errorSummary(err: unknown): { name: string; code?: string } {
  const name = err instanceof Error ? err.name : 'unknown'
  const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined
  return typeof code === 'string' ? { name, code } : { name }
}

/** The entry as the error log gets it: everything but the seats' addresses. */
export function loggedEntry(entry: DoudizhuGameEntry): object {
  return {
    gameId: entry.gameId,
    roomId: entry.roomId,
    startedAt: entry.startedAt.toISOString(),
    endedAt: entry.endedAt.toISOString(),
    ranked: entry.ranked,
    rules: entry.stored.rules,
    record: entry.record,
    players: entry.players.map(({ ip: _ip, ...row }) => ({ ...row, endedAt: row.endedAt.toISOString() })),
  }
}

/** Writes one game, both tables, in one transaction (see the top of this file for a game stored already). */
export async function writeGame(db: Kysely<Database>, entry: DoudizhuGameEntry): Promise<void> {
  await db.transaction().execute(async (trx) => {
    const inserted = await trx
      .insertInto('doudizhuGames')
      .values({
        gameId: entry.gameId,
        roomId: entry.roomId,
        startedAt: entry.startedAt,
        endedAt: entry.endedAt,
        ranked: entry.ranked,
        record: JSON.stringify(entry.stored),
      })
      .onConflict((oc) => oc.column('gameId').doNothing())
      .returning('gameId')
      .executeTakeFirst()
    if (inserted === undefined) {
      const stored = await trx
        .selectFrom('doudizhuGames')
        .select(['roomId', 'startedAt'])
        .where('gameId', '=', entry.gameId)
        .executeTakeFirstOrThrow()
      if (stored.roomId === entry.roomId && stored.startedAt.getTime() === entry.startedAt.getTime()) return
      throw new Error(`game ${entry.gameId} is stored already, as another game`)
    }
    if (entry.players.length === 0) return
    await trx
      .insertInto('doudizhuGamePlayers')
      .values(entry.players.map((p) => ({ ...p })))
      .execute()
  })
}

export function createRecorder(deps: RecorderDeps): Recorder {
  const { db, clock, log } = deps
  const sleep = deps.sleep ?? realSleep
  const delays = deps.retryDelaysMs ?? RETRY_DELAYS_MS
  // The games handed over and neither written nor given up, each with the promise of its writing.
  const writing = new Map<DoudizhuGameEntry, Promise<void>>()
  // Weak: an entry given up is forgotten once nothing holds it any more (its retry loop has ended).
  const givenUp = new WeakSet<DoudizhuGameEntry>()
  // The `internal_error` notes of the games given up that are still being written.
  const alerts = new Set<Promise<void>>()

  function giveUp(entry: DoudizhuGameEntry, err: unknown, why: 'failed' | 'drain_timeout'): void {
    if (givenUp.has(entry)) return
    givenUp.add(entry)
    writing.delete(entry)
    try {
      log.error(
        {
          ...(err === null ? {} : { err: errorSummary(err) }),
          why,
          // Past the drain's timeout a write may still be in flight, and may still commit.
          ...(why === 'drain_timeout' ? { mayStillLand: true } : {}),
          game: loggedEntry(entry),
        },
        'doudizhu game not stored',
      )
    } catch {
      // A logger that throws must not take anything else down.
    }
    const alert = recordOpsEvent(db, { service: 'club', kind: 'internal_error', at: clock.now() }, log)
    alerts.add(alert)
    void alert.finally(() => alerts.delete(alert))
  }

  async function write(entry: DoudizhuGameEntry): Promise<void> {
    let lastError: unknown
    for (let attempt = 0; attempt <= delays.length; attempt++) {
      if (attempt > 0) await sleep(delays[attempt - 1]!)
      if (givenUp.has(entry)) return
      try {
        await writeGame(db, entry)
        writing.delete(entry)
        return
      } catch (err) {
        lastError = err
      }
    }
    giveUp(entry, lastError, 'failed')
  }

  return {
    enqueue(entry) {
      try {
        // Started after this call returns, so the room logic is never held up, not even by the first query's setup.
        const done = Promise.resolve()
          .then(() => write(entry))
          .catch((err: unknown) => giveUp(entry, err, 'failed'))
        writing.set(entry, done)
      } catch {
        // Nothing here can throw; and the caller must never see it if it did.
      }
    },
    async drain(timeoutMs) {
      if (writing.size > 0) {
        let timedOut = false
        const timeout = sleep(timeoutMs).then(() => {
          timedOut = true
        })
        // Games handed over while it waits are waited for too.
        while (writing.size > 0 && !timedOut) await Promise.race([Promise.all([...writing.values()]), timeout])
        // Whatever is still not written is given up now; a write in flight that goes through after this is stored all
        // the same.
        if (timedOut) for (const entry of [...writing.keys()]) giveUp(entry, null, 'drain_timeout')
      }
      // The notes of the games given up, so that they are written before the database is closed. On a real timer:
      // this wait is the last thing before the process exits, whatever clock the retries go by.
      if (alerts.size > 0) await Promise.race([Promise.all([...alerts]), realSleep(ALERT_WAIT_MS)])
    },
    pending: () => writing.size,
  }
}

/**
 * What the club service's doudizhu takes to store its games and read its stats: the first game's number, the record
 * of each finished game handed to `recorder`, `drain` the recorder's, and `welcome.stats` from what is stored. A
 * record that could not even be put together (`onGameOverError`) is logged with the game's number and noted as an
 * `internal_error`; the game goes on.
 */
export function storedDoudizhuOptions(p: {
  db: Kysely<Database>
  clock: Clock
  timeZone: string
  recorder: Recorder
  firstGameId: number
  log: RecorderLog
}): Pick<DoudizhuGameOptions, 'firstGameId' | 'onGameOver' | 'onGameOverError' | 'drain' | 'stats'> {
  const { db, clock, recorder, log } = p
  return {
    firstGameId: p.firstGameId,
    onGameOver: (entry) => recorder.enqueue(entry),
    onGameOverError(err, gameId) {
      log.error({ err: errorSummary(err), gameId }, 'doudizhu game record failed')
      recordOpsEvent(db, { service: 'club', kind: 'internal_error', at: clock.now() }, log)
    },
    drain: (timeoutMs) => recorder.drain(timeoutMs),
    stats: (studentId) => doudizhuStatsSummary(db, studentId, clock.now(), p.timeZone),
  }
}
