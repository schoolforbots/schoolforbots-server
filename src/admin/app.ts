import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import cookie from '@fastify/cookie'
import fastifyStatic from '@fastify/static'
import { TypeBoxValidatorCompiler, type TypeBoxTypeProvider } from '@fastify/type-provider-typebox'
import type { FastifyPluginAsync, FastifyReply } from 'fastify'
import type { Kysely } from 'kysely'
import { Type } from 'typebox'
import type { Llm } from '../llm/client.js'
import type { PromptName, PromptTemplate } from '../llm/prompts.js'
import type { Moderator } from '../moderation/moderator.js'
import { ApiError } from '../registration/errors.js'
import type { Mailer } from '../registration/mailer.js'
import type { Clock } from '../shared/clock.js'
import type { Env, SchoolConfig } from '../shared/config.js'
import type { Database } from '../shared/schema.js'
import type { Switches } from '../shared/switches.js'
import { hashSessionToken, newSessionToken, verifyPassword, verifyTotp } from './auth.js'
import { lessonRoutes } from './lessons.js'
import { statsRoutes } from './stats.js'
import { switchRoutes } from './switches.js'

export interface AdminDeps {
  db: Kysely<Database>
  config: SchoolConfig
  clock: Clock
  /** `env.admin` must be set: the admin routes are only built when it is. */
  env: Env
  /** Null when the model is not set up for this run. */
  llm: Llm | null
  prompts: Record<PromptName, PromptTemplate>
  moderator: Moderator
  switches: Switches
  mailer: Mailer
  /** Where the built front end is; defaults to `admin/dist` in the repository. */
  distDir?: string
}

/**
 * A group of routes under `{ADMIN_PATH}/api/`, behind the session check and the request-header rule. To add admin
 * routes, write one of these and append it to `API_ROUTES`; paths inside are relative to `api/`.
 */
export type AdminApiRoutes = (deps: AdminDeps) => FastifyPluginAsync

const API_ROUTES: AdminApiRoutes[] = [switchRoutes, statsRoutes, lessonRoutes]

export const SESSION_COOKIE = 'sfb_admin'
const SESSION_HOURS = 12
const LOGIN_PER_IP_PER_MINUTE = 5
const LOCK_AFTER_FAILURES = 10
const LOCK_MINUTES = 15

declare module 'fastify' {
  interface FastifyRequest {
    /** Set on the routes behind the session check. */
    adminSession: { tokenHash: string; expiresAt: Date } | null
  }
}

