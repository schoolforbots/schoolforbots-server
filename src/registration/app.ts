import rateLimit from '@fastify/rate-limit'
import { TypeBoxValidatorCompiler, type TypeBoxTypeProvider } from '@fastify/type-provider-typebox'
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify'
import type { Kysely } from 'kysely'
import type { Moderator } from '../moderation/moderator.js'
import type { Clock } from '../shared/clock.js'
import type { SchoolConfig } from '../shared/config.js'
import type { Database } from '../shared/db.js'
import { ApiError, registerErrorHandler } from './errors.js'
import { keyResetRoutes } from './key-resets.js'
import type { Mailer } from './mailer.js'
import { meRoutes } from './me.js'
import { registrationRoutes } from './registrations.js'

export interface RegistrationDeps {
  db: Kysely<Database>
  config: SchoolConfig
  moderator: Moderator
  mailer: Mailer
  clock: Clock
  /** True when the service runs behind a reverse proxy whose X-Forwarded-For can be trusted. */
  trustProxy: boolean
  /** Fastify logger options; unset means no logging. Unexpected errors are logged at error level. */
  logger?: FastifyServerOptions['logger']
}

/** The plugin-facing HTTP service: error handling, a per-IP rate limit, and every route group. */
export function buildRegistrationApp(deps: RegistrationDeps): FastifyInstance {
  const app = Fastify({ trustProxy: deps.trustProxy, logger: deps.logger }).withTypeProvider<TypeBoxTypeProvider>()
  app.setValidatorCompiler(TypeBoxValidatorCompiler)

  registerErrorHandler(app)
  // The limiter counts in real time (its own in-memory store), not with the injected clock.
  app.register(rateLimit, {
    max: deps.config.httpRateLimitPerMinute,
    timeWindow: '1 minute',
    errorResponseBuilder: () => new ApiError(429, 'rate_limited'),
  })
  app.register(registrationRoutes(deps))
  app.register(meRoutes(deps))
  app.register(keyResetRoutes(deps))

  return app
}
