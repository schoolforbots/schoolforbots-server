import type { FastifyServerOptions } from 'fastify'
import { buildClassApp } from '../../src/class/app.js'
import { chatHandlers, createChatEngine } from '../../src/class/chat.js'
import type { MessageHandlers } from '../../src/class/connection.js'
import { disciplineRecorder } from '../../src/class/discipline.js'
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
 *
 * One chat engine (`chat`) serves both: its hooks go into `createLessonHooks`, its handlers to the app, with
 * `overrides.handlers` on top. It ends overdue conversations only when a test calls `chat.tick()`.
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
  const speed = overrides.speed ?? 1
  const chat = createChatEngine({
    db,
    config,
    clock,
    hub,
    moderator,
    discipline: disciplineRecorder,
    speed,
    // The app's logger: the engine only logs while the app is serving.
    log: (obj, msg) => app.log.info(obj, msg),
  })
  const hooks: LessonHooks = { ...createLessonHooks({ db, config, clock, chat }), ...overrides.hooks }
  const runtime = createClassRuntime({ db, config, clock, hub, moderator, speed, hooks })

  const app = buildClassApp({
    db,
    config,
    moderator,
    clock,
    runtime,
    hub,
    hooks,
    handlers: { ...chatHandlers(chat), ...overrides.handlers },
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
    chat,
    config,
    async destroy() {
      await app.close()
      await destroyDb()
    },
  }
}
