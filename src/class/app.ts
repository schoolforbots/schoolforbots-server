import websocket from '@fastify/websocket'
import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyServerOptions } from 'fastify'
import type { Kysely } from 'kysely'
import type { Moderator } from '../moderation/moderator.js'
import type { Clock } from '../shared/clock.js'
import type { SchoolConfig } from '../shared/config.js'
import { databaseAlive, registerHealthz } from '../shared/healthz.js'
import { inetAddress } from '../shared/net.js'
import type { Database } from '../shared/schema.js'
import { hashSecret } from '../shared/secrets.js'
import {
  MAX_FRAME_BYTES,
  serveConnection,
  type ConnectionContext,
  type MessageHandlers,
  type StudentRow,
} from './connection.js'
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
  /**
   * How long a connection has to send a valid hello before it is told so and closed, in real milliseconds (the
   * lesson clock and the timeline speed have no say in it). Default `HELLO_TIMEOUT_MS`.
   */
  helloTimeoutMs?: number
  /**
   * How often every connection is pinged, in real milliseconds; one that has not answered the previous ping by the
   * next is dropped. Default `PING_INTERVAL_MS`.
   */
  pingIntervalMs?: number
  /**
   * The window `classConnection.framesPerMinute` counts a connection's frames in, in real milliseconds. Default
   * `RATE_WINDOW_MS`, a minute; tests shorten it.
   */
  rateWindowMs?: number
  /**
   * Whether the service is stopping: it has sent everyone connected the maintenance `closing`. From then on nobody
   * comes in: a new connection is told the same at the door, and a hello still going is answered with it instead of
   * joining. Unset: never.
   */
  stopping?: () => boolean
  /**
   * True when the service runs behind a reverse proxy whose X-Forwarded-For can be trusted: the address a student's
   * messages are kept with is then the client's that the proxy names, not the proxy's. Unset: false.
   */
  trustProxy?: boolean
  /** What `GET /healthz` checks. Unset: only that the database answers. */
  healthCheck?: () => Promise<boolean>
  /** Fastify logger options; unset means no logging. */
  logger?: FastifyServerOptions['logger']
}

/**
 * The hard ceiling on a frame, well above the protocol's `MAX_FRAME_BYTES`: a frame between the two is answered
 * `invalid_message`, and one past this closes the connection with 1009 before it is read into memory whole.
 */
const WS_MAX_PAYLOAD = 4 * MAX_FRAME_BYTES

// As in the registration service: the scheme is case-insensitive, and one or more spaces separate it from the key.
const BEARER = /^Bearer\s+(\S+)$/i

/**
 * The classroom WebSocket service: `GET /v1/class`, upgraded with `Authorization: Bearer <key>`. A missing or unknown
 * key is refused with 401 before the WebSocket opens. See src/protocol/ws.ts for the messages and connection.ts for
 * what happens on a connection.
 */
export function buildClassApp(deps: ClassDeps): FastifyInstance {
  const app = Fastify({ trustProxy: deps.trustProxy ?? false, logger: deps.logger })
  const ctx: ConnectionContext = { deps, announced: new WeakSet() }
  // The student each upgrade's key belongs to, from the auth hook to the WebSocket handler.
  const students = new WeakMap<FastifyRequest, StudentRow>()

  registerHealthz(app, deps.healthCheck ?? (() => databaseAlive(deps.db)))

  app.register(websocket, {
    options: { maxPayload: WS_MAX_PAYLOAD },
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
          // The peer's address, or behind a trusted proxy the client's it names (see `ClassDeps.trustProxy`).
          serveConnection(ctx, socket, { student, ip: inetAddress(request.ip), log: request.log })
        } catch (err) {
          request.log.error({ err }, 'class connection failed')
          socket.close(1011)
        }
      },
    )
  })

  return app
}
