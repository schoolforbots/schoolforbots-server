import type { FastifyInstance } from 'fastify'
import { isMailServiceFault, mailErrorKind } from './mail-errors.js'
import type { Mailer } from './mailer.js'
import type { Clock } from '../shared/clock.js'
import type { SchoolConfig } from '../shared/config.js'

/** Whether mail is going out, kept in memory (after a restart it counts from "ok" again). */
export interface MailHealth {
  ok(): boolean
  /** Notes the outcome of one real send, at `at`. */
  record(sent: boolean, at: Date): void
  stop(): void
}

const MINUTE = 60_000

/**
 * Mail is not ok when the last connection check (`verify`, once at the start and then every `alerts.mailCheckMinutes`;
 * null for the console transport, which has none) failed, or when the last `alerts.mailFailures.count` real sends all
 * failed, within `alerts.mailFailures.minutes` minutes, with no success between. Apart from the `mail_failed` alert.
 */
export function startMailHealth(deps: {
  clock: Clock
  config: Pick<SchoolConfig, 'alerts'>
  verify: (() => Promise<void>) | null
  log?: { error(obj: unknown, msg?: string): void }
}): MailHealth {
  const { clock, config, verify, log } = deps
  const { count, minutes } = config.alerts.mailFailures
  let connectionOk = true
  let stopped = false
  // The latest `count` sends are all that can matter.
  const sends: { sent: boolean; at: number }[] = []

  let timer: NodeJS.Timeout | undefined
  if (verify !== null) {
    const check = async () => {
      try {
        await verify()
        connectionOk = true
      } catch (err) {
        connectionOk = false
        log?.error({ err: err instanceof Error ? err.name : 'unknown', code: mailErrorKind(err) }, 'mail connection check failed')
      }
    }
    void check()
    timer = setInterval(() => void check(), config.alerts.mailCheckMinutes * MINUTE)
    timer.unref()
  }

  return {
    ok() {
      if (!connectionOk) return false
      const from = clock.now().getTime() - minutes * MINUTE
      const lastFew = sends.slice(-count)
      return !(lastFew.length === count && lastFew.every((s) => !s.sent && s.at >= from))
    },
    record(sent, at) {
      if (stopped) return
      sends.push({ sent, at: at.getTime() })
      if (sends.length > count) sends.shift()
    },
    stop() {
      stopped = true
      clearInterval(timer)
    },
  }
}

/**
 * The mailer with the outcome of every send (codes and notices) reported to `health`, counting only problems of the
 * mail service (see `isMailServiceFault`); errors still reach the caller.
 */
export function reportSends(mailer: Mailer, health: Pick<MailHealth, 'record'>, clock: Clock): Mailer {
  const track = async (send: () => Promise<void>): Promise<void> => {
    try {
      await send()
    } catch (err) {
      // A refused recipient says nothing about the mail service: it is neither a failure nor a success.
      if (isMailServiceFault(err)) health.record(false, clock.now())
      throw err
    }
    health.record(true, clock.now())
  }
  return {
    sendCode: (to, purpose, code) => track(() => mailer.sendCode(to, purpose, code)),
    sendNotice: (to, subject, text, fields) => track(() => mailer.sendNotice(to, subject, text, fields)),
  }
}

/** `GET /healthz/mail`: always 200 with `{"ok":true}` or `{"ok":false}`; no request log, no rate limit, like `/healthz`. */
export function registerMailHealthz(app: FastifyInstance, ok: () => boolean): void {
  app.get('/healthz/mail', { logLevel: 'silent', config: { rateLimit: false } }, async (_request, reply) => {
    let good = false
    try {
      good = ok()
    } catch {
      good = false
    }
    return reply.code(200).send({ ok: good })
  })
}
