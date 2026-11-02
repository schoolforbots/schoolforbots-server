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
    callOnAfterSegment: 3,
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
    databaseUrl: 'postgres://x', mail: { transport: 'smtp', smtpUrl: 'smtp://mail:25' },
    mailFrom: '机器人网校 <no-reply@example.com>', moderationDataDir: 'data/moderation',
    configPath: 'config/school.json', registrationPort: 8080, trustProxy: false,
    classPort: 8081, classTimelineSpeed: 1,
  })
})

test('loadEnv reads overrides', () => {
  expect(loadEnv({
    DATABASE_URL: 'postgres://x', MAIL_TRANSPORT: 'smtp', SMTP_URL: 'smtp://mail:25', MAIL_FROM: 'a <a@b.c>',
    MODERATION_DATA_DIR: '/m', SCHOOL_CONFIG: '/c.json', REGISTRATION_PORT: '9090', TRUST_PROXY: '1',
    CLASS_PORT: '9091', CLASS_TIMELINE_SPEED: '60',
  })).toEqual({
    databaseUrl: 'postgres://x', mail: { transport: 'smtp', smtpUrl: 'smtp://mail:25' }, mailFrom: 'a <a@b.c>',
    moderationDataDir: '/m', configPath: '/c.json', registrationPort: 9090, trustProxy: true,
    classPort: 9091, classTimelineSpeed: 60,
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
      c.lesson = { ...(c.lesson as object), segmentMinutes: segments, dismissalMinute: 30, callOnAfterSegment: 1 }
    })
    expect(() => loadSchoolConfig(tmpPath), JSON.stringify(segments)).toThrow(/lesson\.segmentMinutes/)
  }
  // Ten segments is the most allowed.
  const ten = writeTmpConfig((c) => {
    c.lesson = {
      ...(c.lesson as object),
      segmentMinutes: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      dismissalMinute: 11,
      callOnAfterSegment: 3,
    }
  })
  expect(loadSchoolConfig(ten).lesson.segmentMinutes).toHaveLength(10)
})

test('lesson.callOnAfterSegment must leave a following segment to answer in', () => {
  // The example has 5 segments, so only 1 to 4 are valid.
  for (const after of [0, 5, 6, -1]) {
    const tmpPath = writeTmpConfig((c) => {
      c.lesson = { ...(c.lesson as object), callOnAfterSegment: after }
    })
    expect(() => loadSchoolConfig(tmpPath), String(after)).toThrow(/lesson\.callOnAfterSegment/)
  }
  for (const after of [1, 4]) {
    const tmpPath = writeTmpConfig((c) => {
      c.lesson = { ...(c.lesson as object), callOnAfterSegment: after }
    })
    expect(loadSchoolConfig(tmpPath).lesson.callOnAfterSegment, String(after)).toBe(after)
  }
  // The bound follows the number of segments: with 3 segments, 3 is out and 2 is in.
  const three = (after: number) =>
    writeTmpConfig((c) => {
      c.lesson = { ...(c.lesson as object), segmentMinutes: [10, 20, 25], callOnAfterSegment: after }
    })
  expect(() => loadSchoolConfig(three(3))).toThrow(/lesson\.callOnAfterSegment/)
  expect(loadSchoolConfig(three(2)).lesson.callOnAfterSegment).toBe(2)
  // A single segment leaves no next segment at all.
  const single = writeTmpConfig((c) => {
    c.lesson = { ...(c.lesson as object), segmentMinutes: [15], callOnAfterSegment: 1 }
  })
  expect(() => loadSchoolConfig(single)).toThrow(/lesson\.callOnAfterSegment/)
})

test('both lesson cross-field problems are reported together', () => {
  const tmpPath = writeTmpConfig((c) => {
    c.lesson = { ...(c.lesson as object), segmentMinutes: [5, 5, 15], callOnAfterSegment: 3 }
  })
  expect(() => loadSchoolConfig(tmpPath)).toThrow(/lesson\.segmentMinutes[^]*lesson\.callOnAfterSegment/)
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
  const missing = writeTmpConfig((c) => delete (c.lesson as Record<string, unknown>).callOnAfterSegment)
  expect(() => loadSchoolConfig(missing)).toThrow(/lesson: .*callOnAfterSegment/)
  for (const section of ['lesson', 'chat', 'discipline', 'messageRetentionDays']) {
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

describe('loadClassEnv', () => {
  test('reads only what the class service uses: it needs no mail settings', () => {
    expect(() => loadClassEnv({})).toThrow(/DATABASE_URL/)
    expect(loadClassEnv({ DATABASE_URL: 'postgres://x' })).toEqual({
      databaseUrl: 'postgres://x',
      moderationDataDir: 'data/moderation',
      configPath: 'config/school.json',
      classPort: 8081,
      classTimelineSpeed: 1,
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
      }),
    ).toEqual({ databaseUrl: 'postgres://x', moderationDataDir: '/m', configPath: '/c.json', classPort: 9091, classTimelineSpeed: 60 })
    expect(loadClassEnv({ DATABASE_URL: 'postgres://x', CLASS_PORT: '', CLASS_TIMELINE_SPEED: '' })).toMatchObject({
      classPort: 8081,
      classTimelineSpeed: 1,
    })
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
