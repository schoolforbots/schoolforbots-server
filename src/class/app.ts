import websocket from '@fastify/websocket'
import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyServerOptions } from 'fastify'
import type { Kysely } from 'kysely'
import type { Moderator } from '../moderation/moderator.js'
import type { Clock } from '../shared/clock.js'
import type { SchoolConfig } from '../shared/config.js'
import type { Database } from '../shared/schema.js'
import { hashSecret } from '../shared/secrets.js'
import { serveConnection, type ConnectionContext, type MessageHandlers, type StudentRow } from './connection.js'
import type { LessonHooks } from './hooks.js'
import type { MemoryHub } from './hub.js'
import type { ClassRuntime } from './runtime.js'

export interface ClassDeps {
  db: Kysely<Database>
  config: SchoolConfig
  moderator: Moderator
  clock: Clock
  /** Which session each class is in; a student may be connected only from its doors to its close. */
  runtime: ClassRuntime
  /** The hub the runtime pushes through. The app registers every connection in it at hello. */
  hub: MemoryHub
  /**
   * The lesson hooks, the same ones the runtime runs: `onDisconnect` is called when a student goes offline (their
   * connection closed and no newer one has taken its place).
   */
  hooks: Pick<LessonHooks, 'onDisconnect'>
  /** What the messages after hello do. A message whose handler is missing is answered `invalid_message`. */
  handlers?: Partial<MessageHandlers>
  /** Fastify logger options; unset means no logging. */
  logger?: FastifyServerOptions['logger']
}

/** The most a frame may carry, as the protocol says; a bigger one closes the connection with 1009. */
const MAX_FRAME_BYTES = 16 * 1024

// As in the registration service: the scheme is case-insensitive, and one or more spaces separate it from the key.
const BEARER = /^Bearer\s+(\S+)$/i

/**
 * The classroom WebSocket service: `GET /v1/class`, upgraded with `Authorization: Bearer <key>`. A missing or unknown
 * key is refused with 401 before the WebSocket opens. See src/protocol/ws.ts for the messages and connection.ts for
 * what happens on a connection.
 */
export function buildClassApp(deps: ClassDeps): FastifyInstance {
  const app = Fastify({ logger: deps.logger })
  const ctx: ConnectionContext = { deps, announced: new WeakSet() }
  // The student each upgrade's key belongs to, from the auth hook to the WebSocket handler.
  const students = new WeakMap<FastifyRequest, StudentRow>()

  app.register(websocket, {
    options: { maxPayload: MAX_FRAME_BYTES },
    // Errors of an open connection (a frame too big, a client gone uncleanly): `ws` closes the connection itself.
    errorHandler(error, socket, request) {
      request.log.warn({ err: error }, 'class connection error')
      if (socket.readyState === socket.OPEN) socket.close(1011)
    },
  })

  app.register(async (scope) => {
    scope.get(
      '/v1/class',
      {
        websocket: true,
        onRequest: async (request, reply) => {
          const key = BEARER.exec(request.headers.authorization ?? '')?.[1]
          const student =
            key === undefined
              ? undefined
              : await deps.db
                  .selectFrom('students')
                  .selectAll()
                  .where('keyHash', '=', hashSecret(key))
                  .executeTakeFirst()
          if (student === undefined) {
            return reply.code(401).send({ error: { code: 'unauthorized', message: '钥匙无效，请检查后再试。' } })
          }
          students.set(request, student)
        },
      },
      (socket, request) => {
        const student = students.get(request)
        try {
          if (student === undefined) throw new Error('The upgrade reached the handler without a student')
          // The peer's address: no proxy in front is trusted to name the client.
          serveConnection(ctx, socket, { student, ip: request.ip ?? null, log: request.log })
        } catch (err) {
          request.log.error({ err }, 'class connection failed')
          socket.close(1011)
        }
      },
    )
  })

  return app
}
