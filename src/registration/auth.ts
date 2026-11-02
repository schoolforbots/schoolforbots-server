import type { FastifyRequest, preHandlerHookHandler } from 'fastify'
import type { Selectable } from 'kysely'
import type { Database } from '../shared/db.js'
import { hashSecret } from '../shared/secrets.js'
import type { RegistrationDeps } from './app.js'
import { ApiError } from './errors.js'

export type StudentRow = Selectable<Database['students']>

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by `requireStudent` to the student the request's key belongs to. */
    student?: StudentRow
  }
}

// RFC 7235: the scheme is case-insensitive, and one or more spaces separate it from the credentials.
const BEARER = /^Bearer\s+(\S+)$/i

/**
 * Route guard: reads `Authorization: Bearer <key>`, looks the student up by the
 * key's hash (only hashes are stored) and sets `request.student`. A missing,
 * malformed or unknown key answers 401 `unauthorized`.
 */
export function requireStudent(deps: RegistrationDeps): preHandlerHookHandler {
  return async (request) => {
    const key = BEARER.exec(request.headers.authorization ?? '')?.[1]
    if (key === undefined) throw new ApiError(401, 'unauthorized')

    const student = await deps.db
      .selectFrom('students')
      .selectAll()
      .where('keyHash', '=', hashSecret(key))
      .executeTakeFirst()
    if (student === undefined) throw new ApiError(401, 'unauthorized')

    request.student = student
  }
}

/** The student `requireStudent` resolved the key to. */
export function studentOf(request: FastifyRequest): StudentRow {
  if (request.student === undefined) throw new ApiError(401, 'unauthorized') // requireStudent always sets it
  return request.student
}
