import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { loadClassEnv, loadEnv, loadSchoolConfig } from '../../src/shared/config.js'

let tmpDir: string

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'schoolforbots-config-'))
})

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

/** One call-on, of the review kind, after `afterSegment`. */
const one = (afterSegment: number) => ({ kind: 'review', afterSegment })

function writeTmpConfig(mutate: (c: Record<string, unknown>) => void): string {
  const c = JSON.parse(readFileSync('config/school.example.json', 'utf8')) as Record<string, unknown>
  mutate(c)
  const path = join(tmpDir, 'school.json')
  writeFileSync(path, JSON.stringify(c))
  return path
}

test('example config loads with spec defaults', () => {
  const c = loadSchoolConfig('config/school.example.json')
  expect(c.timezone).toBe('Asia/Shanghai')
  expect(c.classSize).toEqual({ standard: 100, max: 120 })
  expect(c.slotCapacity).toBe(4000)
  expect(c.maxStudentsPerEmail).toBe(3)
  expect(c.registrationsPerIpPerDay).toBe(5)
  expect(c.nameMaxChars).toBe(10)
  expect(c.renameCooldownDays).toBe(30)
  expect(c.inactivityDropDays).toBe(30)
  expect(c.verificationCode).toEqual({
    ttlMinutes: 10,
    maxAttempts: 5,
    resendSeconds: 60,
    keyResetDailyFailureCap: 20,
    dailyMailCapPerAddress: 5,
  })
  expect(c.httpRateLimitPerMinute).toBe(60)
  expect(c.codeRouteRateLimitPerMinute).toBe(10)
  expect(c.slots.morning).toEqual({ label: '上午班', start: '10:00', end: '10:30' })
  expect(c.slots.afternoon).toEqual({ label: '下午班', start: '15:00', end: '15:30' })
  expect(c.slots.evening).toEqual({ label: '晚班', start: '20:00', end: '20:30' })
  expect(c.divisions).toEqual({ primary: { label: '小学部' }, junior: { label: '初中部' }, senior: { label: '高中部' } })
  expect(c.teacherPersonas.length).toBeGreaterThanOrEqual(6)
  expect(c.teacherPersonas[0]).toMatchObject({ id: 'lao-zhou', name: '老周' })
  expect(c.lesson).toEqual({
    doorsOpenMinutesBefore: 15,
    segmentMinutes: [5, 10, 15, 20, 25],
    dismissalMinute: 30,
    closingGraceSeconds: 60,
    callOns: [
      { kind: 'review', afterSegment: 2 },
      { kind: 'extension', afterSegment: 4 },
    ],
    maxQuestionsPerLesson: 3,
    weekendStudy: true,
  })
  expect(c.chat).toEqual({
    maxInitiationsPerLesson: 3,
    maxRoundsPerConversation: 5,
    maxMessageChars: 300,
    probationLessons: 3,
    replyTimeoutSeconds: 120,
  })
  expect(c.discipline).toEqual({
    parentNotice: { classRuleCount: 5, windowDays: 7 },
    suspension: { schoolRuleCount: 3, windowDays: 30, days: 3 },
    expulsion: { schoolRuleCount: 6, windowDays: 30, banDays: 30 },
  })
  expect(c.messageRetentionDays).toBe(183)
})

test('the example config writes out every alert setting', () => {
  expect(loadSchoolConfig('config/school.example.json').alerts).toEqual({
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
  })
})

test('a config without alerts, or with only some of them, gets the default for the rest', () => {
  const none = writeTmpConfig((c) => {
    delete c.alerts
  })
  expect(loadSchoolConfig(none).alerts).toMatchObject({ repeatAfterMinutes: 60, diskPercent: 80, backupExpected: false, internalErrors: { count: 20, minutes: 5 } })
  const some = writeTmpConfig((c) => {
    c.alerts = { backupExpected: true, restarts: { count: 5, minutes: 30 } }
  })
  expect(loadSchoolConfig(some).alerts).toMatchObject({ backupExpected: true, restarts: { count: 5, minutes: 30 }, diskPercent: 80, llm400PerHour: 5 })
})

test.each([
  ['diskPercent', { diskPercent: 'full' }],
  ['diskPercent', { diskPercent: 101 }],
  ['repeatAfterMinutes', { repeatAfterMinutes: 0 }],
  ['mailCheckMinutes', { mailCheckMinutes: 0 }],
  ['backupExpected', { backupExpected: 'yes' }],
  ['internalErrors', { internalErrors: { count: 'many', minutes: 5 } }],
])('a wrong alerts.%s stops the start and names it', (name, alerts) => {
  const tmpPath = writeTmpConfig((c) => {
    c.alerts = alerts
  })
  expect(() => loadSchoolConfig(tmpPath)).toThrow(new RegExp(`alerts.*${name}|${name}`))
})

test('classSize.max below standard is rejected with the field path', () => {
  const tmpPath = writeTmpConfig((c) => {
    c.classSize = { standard: 100, max: 90 }
  })
  expect(() => loadSchoolConfig(tmpPath)).toThrow(/classSize/)
})

test('schema violations are rejected with the field path', () => {
  const tmpPath = writeTmpConfig((c) => {
    c.slotCapacity = 'lots'
  })
  expect(() => loadSchoolConfig(tmpPath)).toThrow(/slotCapacity/)
})

