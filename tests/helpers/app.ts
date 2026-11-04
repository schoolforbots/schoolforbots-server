import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { FastifyServerOptions } from 'fastify'
import { buildRegistrationApp } from '../../src/registration/app.js'
import { MemoryMailer } from '../../src/registration/mailer.js'
import { createModerator, type Moderator } from '../../src/moderation/moderator.js'
import { parseInjectionPatterns, parseWordList } from '../../src/moderation/load.js'
import { loadSchoolConfig, type SchoolConfig } from '../../src/shared/config.js'
import { loadSchoolRules, type SchoolRules } from '../../src/shared/school-rules.js'
import { createTestClock } from './clock.js'
import { createTestDb } from './db.js'

// Paths hang off this file, not the working directory, so the tests run from anywhere.
const fromRoot = (relative: string) => fileURLToPath(new URL(`../../${relative}`, import.meta.url))

/** Fields of the school config to replace; `verificationCode` may name only some of its fields. */
export type ConfigOverrides = Omit<Partial<SchoolConfig>, 'verificationCode'> & {
  verificationCode?: Partial<SchoolConfig['verificationCode']>
}

/**
 * The example school config, with one call-on after segment 3: the timeline runs one call-on for now, and the tests
 * of the class were written against that one.
 */
export function exampleConfigWithOneCallOn(): SchoolConfig {
  const example = loadSchoolConfig(fromRoot('config/school.example.json'))
  return { ...example, lesson: { ...example.lesson, callOns: [{ kind: 'review', afterSegment: 3 }] } }
}

/** The example school config with `overrides` applied. */
export function exampleConfig(overrides: ConfigOverrides = {}): SchoolConfig {
  const example = exampleConfigWithOneCallOn()
  return {
    ...example,
    ...overrides,
    verificationCode: { ...example.verificationCode, ...overrides.verificationCode },
  }
}

/** A moderator with the example word lists. */
export function exampleModerator(): Moderator {
  return createModerator({
    blockedWords: parseWordList(readFileSync(fromRoot('data/moderation/blocked-words.example.txt'), 'utf8')),
    injectionPatterns: parseInjectionPatterns(
      readFileSync(fromRoot('data/moderation/injection-patterns.example.txt'), 'utf8'),
    ),
  })
}

/**
 * A registration service on a fresh database, with the example config and word lists, the school rules in the
 * repository (unless `schoolRules` replaces them) and a controllable clock.
 */
export async function buildTestApp(
  overrides: { config?: ConfigOverrides; schoolRules?: SchoolRules; logger?: FastifyServerOptions['logger'] } = {},
) {
  const { db, destroy: destroyDb } = await createTestDb()

  const config = exampleConfig(overrides.config)
  const schoolRules = overrides.schoolRules ?? loadSchoolRules(fromRoot('school-rules'))
  const moderator = exampleModerator()
  const mailer = new MemoryMailer()
  const clock = createTestClock(new Date('2026-11-02T12:00:00+08:00'))

  const app = buildRegistrationApp({
    db,
    config,
    moderator,
    mailer,
    clock,
    schoolRules,
    trustProxy: false,
    logger: overrides.logger,
  })
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
    schoolRules,
    async destroy() {
      await app.close()
      await destroyDb()
    },
  }
}
