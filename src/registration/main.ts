import { loadModerationData } from '../moderation/load.js'
import { createModerator } from '../moderation/moderator.js'
import { systemClock } from '../shared/clock.js'
import { loadEnv, loadSchoolConfig } from '../shared/config.js'
import { createDb, migrateToLatest } from '../shared/db.js'
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
  if (env.smtpUrl !== undefined) {
    mailer = createSmtpMailer(env.smtpUrl, env.mailFrom, config.verificationCode.ttlMinutes)
  } else {
    console.warn('[mail] SMTP_URL 未设置：验证码只会打印在服务日志里，不会发邮件（仅限开发使用）')
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
  await app.listen({ port: env.registrationPort, host: '0.0.0.0' })

  const dailyJob = startDailyJob(async () => {
    try {
      const report = await runDailyJob({ db, config, clock: systemClock })
      app.log.info({ report }, 'daily job finished')
      return report
    } catch (err) {
      app.log.error({ err }, 'daily job failed')
      throw err
    }
  }, config.timezone)

  let shuttingDown = false
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    app.log.info({ signal }, 'shutting down')
    try {
      dailyJob.stop()
      await app.close() // waits for requests and key-reset mails still in flight
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
  console.error('Registration service failed to start', err)
  process.exit(1)
})