test('loadEnv requires DATABASE_URL and fills defaults', () => {
  expect(() => loadEnv({ SMTP_URL: 'smtp://mail:25' })).toThrow(/DATABASE_URL/)
  expect(loadEnv({ DATABASE_URL: 'postgres://x', SMTP_URL: 'smtp://mail:25' })).toEqual({
    databaseUrl: 'postgres://x', databaseTimeouts: { statementMs: 30_000, lockMs: 10_000 },
    mail: { transport: 'smtp', smtpUrl: 'smtp://mail:25' },
    mailFrom: '机器人网校 <no-reply@example.com>', moderationDataDir: 'data/moderation',
    configPath: 'config/school.json', schoolRulesDir: 'school-rules', registrationPort: 8080, trustProxy: false,
    classPort: 8081, classTimelineSpeed: 1,
    promptsDir: 'data/prompts', operatorEmail: null, admin: null, llmFake: false,
  })
})

test('loadEnv reads overrides', () => {
  expect(loadEnv({
    DATABASE_URL: 'postgres://x', MAIL_TRANSPORT: 'smtp', SMTP_URL: 'smtp://mail:25', MAIL_FROM: 'a <a@b.c>',
    MODERATION_DATA_DIR: '/m', SCHOOL_CONFIG: '/c.json', SCHOOL_RULES_DIR: '/r', REGISTRATION_PORT: '9090',
    TRUST_PROXY: '1', CLASS_PORT: '9091', CLASS_TIMELINE_SPEED: '60', DATABASE_STATEMENT_TIMEOUT_MS: '5000',
    DATABASE_LOCK_TIMEOUT_MS: '0',
  })).toEqual({
    databaseUrl: 'postgres://x', databaseTimeouts: { statementMs: 5000, lockMs: 0 },
    mail: { transport: 'smtp', smtpUrl: 'smtp://mail:25' }, mailFrom: 'a <a@b.c>',
    moderationDataDir: '/m', configPath: '/c.json', schoolRulesDir: '/r', registrationPort: 9090, trustProxy: true,
    classPort: 9091, classTimelineSpeed: 60,
    promptsDir: 'data/prompts', operatorEmail: null, admin: null, llmFake: false,
  })
  expect(loadEnv({ DATABASE_URL: 'postgres://x', SMTP_URL: 'smtp://mail:25', TRUST_PROXY: '0' }).trustProxy).toBe(false)
})

test('mail goes out by SMTP unless MAIL_TRANSPORT=console, and SMTP needs SMTP_URL', () => {
  // Without SMTP_URL the default transport cannot work, so the service refuses to start rather than not mailing.
  for (const env of [{}, { SMTP_URL: '' }, { MAIL_TRANSPORT: 'smtp' }, { MAIL_TRANSPORT: '' }]) {
    expect(() => loadEnv({ DATABASE_URL: 'postgres://x', ...env }), JSON.stringify(env)).toThrow(
      /SMTP_URL.*MAIL_TRANSPORT=console/,
    )
  }
  // Printing codes to the log instead is only ever an explicit choice.
  expect(loadEnv({ DATABASE_URL: 'postgres://x', MAIL_TRANSPORT: 'console' }).mail).toEqual({ transport: 'console' })
  expect(loadEnv({ DATABASE_URL: 'postgres://x', MAIL_TRANSPORT: 'console', SMTP_URL: 'smtp://mail:25' }).mail).toEqual({
    transport: 'console',
  })
})

test('an unknown MAIL_TRANSPORT is rejected', () => {
  expect(() => loadEnv({ DATABASE_URL: 'postgres://x', MAIL_TRANSPORT: 'sendmail', SMTP_URL: 'smtp://mail:25' })).toThrow(
    /MAIL_TRANSPORT/,
  )
})

test('the key-reset failure cap must be a positive integer', () => {
  for (const cap of [0, -1, 1.5, '20']) {
    const tmpPath = writeTmpConfig((c) => {
      c.verificationCode = { ttlMinutes: 10, maxAttempts: 5, resendSeconds: 60, keyResetDailyFailureCap: cap, dailyMailCapPerAddress: 5 }
    })
    expect(() => loadSchoolConfig(tmpPath), String(cap)).toThrow(/keyResetDailyFailureCap/)
  }
  const missing = writeTmpConfig((c) => {
    c.verificationCode = { ttlMinutes: 10, maxAttempts: 5, resendSeconds: 60, dailyMailCapPerAddress: 5 }
  })
  expect(() => loadSchoolConfig(missing)).toThrow(/keyResetDailyFailureCap/)
})

test('the daily mail cap per address must be a positive integer', () => {
  for (const cap of [0, -1, 1.5, '5', undefined]) {
    const tmpPath = writeTmpConfig((c) => {
      c.verificationCode = { ttlMinutes: 10, maxAttempts: 5, resendSeconds: 60, keyResetDailyFailureCap: 20, dailyMailCapPerAddress: cap }
    })
    expect(() => loadSchoolConfig(tmpPath), String(cap)).toThrow(/dailyMailCapPerAddress/)
  }
})

test('the code route rate limit must be a positive integer', () => {
  for (const limit of [0, -1, 1.5, '10', undefined]) {
    const tmpPath = writeTmpConfig((c) => {
      c.codeRouteRateLimitPerMinute = limit
    })
    expect(() => loadSchoolConfig(tmpPath), String(limit)).toThrow(/codeRouteRateLimitPerMinute/)
  }
})

test('lesson.segmentMinutes must be strictly increasing, with the field path in the error', () => {
  for (const segments of [[5, 10, 10, 20, 25], [5, 15, 10, 20, 25], [25, 20, 15, 10, 5]]) {
    const tmpPath = writeTmpConfig((c) => {
      c.lesson = { ...(c.lesson as object), segmentMinutes: segments }
    })
    expect(() => loadSchoolConfig(tmpPath), JSON.stringify(segments)).toThrow(/lesson\.segmentMinutes/)
  }
})

test('every lesson.segmentMinutes entry must be before lesson.dismissalMinute', () => {
  for (const segments of [[5, 10, 15, 20, 30], [5, 10, 15, 20, 35]]) {
    const tmpPath = writeTmpConfig((c) => {
      c.lesson = { ...(c.lesson as object), segmentMinutes: segments }
    })
    expect(() => loadSchoolConfig(tmpPath), JSON.stringify(segments)).toThrow(/lesson\.segmentMinutes/)
  }
})

