import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import type { Kysely } from 'kysely'
import type { Static } from 'typebox'
import type { ModerationCategory } from '../moderation/moderator.js'
import {
  INTRO_ATTEMPTS_PER_DAY,
  INTRO_MAX_CHARS,
  IntroRequest,
  IntroResult,
  type InvalidIntroError,
} from '../protocol/http.js'
import type { Database } from '../shared/db.js'
import { addDaysToDate, localDate } from '../shared/local-time.js'
import type { RegistrationDeps } from './app.js'
import { requireStudent, studentOf, type StudentRow } from './auth.js'
import { ApiError } from './errors.js'

// The self-introduction (PATCH /v1/me/intro): checked against the school's word list only, at once, with no model, and
// stored as checked; the class service reads it out in the first session of each class the student joins. Tries are
// counted per student and school-timezone day, rejected ones included, so the word list cannot be probed cheaply.

/** Where an owner tells the school a check was wrong, or asks for more tries. */
export const FEEDBACK_GROUP = 'QQ 群 1137264978'

/** Whitespace at either end removed and every run of it (line breaks included) made one space. */
export function normalizeIntro(text: string): string {
  return text.trim().replace(/\s+/g, ' ')
}

/** Code points, as owners count characters (an emoji is one). */
export const introLength = (text: string): number => [...text].length

const BLOCKED_BECAUSE: Record<ModerationCategory, string> = {
  sensitive: '自我介绍里有学校不允许的词语',
  injection: '自我介绍里有像是在给 AI 下指令的话',
  privacy: '自我介绍里好像有电话、证件号、邮箱之类的个人信息，为了安全不能交',
}

/** What the owner is told about the tries left today, after a try. */
export function attemptsLeftText(left: number): string {
  if (left === 0) return `今天的 ${INTRO_ATTEMPTS_PER_DAY} 次机会已经用完了，明天再来；着急的话可以加${FEEDBACK_GROUP}找管理员恢复次数。`
  if (left === 1) return `今天只剩最后 1 次机会了，请仔细检查再交；如果还需要更多次数，可以加${FEEDBACK_GROUP}找管理员在后台恢复。`
  return `今天还能交 ${left} 次。`
}

/** The tries a student has used today: the stored count when it is today's, else none. */
export function attemptsUsed(student: Pick<StudentRow, 'introAttempts' | 'introAttemptsOn'>, today: string): number {
  return student.introAttemptsOn === today ? student.introAttempts : 0
}

/** The tries a student has left today. */
export function introAttemptsLeft(student: Pick<StudentRow, 'introAttempts' | 'introAttemptsOn'>, today: string): number {
  return Math.max(0, INTRO_ATTEMPTS_PER_DAY - attemptsUsed(student, today))
}

type Result = Static<typeof IntroResult>
type InvalidIntro = Static<typeof InvalidIntroError>['error']

function invalidIntro(extra: Omit<InvalidIntro, 'code' | 'message'>, message: string): ApiError {
  return new ApiError(400, 'invalid_intro', extra, message)
}

export function introRoutes(deps: RegistrationDeps): FastifyPluginAsyncTypebox {
  return async (app) => {
    app.patch(
      '/v1/me/intro',
      { preHandler: requireStudent(deps), schema: { body: IntroRequest, response: { 200: IntroResult } } },
      async (request) => {
        const result = await handInIntro(deps, studentOf(request).id, request.body.intro)
        // Numbers and outcomes only, never the text.
        request.log.info({ studentId: studentOf(request).id, attemptsLeft: result.attemptsLeft }, 'intro handed in')
        return result
      },
    )
  }
}

/** Hands in, changes or deletes the intro of student `id`; throws the 4xx answers. */
export async function handInIntro(deps: RegistrationDeps, id: number, raw: string): Promise<Result> {
  const { db, config, clock, moderator } = deps
  const intro = normalizeIntro(raw)
  const now = clock.now()
  const today = localDate(now, config.timezone)

  type Outcome = Result | { blocked: ModerationCategory; attemptsLeft: number }
  return db.transaction().execute(async (trx): Promise<Outcome> => {
    // Locked, so two tries at once cannot both take the last one.
    const student = await lockedStudent(trx, id)
    if (student.status === 'dropped' || student.status === 'expelled') {
      throw new ApiError(409, 'wrong_status', {}, '已经离开学校的学生不能交自我介绍。')
    }
    const used = attemptsUsed(student, today)
    const left = Math.max(0, INTRO_ATTEMPTS_PER_DAY - used)

    // Deleting, or handing in what is stored already, changes nothing worth a try.
    if (intro === '' || intro === student.intro) {
      if (intro === '' && student.intro !== null) {
        await trx.updateTable('students').set({ intro: null }).where('id', '=', id).execute()
      }
      const message = intro === '' ? '自我介绍已经删掉了。' : '和现在的自我介绍一样，没有改动。'
      return { intro: intro === '' ? null : intro, attemptsLeft: left, message: `${message}${attemptsLeftText(left)}` }
    }

    if (introLength(intro) > INTRO_MAX_CHARS) {
      throw invalidIntro(
        { reason: 'too_long', attemptsLeft: left },
        `自我介绍最多 ${INTRO_MAX_CHARS} 个字，这段有 ${introLength(intro)} 个字，请删短一点再交。这次不算次数。`,
      )
    }

    if (left === 0) {
      throw new ApiError(
        429,
        'intro_limit',
        { retryAfter: addDaysToDate(today, 1) },
        `今天的 ${INTRO_ATTEMPTS_PER_DAY} 次机会已经用完了，明天再来；着急的话可以加${FEEDBACK_GROUP}找管理员恢复次数。`,
      )
    }

    const after = left - 1
    await trx
      .updateTable('students')
      .set({ introAttempts: used + 1, introAttemptsOn: today })
      .where('id', '=', id)
      .execute()

    const verdict = moderator.check(intro)
    if (verdict.verdict === 'blocked') {
      // The rejected try stays counted: the transaction commits, and the 400 is thrown after it.
      return { blocked: verdict.category, attemptsLeft: after }
    }

    await trx.updateTable('students').set({ intro }).where('id', '=', id).execute()
    return {
      intro,
      attemptsLeft: after,
      message: `自我介绍交上去了，进新班的第一节课老师会念给全班听。${attemptsLeftText(after)}`,
    }
  }).then((outcome) => {
    if ('blocked' in outcome) {
      throw invalidIntro(
        { reason: 'moderation', category: outcome.blocked, attemptsLeft: outcome.attemptsLeft },
        `${BLOCKED_BECAUSE[outcome.blocked]}，没有通过审核，请改一改再交。觉得判错了，可以加${FEEDBACK_GROUP}告诉我们。${attemptsLeftText(outcome.attemptsLeft)}`,
      )
    }
    return outcome
  })
}

async function lockedStudent(trx: Kysely<Database>, id: number): Promise<StudentRow> {
  return trx.selectFrom('students').selectAll().where('id', '=', id).forUpdate().executeTakeFirstOrThrow()
}
