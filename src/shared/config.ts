import { readFileSync } from 'node:fs'
import { Type, type Static } from 'typebox'
import { Value } from 'typebox/value'
import { isDateText } from './local-time.js'

export type Division = 'primary' | 'junior' | 'senior'
export type Slot = 'morning' | 'afternoon' | 'evening'

const PositiveInt = Type.Integer({ minimum: 1 })
const NonNegativeInt = Type.Integer({ minimum: 0 })
const TimeOfDay = Type.String({ pattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$' })
// The shape only; whether it is a real calendar date (not 30 February) is checked after loading, with isDateText.
const DateText = Type.String({ pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' })
// What a teacher says, one sentence per item.
const Speech = Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })
const SlotConfig = Type.Object({ label: Type.String({ minLength: 1 }), start: TimeOfDay, end: TimeOfDay })
const DivisionConfig = Type.Object({ label: Type.String({ minLength: 1 }) })
const CallOn = Type.Object({
  kind: Type.Union([Type.Literal('review'), Type.Literal('extension')]),
  afterSegment: PositiveInt,
})
// Yuan per million tokens. Input that hit the vendor's cache is charged at the cached price, or at the input price
// when none is given.
const Rates = {
  inputYuanPerMillion: Type.Number({ minimum: 0 }),
  outputYuanPerMillion: Type.Number({ minimum: 0 }),
  cachedInputYuanPerMillion: Type.Optional(Type.Number({ minimum: 0 })),
}
// Another set of prices for some hours on some weekdays (1 is Monday, 7 is Sunday), `from` included and `to` excluded,
// in the school's timezone. A window cannot cross midnight: write it as two.
const PriceWindow = Type.Object({
  ...Rates,
  weekdays: Type.Array(Type.Integer({ minimum: 1, maximum: 7 }), { minItems: 1 }),
  from: TimeOfDay,
  to: TimeOfDay,
})
const Price = Type.Object({ ...Rates, windows: Type.Optional(Type.Array(PriceWindow)) })
export type ModelPrice = Static<typeof Price>
const Provider = Type.Object({
  kind: Type.Literal('openai-compatible'),
  baseUrl: Type.String({ minLength: 1 }),
  // The name of the environment variable holding the key; the key itself never goes in the config.
  apiKeyEnv: Type.String({ minLength: 1 }),
  models: Type.Record(Type.String({ minLength: 1 }), Price),
  // Phrases in a provider's error reply that mean it refused the content, so that is told from a failure.
  contentRefusalMarkers: Type.Array(Type.String({ minLength: 1 })),
  // Extra fields merged into every chat/completions request body, for vendors that need them (for example to switch
  // off a reasoning mode). The fields the school itself sets always win over these.
  requestExtras: Type.Optional(Type.Record(Type.String({ minLength: 1 }), Type.Unknown())),
})
const Purpose = Type.Object({ provider: Type.String({ minLength: 1 }), model: Type.String({ minLength: 1 }) })

/** What the model is used for; each purpose picks its own provider and model. */
export const LLM_PURPOSES = [
  'lesson',
  'answer',
  'comment',
  'weekly',
  'secondLayerTeacher',
  'secondLayerChat',
  'wordList',
] as const

/** What a speech may name, written in braces: the teacher, the class, the division and the number of students. */
const SPEECH_PLACEHOLDERS = ['teacher', 'className', 'division', 'classSize']
const braced = (names: string[]) => names.map((name) => `{${name}}`).join(', ')

/** `count` times within `minutes` minutes. */
const CountInMinutes = Type.Object({ count: PositiveInt, minutes: PositiveInt })
// When the operator is mailed. Every field may be left out and then has its default (see `DEFAULT_ALERTS`).
const AlertsSchema = Type.Object({
  // A kind of alert is mailed at most once in this long.
  repeatAfterMinutes: Type.Optional(PositiveInt),
  internalErrors: Type.Optional(CountInMinutes),
  // The model has failed every call, at least three, for this long.
  llmDownMinutes: Type.Optional(PositiveInt),
  // Calls the vendor refused with HTTP 400 in an hour.
  llm400PerHour: Type.Optional(PositiveInt),
  mailFailures: Type.Optional(CountInMinutes),
  restarts: Type.Optional(CountInMinutes),
  // How often the mail service is tried (a connection check) for `GET /healthz/mail`, in minutes.
  mailCheckMinutes: Type.Optional(PositiveInt),
  // Whether backups are expected at all: turn it on for the real school.
  backupExpected: Type.Optional(Type.Boolean()),
  backupMaxAgeHours: Type.Optional(PositiveInt),
  diskPercent: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
})

export interface AlertsConfig {
  repeatAfterMinutes: number
  internalErrors: { count: number; minutes: number }
  llmDownMinutes: number
  llm400PerHour: number
  mailFailures: { count: number; minutes: number }
  restarts: { count: number; minutes: number }
  mailCheckMinutes: number
  backupExpected: boolean
  backupMaxAgeHours: number
  diskPercent: number
}

export const DEFAULT_ALERTS: AlertsConfig = {
  repeatAfterMinutes: 60,
  internalErrors: { count: 20, minutes: 5 },
  llmDownMinutes: 10,
  llm400PerHour: 5,
  mailFailures: { count: 3, minutes: 10 },
  restarts: { count: 3, minutes: 10 },
  mailCheckMinutes: 10,
  backupExpected: false,
  backupMaxAgeHours: 26,
  diskPercent: 80,
}

export const SchoolConfigSchema = Type.Object({
  timezone: Type.String({ minLength: 1 }),
  classSize: Type.Object({ standard: PositiveInt, max: PositiveInt }),
  slotCapacity: PositiveInt,
  maxStudentsPerEmail: PositiveInt,
  registrationsPerIpPerDay: PositiveInt,
  nameMaxChars: PositiveInt,
  renameCooldownDays: Type.Integer({ minimum: 0 }),
  inactivityDropDays: PositiveInt,
  verificationCode: Type.Object({
    ttlMinutes: PositiveInt,
    maxAttempts: PositiveInt,
    resendSeconds: Type.Integer({ minimum: 0 }),
    // Failed key-reset guesses allowed per (student id, email) pair in any 24 hours, summed over all its reset requests.
    keyResetDailyFailureCap: PositiveInt,
    // Code mails per address in any 24 hours: registrations per email, and key resets per (student id, email) pair.
    dailyMailCapPerAddress: PositiveInt,
  }),
  // Per IP, for all routes together that have no limit of their own.
  httpRateLimitPerMinute: PositiveInt,
  // Per IP and per route, for each route that sends or checks a code (registration, key reset, and their verify).
  codeRouteRateLimitPerMinute: PositiveInt,
  slots: Type.Object({ morning: SlotConfig, afternoon: SlotConfig, evening: SlotConfig }),
  divisions: Type.Object({ primary: DivisionConfig, junior: DivisionConfig, senior: DivisionConfig }),
  teacherPersonas: Type.Array(
    Type.Object({
      id: Type.String({ pattern: '^[a-z0-9]+(-[a-z0-9]+)*$' }),
      name: Type.String({ minLength: 1 }),
      personality: Type.String({ minLength: 1 }),
    }),
    { minItems: 1 },
  ),
  // One class session. Minutes count from the start of the slot (minute 0 is the opening).
  lesson: Type.Object({
    // The doors open this long before the slot starts, so students can connect early.
    doorsOpenMinutesBefore: NonNegativeInt,
    // The minute each segment of the lesson body is pushed. Strictly increasing, all before dismissalMinute.
    segmentMinutes: Type.Array(PositiveInt, { minItems: 1, maxItems: 10 }),
    dismissalMinute: PositiveInt,
    // After dismissal, conversations still going get this long to say their last line.
    closingGraceSeconds: NonNegativeInt,
    // The teacher calls on a student after each of these segments (1-based); the next segment is the answer deadline.
    // Two calls on never come after the same segment.
    callOns: Type.Array(CallOn, { minItems: 1 }),
    maxQuestionsPerLesson: NonNegativeInt,
    // Whether Saturdays and Sundays have study halls that look back on the week; without them the weekend is a holiday.
    weekendStudy: Type.Boolean(),
  }),
  // One WebSocket connection to the class service: how fast it may send, and how much may wait, either way.
  classConnection: Type.Object({
    // Frames the connection may send in any minute, every one counted (hello, invalid frames and lines the moderator
    // stops too). Past it, a frame is answered `rate_limited` and not handled.
    framesPerMinute: PositiveInt,
    // Frames the connection may have waiting to be handled, one at a time. Past it, the connection is closed (1008).
    maxQueuedFrames: PositiveInt,
    // What may wait to go out to the connection, in KiB: a client that reads this far behind is dropped.
    maxSendBufferKiB: PositiveInt,
  }),
  chat: Type.Object({
    maxInitiationsPerLesson: NonNegativeInt,
    maxRoundsPerConversation: PositiveInt,
    maxMessageChars: PositiveInt,
    // New students are in probation for their first lessons.
    probationLessons: NonNegativeInt,
    replyTimeoutSeconds: PositiveInt,
  }),
  // Violation counts within a rolling window of days trigger each step.
  discipline: Type.Object({
    parentNotice: Type.Object({ classRuleCount: PositiveInt, windowDays: PositiveInt }),
    suspension: Type.Object({ schoolRuleCount: PositiveInt, windowDays: PositiveInt, days: PositiveInt }),
    expulsion: Type.Object({ schoolRuleCount: PositiveInt, windowDays: PositiveInt, banDays: PositiveInt }),
  }),
  messageRetentionDays: PositiveInt,
  alerts: Type.Optional(AlertsSchema),
  llm: Type.Object({
    providers: Type.Record(Type.String({ minLength: 1 }), Provider),
    purposes: Type.Object({
      lesson: Purpose,
      answer: Purpose,
      comment: Purpose,
      weekly: Purpose,
      secondLayerTeacher: Purpose,
      secondLayerChat: Purpose,
      wordList: Purpose,
    }),
    timeoutSeconds: PositiveInt,
    retries: NonNegativeInt,
    // The most model calls in flight at once in each service (sign-up and classes are separate processes, each with its
    // own count); more wait in line.
    maxConcurrent: PositiveInt,
    monthlyBudgetYuan: Type.Number({ minimum: 0 }),
  }),
  lessonGeneration: Type.Object({
    // `api` has the model write the lessons; `manual` leaves them to be pasted in.
    mode: Type.Union([Type.Literal('api'), Type.Literal('manual')]),
    // Lessons are made for the school days among this many days after today.
    horizonDays: PositiveInt,
    // A pasted lesson is due when this many school days are left before the class.
    manualDeadlineSchoolDays: PositiveInt,
    retryMinutes: PositiveInt,
    // The time one lesson call may take, new or rewritten. A whole lesson is a long reply, so it gets longer than
    // llm.timeoutSeconds.
    timeoutSeconds: PositiveInt,
    // What a lesson should be like, one point per item; goes into the lesson prompt.
    direction: Type.Array(Type.String({ minLength: 1 })),
  }),
  teacherAi: Type.Object({
    // How many of the students' questions the teacher picks the answer from.
    questionSampleSize: PositiveInt,
    // The answer starts this long before the next segment.
    answerLeadSeconds: PositiveInt,
    commentTimeoutSeconds: PositiveInt,
  }),
  secondLayer: Type.Object({
    // 'off' turns the second layer off for good; the runtime switches only matter when it is 'llm'.
    implementation: Type.Union([Type.Literal('off'), Type.Literal('llm')]),
    // Lines wait this long to be checked together.
    batchMillis: PositiveInt,
    timeoutSeconds: PositiveInt,
  }),
  // The runtime switches' starting values, used until an operator changes one.
  switchDefaults: Type.Object({
    teacherLlm: Type.Boolean(),
    secondLayerTeacher: Type.Boolean(),
    secondLayerChat: Type.Boolean(),
  }),
  switchRefreshSeconds: PositiveInt,
  // How far back a discipline record can be revoked.
  revocationWindowDays: PositiveInt,
  // Without a calendar the school has always been open and never takes a break.
  calendar: Type.Optional(
    Type.Object({
      // The first day of school. Before it the school counts as on break (registration goes on); without one, the
      // school counts as open from the start. It stays after the opening, as past breaks do: the count of days toward
      // `inactivityDropDays` reads them (see `inactivityCutoffDay`).
      openingDay: Type.Optional(DateText),
      // The teacher's speech on the first school day on or after the opening day, one sentence per item.
      openingSpeech: Type.Optional(Speech),
      // A break covers `from` and every day up to the day before `reopensOn`, the day the school is back; null means
      // that is not decided yet, which only the last break may say.
      breaks: Type.Array(
        Type.Object({
          from: DateText,
          reopensOn: Type.Union([DateText, Type.Null()]),
          name: Type.Optional(Type.String({ minLength: 1 })),
          // The teacher's speech on the first school day after the break.
          speech: Type.Optional(Speech),
        }),
      ),
    }),
  ),
})

/** The config as loaded: `alerts` is always there, with the defaults for whatever the file left out. */
export type SchoolConfig = Omit<Static<typeof SchoolConfigSchema>, 'alerts'> & { alerts: AlertsConfig }

function pointerToPath(pointer: string): string {
  if (pointer === '') return '(root)'
  return pointer
    .slice(1)
    .split('/')
    .map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'))
    .join('.')
}

/** What is wrong with the school calendar that the schema cannot say, one text per problem. */
function calendarProblems(calendar: NonNullable<SchoolConfig['calendar']>): string[] {
  const problems: string[] = []
  const realDate = (path: string, text: string): boolean => {
    if (isDateText(text)) return true
    problems.push(`${path}: not a real calendar date (${text})`)
    return false
  }

  const { openingDay } = calendar
  const openingDayIsReal = openingDay === undefined || realDate('calendar.openingDay', openingDay)

  // Only breaks with real dates, that end after they start, can be put in order and compared with each other.
  const sound: Array<{ from: string; reopensOn: string | null }> = []
  calendar.breaks.forEach((b, i) => {
    const path = `calendar.breaks.${i}`
    const fromIsReal = realDate(`${path}.from`, b.from)
    const reopensOnIsReal = b.reopensOn === null || realDate(`${path}.reopensOn`, b.reopensOn)
    if (!fromIsReal || !reopensOnIsReal) return
    if (b.reopensOn !== null && b.reopensOn <= b.from) {
      problems.push(`${path}.reopensOn: must be later than from (${b.reopensOn} <= ${b.from})`)
      return
    }
    if (openingDay !== undefined && openingDayIsReal && b.from < openingDay) {
      problems.push(`${path}.from: must not be before calendar.openingDay (${b.from} < ${openingDay})`)
    }
    sound.push(b)
  })

  const byStart = [...sound].sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0))
  byStart.forEach((b, i) => {
    const next = byStart[i + 1]
    if (next === undefined) return
    if (b.reopensOn === null) {
      problems.push(
        `calendar.breaks: only the last break may have reopensOn null (the break from ${b.from} is followed by one from ${next.from})`,
      )
    } else if (b.reopensOn > next.from) {
      problems.push(
        `calendar.breaks: breaks must not overlap (the break from ${b.from} to ${b.reopensOn} runs into the one from ${next.from})`,
      )
    }
  })

  const speeches: Array<[path: string, sentences: string[] | undefined]> = [
    ['calendar.openingSpeech', calendar.openingSpeech],
    ...calendar.breaks.map((b, i): [string, string[] | undefined] => [`calendar.breaks.${i}.speech`, b.speech]),
  ]
  for (const [path, sentences] of speeches) {
    sentences?.forEach((sentence, i) => {
      const names = Array.from(sentence.matchAll(/\{([^{}]*)\}/g), (m) => m[1] ?? '')
      const unknown = [...new Set(names)].filter((name) => !SPEECH_PLACEHOLDERS.includes(name))
      if (unknown.length > 0) {
        problems.push(`${path}.${i}: unknown placeholder ${braced(unknown)} (known: ${braced(SPEECH_PLACEHOLDERS)})`)
      }
    })
  }
  return problems
}

