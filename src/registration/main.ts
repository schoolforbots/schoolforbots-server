import type { FastifyBaseLogger } from 'fastify'
import { loadModerationData } from '../moderation/load.js'
import { startLiveModerator } from '../moderation/rules.js'
import { systemClock } from '../shared/clock.js'
import { loadEnv, loadSchoolConfig } from '../shared/config.js'
import { createDb, migrateToLatest } from '../shared/db.js'
import { loadSchoolRules } from '../shared/school-rules.js'
import { createShutdown } from '../shared/shutdown.js'
import { startSwitches } from '../shared/switches.js'
import { buildRegistrationApp } from './app.js'
import { runDailyJob } from './daily-job.js'
import { ConsoleMailer, createSmtpMailer, type Mailer } from './mailer.js'
import { startDailyJob } from './scheduler.js'

async function main(): Promise<void> {
  const env = loadEnv(process.env)
  const config = loadSchoolConfig(env.configPath)
  const schoolRules = loadSchoolRules(env.schoolRulesDir)

  const db = createDb(env.databaseUrl, env.databaseTimeouts)
  await migrateToLatest(db)

  // The rules less the ones dropped in the admin, read again every few seconds. They log through the app's logger,
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

  let mailer: Mailer
  if (env.mail.transport === 'smtp') {
    mailer = createSmtpMailer(env.mail.smtpUrl, env.mailFrom, config.verificationCode.ttlMinutes)
  } else {
    console.warn('[mail] MAIL_TRANSPORT=console：验证码只会打印在服务日志里，不会发邮件（仅限本地开发使用）')
    mailer = new ConsoleMailer(config.verificationCode.ttlMinutes)
  }

  const app = buildRegistrationApp({
    db,
    config,
    moderator,
    mailer,
    clock: systemClock,
    schoolRules,
    trustProxy: env.trustProxy,
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
  })
  logger = app.log

  // Read from the database, so a change made in the admin reaches this service within a few seconds. Nothing reads it
  // yet; the admin will be given it.
  const switches = await startSwitches({ db, config, clock: systemClock, log: app.log })

  const runAndLog = async (trigger: 'startup' | 'midnight') => {
    try {
      const report = await runDailyJob({ db, config, clock: systemClock })
      app.log.info({ report, trigger }, 'daily job finished')
      return report
    } catch (err) {
      app.log.error({ err, trigger }, 'daily job failed')
      throw err
    }
  }

  // The schedule does not make up a midnight that passed while the service was down, so every start runs the job
  // once too. The job goes by today's date: after the day's run has happened, running it again changes nothing.
  // A failure here is logged and the service starts anyway; the next start or midnight, or `npm run job:daily`, retries.
  await runAndLog('startup').catch(() => undefined)

  await app.listen({ port: env.registrationPort, host: '0.0.0.0' })

  const dailyJob = startDailyJob(() => runAndLog('midnight'), config.timezone)

  const shutdown = createShutdown(async (signal) => {
    app.log.info({ signal }, 'shutting down')
    dailyJob.stop()
    switches.stop()
    moderator.stop()
    await app.close() // waits for requests and key-reset mails still in flight
    await db.destroy()
  })
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

main().catch((err) => {
  console.error('Registration service failed to start', err)
  process.exit(1)
})
