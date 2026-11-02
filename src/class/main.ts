import { loadModerationData } from '../moderation/load.js'
import { createModerator } from '../moderation/moderator.js'
import { systemClock } from '../shared/clock.js'
import { loadClassEnv, loadSchoolConfig } from '../shared/config.js'
import { assertMigrationsUpToDate, createDb } from '../shared/db.js'
import { createShutdown } from '../shared/shutdown.js'
import { createClassService, startClassService } from './service.js'

async function main(): Promise<void> {
  // Only what this service uses: it sends no mail, so it needs no mail settings.
  const env = loadClassEnv(process.env)
  const config = loadSchoolConfig(env.configPath)

  // The registration service migrates the database; this one only checks that it has, and does not start otherwise.
  const db = createDb(env.databaseUrl)
  await assertMigrationsUpToDate(db)

  const moderator = createModerator(loadModerationData(env.moderationDataDir))

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
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
  })
  const { app } = service

  // Ticks once before it listens (a failure ends the start here), then on every interval.
  const ticker = await startClassService(service, { port: env.classPort, speed })

  const shutdown = createShutdown(async (signal) => {
    app.log.info({ signal }, 'shutting down')
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
