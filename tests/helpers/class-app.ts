import type { FastifyServerOptions } from 'fastify'
import { buildClassApp } from '../../src/class/app.js'
import type { MessageHandlers } from '../../src/class/connection.js'
import { createLessonHooks, type LessonHooks } from '../../src/class/hooks.js'
import { createHub } from '../../src/class/hub.js'
import { createClassRuntime } from '../../src/class/runtime.js'
import { exampleConfig, exampleModerator, type ConfigOverrides } from './app.js'
import { createTestClock } from './clock.js'
import { createTestDb } from './db.js'

/**
 * A class service on a fresh database: the example config and word lists, a controllable clock (by default Monday
 * 2 November 2026 at 19:00 in Beijing, before the evening doors), the real hub and the real lesson runtime. The
 * runtime only runs when a test calls `runtime.tick()`.
 *
 * The lesson hooks are `createLessonHooks` (src/class/hooks.ts: whatever has been built so far, the rest no-ops) with
 * `overrides.hooks` on top; the same object goes to the runtime and to the app.
 */
export async function buildTestClassApp(
  overrides: {
    config?: ConfigOverrides
    hooks?: Partial<LessonHooks>
    handlers?: Partial<MessageHandlers>
    now?: Date
    speed?: number
    logger?: FastifyServerOptions['logger']
  } = {},
) {
  const { db, destroy: destroyDb } = await createTestDb()

  const config = exampleConfig(overrides.config)
  const moderator = exampleModerator()
  const clock = createTestClock(overrides.now ?? new Date('2026-11-02T19:00:00+08:00'))
  const hub = createHub()
  const hooks: LessonHooks = { ...createLessonHooks({ db, config, clock }), ...overrides.hooks }
  const runtime = createClassRuntime({ db, config, clock, hub, moderator, speed: overrides.speed ?? 1, hooks })

  const app = buildClassApp({
    db,
    config,
    moderator,
    clock,
    runtime,
    hub,
    hooks,
    handlers: overrides.handlers,
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
    clock,
    runtime,
    hub,
    config,
    async destroy() {
      await app.close()
      await destroyDb()
    },
  }
}
