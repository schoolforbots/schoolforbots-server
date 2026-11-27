import { Value } from 'typebox/value'
import { afterEach, describe, expect, test } from 'vitest'
import { liveStep } from '../../src/class/live.js'
import { ClassLiveResult } from '../../src/protocol/http.js'
import { buildTestClassApp } from '../helpers/class-app.js'
import { insertClass, insertLesson, insertStudent } from '../helpers/factories.js'

// The example school: the evening doors open at 19:45, the lesson starts at 20:00 with segments at minutes 5, 10, 15,
// 20 and 25, and is dismissed at 20:30. 2 November 2026 is a Monday.

type Service = Awaited<ReturnType<typeof buildTestClassApp>>

let s: Service | undefined

afterEach(async () => {
  await s?.destroy()
  s = undefined
})

const at = (clock: string) => new Date(`2026-11-02T${clock}+08:00`)

async function live(service: Service) {
  const res = await service.app.inject({ method: 'GET', url: '/v1/class/live', headers: { origin: 'https://example.org' } })
  expect(res.statusCode).toBe(200)
  const body = res.json()
  expect(Value.Check(ClassLiveResult, body), JSON.stringify([...Value.Errors(ClassLiveResult, body)].slice(0, 3))).toBe(true)
  return { body, headers: res.headers }
}

/** Connects a student to the hub as a connection would, without a WebSocket. */
function online(service: Service, studentId: number, classId: number) {
  service.hub.add({ studentId, classId, send: () => {}, close: () => {} })
}

describe('liveStep', () => {
  test('is the last step a visitor can see', () => {
    expect(liveStep([], 5)).toEqual({ name: 'doors', segment: null, segments: 5 })
    expect(liveStep(['opening'], 5)).toEqual({ name: 'opening', segment: null, segments: 5 })
    expect(liveStep(['opening', 'segment-1', 'call-on-1'], 5)).toEqual({ name: 'call_on', segment: 1, segments: 5 })
    expect(liveStep(['opening', 'segment-1', 'call-on-1', 'qa-1', 'call-on-close-1', 'callouts-1'], 5)).toEqual({
      name: 'qa',
      segment: 1,
      segments: 5,
    })
    expect(liveStep(['opening', 'segment-1', 'qa-1', 'callouts-1', 'segment-2'], 5)).toEqual({ name: 'segment', segment: 2, segments: 5 })
    expect(liveStep(['opening', 'callouts-1', 'dismissal'], 0)).toEqual({ name: 'dismissal', segment: null, segments: 0 })
  })
})

describe('GET /v1/class/live', () => {
  test('with no class open, there is nobody, and any site may read it', async () => {
    s = await buildTestClassApp()
    const { body, headers } = await live(s)
    expect(body).toEqual({ generatedAt: '2026-11-02T11:00:00.000Z', classrooms: [] })
    expect(headers['access-control-allow-origin']).toBe('*')
    expect(headers['cache-control']).toBe('public, max-age=5')
  })

  test('shows each open class, how far it has got and who of it is connected, the anonymous without name or number', async () => {
    s = await buildTestClassApp({ now: at('19:00:00') })
    await insertLesson(s.db, { date: '2026-11-02', subject: '科学', title: '光的折射' })
    const classId = await insertClass(s.db, { classNo: 3, teacherPersonaId: 'lin-laoshi' })
    const named = await insertStudent(s.db, { classId, status: 'active', aiName: '小鱼' })
    const hidden = await insertStudent(s.db, { classId, status: 'active', aiName: '小虾' })
    await insertStudent(s.db, { classId, status: 'active', aiName: '小蟹' })
    // Each chose a type and colors: the anonymous student's are not shown.
    await s.db.updateTable('students').set({ aiType: 'claude', avatarBackground: 'blue' }).where('id', '=', named.id).execute()
    await s.db
      .updateTable('students')
      .set({ liveAnonymous: true, aiType: 'kimi', avatarBackground: 'pink', avatarBorder: 'teal' })
      .where('id', '=', hidden.id)
      .execute()

    s.clock.set(at('19:50:00'))
    await s.runtime.tick()
    online(s, named.id, classId)
    online(s, hidden.id, classId)

    const first = await live(s)
    expect(first.body.classrooms).toHaveLength(1)
    const room = first.body.classrooms[0]
    expect(room).toMatchObject({
      division: 'junior',
      slot: 'evening',
      classNo: 3,
      startsAt: at('20:00:00').toISOString(),
      endsAt: at('20:30:00').toISOString(),
      kind: 'lesson',
      title: '光的折射',
      step: { name: 'doors', segment: null, segments: 5 },
    })
    expect(room.teacher.name).toEqual(expect.any(String))
    expect(room.students).toEqual([
      { anonymous: false, studentId: named.id, aiName: '小鱼', anonId: null, aiType: 'claude', avatar: { background: 'blue', border: null } },
      { anonymous: true, studentId: null, aiName: null, anonId: expect.stringMatching(/^[A-Za-z0-9_-]{12}$/), aiType: null, avatar: null },
    ])
    const anonId = room.students[1].anonId
    expect(JSON.stringify(first.body)).not.toContain('小虾')
    expect(JSON.stringify(first.body)).not.toContain(`"studentId":${hidden.id}`)
    expect(JSON.stringify(first.body)).not.toContain('小蟹')
    expect(JSON.stringify(first.body)).not.toContain('kimi')
    expect(JSON.stringify(first.body)).not.toContain('pink')

    // Into the first segment: the anonymous student keeps the same id.
    s.clock.set(at('20:06:00'))
    await s.runtime.tick()
    const later = await live(s)
    expect(later.body.classrooms[0].step).toEqual({ name: 'segment', segment: 1, segments: 5 })
    expect(later.body.classrooms[0].students[1].anonId).toBe(anonId)
  })

  test('a snapshot is shared for five seconds', async () => {
    s = await buildTestClassApp({ now: at('19:00:00') })
    const classId = await insertClass(s.db, { classNo: 1 })
    const a = await insertStudent(s.db, { classId, status: 'active' })
    await insertLesson(s.db, { date: '2026-11-02', title: '课' })
    s.clock.set(at('19:50:00'))
    await s.runtime.tick()

    const before = await live(s)
    online(s, a.id, classId)
    s.clock.set(at('19:50:04.999'))
    expect((await live(s)).body).toEqual(before.body)
    s.clock.set(at('19:50:05'))
    expect((await live(s)).body.classrooms[0].students).toHaveLength(1)
  })

  test('an address asking too often is told so, readable from any site', async () => {
    s = await buildTestClassApp({ config: { httpRateLimitPerMinute: 1 } })
    await live(s)
    const res = await s.app.inject({ method: 'GET', url: '/v1/class/live' })
    expect(res.statusCode).toBe(429)
    expect(res.json().error.code).toBe('rate_limited')
    expect(res.headers['access-control-allow-origin']).toBe('*')
  })
})
