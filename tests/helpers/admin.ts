import type { FastifyServerOptions } from 'fastify'
import { base32Encode, hashPassword, totpNow } from '../../src/admin/auth.js'
import type { AdminDeps } from '../../src/admin/app.js'
import type { Llm } from '../../src/llm/client.js'
import { buildRegistrationApp } from '../../src/registration/app.js'
import { MemoryMailer } from '../../src/registration/mailer.js'
import { loadEnv, type SchoolConfig } from '../../src/shared/config.js'
import { loadSchoolRules } from '../../src/shared/school-rules.js'
import { createTestClock } from './clock.js'
import { createTestDb } from './db.js'
import { exampleConfig, exampleModerator } from './app.js'
import { examplePrompts, switches as fixedSwitches } from './llm.js'
import { fileURLToPath } from 'node:url'

/** A made-up path: the real one never appears in the repository. */
export const TEST_ADMIN_PATH = '/test-back-office'
export const TEST_PASSWORD = 'a test password, not a real one'
export const TEST_TOTP_SECRET = base32Encode(Buffer.from('12345678901234567890'))
const PASSWORD_HASH = hashPassword(TEST_PASSWORD)

export const CSRF = { 'x-requested-with': 'admin' }

/**
 * The registration service with the admin pages on at `TEST_ADMIN_PATH`, on a fresh database and a controllable clock
 * (by default at noon on Monday 2026-11-02, school time), with the example config and no model unless given.
 */
export async function buildAdminTestApp(
  opts: {
    admin?: boolean
    logger?: FastifyServerOptions['logger']
    distDir?: string
    switches?: AdminDeps['switches']
    config?: SchoolConfig
    llm?: Llm | null
    now?: Date
  } = {},
) {
  const { db, destroy: destroyDb } = await createTestDb()
  const config = opts.config ?? exampleConfig()
  const clock = createTestClock(opts.now ?? new Date('2026-11-02T12:00:00+08:00'))
  const mailer = new MemoryMailer()
  const moderator = exampleModerator()
  const env = loadEnv(
    {
      DATABASE_URL: 'postgres://unused',
      MAIL_TRANSPORT: 'console',
      ADMIN_PATH: TEST_ADMIN_PATH,
      ADMIN_PASSWORD_HASH: PASSWORD_HASH,
      ADMIN_TOTP_SECRET: TEST_TOTP_SECRET,
    },
    () => {},
  )
  const switches = opts.switches ?? fixedSwitches()
  const app = buildRegistrationApp({
    db,
    config,
    moderator,
    mailer,
    clock,
    schoolRules: loadSchoolRules(fileURLToPath(new URL('../../school-rules', import.meta.url))),
    trustProxy: false,
    logger: opts.logger,
    admin:
      opts.admin === false
        ? undefined
        : {
            db,
            config,
            clock,
            env,
            llm: opts.llm ?? null,
            prompts: examplePrompts(),
            moderator,
            switches,
            mailer,
            distDir: opts.distDir,
          },
  })
  try {
    await app.ready()
  } catch (err) {
    await destroyDb()
    throw err
  }

  const url = (path: string) => `${TEST_ADMIN_PATH}/${path}`
  // A code is good once, so a second login in the same step takes the next step's code, or moves the clock on 30 s
  // when that one is out of reach too.
  let lastStep = -1
  function freshCode(): string {
    const stepOf = (d: Date) => Math.floor(d.getTime() / 30_000)
    let step = Math.max(stepOf(clock.now()), lastStep + 1)
    if (step > stepOf(clock.now()) + 1) {
      clock.advance(30_000)
      step = Math.max(stepOf(clock.now()), lastStep + 1)
    }
    lastStep = step
    return totpNow(TEST_TOTP_SECRET, new Date(step * 30_000))
  }
  async function login(over: { password?: string; code?: string; remoteAddress?: string; headers?: Record<string, string> } = {}) {
    return app.inject({
      method: 'POST',
      url: url('api/login'),
      headers: over.headers ?? CSRF,
      remoteAddress: over.remoteAddress,
      payload: { password: over.password ?? TEST_PASSWORD, code: over.code ?? freshCode() },
    })
  }
  /** Logs in and returns the Cookie header value for the following requests. */
  async function session(): Promise<string> {
    const res = await login()
    if (res.statusCode !== 200) throw new Error(`login failed: ${res.statusCode}`)
    return `sfb_admin=${res.cookies[0]?.value}`
  }

  return {
    app,
    db,
    config,
    clock,
    moderator,
    url,
    login,
    session,
    async destroy() {
      await app.close()
      await destroyDb()
    },
  }
}
