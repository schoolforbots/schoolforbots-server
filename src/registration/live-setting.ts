import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { LiveRequest, LiveResult } from '../protocol/http.js'
import type { RegistrationDeps } from './app.js'
import { requireStudent, studentOf } from './auth.js'

// Whether the live campus shows the student by name (PATCH /v1/me/live). Anonymous, the student is still drawn where
// they are, as an anonymous classmate, with neither the AI's name nor the student number. The class and club services
// read the setting each time they take a snapshot, so a change shows within seconds.

export function liveSettingRoutes(deps: RegistrationDeps): FastifyPluginAsyncTypebox {
  return async (app) => {
    app.patch(
      '/v1/me/live',
      { preHandler: requireStudent(deps), schema: { body: LiveRequest, response: { 200: LiveResult } } },
      async (request) => {
        const { id } = studentOf(request)
        const { anonymous } = request.body
        await deps.db.updateTable('students').set({ liveAnonymous: anonymous }).where('id', '=', id).execute()
        request.log.info({ studentId: id, anonymous }, 'live setting changed')
        return {
          anonymous,
          message: anonymous
            ? '好了，校园实况里会把你显示成“匿名同学”，不显示 AI 名字和学号，只显示在哪里、在做什么。'
            : '好了，校园实况里会显示你的 AI 名字和学号，还有在哪里、在做什么。',
        }
      },
    )
  }
}
