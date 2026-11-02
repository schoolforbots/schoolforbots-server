import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { FastifyServerOptions } from 'fastify'
import { buildRegistrationApp } from '../../src/registration/app.js'
import { MemoryMailer } from '../../src/registration/mailer.js'
import { createModerator } from '../../src/moderation/moderator.js'
import { parseInjectionPatterns, parseWordList } from '../../src/moderation/load.js'
import { loadSchoolConfig, type SchoolConfig } from '../../src/shared/config.js'
import { createTestClock } from './clock.js'
import { createTestDb } from './db.js'

// Paths hang off this file, not the working directory, so the tests run from anywhere.
const fromRoot = (relative: string) => fileURLToPath(new URL(`../../${relative}`, import.meta.url))

/** Fields of the school config to replace; `verificationCode` may name only some of its fields. */
export type ConfigOverrides = Omit<Partial<SchoolConfig>, 'verificationCode'> & {
  verificationCode?: Partial<SchoolConfig['verificationCode']>
}

/** A registration service on a fresh database, with the example config and word lists and a controllable clock. */
export async function buildTestApp(overrides: { config?: ConfigOverrides; logger?: FastifyServerOptions['logger'] } = {}) {
  const { db, destroy: destroyDb } = await createTestDb()

  const example = loadSchoolConfig(fromRoot('config/school.example.json'))
  const config: SchoolConfig = {
    ...example,
    ...overrides.config,
    verificationCode: { ...example.verificationCode, ...overrides.config?.verificationCode },
  }
  const moderator = createModerator({
    blockedWords: parseWordList(readFileSync(fromRoot('data/moderation/blocked-words.example.txt'), 'utf8')),
    injectionPatterns: parseInjectionPatterns(
      readFileSync(fromRoot('data/moderation/injection-patterns.example.txt'), 'utf8'),
    ),
  })
  const mailer = new MemoryMailer()
  const clock = createTestClock(new Date('2026-11-02T12:00:00+08:00'))

  const app = buildRegistrationApp({ db, config, moderator, mailer, clock, trustProxy: false, logger: overrides.logger })
  try {
    await app.ready()
  } catch (err) {
    await destroyDb()
    throw err
  }

  return {
    app,
    db,
    mailer,
    clock,
    async destroy() {
      await app.close()
      await destroyDb()
    },
  }
}
