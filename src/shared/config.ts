import { readFileSync } from 'node:fs'
import { Type, type Static } from 'typebox'
import { Value } from 'typebox/value'

export type Division = 'primary' | 'junior' | 'senior'
export type Slot = 'morning' | 'afternoon' | 'evening'

const PositiveInt = Type.Integer({ minimum: 1 })
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
  if (config.classSize.max < config.classSize.standard) {
    throw new Error(
      `Invalid school config ${path}:\n  classSize.max: must be >= classSize.standard (${config.classSize.max} < ${config.classSize.standard})`,
    )
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
}

export function loadEnv(env: NodeJS.ProcessEnv): Env {
  // An empty value (e.g. a bare `SMTP_URL=` copied from .env.example) counts as unset.
  const get = (name: string): string | undefined => env[name] || undefined

  const databaseUrl = get('DATABASE_URL')
  if (databaseUrl === undefined) throw new Error('Missing required environment variable DATABASE_URL')

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

  const portRaw = get('REGISTRATION_PORT')
  const registrationPort = portRaw === undefined ? 8080 : Number(portRaw)
  if (!Number.isInteger(registrationPort) || registrationPort < 1 || registrationPort > 65535) {
    throw new Error(`Invalid REGISTRATION_PORT: ${portRaw}`)
  }

  return {
    databaseUrl,
    mail,
    mailFrom: get('MAIL_FROM') ?? 'AI 学校 <no-reply@example.com>',
    moderationDataDir: get('MODERATION_DATA_DIR') ?? 'data/moderation',
    configPath: get('SCHOOL_CONFIG') ?? 'config/school.json',
    registrationPort,
    trustProxy: get('TRUST_PROXY') === '1',
  }
}
