import { afterEach, describe, expect, test, vi } from 'vitest'
import { isMailServiceFault } from '../../src/registration/mail-errors.js'
import { MemoryMailer, withMailFailures } from '../../src/registration/mailer.js'
import { reportSends, startMailHealth, type MailHealth } from '../../src/registration/mail-health.js'
import { exampleConfig, buildTestApp } from '../helpers/app.js'
import { createTestClock } from '../helpers/clock.js'

const config = exampleConfig() // mailFailures: 3 in 10 minutes, mailCheckMinutes 10
const start = () => new Date('2026-11-10T04:00:00Z')
const MIN = 60_000

let health: MailHealth | undefined
afterEach(() => {
  health?.stop()
  health = undefined
  vi.useRealTimers()
})

describe('the sending record', () => {
  test('count failures in a row within the window are not ok; a success between, or a failure outside the window, is ok', () => {
    const clock = createTestClock(start())
    health = startMailHealth({ clock, config, verify: null })
    expect(health.ok()).toBe(true)
    health.record(false, clock.now())
    health.record(false, clock.now())
    expect(health.ok()).toBe(true)
    health.record(false, clock.now())
    expect(health.ok()).toBe(false)
    health.record(true, clock.now())
    expect(health.ok()).toBe(true)
    health.record(false, clock.now())
    health.record(false, clock.now())
    expect(health.ok()).toBe(true) // the success is in the way
  })

  test('failures older than the window no longer count', () => {
    const clock = createTestClock(start())
    health = startMailHealth({ clock, config, verify: null })
    for (let i = 0; i < 3; i++) health.record(false, clock.now())
    expect(health.ok()).toBe(false)
    clock.advance(10 * MIN + 1)
    expect(health.ok()).toBe(true)
  })

  test('console mail (no verify) is always ok while it sends', () => {
    const clock = createTestClock(start())
    health = startMailHealth({ clock, config, verify: null })
    for (let i = 0; i < 2; i++) health.record(true, clock.now())
    expect(health.ok()).toBe(true)
  })

  test('reportSends reports both sendCode and sendNotice, success and failure, and still throws', async () => {
    const clock = createTestClock(start())
    health = startMailHealth({ clock, config, verify: null })
    const inner = new MemoryMailer()
    const mailer = reportSends(inner, health, clock)
    vi.spyOn(inner, 'sendCode').mockRejectedValue(new Error('smtp down'))
    vi.spyOn(inner, 'sendNotice').mockRejectedValue(new Error('smtp down'))
    await expect(mailer.sendCode('a@example.com', 'register', '1')).rejects.toThrow('smtp down')
    await expect(mailer.sendNotice('o@example.com', 's', 't')).rejects.toThrow('smtp down')
    await expect(mailer.sendCode('a@example.com', 'register', '1')).rejects.toThrow('smtp down')
    expect(health.ok()).toBe(false)
    vi.mocked(inner.sendNotice).mockResolvedValue(undefined)
    await mailer.sendNotice('o@example.com', 's', 't')
    expect(health.ok()).toBe(true)
  })
})

describe('the connection check', () => {
  test('checks once at the start and then every mailCheckMinutes; a failure is not ok, the next success is ok', async () => {
    vi.useFakeTimers({ now: start() })
    const verify = vi.fn<() => Promise<void>>().mockRejectedValueOnce(new Error('refused')).mockResolvedValue(undefined)
    const clock = { now: () => new Date() }
    health = startMailHealth({ clock, config, verify })
    expect(verify).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(0)
    expect(health.ok()).toBe(false)
    await vi.advanceTimersByTimeAsync(10 * MIN - 1)
    expect(verify).toHaveBeenCalledTimes(1)
    expect(health.ok()).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(verify).toHaveBeenCalledTimes(2)
    expect(health.ok()).toBe(true)
  })

  test('the interval comes from the config, and stop ends it', async () => {
    vi.useFakeTimers({ now: start() })
    const verify = vi.fn(async () => undefined)
    const fast = { alerts: { ...config.alerts, mailCheckMinutes: 2 } }
    health = startMailHealth({ clock: { now: () => new Date() }, config: fast, verify })
    await vi.advanceTimersByTimeAsync(2 * MIN)
    expect(verify).toHaveBeenCalledTimes(2)
    health.stop()
    await vi.advanceTimersByTimeAsync(10 * MIN)
    expect(verify).toHaveBeenCalledTimes(2)
  })
})

