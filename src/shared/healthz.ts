import type { FastifyInstance } from 'fastify'
import { sql, type Kysely } from 'kysely'
import type { Database } from './schema.js'

/** Whether the database answers `select 1` within `timeoutMs`. Never throws, and never waits longer than the limit. */
export async function databaseAlive(db: Kysely<Database>, timeoutMs = 2000): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined
  try {
    const timeout = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs)
    })
    const query = (async () => {
      await db.selectNoFrom(sql<number>`1`.as('ok')).execute()
      return true as const
    })()
    // A query that fails after the limit has passed is not left unhandled.
    query.catch(() => {})
    return await Promise.race([query, timeout])
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

/**
 * `GET /healthz`: 200 `{"ok":true}` when `check` passes, 503 `{"ok":false}` when it fails or throws, and nothing more.
 * The route writes no request log and is outside the rate limit: Docker and the sentinel ask every minute.
 */
export function registerHealthz(app: FastifyInstance, check: () => Promise<boolean>): void {
  app.get('/healthz', { logLevel: 'silent', config: { rateLimit: false } }, async (_request, reply) => {
    let ok = false
    try {
      ok = await check()
    } catch {
      ok = false
    }
    return reply.code(ok ? 200 : 503).send({ ok })
  })
}
