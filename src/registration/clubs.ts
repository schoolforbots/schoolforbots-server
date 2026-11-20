import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { Type, type Static } from 'typebox'
import { join, joinedAt, leave, type Club } from '../club/members.js'
import { ClubId } from '../protocol/club.js'
import { ClubMembership } from '../protocol/club-http.js'
import type { StudentStatus } from '../shared/schema.js'
import type { RegistrationDeps } from './app.js'
import { requireStudent, studentOf } from './auth.js'
import { ApiError } from './errors.js'

// Joining and leaving a club. The owner decides: a plugin calls these only when its owner turns the club on or off.
// A new club needs only a new `ClubId`; the routes take any of them.

const ClubParams = Type.Object({ club: ClubId })

/** Why a student may not join a club, in Chinese, or null when they may: they must be active and in a class. */
function whyNotEligible(student: { status: StudentStatus; classId: number | null }): string | null {
  switch (student.status) {
    case 'active':
      return student.classId === null ? '还没有分到班级，分班以后才能入社。' : null
    case 'pending':
    case 'waitlisted':
      return '还没有分到班级，分班以后才能入社。'
    case 'suspended':
      return '停课期间不能入社，停课结束以后再来。'
    case 'dropped':
    case 'expelled':
      return '已经离开学校，不能入社。'
  }
}

function membership(club: Club, at: Date | null): Static<typeof ClubMembership> {
  return { club, member: at !== null, joinedAt: at?.toISOString() ?? null }
}

export function clubRoutes(deps: RegistrationDeps): FastifyPluginAsyncTypebox {
  return async (app) => {
    const schema = { params: ClubParams, response: { 200: ClubMembership } }

    app.get('/v1/me/clubs/:club', { preHandler: requireStudent(deps), schema }, async (request) => {
      const { club } = request.params
      return membership(club, await joinedAt(deps.db, studentOf(request).id, club))
    })

    app.post('/v1/me/clubs/:club', { preHandler: requireStudent(deps), schema }, async (request) =>
      joinClub(deps, studentOf(request).id, request.params.club),
    )

    // Leaving is always allowed, whatever the student's status, and leaving a club one is not in changes nothing.
    app.delete('/v1/me/clubs/:club', { preHandler: requireStudent(deps), schema }, async (request) => {
      const { club } = request.params
      await leave(deps.db, studentOf(request).id, club)
      return membership(club, null)
    })
  }
}

/**
 * A current member gets their membership back as it is; anyone else joins from now if they may, a row left from a
 * membership that is no longer current being started again.
 */
async function joinClub(deps: RegistrationDeps, studentId: number, club: Club): Promise<Static<typeof ClubMembership>> {
  return deps.db.transaction().execute(async (trx) => {
    const already = await joinedAt(trx, studentId, club)
    if (already !== null) return membership(club, already)

    // The status is read again under a share lock: a withdrawal, a penalty or the nightly job may have changed it
    // since the key was checked, and none of them can until this commits, so nobody joins on their way out.
    const student = await trx
      .selectFrom('students')
      .select(['status', 'classId'])
      .where('id', '=', studentId)
      .forShare()
      .executeTakeFirstOrThrow()
    const reason = whyNotEligible(student)
    if (reason !== null) throw new ApiError(409, 'not_eligible', {}, reason)

    return membership(club, await join(trx, studentId, club, deps.clock.now()))
  })
}