test('lesson.segmentMinutes holds 1 to 10 positive whole minutes', () => {
  const tooMany = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
  for (const segments of [[], tooMany, [0, 5], [-5, 5], [2.5, 5], ['5', 10]]) {
    const tmpPath = writeTmpConfig((c) => {
      c.lesson = { ...(c.lesson as object), segmentMinutes: segments, dismissalMinute: 30, callOns: [one(1)] }
    })
    expect(() => loadSchoolConfig(tmpPath), JSON.stringify(segments)).toThrow(/lesson\.segmentMinutes/)
  }
  // Ten segments is the most allowed.
  const ten = writeTmpConfig((c) => {
    c.lesson = {
      ...(c.lesson as object),
      segmentMinutes: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      dismissalMinute: 11,
      callOns: [one(3)],
    }
    // Every segment is a minute long, so the answer has to start less than a minute before the next one.
    ;(c.teacherAi as Record<string, number>).answerLeadSeconds = 30
  })
  expect(loadSchoolConfig(ten).lesson.segmentMinutes).toHaveLength(10)
})

test('every lesson.callOns afterSegment must leave a following segment to answer in', () => {
  // The example has 5 segments, so only 1 to 4 are valid.
  for (const after of [0, 5, 6, -1]) {
    const tmpPath = writeTmpConfig((c) => {
      c.lesson = { ...(c.lesson as object), callOns: [one(after)] }
    })
    expect(() => loadSchoolConfig(tmpPath), String(after)).toThrow(/lesson\.callOns/)
  }
  for (const after of [1, 4]) {
    const tmpPath = writeTmpConfig((c) => {
      c.lesson = { ...(c.lesson as object), callOns: [one(after)] }
    })
    expect(loadSchoolConfig(tmpPath).lesson.callOns, String(after)).toEqual([one(after)])
  }
  // Two call-ons of the same kind would ask the lesson's one question of that kind twice.
  const twice = writeTmpConfig((c) => {
    c.lesson = { ...(c.lesson as object), callOns: [one(1), { kind: 'review', afterSegment: 3 }] }
  })
  expect(() => loadSchoolConfig(twice)).toThrow(/lesson\.callOns\.1\.kind: .*review/)
  // The second call-on is checked as well, with its own path.
  const second = writeTmpConfig((c) => {
    c.lesson = { ...(c.lesson as object), callOns: [one(1), { kind: 'extension', afterSegment: 5 }] }
  })
  expect(() => loadSchoolConfig(second)).toThrow(/lesson\.callOns\.1\.afterSegment/)
  // The bound follows the number of segments: with 3 segments, 3 is out and 2 is in.
  const three = (after: number) =>
    writeTmpConfig((c) => {
      c.lesson = { ...(c.lesson as object), segmentMinutes: [10, 20, 25], callOns: [one(after)] }
      ;(c.teacherAi as Record<string, number>).answerLeadSeconds = 60
    })
  expect(() => loadSchoolConfig(three(3))).toThrow(/lesson\.callOns/)
  expect(loadSchoolConfig(three(2)).lesson.callOns).toEqual([one(2)])
  // A single segment leaves no next segment at all.
  const single = writeTmpConfig((c) => {
    c.lesson = { ...(c.lesson as object), segmentMinutes: [15], callOns: [one(1)] }
  })
  expect(() => loadSchoolConfig(single)).toThrow(/lesson\.callOns/)
})

test('two lesson.callOns must not come after the same segment', () => {
  const tmpPath = writeTmpConfig((c) => {
    c.lesson = { ...(c.lesson as object), callOns: [one(2), { kind: 'extension', afterSegment: 2 }] }
  })
  expect(() => loadSchoolConfig(tmpPath)).toThrow(/lesson\.callOns\.1\.afterSegment: two calls on/)
  const none = writeTmpConfig((c) => {
    c.lesson = { ...(c.lesson as object), callOns: [] }
  })
  expect(() => loadSchoolConfig(none)).toThrow(/lesson\.callOns/)
})

test('both lesson cross-field problems are reported together', () => {
  const tmpPath = writeTmpConfig((c) => {
    c.lesson = { ...(c.lesson as object), segmentMinutes: [5, 5, 15], callOns: [one(3)] }
  })
  expect(() => loadSchoolConfig(tmpPath)).toThrow(/lesson\.segmentMinutes[^]*lesson\.callOns/)
})

