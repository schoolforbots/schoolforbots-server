import { describe, expect, it } from 'vitest'
import type { LessonDetail, LessonQueue, NoticeView } from './api.js'
import { answer } from '../mock/school.js'

// The pretend school of `npm run admin:mock` answers as the server does, so the pages can be worked on against it.

describe('the mock school', () => {
  it('logs out, refuses a code that is not 6 digits, and takes any password with one', () => {
    expect(answer('GET', 'session').status).toBe(200)
    expect(answer('POST', 'logout').status).toBe(200)
    expect(answer('GET', 'lessons/queue')).toMatchObject({ status: 401, body: { error: { code: 'admin_login_required' } } })
    expect(answer('POST', 'login', { password: 'x', code: '12' })).toMatchObject({
      status: 401,
      body: { error: { code: 'admin_login_failed', message: '密码或验证码不对。' } },
    })
    expect(answer('POST', 'login', { password: 'x', code: '123456' }).status).toBe(200)
  })

  it('will not approve a lesson with red marks until they are called false positives', () => {
    const queue = answer('GET', 'lessons/queue').body as LessonQueue
    const flagged = queue.days.flatMap((day) => day.divisions).find((slot) => slot.status === 'flagged')
    const id = flagged?.lessonId ?? 0
    let lesson = answer('GET', `lessons/${id}`).body as LessonDetail
    expect(answer('POST', `lessons/${id}/approve`, { baseVersion: lesson.version })).toMatchObject({
      status: 409,
      body: { error: { code: 'lesson_has_flags' } },
    })
    for (const rule of [...new Set(lesson.flags.map((flag) => flag.rule))]) {
      lesson = answer('POST', `lessons/${id}/false-positive`, { baseVersion: lesson.version, rule }).body as LessonDetail
    }
    expect(answer('POST', `lessons/${id}/approve`, { baseVersion: lesson.version - 1 }).status).toBe(409)
    expect(answer('POST', `lessons/${id}/approve`, { baseVersion: lesson.version }).status).toBe(200)
  })

  it('keeps the notices it is given, and deletes only a draft', () => {
    const made = answer('POST', 'notices', { title: '测试', body: '正文', kind: 'general' }).body as NoticeView
    expect(answer('POST', `notices/${made.id}/publish`).status).toBe(200)
    expect(answer('DELETE', `notices/${made.id}`)).toMatchObject({ status: 409, body: { error: { code: 'wrong_status' } } })
    const listed = (answer('GET', 'notices').body as { notices: NoticeView[] }).notices
    expect(listed.map((notice) => notice.title)).toContain('测试')
  })

  it('answers what it does not know with not_found', () => {
    expect(answer('GET', 'students/999')).toMatchObject({ status: 404, body: { error: { code: 'not_found' } } })
    expect(answer('GET', 'no/such/path').status).toBe(404)
  })
})
