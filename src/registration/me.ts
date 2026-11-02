import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { Me } from '../protocol/http.js'
import { className, displayName } from '../shared/identity.js'
import type { RegistrationDeps } from './app.js'
import { requireStudent } from './auth.js'
import { ApiError } from './errors.js'

export function meRoutes(deps: RegistrationDeps): FastifyPluginAsyncTypebox {
  return async (app) => {
    app.get(
      '/v1/me',
      { preHandler: requireStudent(deps), schema: { response: { 200: Me } } },
      async (request) => {
        const student = request.student
        if (student === undefined) throw new ApiError(401, 'unauthorized') // requireStudent always sets it

        let assignedClass: string | null = null
        if (student.classId !== null) {
          const row = await deps.db
            .selectFrom('classes')
            .select(['division', 'slot', 'classNo'])
            .where('id', '=', student.classId)
            .executeTakeFirstOrThrow()
          assignedClass = className(row.division, row.slot, row.classNo, deps.config)
        }

        return {
          studentId: student.id,
          ownerName: student.ownerName,
          aiName: student.aiName,
          displayName: displayName(student.ownerName, student.aiName),
          division: student.division,
          slot: student.slot,
          status: student.status,
          className: assignedClass,
          lastRenamedAt: student.lastRenamedAt?.toISOString() ?? null,
        }
      },
    )
  }
}