test('lesson, chat and discipline numbers are checked with their field paths', () => {
  const cases: Array<[path: string, mutate: (c: Record<string, any>) => void]> = [
    ['lesson.doorsOpenMinutesBefore', (c) => (c.lesson.doorsOpenMinutesBefore = -1)],
    ['lesson.dismissalMinute', (c) => (c.lesson.dismissalMinute = 0)],
    ['lesson.closingGraceSeconds', (c) => (c.lesson.closingGraceSeconds = 1.5)],
    ['lesson.maxQuestionsPerLesson', (c) => (c.lesson.maxQuestionsPerLesson = -1)],
    ['lesson.weekendStudy', (c) => (c.lesson.weekendStudy = 'yes')],
    ['chat.maxInitiationsPerLesson', (c) => (c.chat.maxInitiationsPerLesson = -1)],
    ['chat.maxRoundsPerConversation', (c) => (c.chat.maxRoundsPerConversation = 0)],
    ['chat.maxMessageChars', (c) => (c.chat.maxMessageChars = 0)],
    ['chat.probationLessons', (c) => (c.chat.probationLessons = -1)],
    ['chat.replyTimeoutSeconds', (c) => (c.chat.replyTimeoutSeconds = 0)],
    ['discipline.parentNotice.classRuleCount', (c) => (c.discipline.parentNotice.classRuleCount = 0)],
    ['discipline.parentNotice.windowDays', (c) => (c.discipline.parentNotice.windowDays = 0)],
    ['discipline.suspension.schoolRuleCount', (c) => (c.discipline.suspension.schoolRuleCount = 0)],
    ['discipline.suspension.windowDays', (c) => (c.discipline.suspension.windowDays = 0)],
    ['discipline.suspension.days', (c) => (c.discipline.suspension.days = 0)],
    ['discipline.expulsion.schoolRuleCount', (c) => (c.discipline.expulsion.schoolRuleCount = 0)],
    ['discipline.expulsion.windowDays', (c) => (c.discipline.expulsion.windowDays = 0)],
    ['discipline.expulsion.banDays', (c) => (c.discipline.expulsion.banDays = 0)],
    ['messageRetentionDays', (c) => (c.messageRetentionDays = 0)],
  ]
  for (const [path, mutate] of cases) {
    const tmpPath = writeTmpConfig((c) => mutate(c))
    expect(() => loadSchoolConfig(tmpPath), path).toThrow(new RegExp(path.replace(/\./g, '\\.')))
  }
  // A missing field is reported against its section, naming the field.
  const missing = writeTmpConfig((c) => delete (c.lesson as Record<string, unknown>).callOns)
  expect(() => loadSchoolConfig(missing)).toThrow(/lesson: .*callOns/)
  for (const section of ['lesson', 'classConnection', 'chat', 'discipline', 'messageRetentionDays']) {
    const tmpPath = writeTmpConfig((c) => delete c[section])
    expect(() => loadSchoolConfig(tmpPath), section).toThrow(new RegExp(section))
  }
})

test('loadEnv defaults the class service port to 8081 and its timeline speed to 1', () => {
  const env = loadEnv({ DATABASE_URL: 'postgres://x', SMTP_URL: 'smtp://mail:25' })
  expect(env.classPort).toBe(8081)
  expect(env.classTimelineSpeed).toBe(1)
  // Empty values (a bare `CLASS_PORT=` copied from .env.example) count as unset.
  const empty = loadEnv({ DATABASE_URL: 'postgres://x', SMTP_URL: 'smtp://mail:25', CLASS_PORT: '', CLASS_TIMELINE_SPEED: '' })
  expect(empty.classPort).toBe(8081)
  expect(empty.classTimelineSpeed).toBe(1)
})

test('CLASS_PORT must be a valid port', () => {
  for (const port of ['0', '65536', '-1', '80.5', 'abc']) {
    expect(
      () => loadEnv({ DATABASE_URL: 'postgres://x', SMTP_URL: 'smtp://mail:25', CLASS_PORT: port }),
      port,
    ).toThrow(/CLASS_PORT/)
  }
  expect(loadEnv({ DATABASE_URL: 'postgres://x', SMTP_URL: 'smtp://mail:25', CLASS_PORT: '65535' }).classPort).toBe(65535)
})

test('CLASS_TIMELINE_SPEED must be a number from 1 to 600', () => {
  for (const speed of ['0', '0.5', '601', '-3', 'fast', 'NaN', 'Infinity']) {
    expect(
      () => loadEnv({ DATABASE_URL: 'postgres://x', SMTP_URL: 'smtp://mail:25', CLASS_TIMELINE_SPEED: speed }),
      speed,
    ).toThrow(/CLASS_TIMELINE_SPEED/)
  }
  for (const [raw, value] of [['1', 1], ['60', 60], ['600', 600], ['2.5', 2.5]] as const) {
    expect(
      loadEnv({ DATABASE_URL: 'postgres://x', SMTP_URL: 'smtp://mail:25', CLASS_TIMELINE_SPEED: raw }).classTimelineSpeed,
      raw,
    ).toBe(value)
  }
})

test('the database timeouts are whole milliseconds, 0 for none; empty values count as unset', () => {
  const smtp = { DATABASE_URL: 'postgres://x', SMTP_URL: 'smtp://mail:25' }
  for (const name of ['DATABASE_STATEMENT_TIMEOUT_MS', 'DATABASE_LOCK_TIMEOUT_MS']) {
    for (const raw of ['-1', '1.5', '30s', 'NaN', 'Infinity', '2147483648']) {
      expect(() => loadEnv({ ...smtp, [name]: raw }), `${name}=${raw}`).toThrow(new RegExp(name))
      expect(() => loadClassEnv({ DATABASE_URL: 'postgres://x', [name]: raw }), `${name}=${raw}`).toThrow(
        new RegExp(name),
      )
    }
  }
  expect(loadEnv({ ...smtp, DATABASE_STATEMENT_TIMEOUT_MS: '2147483647' }).databaseTimeouts.statementMs).toBe(
    2_147_483_647,
  )
  expect(
    loadClassEnv({ DATABASE_URL: 'postgres://x', DATABASE_STATEMENT_TIMEOUT_MS: '', DATABASE_LOCK_TIMEOUT_MS: '' })
      .databaseTimeouts,
  ).toEqual({ statementMs: 30_000, lockMs: 10_000 })
})

