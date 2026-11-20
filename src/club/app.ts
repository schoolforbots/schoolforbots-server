import websocket from '@fastify/websocket'
import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyServerOptions } from 'fastify'
import type { Kysely } from 'kysely'
import type { Clock } from '../shared/clock.js'
import type { SchoolConfig } from '../shared/config.js'
import { databaseAlive, registerHealthz } from '../shared/healthz.js'
import type { Maintenance } from '../shared/maintenance.js'
import type { Database } from '../shared/schema.js'
import { hashSecret } from '../shared/secrets.js'
import type { Club } from './club.js'
import { MAX_FRAME_BYTES, serveConnection } from './connection.js'
import type { ClubClosed } from './hours.js'

export interface ClubDeps {
  db: Kysely<Database>
  config: SchoolConfig
  clock: Clock
  /** The club: the connections, the rooms and the rest, and the game (see club.ts). */
  club: Club
  /**
   * How long a connection has to send a valid hello before it is told so (`service_stopping`) and closed, in real
   * milliseconds. Default `HELLO_TIMEOUT_MS`, as in the class.
   */
  helloTimeoutMs?: number
  /** How often every connection is pinged, in real milliseconds. Default `PING_INTERVAL_MS`, as in the class. */
  pingIntervalMs?: number
  /** The window `club.connection.framesPerMinute` counts a connection's frames in. Default a minute. */
  rateWindowMs?: number
  /**
   * Whether the service is stopping: from then on nobody comes in, and a hello still going is answered with
   * `service_stopping` instead of joining. Unset: never.
   */
  stopping?: () => boolean
  /**
   * The maintenance now on, or null. While it is on nobody comes in (`maintenance`), and every message is answered
   * `club_closed`. Unset: never.
   */
  maintenance?: () => Maintenance | null
  /**
   * Whether the clubs are switched on; while not, nobody comes in (`club_closed` with no `reopensAt`). Unset:
   * `club.enabled` of the config.
   */
  clubEnabled?: () => boolean
  /** Whether the club is closed by the timetable at a moment. Unset: `clubClosedAt` of the config. */
  closedAt?: (now: Date) => ClubClosed
  /** What `GET /healthz` checks. Unset: only that the database answers. */
  healthCheck?: () => Promise<boolean>
  /** Called each time something unexpected goes wrong in a connection (the places that close it with 1011). */
  onInternalError?: () => void
  /** Fastify logger options; unset means no logging. */
  logger?: FastifyServerOptions['logger']
}

/** The hard ceiling on a frame, as in the class: past it the connection closes with 1009 before it is read whole. */
const WS_MAX_PAYLOAD = 4 * MAX_FRAME_BYTES

const BEARER = /^Bearer\s+(\S+)$/i

/**
 * The club WebSocket service: `GET /v1/club`, upgraded with `Authorization: Bearer <key>`. A missing or unknown key is
 * refused with 401 before the WebSocket opens. See src/protocol/club.ts for the messages and connection.ts for what
 * happens on a connection.
 */
export function buildClubApp(deps: ClubDeps): FastifyInstance {
  const app = Fastify({ logger: deps.logger })
  const noteInternalError = () => {
    try {
      deps.onInternalError?.()
    } catch {
      // Counting an error must not change what happens to the connection.
    }
  }
  // The student each upgrade's key belongs to, from the auth hook to the WebSocket handler.
  const students = new WeakMap<FastifyRequest, number>()

  registerHealthz(app, deps.healthCheck ?? (() => databaseAlive(deps.db)))

  app.register(websocket, {
    options: { maxPayload: WS_MAX_PAYLOAD },
    errorHandler(error, socket, request) {
      request.log.warn({ err: error }, 'club connection error')
      if (socket.readyState === socket.OPEN) {
        noteInternalError()
        socket.close(1011)
      }
    },
  })

  app.register(async (scope) => {
    scope.get(
      '/v1/club',
      {
        websocket: true,
        onRequest: async (request, reply) => {
          const key = BEARER.exec(request.headers.authorization ?? '')?.[1]
          const student =
            key === undefined
              ? undefined
              : await deps.db
                  .selectFrom('students')
                  .select('id')
                  .where('keyHash', '=', hashSecret(key))
                  .executeTakeFirst()
          if (student === undefined) {
            return reply.code(401).send({ error: { code: 'unauthorized', message: '钥匙无效，请检查后再试。' } })
          }
          students.set(request, student.id)
        },
      },
      (socket, request) => {
        const studentId = students.get(request)
        try {
          if (studentId === undefined) throw new Error('The upgrade reached the handler without a student')
          serveConnection(deps, socket, { studentId, log: request.log })
        } catch (err) {
          request.log.error({ err }, 'club connection failed')
          noteInternalError()
          socket.close(1011)
        }
      },
    )
  })

  return app
}
