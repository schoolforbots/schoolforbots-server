import { loadModerationData } from '../moderation/load.js'
import { createModerator } from '../moderation/moderator.js'
import { systemClock } from '../shared/clock.js'
import { loadEnv, loadSchoolConfig } from '../shared/config.js'
import { assertMigrationsUpToDate, createDb } from '../shared/db.js'
import { createClassService, tickIntervalMs } from './service.js'
import { startTicker } from './ticker.js'

async function main(): Promise<void> {
  const env = loadEnv(process.env)
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

  await app.listen({ port: env.classPort, host: '0.0.0.0' })

  const ticker = startTicker(service.tick, tickIntervalMs(speed), (err) => app.log.error({ err }, 'class tick failed'))

  let shuttingDown = false
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    app.log.info({ signal }, 'shutting down')
    try {
      await ticker.stop() // waits for a tick still running
      service.disconnectAll()
      await app.close()
      await db.destroy()
      process.exit(0)
    } catch (err) {
      console.error('Shutdown failed', err)
      process.exit(1)
    }
  }
  process.on('SIGTERM', (signal) => void shutdown(signal))
  process.on('SIGINT', (signal) => void shutdown(signal))
}

main().catch((err) => {
  console.error('Class service failed to start', err)
  process.exit(1)
})