export function loadSchoolConfig(path: string): SchoolConfig {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    throw new Error(`Cannot read school config ${path}: ${(err as Error).message}`)
  }

  const problems = Value.Errors(SchoolConfigSchema, raw).map(
    (e) => `${pointerToPath(e.instancePath)}: ${e.message}`,
  )
  if (problems.length > 0) {
    throw new Error(`Invalid school config ${path}:\n  ${problems.join('\n  ')}`)
  }

  const parsed = raw as Static<typeof SchoolConfigSchema>
  const config: SchoolConfig = { ...parsed, alerts: { ...DEFAULT_ALERTS, ...parsed.alerts } }
  const crossFieldProblems: string[] = []
  if (config.classSize.max < config.classSize.standard) {
    crossFieldProblems.push(
      `classSize.max: must be >= classSize.standard (${config.classSize.max} < ${config.classSize.standard})`,
    )
  }

  const { segmentMinutes, dismissalMinute, callOns } = config.lesson
  if (segmentMinutes.some((minute, i) => i > 0 && minute <= (segmentMinutes[i - 1] ?? 0))) {
    crossFieldProblems.push(`lesson.segmentMinutes: must be strictly increasing (${segmentMinutes.join(', ')})`)
  }
  if (segmentMinutes.some((minute) => minute >= dismissalMinute)) {
    crossFieldProblems.push(
      `lesson.segmentMinutes: every segment must come before lesson.dismissalMinute (${segmentMinutes.join(', ')} vs ${dismissalMinute})`,
    )
  }
  // A call-on needs a next segment: its start is the deadline for the student's answer. A lesson has one question of
  // each kind, so two call-ons of the same kind would ask it twice.
  const seenSegments = new Set<number>()
  const seenKinds = new Set<string>()
  callOns.forEach((callOn, i) => {
    if (seenKinds.has(callOn.kind)) {
      crossFieldProblems.push(`lesson.callOns.${i}.kind: two call-ons must not be of the same kind (${callOn.kind})`)
    }
    seenKinds.add(callOn.kind)
    const path = `lesson.callOns.${i}.afterSegment`
    if (callOn.afterSegment > segmentMinutes.length - 1) {
      crossFieldProblems.push(
        `${path}: must be between 1 and ${segmentMinutes.length - 1} (the number of segments minus one), got ${callOn.afterSegment}`,
      )
    }
    if (seenSegments.has(callOn.afterSegment)) {
      crossFieldProblems.push(`${path}: two calls on must not come after the same segment (${callOn.afterSegment})`)
    }
    seenSegments.add(callOn.afterSegment)
  })

  const { providers, purposes } = config.llm
  for (const purpose of LLM_PURPOSES) {
    const { provider, model } = purposes[purpose]
    const found = providers[provider]
    if (found === undefined) {
      crossFieldProblems.push(`llm.purposes.${purpose}.provider: no such provider in llm.providers (${provider})`)
    } else if (found.models[model] === undefined) {
      crossFieldProblems.push(`llm.purposes.${purpose}.model: provider ${provider} has no model ${model}`)
    }
  }

  for (const [providerName, provider] of Object.entries(providers)) {
    for (const [modelName, price] of Object.entries(provider.models)) {
      price.windows?.forEach((window, i) => {
        const path = `llm.providers.${providerName}.models.${modelName}.windows[${i}]`
        if (window.from >= window.to) {
          crossFieldProblems.push(`${path}: from must be before to (${window.from} >= ${window.to}); a window across midnight is written as two`)
        }
        if (new Set(window.weekdays).size !== window.weekdays.length) {
          crossFieldProblems.push(`${path}: weekdays must not repeat a day (${window.weekdays.join(', ')})`)
        }
      })
    }
  }

  // The answer starts this long before the next segment, so it has to fit in the shortest one.
  const segmentEnds = [...segmentMinutes.slice(1), dismissalMinute]
  const shortestSegmentSeconds = Math.min(...segmentEnds.map((end, i) => (end - (segmentMinutes[i] ?? 0)) * 60))
  if (config.teacherAi.answerLeadSeconds >= shortestSegmentSeconds) {
    crossFieldProblems.push(
      `teacherAi.answerLeadSeconds: must be shorter than the shortest segment (${shortestSegmentSeconds} seconds), got ${config.teacherAi.answerLeadSeconds}`,
    )
  }

  if (config.calendar !== undefined) crossFieldProblems.push(...calendarProblems(config.calendar))

  if (crossFieldProblems.length > 0) {
    throw new Error(`Invalid school config ${path}:\n  ${crossFieldProblems.join('\n  ')}`)
  }
  return config
}