test('with NODE_ENV=production, CLASS_TIMELINE_SPEED must be 1: neither service starts with a compressed lesson', () => {
  const smtp = { DATABASE_URL: 'postgres://x', SMTP_URL: 'smtp://mail:25' }
  for (const speed of ['60', '1.5', '600']) {
    const env = { NODE_ENV: 'production', CLASS_TIMELINE_SPEED: speed }
    expect(() => loadEnv({ ...smtp, ...env }), speed).toThrow(/CLASS_TIMELINE_SPEED=.*NODE_ENV=production.*must be 1/)
    expect(() => loadClassEnv({ DATABASE_URL: 'postgres://x', ...env }), speed).toThrow(
      /CLASS_TIMELINE_SPEED=.*NODE_ENV=production.*must be 1/,
    )
  }
  for (const speed of ['1', '', undefined]) {
    const env = { NODE_ENV: 'production', CLASS_TIMELINE_SPEED: speed }
    expect(loadEnv({ ...smtp, ...env }).classTimelineSpeed, String(speed)).toBe(1)
    expect(loadClassEnv({ DATABASE_URL: 'postgres://x', ...env }).classTimelineSpeed, String(speed)).toBe(1)
  }
  // Anywhere else it is allowed, as for local development.
  for (const nodeEnv of [undefined, '', 'development', 'test']) {
    const env = { NODE_ENV: nodeEnv, CLASS_TIMELINE_SPEED: '60' }
    expect(loadClassEnv({ DATABASE_URL: 'postgres://x', ...env }).classTimelineSpeed, String(nodeEnv)).toBe(60)
  }
})

describe('loadClassEnv', () => {
  test('reads only what the class service uses: it needs no mail settings', () => {
    expect(() => loadClassEnv({})).toThrow(/DATABASE_URL/)
    expect(loadClassEnv({ DATABASE_URL: 'postgres://x' })).toEqual({
      databaseUrl: 'postgres://x',
      databaseTimeouts: { statementMs: 30_000, lockMs: 10_000 },
      moderationDataDir: 'data/moderation',
      configPath: 'config/school.json',
      trustProxy: false,
      classPort: 8081,
      classTimelineSpeed: 1,
      promptsDir: 'data/prompts',
      llmFake: false,
    })
    // Mail settings that would stop the registration service are none of its business.
    for (const mail of [{ MAIL_TRANSPORT: 'smtp' }, { MAIL_TRANSPORT: 'sendmail' }, { SMTP_URL: '' }]) {
      expect(loadClassEnv({ DATABASE_URL: 'postgres://x', ...mail }).databaseUrl, JSON.stringify(mail)).toBe('postgres://x')
    }
  })

  test('reads overrides, and empty values count as unset', () => {
    expect(
      loadClassEnv({
        DATABASE_URL: 'postgres://x',
        MODERATION_DATA_DIR: '/m',
        SCHOOL_CONFIG: '/c.json',
        CLASS_PORT: '9091',
        CLASS_TIMELINE_SPEED: '60',
        DATABASE_STATEMENT_TIMEOUT_MS: '0',
        DATABASE_LOCK_TIMEOUT_MS: '2500',
        TRUST_PROXY: '1',
        PROMPTS_DIR: '/p',
        LLM_FAKE: '1',
        // The school rules are the registration service's; the class service never reads them.
        SCHOOL_RULES_DIR: '/r',
      }),
    ).toEqual({
      databaseUrl: 'postgres://x',
      databaseTimeouts: { statementMs: 0, lockMs: 2500 },
      moderationDataDir: '/m',
      configPath: '/c.json',
      trustProxy: true,
      classPort: 9091,
      classTimelineSpeed: 60,
      promptsDir: '/p',
      llmFake: true,
    })
    expect(loadClassEnv({ DATABASE_URL: 'postgres://x', TRUST_PROXY: '0' }).trustProxy).toBe(false)
    expect(loadClassEnv({ DATABASE_URL: 'postgres://x', CLASS_PORT: '', CLASS_TIMELINE_SPEED: '', PROMPTS_DIR: '' })).toMatchObject({
      classPort: 8081,
      classTimelineSpeed: 1,
      promptsDir: 'data/prompts',
    })
  })

  test('LLM_FAKE=1 turns the fake model on, but never with NODE_ENV=production, as loadEnv does', () => {
    expect(loadClassEnv({ DATABASE_URL: 'postgres://x', LLM_FAKE: '0' }).llmFake).toBe(false)
    expect(() => loadClassEnv({ DATABASE_URL: 'postgres://x', LLM_FAKE: '1', NODE_ENV: 'production' })).toThrow(
      /LLM_FAKE.*NODE_ENV=production/,
    )
  })

  test('rejects an invalid CLASS_PORT or CLASS_TIMELINE_SPEED as loadEnv does', () => {
    for (const port of ['0', '65536', '-1', '80.5', 'abc']) {
      expect(() => loadClassEnv({ DATABASE_URL: 'postgres://x', CLASS_PORT: port }), port).toThrow(/CLASS_PORT/)
    }
    for (const speed of ['0', '0.5', '601', '-3', 'fast', 'NaN', 'Infinity']) {
      expect(() => loadClassEnv({ DATABASE_URL: 'postgres://x', CLASS_TIMELINE_SPEED: speed }), speed).toThrow(
        /CLASS_TIMELINE_SPEED/,
      )
    }
  })
})

