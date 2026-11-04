import rateLimit from '@fastify/rate-limit'
import { TypeBoxValidatorCompiler, type TypeBoxTypeProvider } from '@fastify/type-provider-typebox'
import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyServerOptions } from 'fastify'
import type { Kysely } from 'kysely'
import { adminRoutes, isAdminApiRequest, isAdminUrl, type AdminDeps } from '../admin/app.js'
import type { Moderator } from '../moderation/moderator.js'
import type { Clock } from '../shared/clock.js'
import type { SchoolConfig } from '../shared/config.js'
import type { Database } from '../shared/db.js'
import type { SchoolRules } from '../shared/school-rules.js'
import { ApiError, registerErrorHandler } from './errors.js'
import { keyResetRoutes } from './key-resets.js'
import type { Mailer } from './mailer.js'
import { meRoutes } from './me.js'
import { recordsRoutes } from './records.js'
import { registrationRoutes } from './registrations.js'
import { schoolRoutes } from './school.js'

export interface RegistrationDeps {
  db: Kysely<Database>
  config: SchoolConfig
  moderator: Moderator
  mailer: Mailer
  clock: Clock
  /** The school rules, every version, read at startup. */
  schoolRules: SchoolRules
  /** True when the service runs behind a reverse proxy whose X-Forwarded-For can be trusted. */
  trustProxy: boolean
  /** Fastify logger options; unset means no logging. Unexpected errors are logged at error level. */
  logger?: FastifyServerOptions['logger']
  /** The admin pages. They are served only when `admin.env.admin` is set; without it every path under them is a 404. */
  admin?: AdminDeps
}

/** Logger options whose request line writes `[admin]` instead of a URL under the admin path. */
function hidingAdminPath(logger: RegistrationDeps['logger'], adminPath: string): FastifyServerOptions['logger'] {
  if (logger === undefined || logger === false) return logger
  const options = logger === true ? {} : logger
  // A logger object already built cannot take serializers; it is used as it is.
  if ('info' in options && typeof options.info === 'function') return logger
  return {
    ...options,
    serializers: {
      ...options.serializers,
      // The same fields as Fastify's own request serializer, less the path and the query.
      req: (request: FastifyRequest) => ({
        method: request.method,
        url: isAdminUrl(request.url, adminPath) ? '[admin]' : request.url,
        host: request.host,
        remoteAddress: request.ip,
        remotePort: request.socket?.remotePort,
      }),
    },
  }
}

/** The plugin-facing HTTP service: error handling, a per-IP rate limit, and every route group. */
export function buildRegistrationApp(deps: RegistrationDeps): FastifyInstance {
  const adminPath = deps.admin?.env.admin?.path
  const logger = adminPath === undefined ? deps.logger : hidingAdminPath(deps.logger, adminPath)
  const app = Fastify({ trustProxy: deps.trustProxy, logger }).withTypeProvider<TypeBoxTypeProvider>()
  app.setValidatorCompiler(TypeBoxValidatorCompiler)

  registerErrorHandler(app)
  // The limiter counts in real time (its own in-memory store), not with the injected clock. The routes that send
  // or check a code have a stricter limit of their own (see codeRouteConfig), which replaces this one for them; the
  // admin API behind its login has a larger one of its own, so this one lets its requests through.
  app.register(rateLimit, {
    max: deps.config.httpRateLimitPerMinute,
    timeWindow: '1 minute',
    errorResponseBuilder: () => new ApiError(429, 'rate_limited'),
    allowList: (request) => isAdminApiRequest(request),
  })
  app.register(registrationRoutes(deps))
  app.register(meRoutes(deps))
  app.register(recordsRoutes(deps))
  app.register(keyResetRoutes(deps))
  app.register(schoolRoutes(deps))
  if (deps.admin !== undefined && adminPath !== undefined) app.register(adminRoutes(deps.admin), { prefix: adminPath })

  return app
}