/** How verification codes leave: by SMTP, or (development only) printed to the service log. */
export type MailEnv = { transport: 'smtp'; smtpUrl: string } | { transport: 'console' }

/**
 * How long one statement may run, and wait for a lock, before Postgres cancels it, in milliseconds. A query stuck
 * on a lock or running away would otherwise hold its pool connection for good. 0 sets none (the database's own
 * setting then applies, which is none unless it says otherwise).
 */
export interface DatabaseTimeouts {
  statementMs: number
  lockMs: number
}

export const DEFAULT_DATABASE_TIMEOUTS: DatabaseTimeouts = { statementMs: 30_000, lockMs: 10_000 }

export interface Env {
  databaseUrl: string
  databaseTimeouts: DatabaseTimeouts
  mail: MailEnv
  mailFrom: string
  moderationDataDir: string
  configPath: string
  /** Where the school rules are, one file per version (see school-rules.ts). Only the registration service reads them. */
  schoolRulesDir: string
  registrationPort: number
  /** Whether the services run behind a reverse proxy whose X-Forwarded-For can be trusted to name the client. */
  trustProxy: boolean
  classPort: number
  /**
   * Playback speed of a lesson's timeline (1 = real time). Only for local development: plays a lesson compressed.
   * With `NODE_ENV=production` it must be 1.
   */
  classTimelineSpeed: number
  /** Where the prompt files are, one per purpose. */
  promptsDir: string
  /** Where the notice goes when the monthly budget is used up; null means it is only shown on the admin page. */
  operatorEmail: string | null
  /**
   * The admin pages: the path they are served under, the password hash and the TOTP secret. Null (no admin pages)
   * unless all three variables are set. Each provider's key is read from the variable its `apiKeyEnv` names, when the
   * provider is set up, not here.
   */
  admin: { path: string; passwordHash: string; totpSecret: string } | null
  /** Answers every model call with a canned reply. Only for local development; with `NODE_ENV=production` it is refused. */
  llmFake: boolean
}