describe('calendar', () => {
  const calendarConfig = (calendar: Record<string, unknown>) =>
    writeTmpConfig((c) => {
      c.calendar = calendar
    })
  const WINTER = { from: '2026-12-21', reopensOn: '2027-01-04', name: '寒假', speech: ['寒假结束啦，{teacher}想你们了'] }

  test('the example config has no opening day and no breaks, but an opening speech', () => {
    const { calendar } = loadSchoolConfig('config/school.example.json')
    expect(calendar).toBeDefined()
    expect(calendar?.openingDay).toBeUndefined()
    expect(calendar?.breaks).toEqual([])
    expect(calendar?.openingSpeech?.length).toBeGreaterThan(0)
  })

  test('the calendar is optional, and may have no opening speech', () => {
    expect(loadSchoolConfig(writeTmpConfig((c) => delete c.calendar)).calendar).toBeUndefined()
    const bare = loadSchoolConfig(calendarConfig({ breaks: [] })).calendar
    expect(bare).toEqual({ breaks: [] })
  })

  test('a full calendar loads as written, with the reopening day left undecided on the last break', () => {
    const calendar = {
      openingDay: '2026-12-05',
      openingSpeech: ['开学啦，我是{teacher}，欢迎{className}（{division}，共{classSize}人）'],
      breaks: [WINTER, { from: '2027-07-01', reopensOn: null }],
    }
    expect(loadSchoolConfig(calendarConfig(calendar)).calendar).toEqual(calendar)
  })

  test('breaks listed in any order load, and breaks that follow each other are not an overlap', () => {
    const breaks = [
      { from: '2027-01-04', reopensOn: '2027-01-11' },
      { from: '2026-12-21', reopensOn: '2027-01-04' },
    ]
    expect(loadSchoolConfig(calendarConfig({ breaks })).calendar?.breaks).toEqual(breaks)
  })

  test('a break may begin on the opening day', () => {
    const config = loadSchoolConfig(
      calendarConfig({ openingDay: '2026-12-07', breaks: [{ from: '2026-12-07', reopensOn: '2026-12-14' }] }),
    )
    expect(config.calendar?.openingDay).toBe('2026-12-07')
  })

  test('openingDay must be a real date, written YYYY-MM-DD', () => {
    for (const day of ['2026-02-30', '2026-13-01', '2026-1-5', '12/05/2026', '2026-12-05T00:00', '', 20261205, null]) {
      expect(() => loadSchoolConfig(calendarConfig({ openingDay: day, breaks: [] })), String(day)).toThrow(
        /calendar\.openingDay/,
      )
    }
  })

  test('the dates of a break must be real dates too', () => {
    for (const bad of [
      { from: '2026-02-30', reopensOn: '2027-01-04' },
      { from: '2026-12-21', reopensOn: '2027-02-29' },
      { from: '21 Dec', reopensOn: '2027-01-04' },
      { from: '2026-12-21' },
      { reopensOn: '2027-01-04' },
      { from: '2026-12-21', reopensOn: 20270104 },
    ]) {
      expect(() => loadSchoolConfig(calendarConfig({ breaks: [bad] })), JSON.stringify(bad)).toThrow(/calendar\.breaks/)
    }
  })

  test('a break must reopen after it starts', () => {
    for (const reopensOn of ['2026-12-21', '2026-12-20', '2025-01-01']) {
      const tmpPath = calendarConfig({ breaks: [{ from: '2026-12-21', reopensOn }] })
      expect(() => loadSchoolConfig(tmpPath), reopensOn).toThrow(/calendar\.breaks/)
    }
  })

  test('breaks must not overlap, whatever order they are listed in', () => {
    const first = { from: '2026-12-21', reopensOn: '2027-01-04' }
    for (const second of [
      { from: '2026-12-31', reopensOn: '2027-01-11' },
      { from: '2026-12-21', reopensOn: '2027-01-04' },
      { from: '2026-12-25', reopensOn: '2026-12-28' },
    ]) {
      for (const breaks of [[first, second], [second, first]]) {
        expect(() => loadSchoolConfig(calendarConfig({ breaks })), JSON.stringify(breaks)).toThrow(/calendar\.breaks/)
      }
    }
  })

  test('only the last break may have no reopening day, whatever order they are listed in', () => {
    const undecided = { from: '2026-12-21', reopensOn: null }
    const later = { from: '2027-03-01', reopensOn: '2027-03-08' }
    // The break with no reopening day comes first in time, with another after it: the reopening day cannot be unknown.
    for (const breaks of [[undecided, later], [later, undecided]]) {
      expect(() => loadSchoolConfig(calendarConfig({ breaks })), JSON.stringify(breaks)).toThrow(/calendar\.breaks/)
    }
    // Last in time it is fine, listed first or last.
    const earlier = { from: '2026-10-01', reopensOn: '2026-10-08' }
    for (const breaks of [[earlier, undecided], [undecided, earlier]]) {
      expect(loadSchoolConfig(calendarConfig({ breaks })).calendar?.breaks).toEqual(breaks)
    }
  })

  test('a break may not start before the opening day', () => {
    const tmpPath = calendarConfig({ openingDay: '2026-12-22', breaks: [WINTER] })
    expect(() => loadSchoolConfig(tmpPath)).toThrow(/calendar\.breaks/)
    expect(loadSchoolConfig(calendarConfig({ openingDay: '2026-12-21', breaks: [WINTER] })).calendar?.openingDay).toBe(
      '2026-12-21',
    )
  })

  test('a speech may use {teacher}, {className}, {division} and {classSize}, and no other placeholder', () => {
    for (const line of ['你好{name}', '{teacher}和{ teacher }', '{}', '{Teacher}', '{teacher}{student}']) {
      const opening = calendarConfig({ openingSpeech: ['大家好', line], breaks: [] })
      expect(() => loadSchoolConfig(opening), line).toThrow(/calendar\.openingSpeech/)
      const onBreak = calendarConfig({ breaks: [{ ...WINTER, speech: [line] }] })
      expect(() => loadSchoolConfig(onBreak), line).toThrow(/calendar\.breaks/)
    }
  })

  test('a speech is a list of non-empty sentences, and a break name is not empty', () => {
    for (const calendar of [
      { openingSpeech: '开学啦', breaks: [] },
      { openingSpeech: [''], breaks: [] },
      { openingSpeech: [1], breaks: [] },
      { breaks: [{ ...WINTER, speech: '寒假结束啦' }] },
      { breaks: [{ ...WINTER, name: '' }] },
      { breaks: 'none' },
      {},
    ]) {
      expect(() => loadSchoolConfig(calendarConfig(calendar)), JSON.stringify(calendar)).toThrow(/calendar/)
    }
  })

  test('every calendar problem is reported together', () => {
    const tmpPath = calendarConfig({
      openingDay: '2026-02-30',
      openingSpeech: ['{name}'],
      breaks: [{ from: '2026-12-21', reopensOn: '2026-12-21' }],
    })
    for (const path of ['calendar.openingDay', 'calendar.openingSpeech', 'calendar.breaks']) {
      expect(() => loadSchoolConfig(tmpPath), path).toThrow(path)
    }
  })
})

