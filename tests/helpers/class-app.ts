import type { FastifyServerOptions } from 'fastify'
import type { Kysely } from 'kysely'
import type { MessageHandlers } from '../../src/class/connection.js'
import type { LessonHooks } from '../../src/class/hooks.js'
import { createClassService, type ModelDeps } from '../../src/class/service.js'
import type { Clock } from '../../src/shared/clock.js'
import type { SchoolConfig } from '../../src/shared/config.js'
import { startMaintenanceWatch } from '../../src/shared/maintenance.js'
import type { Database } from '../../src/shared/schema.js'
import { exampleConfig, exampleModerator, type ConfigOverrides } from './app.js'
import { createTestClock } from './clock.js'
import { createTestDb } from './db.js'

/**
 * A class service on a fresh database, assembled as the running service is (`createClassService`): the example
 * config and word lists, a controllable clock (by default Monday 2 November 2026 at 19:00 in Beijing, before the
 * evening doors), the real hub and the real lesson runtime. The runtime only runs when a test calls `runtime.tick()`
 * (or `tick()`, which the running service calls on its interval).
 *
 * The lesson hooks are `createLessonHooks` (src/class/hooks.ts: whatever has been built so far, the rest no-ops) with
 * `overrides.hooks` on top; the same object goes to the runtime and to the app.
 *
 * One chat engine (`chat`) serves both: its hooks go into `createLessonHooks`, its handlers to the app, with
 * `overrides.handlers` on top. It ends overdue conversations only when a test calls `chat.tick()` (or `tick()`). The
 * questions and the call-on (`questions`) are wired the same way; the teacher calls on the first student online
 * unless `random` says otherwise (see `callOnStep`).
 * The hub goes into `createLessonHooks` too (it needs one), so a session that runs to its close writes the summaries
 * (and pushes them to whoever is online).
 *
 * Without `model` the teacher has no model and answers no question. `model` makes one on the test's database, config
 * and clock; `teacherAi` is then the teacher's model work, whose `idle()` waits for the answers being worked on.
 *
 * The maintenance switch (`maintenance`) is a real watch on the test's database that reads it only when asked: after
 * `setMaintenance`, a test calls `maintenance.refresh()`, as the running service's timer would.
 *
 * The transport's timers run on real time with the service's defaults (10 s for hello, a ping every 30 s) unless
 * `helloTimeoutMs` or `pingIntervalMs` shorten them. A connection made with `app.injectWS` does not answer pings, so
 * it is dropped at its second ping (a minute in, by default): for pings, connect over TCP.
 */
export async function buildTestClassApp(
  overrides: {
    config?: ConfigOverrides
    hooks?: Partial<LessonHooks>
    handlers?: Partial<MessageHandlers>
    now?: Date
    speed?: number
    random?: () => number
    logger?: FastifyServerOptions['logger']
    helloTimeoutMs?: number
    pingIntervalMs?: number
    rateWindowMs?: number
    trustProxy?: boolean
    model?: (p: { db: Kysely<Database>; config: SchoolConfig; clock: Clock }) => ModelDeps
  } = {},
) {
  const { db, destroy: destroyDb } = await createTestDb()

  const config = exampleConfig(overrides.config)
  const clock = createTestClock(overrides.now ?? new Date('2026-11-02T19:00:00+08:00'))
  // Read when asked (`refresh`), never on a timer.
  const maintenance = await startMaintenanceWatch({ db, config }, { refreshMs: 3_600_000 })
  const service = createClassService({
    db,
    config,
    moderator: exampleModerator(),
    clock,
    speed: overrides.speed ?? 1,
    logger: overrides.logger,
    random: overrides.random ?? (() => 0),
    hooks: overrides.hooks,
    handlers: overrides.handlers,
    helloTimeoutMs: overrides.helloTimeoutMs,
    pingIntervalMs: overrides.pingIntervalMs,
    rateWindowMs: overrides.rateWindowMs,
    trustProxy: overrides.trustProxy,
    model: overrides.model?.({ db, config, clock }),
    maintenance,
  })
  const { app, runtime, hub, chat, questions, hooks, teacherAi } = service
  try {
    await app.ready()
  } catch (err) {
    maintenance.stop()
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
    questions,
    hooks,
    teacherAi,
    config,
    maintenance,
    tick: service.tick,
    disconnectAll: service.disconnectAll,
    watchTicker: service.watchTicker,
    async destroy() {
      maintenance.stop()
      await app.close()
      await destroyDb()
    },
  }
}
