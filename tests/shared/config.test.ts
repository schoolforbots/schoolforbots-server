import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { loadEnv, loadSchoolConfig } from '../../src/shared/config.js'

let tmpDir: string

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'ai-school-config-'))
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
  })
  expect(c.httpRateLimitPerMinute).toBe(60)
  expect(c.slots.morning).toEqual({ label: '上午班', start: '10:00', end: '11:00' })
  expect(c.slots.afternoon).toEqual({ label: '下午班', start: '15:00', end: '16:00' })
  expect(c.slots.evening).toEqual({ label: '晚班', start: '20:00', end: '21:00' })
  expect(c.divisions).toEqual({ primary: { label: '小学部' }, junior: { label: '初中部' }, senior: { label: '高中部' } })
  expect(c.teacherPersonas.length).toBeGreaterThanOrEqual(6)
  expect(c.teacherPersonas[0]).toMatchObject({ id: 'lao-zhou', name: '老周' })
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
  expect(() => loadEnv({})).toThrow(/DATABASE_URL/)
  expect(loadEnv({ DATABASE_URL: 'postgres://x' })).toEqual({
    databaseUrl: 'postgres://x', smtpUrl: undefined, mailFrom: 'AI 学校 <no-reply@example.com>',
    moderationDataDir: 'data/moderation', configPath: 'config/school.json',
    registrationPort: 8080, trustProxy: false,
  })
})

test('loadEnv reads overrides', () => {
  expect(loadEnv({
    DATABASE_URL: 'postgres://x', SMTP_URL: 'smtp://mail:25', MAIL_FROM: 'a <a@b.c>',
    MODERATION_DATA_DIR: '/m', SCHOOL_CONFIG: '/c.json', REGISTRATION_PORT: '9090', TRUST_PROXY: '1',
  })).toEqual({
    databaseUrl: 'postgres://x', smtpUrl: 'smtp://mail:25', mailFrom: 'a <a@b.c>',
    moderationDataDir: '/m', configPath: '/c.json', registrationPort: 9090, trustProxy: true,
  })
  expect(loadEnv({ DATABASE_URL: 'postgres://x', TRUST_PROXY: '0' }).trustProxy).toBe(false)
})

test('the key-reset failure cap must be a positive integer', () => {
  for (const cap of [0, -1, 1.5, '20']) {
    const tmpPath = writeTmpConfig((c) => {
      c.verificationCode = { ttlMinutes: 10, maxAttempts: 5, resendSeconds: 60, keyResetDailyFailureCap: cap }
    })
    expect(() => loadSchoolConfig(tmpPath), String(cap)).toThrow(/keyResetDailyFailureCap/)
  }
  const missing = writeTmpConfig((c) => {
    c.verificationCode = { ttlMinutes: 10, maxAttempts: 5, resendSeconds: 60 }
  })
  expect(() => loadSchoolConfig(missing)).toThrow(/keyResetDailyFailureCap/)
})
