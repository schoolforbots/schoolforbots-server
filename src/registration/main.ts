import type { FastifyBaseLogger } from 'fastify'
import { generateMissing, type GeneratorDeps } from '../lessons/generator.js'
import { checkBudget } from '../llm/budget.js'
import { buildProviders, createLlm } from '../llm/client.js'
import { loadPrompts } from '../llm/prompts.js'
import { loadModerationData } from '../moderation/load.js'
import { startLiveModerator } from '../moderation/rules.js'
import { systemClock } from '../shared/clock.js'
import { loadEnv, loadSchoolConfig } from '../shared/config.js'
import { createDb, migrateToLatest } from '../shared/db.js'
import { loadSchoolRules } from '../shared/school-rules.js'
import { createShutdown } from '../shared/shutdown.js'
import { startSwitches } from '../shared/switches.js'
import { runWeeklyReview } from '../weekly/review.js'
import { buildRegistrationApp } from './app.js'
import { runDailyJob } from './daily-job.js'
import { ConsoleMailer, createSmtpMailer, type Mailer } from './mailer.js'
import { isWeeklyReviewDay, startDailyJob, startPeriodicJob } from './scheduler.js'

async function main(): Promise<void> {
  const env = loadEnv(process.env)
  const config = loadSchoolConfig(env.configPath)
  const schoolRules = loadSchoolRules(env.schoolRulesDir)
  // The model's prompts and providers are read before anything starts: a missing prompt file or key stops the start.
  const prompts = loadPrompts(env.promptsDir)
  const providers = env.llmFake ? {} : buildProviders(config, process.env)
  if (env.llmFake) console.warn('[registration] LLM_FAKE=1：大模型的每次调用都只拿写死的回复，不联网也不花钱（仅限本地开发使用）')

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

  // What starts before the app logs through it too, once it exists.
  const log = {
    info: (obj: unknown, msg?: string) => logger?.info(obj, msg),
    error: (obj: unknown, msg?: string) => logger?.error(obj, msg),
  }

  let mailer: Mailer
  if (env.mail.transport === 'smtp') {
    mailer = createSmtpMailer(env.mail.smtpUrl, env.mailFrom, config.verificationCode.ttlMinutes)
  } else {
    console.warn('[mail] MAIL_TRANSPORT=console：验证码只会打印在服务日志里，不会发邮件（仅限本地开发使用）')
    mailer = new ConsoleMailer(config.verificationCode.ttlMinutes)
  }

  // The model, with its costs recorded and the monthly budget watched. The lessons are made with it, and the admin
  // is given it and the prompts too.
  const llm = createLlm({
    db,
    config,
    clock: systemClock,
    providers,
    fake: env.llmFake,
    budget: { mailer, operatorEmail: env.operatorEmail },
    log,
  })

  // Read from the database, so a change made in the admin reaches this service within a few seconds.
  const switches = await startSwitches({ db, config, clock: systemClock, log })

  const app = buildRegistrationApp({
    db,
    config,
    moderator,
    mailer,
    clock: systemClock,
    schoolRules,
    trustProxy: env.trustProxy,
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
    admin: { db, config, clock: systemClock, env, llm, prompts, moderator, switches, mailer },
  })
  logger = app.log
  const lessons: GeneratorDeps = { db, config, clock: systemClock, moderator, llm, prompts, log: app.log }

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

  // The spend of the month against the budget, for the class service's model calls: it records them but has no mail
  // settings to send the notice with. This service's own calls are checked as they are made.
  const checkSpend = () =>
    checkBudget({ db, config, clock: systemClock, mailer, operatorEmail: env.operatorEmail }).catch((err: unknown) =>
      app.log.error({ err: err instanceof Error ? err.name : 'unknown' }, 'budget check failed'),
    )

  // The lessons of the days ahead: made after each midnight job, then every retryMinutes, which retries the ones that
  // failed; a run only acts on missing lessons, so one with nothing to do is cheap. Every start runs it once too. After
  // each run, the spend is checked.
  const lessonGeneration = startPeriodicJob(
    async () => {
      try {
        app.log.info({ report: await generateMissing(lessons) }, 'lesson generation finished')
      } finally {
        await checkSpend()
      }
    },
    config.lessonGeneration.retryMinutes,
    (err) => app.log.error({ err: err instanceof Error ? err.constructor.name : 'unknown' }, 'lesson generation failed'),
  )
  void lessonGeneration.runNow()

  // The review of the last week that has ended: after the midnight job of a Monday. Like the daily job, every start
  // runs it too, which makes up a Monday the service was down for; a week already reviewed is left as it is.
  const runWeekly = async (trigger: 'startup' | 'midnight') => {
    try {
      await runWeeklyReview({ db, config, clock: systemClock, llm, prompts, log: app.log })
    } catch (err) {
      app.log.error({ err: err instanceof Error ? err.constructor.name : 'unknown', trigger }, 'weekly review failed')
    }
  }
  void runWeekly('startup')

  const dailyJob = startDailyJob(async () => {
    try {
      await runAndLog('midnight')
    } finally {
      await lessonGeneration.runNow()
      if (isWeeklyReviewDay(systemClock.now(), config.timezone)) await runWeekly('midnight')
    }
  }, config.timezone)

  const shutdown = createShutdown(async (signal) => {
    app.log.info({ signal }, 'shutting down')
    dailyJob.stop()
    lessonGeneration.stop()
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
