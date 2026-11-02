import { systemClock } from '../shared/clock.js'
import { loadEnv, loadSchoolConfig } from '../shared/config.js'
import { createDb } from '../shared/db.js'
import { runDailyJob } from './daily-job.js'

// `npm run job:daily`: runs the nightly job once, now, with the service's environment and school config, then exits
// 0 if it succeeded and 1 if it did not. The service already runs the job at every start and every local midnight;
// this is for running it by hand. The job goes by today's date in the school's timezone, so running it after the
// day's run has happened changes nothing.
async function main(): Promise<void> {
  const env = loadEnv(process.env)
  const config = loadSchoolConfig(env.configPath)
  const db = createDb(env.databaseUrl)
  try {
    const report = await runDailyJob({ db, config, clock: systemClock })
    console.log('Daily job finished', report)
  } finally {
    await db.destroy()
  }
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    console.error('Daily job failed', err)
    process.exit(1)
  },
)
