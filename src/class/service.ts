import type { FastifyInstance, FastifyServerOptions } from 'fastify'
import type { Kysely } from 'kysely'
import type { Llm } from '../llm/client.js'
import type { PromptName, PromptTemplate } from '../llm/prompts.js'
import type { Moderator } from '../moderation/moderator.js'
import type { SecondLayer } from '../moderation/second-layer.js'
import type { Clock } from '../shared/clock.js'
import type { SchoolConfig } from '../shared/config.js'
import { databaseAlive } from '../shared/healthz.js'
import type { Database } from '../shared/schema.js'
import type { Switches } from '../shared/switches.js'
import { buildClassApp } from './app.js'
import { chatHandlers, createChatEngine, type ChatEngine } from './chat.js'
import { MAINTENANCE, type MessageHandlers } from './connection.js'
import { disciplineRecorder } from './discipline.js'
import { createLessonHooks, type LessonHooks } from './hooks.js'
import { createHub, type MemoryHub } from './hub.js'
import { questionHandlers, type QuestionsDeps } from './questions.js'
import { createClassRuntime, LIVE_TOLERANCE_MS, onlyClassStepsFailed, type ClassRuntime } from './runtime.js'
import { createTeacherAi, type TeacherAi } from './teacher-ai.js'
import { startTicker, type Ticker } from './ticker.js'

/** What the service's work with the model is done with: the model, its prompts, the second layer and the switches. */
export interface ModelDeps {
  llm: Llm
  prompts: Record<PromptName, PromptTemplate>
  secondLayer: SecondLayer
  switches: Switches
}

export interface ClassServiceDeps {
  db: Kysely<Database>
  config: SchoolConfig
  moderator: Moderator
  clock: Clock
  /** Timeline speed (`CLASS_TIMELINE_SPEED`): 1 is real time. It scales every lesson duration, not the transport's. */
  speed: number
  /** Whether X-Forwarded-For names the client (see `ClassDeps.trustProxy`). Unset: false. */
  trustProxy?: boolean
  /** Fastify logger options; unset means no logging. */
  logger?: FastifyServerOptions['logger']
  /**
   * Picks whom the teacher calls on (see `QuestionsDeps.random`) and which questions the teacher reads when there are
   * too many (see `TeacherAiDeps.random`); `Math.random` when unset.
   */
  random?: () => number
  /**
   * The model the teacher answers questions and comments on answers with, and the second layer the answers to a
   * call-on pass; without it, the teacher answers no question and thanks every answer with the template line.
   */
  model?: ModelDeps
  /** Put in place of the real lesson hooks, for the runtime and the app alike (tests). */
  hooks?: Partial<LessonHooks>
  /** Put in place of the real message handlers (tests). */
  handlers?: Partial<MessageHandlers>
  /** The deadline for hello, in real milliseconds (see `ClassDeps`); tests shorten it. */
  helloTimeoutMs?: number
  /** How often connections are pinged, in real milliseconds (see `ClassDeps`); tests shorten it. */
  pingIntervalMs?: number
  /** The window the frames per minute are counted in, in real milliseconds (see `ClassDeps`); tests shorten it. */
  rateWindowMs?: number
}

/** The class service's parts, assembled. */
export interface ClassService {
  app: FastifyInstance
  hub: MemoryHub
  runtime: ClassRuntime
  chat: ChatEngine
  questions: QuestionsDeps
  hooks: LessonHooks
  /**
   * The teacher's work with the model, null without a model. Its `idle()` waits for the answers and the comments
   * being worked on.
   */
  teacherAi: TeacherAi | null
  /** What the service runs on its interval: the lesson runtime's steps, then the conversations overdue by the clock. */
  tick(): Promise<void>
  /**
   * The service is stopping: tells every student connected that the school is under maintenance and disconnects
   * them. From then on nobody comes in (see `ClassDeps.stopping`).
   */
  disconnectAll(): void
  /**
   * Hands the service the ticker that runs `tick()` every `intervalMs`, so `/healthz` can tell a stuck clock: until it
   * is handed over, or when its last run ended more than `max(30 s, 3 intervals)` ago, the service is unhealthy.
   */
  watchTicker(ticker: Pick<Ticker, 'lastFinishedAt'>, intervalMs: number): void
}

/** The least time without a finished tick that makes `/healthz` fail. */
export const STUCK_TICK_FLOOR_MS = 30_000

/**
 * The class service on one database: the hub, the chat engine, the questions and the call-ons, the teacher's answers
 * and comments (with a model), the lesson hooks, the lesson runtime and the WebSocket app. One chat engine serves both
 * the hooks and the app's handlers, as do the questions; the same hooks go to the runtime and to the app. Nothing runs
 * until something calls `tick()`.
 */
