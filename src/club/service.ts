import type { FastifyInstance, FastifyServerOptions } from 'fastify'
import type { Kysely } from 'kysely'
import { startTicker, type Ticker } from '../class/ticker.js'
import type { Clock } from '../shared/clock.js'
import type { SchoolConfig } from '../shared/config.js'
import { databaseAlive } from '../shared/healthz.js'
import type { MaintenanceWatch } from '../shared/maintenance.js'
import type { Database } from '../shared/schema.js'
import { buildClubApp, type ClubDeps } from './app.js'
import { Club, type ClubOptions, type DoorClosing, SERVICE_STOPPING, studentRefusal } from './club.js'
import { clubDoor } from './connection.js'
import type { GameModule } from './game.js'
import { GONE_STANDING, standingsAmong } from './members.js'
import type { WordLists } from './reactions.js'

// The club service assembled: the club (club.ts), its WebSocket app (app.ts), and what runs on time.
//
// - The tick, every second: first the doors (below), then the club's own tick (the games, the graces of the students
//   who lost the connection, the idle prompts and their end, the invitations' expiry), and every
//   `switchRefreshSeconds` the rounds of the students online.
// - The doors. Whether anyone may come in is decided at the door (`clubDoor`: the clubs switched off, the timetable,
//   maintenance), from what is true at that moment: the clock, `club.enabled` of the config, and the maintenance
//   switch as last read. So the door is closed from the very moment the club closes, before anything here has noticed;
//   no hello that comes after it gets in. The tick (and a change of the maintenance switch, at once) then finds the
//   club closed where it was open and closes it for those inside: every game played out, every room closed, everyone
//   sent `closing` (`club_closed` with `reopensAt`, none when the clubs are switched off; or `maintenance`).
// - The rounds: one query for the standing and the membership of everyone online; whoever may no longer be in
//   (suspended, expelled, no longer a member) is sent `closing` saying so and disconnected, their seat then handled as
//   for any disconnect. The standing is the one read by the query: a student whose standing changes again in the
//   moment between the query and the disconnect is judged by the one read.
// - Stopping: everyone is sent `service_stopping` and disconnected, and nobody comes in after; the rooms are not
//   closed (no `closed` event): they go with the process.
//
// `club.enabled` is read from the config only: the runtime switches (src/shared/switches.ts) have none for the clubs.

export interface ClubServiceDeps {
  db: Kysely<Database>
  config: SchoolConfig
  clock: Clock
  game: GameModule
  wordLists: WordLists
  /** Picks the room numbers (see `RoomsOptions.randomInt`); `crypto.randomInt` when unset. */
  randomInt?: ClubOptions['randomInt']
  /**
   * The maintenance switch, as the database says it is (see `startMaintenanceWatch`). While it is on nobody comes in;
   * when it comes on, the club closes for those inside (`maintenance`). Unset: never on.
   */
  maintenance?: MaintenanceWatch
  /** Fastify logger options; unset means no logging. */
  logger?: FastifyServerOptions['logger']
  /** See `ClubDeps.helloTimeoutMs`. */
  helloTimeoutMs?: number
  /** See `ClubDeps.pingIntervalMs`. */
  pingIntervalMs?: number
  /** See `ClubDeps.rateWindowMs`. */
  rateWindowMs?: number
  /**
   * Called for each unexpected error: in a connection (see `ClubDeps.onInternalError`), in a room's tick, and a round
   * of the students online that failed. To count it for the alert mails.
   */
  onInternalError?: () => void
}

export interface ClubService {
  app: FastifyInstance
  club: Club
  /** What runs every `intervalMs`: the doors, the club's tick, and the rounds when they are due (not waited for). */
  tick(): Promise<void>
  /** How often the service ticks, in real milliseconds. */
  intervalMs: number
  /** A round of the students online now (see the top of this file); the one going on when there is one already. */
  rounds(): Promise<void>
  /** Resolves when the round going on, if any, has finished. */
  roundsDone(): Promise<void>
  /** The service is stopping: everyone is sent `service_stopping` and disconnected; from then on nobody comes in. */
  disconnectAll(): void
  /**
   * Hands the service the ticker that runs `tick()`, so `/healthz` can tell a stuck clock: until it is handed over,
   * or when its last run ended more than `max(30 s, 3 intervals)` ago, the service is unhealthy.
   */
  watchTicker(ticker: Pick<Ticker, 'lastFinishedAt'>, intervalMs: number): void
}

/** The club's tick: a second, which is the finest any of its timers is (graces, idle prompts, invitations). */
export const CLUB_TICK_MS = 1000

/** The least time without a finished tick that makes `/healthz` fail, as in the class service. */
export const STUCK_TICK_FLOOR_MS = 30_000

const errorName = (err: unknown) => (err instanceof Error ? err.name : 'unknown')

