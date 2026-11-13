import type { FastifyInstance, FastifyServerOptions } from 'fastify'
import type { Kysely } from 'kysely'
import type { Llm } from '../llm/client.js'
import type { PromptName, PromptTemplate } from '../llm/prompts.js'
import type { Moderator } from '../moderation/moderator.js'
import type { SecondLayer } from '../moderation/second-layer.js'
import type { Clock } from '../shared/clock.js'
import type { SchoolConfig } from '../shared/config.js'
import { databaseAlive } from '../shared/healthz.js'
import type { MaintenanceWatch } from '../shared/maintenance.js'
import type { Database } from '../shared/schema.js'
import type { Switches } from '../shared/switches.js'
import { buildClassApp } from './app.js'
import { chatHandlers, createChatEngine, type ChatEngine } from './chat.js'
import { maintenanceClosing, SHUTTING_DOWN, type MessageHandlers } from './connection.js'
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
  /**
   * The maintenance switch, as the database says it is (see `startMaintenanceWatch`). When it comes on, everyone
   * connected is sent the `maintenance` `closing` and disconnected; while it is on, nobody comes in and the lesson
   * going on ends early (see `ClassRuntimeDeps.maintenance`). Unset: never on.
   */
  maintenance?: MaintenanceWatch
  /** Called for each unexpected error in a connection, to count it for the alert mails (see `ClassDeps`). */
  onInternalError?: () => void
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
  /** The interval, in real milliseconds: `tickIntervalMs` for the service's speed and the classes' stagger. */
  intervalMs: number
  /**
   * The service is stopping: tells every student connected so (`SHUTTING_DOWN`: the school is under maintenance,
   * reconnect later) and disconnects them. From then on nobody comes in (see `ClassDeps.stopping`).
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
 * the hooks and the app's handlers, as do the questions; the same hooks go to the runtime and to the app, and the
 * maintenance switch to the runtime, the app and the hub. Nothing runs until something calls `tick()`.
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

  const maintenance = () => deps.maintenance?.current() ?? null

  const hub = createHub()
  // Switched on, or its message or expected time changed while on: everyone still connected is sent home with what the
  // operator wrote. Nobody gets in while it is on, so after the first time the hub is empty.
  deps.maintenance?.onChange((now) => {
    if (now === null) return
    log({}, 'maintenance on, every connection closed')
    hub.disconnectAll(maintenanceClosing(now))
  })
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
  const intervalMs = tickIntervalMs(speed, config.lesson.staggerMillis)
  // A failed step is tried again about as often as at the usual pace, not at every one of the faster ticks.
  const ticksPerRetry = Math.max(1, Math.round(tickIntervalMs(speed) / intervalMs))
  const runtime = createClassRuntime({ db, config, clock, hub, moderator, speed, hooks, maintenance, ticksPerRetry, log })

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
    maintenance,
    healthCheck: healthy,
    trustProxy: deps.trustProxy,
    onInternalError: deps.onInternalError,
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
    intervalMs,
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
      hub.disconnectAll(SHUTTING_DOWN)
    },
    watchTicker(ticker, intervalMs) {
      watched = { ticker, intervalMs }
    },
  }
}

/** The ticks the service takes within the window the classes' steps are spread over (`lesson.staggerMillis`). */
const TICKS_PER_STAGGER = 10

/**
 * How often the service ticks, in real milliseconds: a third of the time a session's close still runs live (see
 * `LIVE_TOLERANCE_MS`, which the speed divides), so a close the service was up for is never run quietly; a second at
 * most, and 20 ms at least. With the classes staggered over `staggerMillis` (which the speed divides too), no more
 * than a tenth of that window: the steps the classes have at one moment then go out in about ten small groups across
 * the window, each class's near its own time, not in one or two big groups at the ticks that happen to fall in it.
 */
export function tickIntervalMs(speed: number, staggerMillis = 0): number {
  const live = LIVE_TOLERANCE_MS / speed / 3
  const stagger = staggerMillis > 0 ? staggerMillis / speed / TICKS_PER_STAGGER : Infinity
  return Math.floor(Math.min(1000, Math.max(20, Math.min(live, stagger))))
}

/**
 * Starts the service: one tick, then listening, then a tick on every interval. The first tick comes before anyone can
 * connect, so the sessions going on are open by then: a student back right after a restart is let in, not told that
 * the next lesson is tomorrow.
 *
 * A first tick that could not open or load the sessions fails the start, and nothing listens. One in which only the
 * steps of some classes failed does not: those classes are left behind, the others are taught, and the failed steps
 * are tried again at the ticks to come (see `ClassStepError`). A class whose step keeps failing then keeps only itself
 * from going on, not the whole service from starting. Later failures are logged. Every failure that is logged, this
 * one too, is reported to `onTickFailure`.
 *
 * The ticks come every `service.intervalMs`, or `tickIntervalMs(p.speed)` when the service does not say.
 */
export async function startClassService(
  service: Pick<ClassService, 'app' | 'tick'> & Partial<Pick<ClassService, 'watchTicker' | 'intervalMs'>>,
  p: { port: number; host?: string; speed: number; onTickFailure?: () => void },
): Promise<Ticker> {
  const { app, tick } = service
  const logFailure = (err: unknown) => {
    app.log.error({ err }, 'class tick failed')
    // Counted for the alert mails; counting must not stop the next tick.
    try {
      p.onTickFailure?.()
    } catch {
      // Nothing to do about it here.
    }
  }
  try {
    await tick()
  } catch (err) {
    if (!onlyClassStepsFailed(err)) throw err
    logFailure(err)
  }
  await app.listen({ port: p.port, host: p.host ?? '0.0.0.0' })
  const intervalMs = service.intervalMs ?? tickIntervalMs(p.speed)
  const ticker = startTicker(tick, intervalMs, logFailure)
  service.watchTicker?.(ticker, intervalMs)
  return ticker
}