export function createClassService(deps: ClassServiceDeps): ClassService {
  const { db, config, moderator, clock, speed } = deps
  // The app's logger: the parts only log while the app is serving.
  const log = (obj: object, msg: string) => app.log.info(obj, msg)
  const logError = (obj: object, msg: string) => app.log.error(obj, msg)
  // Set by `disconnectAll`, for good.
  let stopping = false
  let watched: { ticker: Pick<Ticker, 'lastFinishedAt'>; intervalMs: number } | null = null
  const healthy = async () => {
    if (watched === null) return false
    const finishedAt = watched.ticker.lastFinishedAt()
    if (finishedAt === null) return false
    if (Date.now() - finishedAt > Math.max(STUCK_TICK_FLOOR_MS, 3 * watched.intervalMs)) return false
    return databaseAlive(db)
  }

  const hub = createHub()
  const chat = createChatEngine({
    db,
    config,
    clock,
    hub,
    moderator,
    secondLayer: deps.model?.secondLayer,
    discipline: disciplineRecorder,
    speed,
    log,
  })
  const teacherAi =
    deps.model === undefined
      ? null
      : createTeacherAi({
          db,
          config,
          clock,
          hub,
          moderator,
          ...deps.model,
          speed,
          random: deps.random,
          log: { info: log, error: logError },
        })
  const questions: QuestionsDeps = {
    db,
    config,
    clock,
    hub,
    moderator,
    secondLayer: deps.model?.secondLayer,
    discipline: disciplineRecorder,
    teacherAi: teacherAi ?? undefined,
    random: deps.random,
    log,
  }
  const hooks: LessonHooks = {
    ...createLessonHooks({ db, config, clock, chat, questions, hub, teacherAi: teacherAi ?? undefined, log }),
    ...deps.hooks,
  }
  const runtime = createClassRuntime({ db, config, clock, hub, moderator, speed, hooks, log })

  const app = buildClassApp({
    db,
    config,
    moderator,
    clock,
    runtime,
    hub,
    hooks,
    // The two take different messages and seams (chat: `join`; questions: `resume`), so neither replaces the other's.
    handlers: { ...chatHandlers(chat), ...questionHandlers(questions), ...deps.handlers },
    helloTimeoutMs: deps.helloTimeoutMs,
    pingIntervalMs: deps.pingIntervalMs,
    rateWindowMs: deps.rateWindowMs,
    stopping: () => stopping,
    healthCheck: healthy,
    trustProxy: deps.trustProxy,
    logger: deps.logger,
  })

  return {
    app,
    hub,
    runtime,
    chat,
    questions,
    hooks,
    teacherAi,
    async tick() {
      // The runtime first: the close of a session ends its conversations as a dismissal. A failed tick of the runtime
      // does not hold up the conversations.
      let failure: { err: unknown } | null = null
      try {
        await runtime.tick()
      } catch (err) {
        failure = { err }
      }
      chat.tick()
      if (failure !== null) throw failure.err
    },
    disconnectAll() {
      stopping = true
      hub.disconnectAll(MAINTENANCE)
    },
    watchTicker(ticker, intervalMs) {
      watched = { ticker, intervalMs }
    },
  }
}

/**
 * How often the service ticks, in real milliseconds: a third of the time a session's close still runs live (see
 * `LIVE_TOLERANCE_MS`, which the speed divides), so a close the service was up for is never run quietly; a second at
 * most, and 20 ms at least.
 */
export function tickIntervalMs(speed: number): number {
  return Math.floor(Math.min(1000, Math.max(20, LIVE_TOLERANCE_MS / speed / 3)))
}

/**
 * Starts the service: one tick, then listening, then a tick on every interval. The first tick comes before anyone can
 * connect, so the sessions going on are open by then: a student back right after a restart is let in, not told that
 * the next lesson is tomorrow.
 *
 * A first tick that could not open or load the sessions fails the start, and nothing listens. One in which only the
 * steps of some classes failed does not: those classes are left behind, the others are taught, and every tick tries
 * the failed steps again (see `ClassStepError`). A class whose step keeps failing then keeps only itself from going
 * on, not the whole service from starting. Later failures are logged.
 */
export async function startClassService(
  service: Pick<ClassService, 'app' | 'tick'> & Partial<Pick<ClassService, 'watchTicker'>>,
  p: { port: number; host?: string; speed: number },
): Promise<Ticker> {
  const { app, tick } = service
  const logFailure = (err: unknown) => app.log.error({ err }, 'class tick failed')
  try {
    await tick()
  } catch (err) {
    if (!onlyClassStepsFailed(err)) throw err
    logFailure(err)
  }
  await app.listen({ port: p.port, host: p.host ?? '0.0.0.0' })
  const intervalMs = tickIntervalMs(p.speed)
  const ticker = startTicker(tick, intervalMs, logFailure)
  service.watchTicker?.(ticker, intervalMs)
  return ticker
}