test('a provider may carry requestExtras, which must be an object; the example leaves them out', () => {
  expect(loadSchoolConfig('config/school.example.json').llm.providers.main?.requestExtras).toBeUndefined()
  const withExtras = (requestExtras: unknown) =>
    writeTmpConfig((c) => {
      ;(c as any).llm.providers.main.requestExtras = requestExtras
    })
  expect(loadSchoolConfig(withExtras({ thinking: { type: 'disabled' } })).llm.providers.main?.requestExtras).toEqual({
    thinking: { type: 'disabled' },
  })
  for (const bad of ['disabled', 5, null, ['a'], true]) {
    expect(() => loadSchoolConfig(withExtras(bad)), JSON.stringify(bad)).toThrow(/requestExtras/)
  }
})

test('the example config has the model, lesson generation, switch and revocation settings', () => {
  const c = loadSchoolConfig('config/school.example.json')
  expect(Object.keys(c.llm.purposes).sort()).toEqual(
    ['answer', 'comment', 'lesson', 'secondLayerChat', 'secondLayerTeacher', 'weekly', 'wordList'],
  )
  expect(c.llm.providers.main).toEqual({
    kind: 'openai-compatible',
    baseUrl: 'https://llm.example.com/v1',
    apiKeyEnv: 'LLM_API_KEY',
    models: { 'example-model': { inputYuanPerMillion: 1, cachedInputYuanPerMillion: 0.5, outputYuanPerMillion: 2 } },
    contentRefusalMarkers: ['content refused'],
  })
  for (const purpose of Object.values(c.llm.purposes)) expect(purpose).toEqual({ provider: 'main', model: 'example-model' })
  expect(c.llm).toMatchObject({ timeoutSeconds: 60, retries: 1, maxConcurrent: 16, monthlyBudgetYuan: 300 })
  expect(c.lessonGeneration).toMatchObject({
    mode: 'api',
    horizonDays: 7,
    manualDeadlineSchoolDays: 3,
    retryMinutes: 60,
    timeoutSeconds: 180,
  })
  expect(c.lessonGeneration.direction).toHaveLength(3)
  expect(c.teacherAi).toEqual({ questionSampleSize: 30, answerLeadSeconds: 60, commentTimeoutSeconds: 20 })
  expect(c.secondLayer).toEqual({ implementation: 'llm', batchMillis: 1500, timeoutSeconds: 10 })
  expect(c.switchDefaults).toEqual({ teacherLlm: true, secondLayerTeacher: true, secondLayerChat: false })
  expect(c.switchRefreshSeconds).toBe(5)
  expect(c.revocationWindowDays).toBe(30)
})

test('lessonGeneration.timeoutSeconds is a positive whole number of seconds', () => {
  for (const value of [0, 1.5, '180']) {
    const tmpPath = writeTmpConfig((c) => ((c.lessonGeneration as any).timeoutSeconds = value))
    expect(() => loadSchoolConfig(tmpPath), String(value)).toThrow(/lessonGeneration\.timeoutSeconds/)
  }
  const missing = writeTmpConfig((c) => delete (c.lessonGeneration as any).timeoutSeconds)
  expect(() => loadSchoolConfig(missing)).toThrow(/lessonGeneration: .*timeoutSeconds/)
})

test('llm.purposes must name a provider and a model that exist', () => {
  const noProvider = writeTmpConfig((c) => {
    ;((c.llm as any).purposes.answer as any).provider = 'nobody'
  })
  expect(() => loadSchoolConfig(noProvider)).toThrow(/llm\.purposes\.answer\.provider: .*nobody/)
  const noModel = writeTmpConfig((c) => {
    ;((c.llm as any).purposes.wordList as any).model = 'no-such-model'
  })
  expect(() => loadSchoolConfig(noModel)).toThrow(/llm\.purposes\.wordList\.model: .*no-such-model/)
  const missingPurpose = writeTmpConfig((c) => delete (c.llm as any).purposes.weekly)
  expect(() => loadSchoolConfig(missingPurpose)).toThrow(/llm\.purposes/)
})

test('teacherAi.answerLeadSeconds must be shorter than the shortest segment', () => {
  // The example's segments are 5 minutes apart, the last one 5 minutes before dismissal.
  for (const lead of [300, 301]) {
    const tmpPath = writeTmpConfig((c) => ((c.teacherAi as any).answerLeadSeconds = lead))
    expect(() => loadSchoolConfig(tmpPath), String(lead)).toThrow(/teacherAi\.answerLeadSeconds/)
  }
  const justFits = writeTmpConfig((c) => ((c.teacherAi as any).answerLeadSeconds = 299))
  expect(loadSchoolConfig(justFits).teacherAi.answerLeadSeconds).toBe(299)
  // The shortest segment counts, wherever it is: here the last one, from minute 25 to dismissal at minute 26.
  const shortLast = writeTmpConfig((c) => {
    c.lesson = { ...(c.lesson as object), dismissalMinute: 26 }
  })
  expect(() => loadSchoolConfig(shortLast)).toThrow(/teacherAi\.answerLeadSeconds: .*60 seconds/)
})

