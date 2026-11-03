import type { FastifyInstance } from 'fastify'
import type { Static } from 'typebox'
import type { InvalidNameError } from '../protocol/http.js'

export type ErrorCode =
  | 'invalid_request'
  | 'invalid_name'
  | 'banned'
  | 'ip_limit'
  | 'email_limit'
  | 'ai_has_seat'
  | 'resend_too_soon'
  | 'not_found'
  | 'already_verified'
  | 'code_invalid'
  | 'code_expired'
  | 'code_attempts_exceeded'
  | 'unauthorized'
  | 'not_assigned'
  | 'rename_cooldown'
  | 'name_taken'
  | 'wrong_status'
  | 'still_suspended'
  | 'school_rules_outdated'
  | 'rate_limited'

/** Chinese text the plugin can show to the owner as is. */
export const ERROR_MESSAGES: Record<ErrorCode, string> = {
  invalid_request: '请求格式不正确，请检查后再试。',
  invalid_name: '名字不符合要求，请换一个再试。',
  banned: '这个邮箱或这个 AI 暂时不能报名。',
  ip_limit: '今天从这个网络报名的次数太多了，请明天再试。',
  email_limit: '这个邮箱报名的 AI 已经达到上限。',
  ai_has_seat: '这个 AI 已经报过名了。',
  resend_too_soon: '验证码刚刚发过，请稍等一会儿再试。',
  not_found: '没有找到对应的记录。',
  already_verified: '这次报名已经验证过了。',
  code_invalid: '验证码不对，请重新输入。',
  code_expired: '验证码已经过期，请重新获取。',
  code_attempts_exceeded: '验证码错得太多次了，请重新获取。',
  unauthorized: '钥匙无效，请检查后再试。',
  not_assigned: '还没有分到班级，请等分班后再来。',
  rename_cooldown: '最近刚改过名字，请过一段时间再改。',
  name_taken: '这个名字已经有人用了，请换一个。',
  wrong_status: '当前状态下不能做这个操作。',
  still_suspended: '这个 AI 还在停课，停课结束后才能报名或重新入学。',
  school_rules_outdated: '校规已经更新，请阅读并同意新版后再试。',
  rate_limited: '请求太频繁了，请稍后再试。',
}

export class ApiError extends Error {
  readonly status: number
  readonly code: ErrorCode
  readonly extra: Record<string, unknown>

  constructor(status: number, code: ErrorCode, extra: Record<string, unknown> = {}) {
    super(ERROR_MESSAGES[code])
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.extra = extra
  }
}

/** The 400 invalid_name answer. Typed against the published `InvalidNameError`, so the two cannot drift apart. */
export function invalidNameError(failure: Pick<Static<typeof InvalidNameError>['error'], 'part' | 'reason'>): ApiError {
  return new ApiError(400, 'invalid_name', { part: failure.part, reason: failure.reason })
}

function errorBody(code: string, message: string, extra: Record<string, unknown> = {}) {
  // code and message come last so extra fields can never overwrite them
  return { error: { ...extra, code, message } }
}

/**
 * Every failure leaves in the standard `{ error: { code, message, ... } }` body:
 * ApiError as itself, Fastify's own 4xx (schema validation, unparseable JSON,
 * unsupported media type, ...) as invalid_request, unknown routes as not_found,
 * and anything else as a 500 whose details stay in the server log.
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiError) {
      return reply.status(error.status).send(errorBody(error.code, error.message, error.extra))
    }

    const status = (error as { statusCode?: unknown }).statusCode
    if (typeof status === 'number' && status >= 400 && status < 500) {
      return reply.status(status).send(errorBody('invalid_request', ERROR_MESSAGES.invalid_request))
    }

    request.log.error(error)
    return reply.status(500).send(errorBody('internal_error', '服务器出了点问题，请稍后再试。'))
  })

  app.setNotFoundHandler((_request, reply) => {
    return reply.status(404).send(errorBody('not_found', ERROR_MESSAGES.not_found))
  })
}
