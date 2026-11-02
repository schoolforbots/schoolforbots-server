import { readFileSync } from 'node:fs'
import { Type, type Static } from 'typebox'
import { Value } from 'typebox/value'

export type Division = 'primary' | 'junior' | 'senior'
export type Slot = 'morning' | 'afternoon' | 'evening'

const PositiveInt = Type.Integer({ minimum: 1 })
const NonNegativeInt = Type.Integer({ minimum: 0 })
const TimeOfDay = Type.String({ pattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$' })
const SlotConfig = Type.Object({ label: Type.String({ minLength: 1 }), start: TimeOfDay, end: TimeOfDay })
const DivisionConfig = Type.Object({ label: Type.String({ minLength: 1 }) })

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
    // The teacher calls on a student after this segment (1-based); the next segment is the answer deadline.
    callOnAfterSegment: PositiveInt,
    maxQuestionsPerLesson: NonNegativeInt,
    // Whether lessons are held on Saturdays and Sundays too.
    weekendStudy: Type.Boolean(),
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
})

export type SchoolConfig = Static<typeof SchoolConfigSchema>

function pointerToPath(pointer: string): string {
  if (pointer === '') return '(root)'
  return pointer
    .slice(1)
    .split('/')
    .map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'))
    .join('.')
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

  const config = raw as SchoolConfig
  const crossFieldProblems: string[] = []
  if (config.classSize.max < config.classSize.standard) {
    crossFieldProblems.push(
      `classSize.max: must be >= classSize.standard (${config.classSize.max} < ${config.classSize.standard})`,
    )
  }

  const { segmentMinutes, dismissalMinute, callOnAfterSegment } = config.lesson
  if (segmentMinutes.some((minute, i) => i > 0 && minute <= (segmentMinutes[i - 1] ?? 0))) {
    crossFieldProblems.push(`lesson.segmentMinutes: must be strictly increasing (${segmentMinutes.join(', ')})`)
  }
  if (segmentMinutes.some((minute) => minute >= dismissalMinute)) {
    crossFieldProblems.push(
      `lesson.segmentMinutes: every segment must come before lesson.dismissalMinute (${segmentMinutes.join(', ')} vs ${dismissalMinute})`,
    )
  }
  // The call-on needs a next segment: its start is the deadline for the student's answer.
  if (callOnAfterSegment > segmentMinutes.length - 1) {
    crossFieldProblems.push(
      `lesson.callOnAfterSegment: must be between 1 and ${segmentMinutes.length - 1} (the number of segments minus one), got ${callOnAfterSegment}`,
    )
  }

  if (crossFieldProblems.length > 0) {
    throw new Error(`Invalid school config ${path}:\n  ${crossFieldProblems.join('\n  ')}`)
  }
  return config
}

/** How verification codes leave: by SMTP, or (development only) printed to the service log. */
export type MailEnv = { transport: 'smtp'; smtpUrl: string } | { transport: 'console' }

export interface Env {
  databaseUrl: string
  mail: MailEnv
  mailFrom: string
  moderationDataDir: string
  configPath: string
  registrationPort: number
  trustProxy: boolean
  classPort: number
  /** Playback speed of a lesson's timeline (1 = real time). Only for local development: plays a lesson compressed. */
  classTimelineSpeed: number
}

/** What the class service reads from the environment: what it uses, and no mail settings, which it never does. */
export type ClassEnv = Pick<Env, 'databaseUrl' | 'moderationDataDir' | 'configPath' | 'classPort' | 'classTimelineSpeed'>

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

function parseTimelineSpeed(get: Get): number {
  const speedRaw = get('CLASS_TIMELINE_SPEED')
  const speed = speedRaw === undefined ? 1 : Number(speedRaw)
  if (!Number.isFinite(speed) || speed < 1 || speed > 600) {
    throw new Error(`Invalid CLASS_TIMELINE_SPEED: ${speedRaw} (expected a number from 1 to 600)`)
  }
  return speed
}

const moderationDataDirOf = (get: Get) => get('MODERATION_DATA_DIR') ?? 'data/moderation'
const configPathOf = (get: Get) => get('SCHOOL_CONFIG') ?? 'config/school.json'
const classPortOf = (get: Get) => parsePort('CLASS_PORT', get('CLASS_PORT'), 8081)

/** The environment of the class service, read as `loadEnv` reads the same variables. */
export function loadClassEnv(env: NodeJS.ProcessEnv): ClassEnv {
  const get = getter(env)
  const databaseUrl = requireDatabaseUrl(get)
  const classPort = classPortOf(get)
  const classTimelineSpeed = parseTimelineSpeed(get)
  return {
    databaseUrl,
    moderationDataDir: moderationDataDirOf(get),
    configPath: configPathOf(get),
    classPort,
    classTimelineSpeed,
  }
}

/** The environment of the registration service and the tools. */
export function loadEnv(env: NodeJS.ProcessEnv): Env {
  const get = getter(env)

  const databaseUrl = requireDatabaseUrl(get)

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

  return {
    databaseUrl,
    mail,
    mailFrom: get('MAIL_FROM') ?? '机器人网校 <no-reply@example.com>',
    moderationDataDir: moderationDataDirOf(get),
    configPath: configPathOf(get),
    registrationPort,
    trustProxy: get('TRUST_PROXY') === '1',
    classPort,
    classTimelineSpeed,
  }
}
