import type { FastifyBaseLogger } from 'fastify'
import { loadModerationData } from '../moderation/load.js'
import { startLiveModerator } from '../moderation/rules.js'
import { systemClock } from '../shared/clock.js'
import { loadClassEnv, loadSchoolConfig } from '../shared/config.js'
import { assertMigrationsUpToDate, createDb } from '../shared/db.js'
import { createShutdown } from '../shared/shutdown.js'
import { startSwitches } from '../shared/switches.js'
import { createClassService, startClassService } from './service.js'

async function main(): Promise<void> {
  // Only what this service uses: it sends no mail, so it needs no mail settings.
  const env = loadClassEnv(process.env)
  const config = loadSchoolConfig(env.configPath)

  // The registration service migrates the database; this one only checks that it has, and does not start otherwise.
  const db = createDb(env.databaseUrl, env.databaseTimeouts)
  await assertMigrationsUpToDate(db)

  // The rules less the ones dropped in the admin, read again every few seconds. They log through the service's logger,
  // made with them below: their first read comes before it (and a failure then stops the start), every later one after.
  let logger: FastifyBaseLogger | undefined
  const moderator = await startLiveModerator(
    {
      db,
      data: loadModerationData(env.moderationDataDir),
      log: { info: (obj, msg) => logger?.info(obj, msg), error: (obj, msg) => logger?.error(obj, msg) },
    },
    { refreshMs: config.switchRefreshSeconds * 1000 },
  )

  const speed = env.classTimelineSpeed
  if (speed !== 1) {
    console.warn(`[class] CLASS_TIMELINE_SPEED=${speed}：每节课按 ${speed} 倍速播放（仅限本地开发使用）`)
  }

  const service = createClassService({
    db,
    config,
    moderator,
    clock: systemClock,
    speed,
    trustProxy: env.trustProxy,
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
  })
  const { app } = service
  logger = app.log

  // Read from the database, so a change made in the admin reaches this service within a few seconds. Nothing reads it
  // yet; the teacher and the second layer will be given it.
  const switches = await startSwitches({ db, config, clock: systemClock, log: app.log })

  // Ticks once before it listens (a failure ends the start here), then on every interval.
  const ticker = await startClassService(service, { port: env.classPort, speed })

  const shutdown = createShutdown(async (signal) => {
    app.log.info({ signal }, 'shutting down')
    switches.stop()
    moderator.stop()
    await ticker.stop() // waits for a tick still running
    service.disconnectAll() // and from now on nobody comes in
    await app.close()
    await db.destroy()
  })
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

main().catch((err) => {
  console.error('Class service failed to start', err)
  process.exit(1)
})
