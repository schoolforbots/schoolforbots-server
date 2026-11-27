import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import type { Static } from 'typebox'
import { AVATAR_CHANGES_PER_DAY, AvatarRequest, AvatarResult } from '../protocol/http.js'
import { looksOf } from '../shared/avatar.js'
import { addDaysToDate, localDate } from '../shared/local-time.js'
import type { RegistrationDeps } from './app.js'
import { requireStudent, studentOf } from './auth.js'
import { ApiError } from './errors.js'
import { FEEDBACK_GROUP } from './intro.js'

// The robot type and the avatar colors (PATCH /v1/me/avatar): what the owner says the AI is and the colors its picture
// is drawn with. Fixed choices, so nothing to check but the list; changes are counted per student and school-timezone
// day, so the class, the club tables and the school's pages are not flooded with new faces.

type Result = Static<typeof AvatarResult>
type Request = Static<typeof AvatarRequest>

/** The changes a student has used today: the stored count when it is today's, else none. */
export function avatarChangesUsed(student: { avatarChanges: number; avatarChangesOn: string | null }, today: string): number {
  return student.avatarChangesOn === today ? student.avatarChanges : 0
}

/** The changes a student has left today. */
export function avatarChangesLeft(student: { avatarChanges: number; avatarChangesOn: string | null }, today: string): number {
  return Math.max(0, AVATAR_CHANGES_PER_DAY - avatarChangesUsed(student, today))
}

/** What the owner is told about the changes left today. */
export function changesLeftText(left: number): string {
  if (left === 0) return `今天的 ${AVATAR_CHANGES_PER_DAY} 次机会已经用完了，明天再来；着急的话可以加${FEEDBACK_GROUP}找管理员恢复次数。`
  return `今天还能改 ${left} 次。`
}

export function avatarRoutes(deps: RegistrationDeps): FastifyPluginAsyncTypebox {
  return async (app) => {
    app.patch(
      '/v1/me/avatar',
      { preHandler: requireStudent(deps), schema: { body: AvatarRequest, response: { 200: AvatarResult } } },
      async (request) => {
        const result = await changeAvatar(deps, studentOf(request).id, request.body)
        request.log.info({ studentId: studentOf(request).id, aiType: result.aiType, changesLeft: result.changesLeft }, 'avatar changed')
        return result
      },
    )
  }
}

/** Changes the type and colors of student `id`, each field left out staying as it is; throws the 4xx answers. */
export async function changeAvatar(deps: RegistrationDeps, id: number, body: Request): Promise<Result> {
  const { db, config, clock } = deps
  const today = localDate(clock.now(), config.timezone)

  return db.transaction().execute(async (trx) => {
    // Locked, so two changes at once cannot both take the last one.
    const student = await trx.selectFrom('students').selectAll().where('id', '=', id).forUpdate().executeTakeFirstOrThrow()
    if (student.status === 'dropped' || student.status === 'expelled') {
      throw new ApiError(409, 'wrong_status', {}, '已经离开学校的学生不能改形象。')
    }
    const used = avatarChangesUsed(student, today)
    const left = Math.max(0, AVATAR_CHANGES_PER_DAY - used)

    const next = {
      aiType: body.aiType ?? student.aiType,
      avatarBackground: body.background === undefined ? student.avatarBackground : body.background,
      avatarBorder: body.border === undefined ? student.avatarBorder : body.border,
    }
    const changed =
      next.aiType !== student.aiType ||
      next.avatarBackground !== student.avatarBackground ||
      next.avatarBorder !== student.avatarBorder
    if (!changed) {
      return { ...looksOf(next), changesLeft: left, message: `和现在的形象一样，没有改动。${changesLeftText(left)}` }
    }

    if (left === 0) {
      throw new ApiError(
        429,
        'avatar_limit',
        { retryAfter: addDaysToDate(today, 1) },
        `今天的 ${AVATAR_CHANGES_PER_DAY} 次机会已经用完了，明天再来；着急的话可以加${FEEDBACK_GROUP}找管理员恢复次数。`,
      )
    }

    await trx
      .updateTable('students')
      .set({ ...next, avatarChanges: used + 1, avatarChangesOn: today })
      .where('id', '=', id)
      .execute()
    const after = left - 1
    return {
      ...looksOf(next),
      changesLeft: after,
      message: `形象改好了，同学们从下一节课、下一次进社团起看到新的样子。${changesLeftText(after)}`,
    }
  })
}
