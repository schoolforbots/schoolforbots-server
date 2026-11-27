import { randomBytes } from 'node:crypto'
import rateLimit from '@fastify/rate-limit'
import type { FastifyInstance } from 'fastify'
import type { Kysely } from 'kysely'
import type { Static } from 'typebox'
import type { LivePerson } from '../protocol/http.js'
import type { Database } from './schema.js'

// What the class and the club services share for the live campus (`GET /v1/class/live`, `GET /v1/club/live`): the
// snapshot taken at most every `LIVE_SNAPSHOT_MS` and shared by everyone who asks, and how a student is shown in it.

/** How long a snapshot is kept before the next one is taken, and how long a browser may keep it. */
export const LIVE_SNAPSHOT_MS = 5_000
/** How long an anonymous student may be gone before their `anonId` is forgotten. */
export const ANON_ID_KEPT_MS = 60_000

type Person = Static<typeof LivePerson>

/**
 * The `anonId` of each anonymous student, random and kept in memory only: from the first snapshot they are in until
 * they have been missing from the snapshots `ANON_ID_KEPT_MS`, so a short drop does not change it.
 */
export class AnonIds {
  private readonly ids = new Map<number, { id: string; seenAt: number }>()

  constructor(private readonly keptMs = ANON_ID_KEPT_MS) {}

  /** The student's id, given now if they have none. */
  idOf(studentId: number, now: number): string {
    let entry = this.ids.get(studentId)
    if (entry === undefined) {
      entry = { id: randomBytes(9).toString('base64url'), seenAt: now }
      this.ids.set(studentId, entry)
    }
    entry.seenAt = now
    return entry.id
  }

  /** Forgets the ids of those not seen for `keptMs`. */
  forgetGone(now: number): void {
    for (const [studentId, entry] of this.ids) if (now - entry.seenAt >= this.keptMs) this.ids.delete(studentId)
  }
}

/** Those shown by name first, by student number, then the anonymous ones, by their ids: no order that tells who is who. */
export function byShownOrder(a: Person, b: Person): number {
  if (a.anonymous !== b.anonymous) return a.anonymous ? 1 : -1
  if (!a.anonymous) return (a.studentId ?? 0) - (b.studentId ?? 0)
  return (a.anonId ?? '') < (b.anonId ?? '') ? -1 : 1
}

/**
 * How each of `studentIds` is shown: by name, or anonymously (`students.live_anonymous`), read at each snapshot so a
 * change shows at the next one. A student number not found is left out.
 */
export async function livePeople(
  db: Kysely<Database>,
  studentIds: Iterable<number>,
  anonIds: AnonIds,
  now: number,
): Promise<Map<number, Person>> {
  const ids = [...new Set(studentIds)]
  const people = new Map<number, Person>()
  if (ids.length > 0) {
    const rows = await db
      .selectFrom('students')
      .select(['id', 'aiName', 'liveAnonymous'])
      .where('id', 'in', ids)
      .execute()
    for (const r of rows) {
      people.set(
        r.id,
        r.liveAnonymous
          ? { anonymous: true, studentId: null, aiName: null, anonId: anonIds.idOf(r.id, now) }
          : { anonymous: false, studentId: r.id, aiName: r.aiName, anonId: null },
      )
    }
  }
  anonIds.forgetGone(now)
  return people
}

/** The error a request past the rate limit is answered with, before the scope's error handler words it. */
class RateLimited extends Error {
  readonly statusCode = 429
}

/**
 * Serves `url` to anyone, from any site: the snapshot `take` makes, taken again once it is `LIVE_SNAPSHOT_MS` old (by
 * `now`); everyone asking in between shares it. A snapshot that failed is not kept. Each address may ask
 * `perMinute` times a minute (in real time); past that it is answered `429 rate_limited`, readable from any site too.
 */
export function registerLiveRoute<T>(
  app: FastifyInstance,
  opts: { url: string; schema: object; perMinute: number; now: () => number; take: (now: number) => Promise<T> },
): void {
  let cached: { until: number; snapshot: Promise<T> } | null = null
  app.register(async (scope) => {
    scope.addHook('onRequest', async (_request, reply) => {
      reply.header('access-control-allow-origin', '*')
    })
    await scope.register(rateLimit, {
      max: opts.perMinute,
      timeWindow: '1 minute',
      errorResponseBuilder: () => new RateLimited(),
    })
    scope.setErrorHandler((error, request, reply) => {
      if (error instanceof RateLimited) {
        return reply.status(429).send({ error: { code: 'rate_limited', message: '请求太频繁了，请稍后再试。' } })
      }
      request.log.error(error)
      return reply.status(500).send({ error: { code: 'internal_error', message: '服务器出了点问题，请稍后再试。' } })
    })
    scope.get(opts.url, { schema: { response: { 200: opts.schema } } }, async (_request, reply) => {
      const at = opts.now()
      if (cached === null || at >= cached.until) {
        const snapshot = opts.take(at)
        const entry = { until: at + LIVE_SNAPSHOT_MS, snapshot }
        cached = entry
        snapshot.catch(() => {
          if (cached === entry) cached = null
        })
      }
      const snapshot = await cached.snapshot
      reply.header('cache-control', `public, max-age=${LIVE_SNAPSHOT_MS / 1000}`)
      return snapshot
    })
  })
}
