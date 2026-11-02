import { loadModerationData } from '../moderation/load.js'
import { createModerator } from '../moderation/moderator.js'
import { systemClock } from '../shared/clock.js'
import { loadEnv, loadSchoolConfig } from '../shared/config.js'
import { createDb, migrateToLatest } from '../shared/db.js'
import { createShutdown } from '../shared/shutdown.js'
import { buildRegistrationApp } from './app.js'
import { runDailyJob } from './daily-job.js'
import { ConsoleMailer, createSmtpMailer, type Mailer } from './mailer.js'
import { startDailyJob } from './scheduler.js'

async function main(): Promise<void> {
  const env = loadEnv(process.env)
  const config = loadSchoolConfig(env.configPath)

  const db = createDb(env.databaseUrl)
  await migrateToLatest(db)

  const moderator = createModerator(loadModerationData(env.moderationDataDir))

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
    trustProxy: env.trustProxy,
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
  })

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
