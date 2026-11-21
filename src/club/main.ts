import type { FastifyBaseLogger } from 'fastify'
import { recordOpsEvent, recordStart } from '../ops/events.js'
import { systemClock } from '../shared/clock.js'
import { loadClubEnv, loadSchoolConfig } from '../shared/config.js'
import { assertMigrationsUpToDate, createDb } from '../shared/db.js'
import { startMaintenanceWatch } from '../shared/maintenance.js'
import { createShutdown } from '../shared/shutdown.js'
import { doudizhuGame } from './doudizhu-game.js'
import { createClubService, startClubService } from './service.js'
import { loadWordLists } from './word-lists.js'

async function main(): Promise<void> {
  // Only what this service uses: no mail, no model, no moderation.
  const env = loadClubEnv(process.env)
  const config = loadSchoolConfig(env.configPath)
  // The word lists are read before anything starts: a missing or malformed list stops the start.
  const wordLists = loadWordLists(config.club.wordLists)

  // The registration service migrates the database; this one only checks that it has, and does not start otherwise.
  const db = createDb(env.databaseUrl, env.databaseTimeouts)
  await assertMigrationsUpToDate(db)
  // Counted for the alert about a service that keeps restarting. Failing to note it does not stop the start.
  await recordStart(db, 'club', systemClock.now()).catch((err: unknown) =>
    console.error('Could not record the start', err instanceof Error ? err.name : 'unknown'),
  )

  // What starts before the service logs through the service's logger, made with the service below.
  let logger: FastifyBaseLogger | undefined
  const log = {
    info: (obj: unknown, msg?: string) => logger?.info(obj, msg),
    error: (obj: unknown, msg?: string) => logger?.error(obj, msg),
  }

  // Read before the first tick: a service started while it is on lets nobody in.
  const maintenance = await startMaintenanceWatch({ db, config, log })

  // What the alert mails count: a failed tick or round, a room that failed, an unexpected error in a connection.
  // Noted without holding anything up; a failed write is only logged.
  const noteInternalError = () => recordOpsEvent(db, { service: 'club', kind: 'internal_error', at: systemClock.now() }, log)

  const service = createClubService({
    db,
    config,
    clock: systemClock,
    game: doudizhuGame({
      timeBankSeconds: config.club.timeBankSeconds,
      trusteeDelaySeconds: config.club.trusteeDelaySeconds,
    }),
    wordLists,
    maintenance,
    trustProxy: env.trustProxy,
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
    onInternalError: noteInternalError,
  })
  const { app } = service
  logger = app.log
  if (!config.club.enabled) app.log.warn({}, 'club.enabled is false: the club service runs, and lets nobody in')

  // Ticks once before it listens, then on every interval.
  const ticker = await startClubService(service, { port: env.clubPort, onTickFailure: noteInternalError })

  const shutdown = createShutdown(async (signal) => {
    app.log.info({ signal }, 'shutting down')
    maintenance.stop()
    await ticker.stop() // waits for a tick still running
    await service.roundsDone()
    service.disconnectAll() // and from now on nobody comes in
    await app.close()
    await db.destroy()
  })
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

main().catch((err) => {
  console.error('Club service failed to start', err)
  process.exit(1)
})
