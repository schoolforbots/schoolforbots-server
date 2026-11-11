import { afterEach, describe, expect, test, vi } from 'vitest'
import { MemoryMailer } from '../../src/registration/mailer.js'
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