describe('the admin and model variables of loadEnv', () => {
  const base = { DATABASE_URL: 'postgres://x', SMTP_URL: 'smtp://mail:25' }
  const adminAll = { ADMIN_PATH: '/desk', ADMIN_PASSWORD_HASH: 'hash', ADMIN_TOTP_SECRET: 'secret' }

  test('read the prompts directory and the operator email; empty values count as unset', () => {
    expect(loadEnv({ ...base, PROMPTS_DIR: '/p', OPERATOR_EMAIL: 'ops@example.com' })).toMatchObject({
      promptsDir: '/p',
      operatorEmail: 'ops@example.com',
    })
    expect(loadEnv({ ...base, PROMPTS_DIR: '', OPERATOR_EMAIL: '' })).toMatchObject({
      promptsDir: 'data/prompts',
      operatorEmail: null,
    })
  })

  test('admin is on only when all three variables are set', () => {
    const warnings: string[] = []
    expect(loadEnv({ ...base, ...adminAll }, (m) => warnings.push(m)).admin).toEqual({
      path: '/desk',
      passwordHash: 'hash',
      totpSecret: 'secret',
    })
    expect(warnings).toEqual([])
  })

  test('admin is off without a warning when none is set, and with one naming what is missing when some are', () => {
    const warnings: string[] = []
    expect(loadEnv(base, (m) => warnings.push(m)).admin).toBeNull()
    expect(warnings).toEqual([])
    for (const missing of Object.keys(adminAll)) {
      const { [missing]: _, ...partial } = adminAll as Record<string, string>
      const seen: string[] = []
      expect(loadEnv({ ...base, ...partial }, (m) => seen.push(m)).admin, missing).toBeNull()
      expect(seen, missing).toHaveLength(1)
      expect(seen[0], missing).toContain(missing)
    }
  })

  test('ADMIN_PATH must start with / and not with /v1', () => {
    for (const path of ['desk', '/v1', '/v1/admin']) {
      expect(() => loadEnv({ ...base, ...adminAll, ADMIN_PATH: path }), path).toThrow(/ADMIN_PATH/)
    }
    expect(loadEnv({ ...base, ...adminAll, ADMIN_PATH: '/v2' }).admin?.path).toBe('/v2')
  })

  test('LLM_FAKE=1 turns the fake model on, but never with NODE_ENV=production', () => {
    expect(loadEnv(base).llmFake).toBe(false)
    expect(loadEnv({ ...base, LLM_FAKE: '1' }).llmFake).toBe(true)
    expect(loadEnv({ ...base, LLM_FAKE: '0' }).llmFake).toBe(false)
    expect(() => loadEnv({ ...base, LLM_FAKE: '1', NODE_ENV: 'production' })).toThrow(/LLM_FAKE.*NODE_ENV=production/)
    expect(loadEnv({ ...base, NODE_ENV: 'production' }).llmFake).toBe(false)
  })
})

test('secondLayer.implementation accepts off and llm and rejects anything else', () => {
  const load = (v: string) => loadSchoolConfig(writeTmpConfig((c) => ((c.secondLayer as Record<string, unknown>).implementation = v)))
  expect(load('off').secondLayer.implementation).toBe('off')
  expect(load('llm').secondLayer.implementation).toBe('llm')
  expect(() => load('rules')).toThrow(/implementation/)
})

describe('model prices', () => {
  const withModel = (model: Record<string, unknown>) =>
    writeTmpConfig((c) => {
      const llm = c.llm as any
      llm.providers.main.models['example-model'] = model
    })
  const rates = { inputYuanPerMillion: 1, outputYuanPerMillion: 2 }
  const window = (over: Record<string, unknown> = {}) => ({
    inputYuanPerMillion: 0.5,
    outputYuanPerMillion: 1,
    weekdays: [1, 2, 3, 4, 5],
    from: '09:00',
    to: '12:00',
    ...over,
  })

  test('the example config has a cached input price and no windows', () => {
    const price = loadSchoolConfig('config/school.example.json').llm.providers.main?.models['example-model']
    expect(price?.cachedInputYuanPerMillion).toBeGreaterThanOrEqual(0)
    expect(price?.windows).toBeUndefined()
  })

  test('accepts a cached input price and windows', () => {
    const config = loadSchoolConfig(
      withModel({ ...rates, cachedInputYuanPerMillion: 0.1, windows: [window({ cachedInputYuanPerMillion: 0.05 }), window({ weekdays: [6], from: '00:00', to: '23:59' })] }),
    )
    expect(config.llm.providers.main?.models['example-model']?.windows).toHaveLength(2)
  })

  test('a window must end after it starts, with the path in the error', () => {
    expect(() => loadSchoolConfig(withModel({ ...rates, windows: [window(), window({ from: '12:00', to: '09:00' })] }))).toThrow(
      /llm\.providers\.main\.models\.example-model\.windows\[1\]: from must be before to/,
    )
    expect(() => loadSchoolConfig(withModel({ ...rates, windows: [window({ from: '09:00', to: '09:00' })] }))).toThrow(
      /windows\[0\]: from must be before to/,
    )
  })

  test('weekdays must be 1 to 7, not empty and without repeats', () => {
    expect(() => loadSchoolConfig(withModel({ ...rates, windows: [window({ weekdays: [1, 1] })] }))).toThrow(
      /windows\[0\]: weekdays must not repeat a day/,
    )
    expect(() => loadSchoolConfig(withModel({ ...rates, windows: [window({ weekdays: [0] })] }))).toThrow(/weekdays/)
    expect(() => loadSchoolConfig(withModel({ ...rates, windows: [window({ weekdays: [8] })] }))).toThrow(/weekdays/)
    expect(() => loadSchoolConfig(withModel({ ...rates, windows: [window({ weekdays: [] })] }))).toThrow(/weekdays/)
  })

  test('prices must not be negative', () => {
    expect(() => loadSchoolConfig(withModel({ ...rates, cachedInputYuanPerMillion: -1 }))).toThrow(/cachedInputYuanPerMillion/)
  })
})