export function createClubService(deps: ClubServiceDeps): ClubService {
  const { db, config, clock, game } = deps
  // Set by `disconnectAll`, for good.
  let stopping = false
  let watched: { ticker: Pick<Ticker, 'lastFinishedAt'>; intervalMs: number } | null = null

  const noteInternalError = () => {
    try {
      deps.onInternalError?.()
    } catch {
      // Counting an error must not change what happens.
    }
  }

  const club = new Club({
    config,
    game,
    wordLists: deps.wordLists,
    ...(deps.randomInt === undefined ? {} : { randomInt: deps.randomInt }),
    onError(roomId, err) {
      app.log.error({ err, roomId }, 'club room failed')
      noteInternalError()
    },
  })

  const healthy = async () => {
    if (watched === null) return false
    const finishedAt = watched.ticker.lastFinishedAt()
    if (finishedAt === null) return false
    if (Date.now() - finishedAt > Math.max(STUCK_TICK_FLOOR_MS, 3 * watched.intervalMs)) return false
    return databaseAlive(db)
  }

  const appDeps: ClubDeps = {
    db,
    config,
    clock,
    club,
    stopping: () => stopping,
    maintenance: () => deps.maintenance?.current() ?? null,
    healthCheck: healthy,
    onInternalError: noteInternalError,
    ...(deps.helloTimeoutMs === undefined ? {} : { helloTimeoutMs: deps.helloTimeoutMs }),
    ...(deps.pingIntervalMs === undefined ? {} : { pingIntervalMs: deps.pingIntervalMs }),
    ...(deps.rateWindowMs === undefined ? {} : { rateWindowMs: deps.rateWindowMs }),
    ...(deps.logger === undefined ? {} : { logger: deps.logger }),
  }
  const app = buildClubApp(appDeps)

  // ---- The doors ----

  // Whether the last look found the club closed. False at first: a service started while the club is closed closes
  // it at its first tick, which finds nobody inside.
  let wasClosed = false

  /** Closes the club for those inside when it has closed since the last look (see the top of this file). */
  function checkDoors(now: Date): void {
    if (stopping) return
    const door = clubDoor(appDeps, now)
    if (door === null) {
      if (wasClosed) app.log.info({}, 'club open')
      wasClosed = false
      return
    }
    if (door.reason !== 'club_closed' && door.reason !== 'maintenance') return
    // Closed already, nobody can have come in since; anyone (or any room) found inside all the same is closed too.
    if (!wasClosed || club.online().length > 0 || club.rooms.size > 0) {
      app.log.info({ reason: door.reason, online: club.online().length, rooms: club.rooms.size }, 'club closed')
      club.closeDoors(door as DoorClosing, now)
    }
    wasClosed = true
  }

  // The watch has its new value by the time it calls this, so the door already says so.
  deps.maintenance?.onChange(() => {
    try {
      checkDoors(clock.now())
    } catch (err) {
      app.log.error({ err }, 'club close for maintenance failed')
      noteInternalError()
    }
  })

  // ---- The rounds ----

  const roundMs = config.switchRefreshSeconds * 1000
  let lastRoundAt = clock.now().getTime()
  let round: Promise<void> | null = null

  async function oneRound(): Promise<void> {
    const online = club.online()
    if (online.length === 0) return
    const standings = await standingsAmong(db, online, game.club)
    if (stopping) return
    const now = clock.now()
    for (const studentId of online) {
      const refusal = studentRefusal(standings.get(studentId) ?? GONE_STANDING, game, config, now)
      if (refusal === null) continue
      if (club.disconnect(studentId, refusal)) app.log.info({ studentId, reason: refusal.reason }, 'student sent out of club')
    }
  }

  function rounds(): Promise<void> {
    round ??= oneRound()
      .catch((err: unknown) => {
        // Only the error's name: its message can carry connection details.
        app.log.error({ err: errorName(err) }, 'club rounds failed')
        noteInternalError()
      })
      .finally(() => {
        round = null
      })
    return round
  }

  return {
    app,
    club,
    intervalMs: CLUB_TICK_MS,
    async tick() {
      const now = clock.now()
      checkDoors(now)
      club.tick(now)
      if (now.getTime() - lastRoundAt >= roundMs) {
        lastRoundAt = now.getTime()
        void rounds()
      }
    },
    rounds,
    roundsDone: () => round ?? Promise.resolve(),
    disconnectAll() {
      stopping = true
      club.disconnectAll(SERVICE_STOPPING)
    },
    watchTicker(ticker, intervalMs) {
      watched = { ticker, intervalMs }
    },
  }
}

/**
 * Starts the service: one tick (a failure fails the start, and nothing listens), then listening, then a tick on every
 * interval, the ticker handed to `/healthz`. A later tick that fails is logged and reported to `onTickFailure`, and the
 * next one still happens.
 */
export async function startClubService(
  service: Pick<ClubService, 'app' | 'tick' | 'intervalMs'> & Partial<Pick<ClubService, 'watchTicker'>>,
  p: { port: number; host?: string; onTickFailure?: () => void },
): Promise<Ticker> {
  const { app, tick, intervalMs } = service
  await tick()
  await app.listen({ port: p.port, host: p.host ?? '0.0.0.0' })
  const ticker = startTicker(tick, intervalMs, (err) => {
    app.log.error({ err }, 'club tick failed')
    try {
      p.onTickFailure?.()
    } catch {
      // Counting must not stop the next tick.
    }
  })
  service.watchTicker?.(ticker, intervalMs)
  return ticker
}