describe('GET /healthz/mail', () => {
  test('answers 200 with only ok, for both states, while /healthz stays 200', async () => {
    const clock = createTestClock(start())
    let up = true
    const mailHealth: MailHealth = { ok: () => up, record: () => undefined, stop: () => undefined }
    const t = await buildTestApp({ mailHealth })
    try {
      const good = await t.app.inject({ method: 'GET', url: '/healthz/mail' })
      expect(good.statusCode).toBe(200)
      expect(good.body).toBe('{"ok":true}')
      up = false
      const bad = await t.app.inject({ method: 'GET', url: '/healthz/mail' })
      expect(bad.statusCode).toBe(200)
      expect(bad.body).toBe('{"ok":false}')
      expect((await t.app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200)
      for (let i = 0; i < 200; i++) expect((await t.app.inject({ method: 'GET', url: '/healthz/mail' })).statusCode).toBe(200)
    } finally {
      void clock
      await t.destroy()
    }
  })
})

/** An error as nodemailer shapes it. */
const mailError = (code: string, command?: string, responseCode?: number) => Object.assign(new Error('x'), { code, command, responseCode })

describe('isMailServiceFault', () => {
  test.each([
    ['connection refused', mailError('ECONNECTION', 'CONN'), true],
    ['socket reset', mailError('ESOCKET'), true],
    ['timeout', mailError('ETIMEDOUT', 'CONN'), true],
    ['DNS', mailError('EDNS'), true],
    ['login failed', mailError('EAUTH', 'AUTH PLAIN', 535), true],
    ['server shutting down at the greeting', mailError('EPROTOCOL', 'CONN', 421), true],
    ['sender refused', mailError('EENVELOPE', 'MAIL FROM', 550), true],
    ['message refused', mailError('EENVELOPE', 'DATA', 554), true],
    ['the whole server unavailable at RCPT TO (421)', mailError('EENVELOPE', 'RCPT TO', 421), true],
    ['temporary server error at RCPT TO (454)', mailError('EENVELOPE', 'RCPT TO', 454), true],
    ['an error that is not nodemailer\'s', new Error('boom'), true],
    ['not even an Error', 'boom', true],
    ['recipient does not exist (550)', mailError('EENVELOPE', 'RCPT TO', 550), false],
    ['recipient address rejected (553)', mailError('EENVELOPE', 'RCPT TO', 553), false],
    ['recipient deferred (450)', mailError('EENVELOPE', 'RCPT TO', 450), false],
    ['malformed recipient caught by nodemailer', mailError('EENVELOPE', 'API'), false],
  ])('%s', (_name, err, fault) => {
    expect(isMailServiceFault(err)).toBe(fault)
  })
})

describe('refused recipients are not the mail service failing', () => {
  const failing = (err: Error) => {
    const inner = new MemoryMailer()
    vi.spyOn(inner, 'sendCode').mockRejectedValue(err)
    return inner
  }

  test('several refused recipients in a row: /healthz/mail stays ok, no mail_failed, the error still reaches the caller, one log line without the address', async () => {
    const clock = createTestClock(start())
    health = startMailHealth({ clock, config, verify: null })
    const onFailure = vi.fn()
    const lines: unknown[] = []
    const inner = failing(mailError('EENVELOPE', 'RCPT TO', 550))
    const mailer = reportSends(withMailFailures(inner, onFailure, { info: (o) => void lines.push(o) }), health, clock)
    for (let i = 0; i < 5; i++) await expect(mailer.sendCode('fake@example.com', 'register', '1')).rejects.toThrow('x')
    expect(health.ok()).toBe(true)
    expect(onFailure).not.toHaveBeenCalled()
    expect(lines).toEqual(Array(5).fill({ code: 'EENVELOPE' }))
    expect(JSON.stringify(lines)).not.toContain('fake@example.com')
  })

  test('several connection failures in a row: not ok, and mail_failed is reported each time', async () => {
    const clock = createTestClock(start())
    health = startMailHealth({ clock, config, verify: null })
    const onFailure = vi.fn()
    const mailer = reportSends(withMailFailures(failing(mailError('ECONNECTION', 'CONN')), onFailure), health, clock)
    for (let i = 0; i < 3; i++) await expect(mailer.sendCode('a@example.com', 'register', '1')).rejects.toThrow('x')
    expect(health.ok()).toBe(false)
    expect(onFailure).toHaveBeenCalledTimes(3)
  })
})