/** What the class service reads from the environment: what it uses, and no mail settings, which it never does. */
export type ClassEnv = Pick<
  Env,
  | 'databaseUrl'
  | 'databaseTimeouts'
  | 'moderationDataDir'
  | 'configPath'
  | 'trustProxy'
  | 'classPort'
  | 'classTimelineSpeed'
  | 'promptsDir'
  | 'llmFake'
>

type Get = (name: string) => string | undefined

function getter(env: NodeJS.ProcessEnv): Get {
  // An empty value (e.g. a bare `SMTP_URL=` copied from .env.example) counts as unset.
  return (name) => env[name] || undefined
}

function parsePort(name: string, raw: string | undefined, fallback: number): number {
  const port = raw === undefined ? fallback : Number(raw)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid ${name}: ${raw}`)
  return port
}

function requireDatabaseUrl(get: Get): string {
  const databaseUrl = get('DATABASE_URL')
  if (databaseUrl === undefined) throw new Error('Missing required environment variable DATABASE_URL')
  return databaseUrl
}

function parseTimeoutMs(name: string, raw: string | undefined, fallback: number): number {
  const ms = raw === undefined ? fallback : Number(raw)
  // Postgres takes at most 2^31 - 1 milliseconds (about 24 days).
  if (!Number.isInteger(ms) || ms < 0 || ms > 2_147_483_647) {
    throw new Error(`Invalid ${name}: ${raw} (expected a whole number of milliseconds, 0 for none)`)
  }
  return ms
}

function databaseTimeoutsOf(get: Get): DatabaseTimeouts {
  return {
    statementMs: parseTimeoutMs(
      'DATABASE_STATEMENT_TIMEOUT_MS',
      get('DATABASE_STATEMENT_TIMEOUT_MS'),
      DEFAULT_DATABASE_TIMEOUTS.statementMs,
    ),
    lockMs: parseTimeoutMs('DATABASE_LOCK_TIMEOUT_MS', get('DATABASE_LOCK_TIMEOUT_MS'), DEFAULT_DATABASE_TIMEOUTS.lockMs),
  }
}

function parseTimelineSpeed(get: Get): number {
  const speedRaw = get('CLASS_TIMELINE_SPEED')
  const speed = speedRaw === undefined ? 1 : Number(speedRaw)
  if (!Number.isFinite(speed) || speed < 1 || speed > 600) {
    throw new Error(`Invalid CLASS_TIMELINE_SPEED: ${speedRaw} (expected a number from 1 to 600)`)
  }
  // A compressed lesson in production would rush every class through its lesson in a few minutes.
  if (speed !== 1 && get('NODE_ENV') === 'production') {
    throw new Error(
      `CLASS_TIMELINE_SPEED=${speedRaw} is for local development only: with NODE_ENV=production it must be 1 (or unset)`,
    )
  }
  return speed
}

const moderationDataDirOf = (get: Get) => get('MODERATION_DATA_DIR') ?? 'data/moderation'
const configPathOf = (get: Get) => get('SCHOOL_CONFIG') ?? 'config/school.json'
const classPortOf = (get: Get) => parsePort('CLASS_PORT', get('CLASS_PORT'), 8081)
const trustProxyOf = (get: Get) => get('TRUST_PROXY') === '1'
const promptsDirOf = (get: Get) => get('PROMPTS_DIR') ?? 'data/prompts'

/** The environment of the class service, read as `loadEnv` reads the same variables. */
export function loadClassEnv(env: NodeJS.ProcessEnv): ClassEnv {
  const get = getter(env)
  const databaseUrl = requireDatabaseUrl(get)
  const databaseTimeouts = databaseTimeoutsOf(get)
  const classPort = classPortOf(get)
  const classTimelineSpeed = parseTimelineSpeed(get)
  const llmFake = parseLlmFake(get)
  return {
    databaseUrl,
    databaseTimeouts,
    moderationDataDir: moderationDataDirOf(get),
    configPath: configPathOf(get),
    trustProxy: trustProxyOf(get),
    classPort,
    classTimelineSpeed,
    promptsDir: promptsDirOf(get),
    llmFake,
  }
}

function parseAdmin(get: Get, warn: (message: string) => void): Env['admin'] {
  const path = get('ADMIN_PATH')
  const passwordHash = get('ADMIN_PASSWORD_HASH')
  const totpSecret = get('ADMIN_TOTP_SECRET')
  if (path !== undefined && (!path.startsWith('/') || path.startsWith('/v1'))) {
    throw new Error(`Invalid ADMIN_PATH: it must start with / and must not start with /v1`)
  }
  if (path === undefined || passwordHash === undefined || totpSecret === undefined) {
    const missing = [
      ['ADMIN_PATH', path],
      ['ADMIN_PASSWORD_HASH', passwordHash],
      ['ADMIN_TOTP_SECRET', totpSecret],
    ].filter(([, value]) => value === undefined)
    // Nothing set is the ordinary case of a service with no admin pages; only some set looks like a mistake.
    if (missing.length < 3) {
      warn(`The admin pages are off: ${missing.map(([name]) => name).join(', ')} not set (all three of ADMIN_PATH, ADMIN_PASSWORD_HASH and ADMIN_TOTP_SECRET are needed)`)
    }
    return null
  }
  return { path, passwordHash, totpSecret }
}

function parseLlmFake(get: Get): boolean {
  const fake = get('LLM_FAKE') === '1'
  if (fake && get('NODE_ENV') === 'production') {
    throw new Error('LLM_FAKE=1 is for local development only: with NODE_ENV=production it must not be set')
  }
  return fake
}

/**
 * `MAIL_FROM` must be one sender address, bare (`a@b.c`) or with a name (`name <a@b.c>`), with no line break, `<` or
 * `>` inside the address: the mailer refuses such a sender on every send, which would fail every verification mail.
 * Checked here with a simple pattern of our own (not nodemailer's address parser, which accepts leniently what its
 * sender check then refuses), so a malformed value stops the start.
 */
function parseMailFrom(value: string): string {
  const bad = () =>
    new Error(`Invalid MAIL_FROM: ${JSON.stringify(value)} (expected one address, as a@b.c or name <a@b.c>, with no line break, < or > inside it)`)
  if (/[\r\n]/.test(value)) throw bad()
  const named = /^[^<>]*<([^<>\s@]+@[^<>\s@]+)>$/.exec(value.trim())
  const bare = /^[^<>\s@]+@[^<>\s@]+$/.test(value.trim())
  if (!named && !bare) throw bad()
  return value
}

/**
 * The environment of the registration service and the tools. `warn` takes the notices that do not stop the start
 * (a half-set admin configuration).
 */
export function loadEnv(env: NodeJS.ProcessEnv, warn: (message: string) => void = console.warn): Env {
  const get = getter(env)

  const databaseUrl = requireDatabaseUrl(get)
  const databaseTimeouts = databaseTimeoutsOf(get)

  // Codes are printed instead of mailed only when MAIL_TRANSPORT=console says so: a missing SMTP_URL must not
  // quietly turn a deployment into one that mails nobody and writes the codes to its log.
  const transport = get('MAIL_TRANSPORT') ?? 'smtp'
  let mail: MailEnv
  if (transport === 'console') {
    mail = { transport }
  } else if (transport === 'smtp') {
    const smtpUrl = get('SMTP_URL')
    if (smtpUrl === undefined) {
      throw new Error(
        'Missing SMTP_URL: verification codes are mailed by SMTP (MAIL_TRANSPORT=smtp, the default). ' +
          'Set SMTP_URL, or set MAIL_TRANSPORT=console to print the codes to the log instead (local development only).',
      )
    }
    mail = { transport, smtpUrl }
  } else {
    throw new Error(`Invalid MAIL_TRANSPORT: ${transport} (expected smtp or console)`)
  }

  const registrationPort = parsePort('REGISTRATION_PORT', get('REGISTRATION_PORT'), 8080)
  const classPort = classPortOf(get)
  const classTimelineSpeed = parseTimelineSpeed(get)
  const admin = parseAdmin(get, warn)
  const llmFake = parseLlmFake(get)

  return {
    databaseUrl,
    databaseTimeouts,
    mail,
    mailFrom: parseMailFrom(get('MAIL_FROM') ?? '机器人网校 <no-reply@example.com>'),
    moderationDataDir: moderationDataDirOf(get),
    configPath: configPathOf(get),
    schoolRulesDir: get('SCHOOL_RULES_DIR') ?? 'school-rules',
    registrationPort,
    trustProxy: trustProxyOf(get),
    classPort,
    classTimelineSpeed,
    promptsDir: promptsDirOf(get),
    operatorEmail: get('OPERATOR_EMAIL') ?? null,
    admin,
    llmFake,
  }
}
