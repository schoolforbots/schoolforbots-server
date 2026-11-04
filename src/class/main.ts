import { setTimeout as delay } from 'node:timers/promises'
import type { FastifyBaseLogger } from 'fastify'
import { buildProviders, createLlm } from '../llm/client.js'
import { loadPrompts } from '../llm/prompts.js'
import { loadModerationData } from '../moderation/load.js'
import { startLiveModerator } from '../moderation/rules.js'
import { createSecondLayer } from '../moderation/second-layer.js'
import { systemClock } from '../shared/clock.js'
import { loadClassEnv, loadSchoolConfig } from '../shared/config.js'
import { assertMigrationsUpToDate, createDb } from '../shared/db.js'
import { createShutdown, SHUTDOWN_DEADLINE_MS } from '../shared/shutdown.js'
import { startSwitches } from '../shared/switches.js'
import { createClassService, startClassService } from './service.js'

async function main(): Promise<void> {
  // Only what this service uses: it sends no mail, so it needs no mail settings.
  const env = loadClassEnv(process.env)
  const config = loadSchoolConfig(env.configPath)
  // The model's prompts and providers are read before anything starts: a missing prompt file or key stops the start.
  const prompts = loadPrompts(env.promptsDir)
  const providers = env.llmFake ? {} : buildProviders(config, process.env)

  // The registration service migrates the database; this one only checks that it has, and does not start otherwise.
  const db = createDb(env.databaseUrl, env.databaseTimeouts)
  await assertMigrationsUpToDate(db)

  // What starts before the service logs through the service's logger, made with the service below: the first reads of
  // the rules and the switches come before it (a failure of the rules then stops the start), everything later after.
  let logger: FastifyBaseLogger | undefined
  const log = {
    info: (obj: unknown, msg?: string) => logger?.info(obj, msg),
    warn: (obj: unknown, msg?: string) => logger?.warn(obj, msg),
    error: (obj: unknown, msg?: string) => logger?.error(obj, msg),
  }

  // The rules less the ones dropped in the admin, read again every few seconds.
  const moderator = await startLiveModerator(
    { db, data: loadModerationData(env.moderationDataDir), log },
    { refreshMs: config.switchRefreshSeconds * 1000 },
  )

  // Read from the database, so a change made in the admin reaches this service within a few seconds.
  const switches = await startSwitches({ db, config, clock: systemClock, log })

  // The model, with the cost of every call recorded. The monthly budget is watched by the registration service, which
  // has the mail settings for the notice: it checks the spend of both services after each of its runs.
  const llm = createLlm({ db, config, clock: systemClock, providers, fake: env.llmFake, log })
  const secondLayer = createSecondLayer({ config, llm, switches, prompts, log })

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
    model: { llm, prompts, secondLayer, switches },
  })
  const { app } = service
  logger = app.log

  // Ticks once before it listens (a failure ends the start here), then on every interval.
  const ticker = await startClassService(service, { port: env.classPort, speed })

  const shutdown = createShutdown(async (signal) => {
    app.log.info({ signal }, 'shutting down')
    switches.stop()
    moderator.stop()
    await ticker.stop() // waits for a tick still running; after it no answering starts
    // The answers still being worked on get half the time the shutdown has to reach the class; any later is dropped.
    await Promise.race([service.teacherAi?.idle(), delay(SHUTDOWN_DEADLINE_MS / 2)])
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