const NOT_BUILT_PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>后台</title></head>
<body><p>后台页面还没打包，先运行 npm run admin:build</p></body></html>
`

const defaultDistDir = fileURLToPath(new URL('../../admin/dist', import.meta.url))

/** The admin pages and their API, to be registered with `prefix` set to the admin path. */
export function adminRoutes(deps: AdminDeps): FastifyPluginAsync {
  const admin = deps.env.admin
  if (admin === null) throw new Error('adminRoutes needs ADMIN_PATH, ADMIN_PASSWORD_HASH and ADMIN_TOTP_SECRET')
  const adminPath = admin.path
  const dist = deps.distDir ?? defaultDistDir

  return async (app) => {
    await app.register(cookie)
    app.addHook('onRequest', async (_request, reply) => {
      reply.header('x-content-type-options', 'nosniff')
      reply.header('x-frame-options', 'DENY')
      reply.header('referrer-policy', 'no-referrer')
    })

    async function sendIndex(reply: FastifyReply) {
      reply.header('cache-control', 'no-store')
      try {
        return reply.type('text/html; charset=utf-8').send(await readFile(join(dist, 'index.html')))
      } catch {
        return reply.type('text/html; charset=utf-8').send(NOT_BUILT_PAGE)
      }
    }

    // `/x` and `/x/` are different routes here: the first sends the browser to the second, so the page's relative
    // links (assets/..., api/...) resolve under the admin path.
    app.get('', { prefixTrailingSlash: 'no-slash' }, async (_request, reply) => reply.redirect(`${adminPath}/`))
    app.get('/', { prefixTrailingSlash: 'slash' }, async (_request, reply) => sendIndex(reply))
    if (existsSync(join(dist, 'assets'))) {
      await app.register(fastifyStatic, { root: join(dist, 'assets'), prefix: '/assets/', decorateReply: false })
    }
    // Any other page is the front end's own (client-side navigation); `api/` is never one of them.
    app.get('/*', async (_request, reply) => sendIndex(reply))

    await app.register(apiRoutes(deps, adminPath), { prefix: '/api' })
  }
}

function apiRoutes(deps: AdminDeps, adminPath: string): FastifyPluginAsync {
  const { db, clock } = deps
  const credentials = deps.env.admin
  if (credentials === null) throw new Error('unreachable')

  // Consecutive wrong logins, from anyone. Kept in memory: a restart clears it, and so does a right login.
  let failures = 0
  let lockedUntil = 0
  // The newest time step of a code that logged in. A code is good once: this and any older step are refused, so a
  // login body that leaks cannot be sent again.
  let lastAcceptedStep = -1

  const cookieOptions = { path: adminPath, httpOnly: true, secure: true, sameSite: 'strict' as const }

  return async (instance) => {
    const app = instance.withTypeProvider<TypeBoxTypeProvider>()
    app.setValidatorCompiler(TypeBoxValidatorCompiler)
    app.decorateRequest('adminSession', null)

    app.addHook('onRequest', async (request, reply) => {
      reply.header('cache-control', 'no-store')
      // A cross-site form or fetch cannot set this header without a CORS preflight, which this service never answers.
      if (request.method !== 'GET' && request.headers['x-requested-with'] !== 'admin') {
        throw new ApiError(403, 'admin_csrf')
      }
    })

    app.register(async (scope) => {
      scope.withTypeProvider<TypeBoxTypeProvider>().post(
        '/login',
        {
          config: { rateLimit: { max: LOGIN_PER_IP_PER_MINUTE, timeWindow: '1 minute' } },
          schema: {
            body: Type.Object(
              { password: Type.String({ maxLength: 500 }), code: Type.String({ maxLength: 32 }) },
              { additionalProperties: false },
            ),
          },
        },
        async (request, reply) => {
          const now = clock.now()
          if (lockedUntil > now.getTime()) throw new ApiError(429, 'admin_locked')

          // Both are always checked, so the time taken does not say which one was wrong. Everything up to the
          // failure count is synchronous, so parallel requests cannot all slip in before the count rises.
          const passwordOk = verifyPassword(request.body.password, credentials.passwordHash)
          const step = verifyTotp(credentials.totpSecret, request.body.code, now)
          const codeOk = step !== null && step > lastAcceptedStep
          if (!passwordOk || !codeOk) {
            failures += 1
            if (failures >= LOCK_AFTER_FAILURES) {
              failures = 0
              lockedUntil = now.getTime() + LOCK_MINUTES * 60_000
            }
            throw new ApiError(401, 'admin_login_failed')
          }
          failures = 0
          lastAcceptedStep = step

          const { token, hash } = newSessionToken()
          const expiresAt = new Date(now.getTime() + SESSION_HOURS * 3_600_000)
          await db.deleteFrom('adminSessions').where('expiresAt', '<=', now).execute()
          await db.insertInto('adminSessions').values({ tokenHash: hash, expiresAt, createdAt: now }).execute()
          reply.setCookie(SESSION_COOKIE, token, { ...cookieOptions, maxAge: SESSION_HOURS * 3600 })
          return { expiresAt: expiresAt.toISOString() }
        },
      )
    })

    app.register(async (authed) => {
      authed.addHook('onRequest', async (request) => {
        const token = request.cookies[SESSION_COOKIE]
        if (typeof token !== 'string' || token === '') throw new ApiError(401, 'admin_login_required')
        const tokenHash = hashSessionToken(token)
        const row = await db
          .selectFrom('adminSessions')
          .select(['expiresAt'])
          .where('tokenHash', '=', tokenHash)
          .where('expiresAt', '>', clock.now())
          .executeTakeFirst()
        if (row === undefined) throw new ApiError(401, 'admin_login_required')
        request.adminSession = { tokenHash, expiresAt: row.expiresAt }
      })

      authed.get('/session', async (request) => ({ expiresAt: request.adminSession?.expiresAt.toISOString() }))
      authed.post('/logout', async (request, reply) => {
        if (request.adminSession !== null) {
          await db.deleteFrom('adminSessions').where('tokenHash', '=', request.adminSession.tokenHash).execute()
        }
        reply.clearCookie(SESSION_COOKIE, cookieOptions)
        return { ok: true }
      })
      for (const routes of API_ROUTES) authed.register(routes(deps))

      // An unknown address under api/ is a 404 only after the session check.
      authed.all('/*', async () => {
        throw new ApiError(404, 'not_found')
      })
    })
  }
}

/** Whether a request URL is under the admin path (also with the path percent-encoded or in another case). */
export function isAdminUrl(url: string, adminPath: string): boolean {
  const lower = adminPath.toLowerCase()
  const candidates = [url]
  try {
    candidates.push(decodeURIComponent(url))
  } catch {
    // an invalid escape is matched as it is written
  }
  return candidates.some((candidate) => {
    const u = candidate.toLowerCase()
    return u === lower || u.startsWith(`${lower}/`) || u.startsWith(`${lower}?`)
  })
}
