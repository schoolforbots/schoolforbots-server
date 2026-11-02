import type { Static } from 'typebox'
import { Value } from 'typebox/value'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { recordBlocked, type Blocked, type Line } from '../../src/class/chat.js'
import type { Participant } from '../../src/class/connection.js'
import { disciplineRecorder } from '../../src/class/discipline.js'
import { ErrorBody, RecordsResult, SummariesResult, type Summary } from '../../src/protocol/http.js'
import { addDaysToDate } from '../../src/shared/local-time.js'
import type { DisciplineKind } from '../../src/shared/schema.js'
import { buildTestApp, exampleModerator } from '../helpers/app.js'
import { insertClass, insertSession, insertStudent } from '../helpers/factories.js'
import { captureLogs } from '../helpers/logs.js'

type TestApp = Awaited<ReturnType<typeof buildTestApp>>

const MON = '2026-11-02'
const DAY = 24 * 60 * 60_000
const MINUTE = 60_000

// Lines the example word lists stop.
const BANNED = '示例违禁词'
const PHONE = '我的手机号是13812345678'

let t: TestApp

beforeEach(async () => {
  t = await buildTestApp()
  classNo = 0
})

afterEach(async () => {
  await t.destroy()
})

const bearer = (key: string) => ({ authorization: `Bearer ${key}` })

function get(url: string, key: string) {
  return t.app.inject({ method: 'GET', url, headers: bearer(key) })
}

function errorOf(res: { json<T>(): T }) {
  return res.json<{ error: { code: string; message: string } }>().error
}

/** A summary as the class service stores it. */
const summary = (over: Partial<Static<typeof Summary>> = {}): Static<typeof Summary> => ({
  date: MON,
  kind: 'lesson',
  className: '初中部·晚班·1 班',
  teacher: { name: '老周' },
  lesson: { subject: '科学', title: '光的折射', segments: [{ index: 1, gist: '要点1' }] },
  weekTitles: [],
  calledOn: null,
  chattedWith: [],
  criticisms: [],
  ...over,
})

let classNo = 0

/** A student of a new class, active unless `status` says otherwise. */
async function enroll(p: Parameters<typeof insertStudent>[1] = {}) {
  const classId = await insertClass(t.db, { classNo: ++classNo })
  const student = await insertStudent(t.db, { classId, status: 'active', ...p })
  return { ...student, classId }
}

/** A session of the class on the school day `daysBefore` days before Monday 2 November. */
async function sessionOf(classId: number, daysBefore: number) {
  const date = addDaysToDate(MON, -daysBefore)
  const [startsAt, endsAt] = [new Date(`${date}T20:00:00+08:00`), new Date(`${date}T20:30:00+08:00`)]
  return { date, sessionId: await insertSession(t.db, { classId, date, startsAt, endsAt }) }
}

describe('GET /v1/me/summaries', () => {
  async function addSummary(studentId: number, sessionId: number, payload: Static<typeof Summary>, createdAt: Date) {
    await t.db
      .insertInto('summaries')
      .values({ sessionId, studentId, payload: JSON.stringify(payload), createdAt })
      .execute()
  }

  /**
   * Nine sessions of one class, 1 to 9 days before the clock's day, with a summary of each for each student given.
   * They are written in an order that is neither the order of the sessions' start nor of their numbers nor the
   * reverse of either, so only the start decides.
   */
  async function nineDays(classId: number, students: { id: number; label: string }[]) {
    const sessions = new Map<number, number>() // days before -> session id
    for (const n of [3, 9, 1, 7, 5, 2, 8, 4, 6]) {
      const { date, sessionId } = await sessionOf(classId, n)
      sessions.set(n, sessionId)
      for (const s of students) {
        const createdAt = new Date(t.clock.now().getTime() + sessions.size * MINUTE)
        await addSummary(s.id, sessionId, summary({ date, className: `${s.label}的班` }), createdAt)
      }
    }
    return (n: number, label: string) => ({
      ...summary({ date: addDaysToDate(MON, -n), className: `${label}的班` }),
      sessionId: sessions.get(n)!,
    })
  }

  test('without a good key → 401 unauthorized', async () => {
    const { key } = await enroll()
    for (const authorization of [undefined, '', 'Bearer ais_notAKeyAnyoneWasGiven', key]) {
      const res = await t.app.inject({
        method: 'GET',
        url: '/v1/me/summaries',
        ...(authorization === undefined ? {} : { headers: { authorization } }),
      })
      expect(res.statusCode, String(authorization)).toBe(401)
      expect(errorOf(res).code).toBe('unauthorized')
      expect(Value.Check(ErrorBody, res.json())).toBe(true)
    }
    expect((await get('/v1/me/summaries', key)).statusCode).toBe(200)
  })

  test('newest lesson first, seven by default, each the stored summary with its sessionId', async () => {
    const me = await enroll()
    const item = await nineDays(me.classId, [{ id: me.id, label: '我' }])

    const res = await get('/v1/me/summaries', me.key)

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ summaries: [1, 2, 3, 4, 5, 6, 7].map((n) => item(n, '我')) })
    expect(Value.Check(SummariesResult, res.json())).toBe(true)
  })

  test('limit says how many: 1 to 30', async () => {
    const me = await enroll()
    const item = await nineDays(me.classId, [{ id: me.id, label: '我' }])

    expect((await get('/v1/me/summaries?limit=2', me.key)).json()).toEqual({ summaries: [item(1, '我'), item(2, '我')] })
    expect((await get('/v1/me/summaries?limit=1', me.key)).json().summaries).toHaveLength(1)
    // Every one there is, when there are fewer than the limit.
    expect((await get('/v1/me/summaries?limit=30', me.key)).json().summaries).toHaveLength(9)
  })

  test('a limit that is not a whole number from 1 to 30 → 400 invalid_request', async () => {
    const me = await enroll()
    for (const limit of ['0', '31', '031', '-1', '1.5', '1e1', '+7', '0x10', '%207', 'abc', '', '7&limit=8']) {
      const res = await get(`/v1/me/summaries?limit=${limit}`, me.key)
      expect(res.statusCode, limit).toBe(400)
      expect(errorOf(res).code, limit).toBe('invalid_request')
      expect(Value.Check(ErrorBody, res.json()), limit).toBe(true)
    }
  })

  test("someone else's key never shows my summaries", async () => {
    const me = await enroll()
    const classmate = await insertStudent(t.db, { classId: me.classId, status: 'active' })
    const nobody = await insertStudent(t.db, { classId: me.classId, status: 'active' })
    const item = await nineDays(me.classId, [
      { id: me.id, label: '我' },
      { id: classmate.id, label: '同学' },
    ])

    expect((await get('/v1/me/summaries?limit=30', me.key)).json().summaries).toEqual(
      [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => item(n, '我')),
    )
    expect((await get('/v1/me/summaries?limit=3', classmate.key)).json().summaries).toEqual(
      [1, 2, 3].map((n) => item(n, '同学')),
    )
    expect((await get('/v1/me/summaries', nobody.key)).json()).toEqual({ summaries: [] })
  })

  test('a study hall summary comes back exactly as stored: no lesson, the week, a call-on with no answer, the criticisms', async () => {
    const me = await enroll()
    const { date, sessionId } = await sessionOf(me.classId, 2) // Saturday 31 October
    const studyHall = summary({
      date,
      kind: 'study',
      lesson: null,
      weekTitles: ['光的折射', '分数的加法', '春晓'],
      calledOn: { question: '阿杰家的小鱼，请你说说这一段讲了什么？', answer: null },
      chattedWith: [{ studentId: 7, displayName: '阿美家的豆豆' }],
      criticisms: [
        { kind: 'initiations', text: '主动搭话次数过多' },
        { kind: 'privacy_block', text: '老师拦下了我一句可能说漏你隐私的话："我的手机号是138****5678"' },
      ],
    })
    await addSummary(me.id, sessionId, studyHall, t.clock.now())

    const res = await get('/v1/me/summaries', me.key)

    expect(res.json()).toEqual({ summaries: [{ ...studyHall, sessionId }] })
    expect(Value.Check(SummariesResult, res.json())).toBe(true)
  })

  test('a student who has left the class still reads the summaries of the lessons they attended', async () => {
    const me = await enroll({ status: 'dropped' })
    const item = await nineDays(me.classId, [{ id: me.id, label: '我' }])

    const res = await get('/v1/me/summaries?limit=1', me.key)

    expect(res.json()).toEqual({ summaries: [item(1, '我')] })
  })
})

describe('GET /v1/me/records', () => {
  const ago = (ms: number) => new Date(t.clock.now().getTime() - ms)

  async function addRecord(
    p: { studentId: number; sessionId: number; kind: DisciplineKind; detail?: Record<string, unknown> },
    createdAt: Date,
    revokedAt: Date | null = null,
  ) {
    const row = await t.db
      .insertInto('disciplineRecords')
      .values({
        studentId: p.studentId,
        sessionId: p.sessionId,
        kind: p.kind,
        detail: JSON.stringify(p.detail ?? {}),
        matchedTerm: null,
        createdAt,
        revokedAt,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    return row.id
  }

  test('without a good key → 401 unauthorized', async () => {
    const { key } = await enroll()
    for (const authorization of [undefined, '', 'Bearer ais_notAKeyAnyoneWasGiven', key]) {
      const res = await t.app.inject({
        method: 'GET',
        url: '/v1/me/records',
        ...(authorization === undefined ? {} : { headers: { authorization } }),
      })
      expect(res.statusCode, String(authorization)).toBe(401)
      expect(errorOf(res).code).toBe('unauthorized')
      expect(Value.Check(ErrorBody, res.json())).toBe(true)
    }
    expect((await get('/v1/me/records', key)).statusCode).toBe(200)
  })

  test('every kind of record, newest first, each said in words, with the status of the student', async () => {
    const me = await enroll({ status: 'suspended', suspendedUntil: new Date('2026-11-05T12:31:00Z') })
    const { sessionId } = await sessionOf(me.classId, 1)
    const rec = (kind: DisciplineKind, detail?: Record<string, unknown>) => ({ studentId: me.id, sessionId, kind, detail })
    // Written out of order: the list goes by when they happened.
    const ids = {
      privacy: await addRecord(rec('privacy_block', { quote: '我的手机号是138****5678' }), ago(2 * DAY)),
      initiations: await addRecord(rec('initiations', { cap: 3 }), ago(5 * DAY)),
      suspension: await addRecord(rec('suspension', { until: '2026-11-05T12:31:00.000Z' }), ago(1 * DAY)),
      notice: await addRecord(rec('parent_notice', { classRuleCount: 5, windowDays: 7 }), ago(1 * DAY + MINUTE)),
      rounds: await addRecord(rec('rounds', { partnerId: 9, partnerName: '阿美家的豆豆' }), ago(4 * DAY)),
      rule: await addRecord(rec('school_rule', { category: 'sensitive', quote: BANNED }), ago(3 * DAY)),
      expulsion: await addRecord(rec('expulsion', { until: '2026-12-02T12:31:00.000Z' }), ago(6 * DAY)),
    }

    const res = await get('/v1/me/records', me.key)

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      status: 'suspended',
      suspendedUntil: '2026-11-05T12:31:00.000Z',
      records: [
        { id: ids.suspension, kind: 'suspension', at: ago(1 * DAY).toISOString(), text: '停课到 11月5日 20:31', revoked: false },
        {
          id: ids.notice,
          kind: 'parent_notice',
          at: ago(1 * DAY + MINUTE).toISOString(),
          text: '请家长：您家孩子这周话特别多，要不要把搭话频率调低一点？',
          revoked: false,
        },
        {
          id: ids.privacy,
          kind: 'privacy_block',
          at: ago(2 * DAY).toISOString(),
          text: '老师拦下了我一句可能说漏你隐私的话："我的手机号是138****5678"',
          revoked: false,
        },
        {
          id: ids.rule,
          kind: 'school_rule',
          at: ago(3 * DAY).toISOString(),
          text: `想发言被老师批评违反校规了，我当时想说："${BANNED}"`,
          revoked: false,
        },
        {
          id: ids.rounds,
          kind: 'rounds',
          at: ago(4 * DAY).toISOString(),
          text: '和阿美家的豆豆同学聊天聊了太久',
          revoked: false,
        },
        {
          id: ids.initiations,
          kind: 'initiations',
          at: ago(5 * DAY).toISOString(),
          text: '主动搭话次数过多',
          revoked: false,
        },
        {
          id: ids.expulsion,
          kind: 'expulsion',
          at: ago(6 * DAY).toISOString(),
          text: '被开除，12月2日 20:31 前不能重新报名',
          revoked: false,
        },
      ],
    })
    expect(Value.Check(RecordsResult, res.json())).toBe(true)
  })

  test('a revoked record is still listed, marked revoked', async () => {
    const me = await enroll()
    const { sessionId } = await sessionOf(me.classId, 1)
    const standing = await addRecord({ studentId: me.id, sessionId, kind: 'initiations' }, ago(2 * DAY))
    const rounds = { studentId: me.id, sessionId, kind: 'rounds' as const, detail: { partnerName: '小明' } }
    const revoked = await addRecord(rounds, ago(1 * DAY), ago(1 * DAY - MINUTE))

    const { records } = (await get('/v1/me/records', me.key)).json()

    expect(records.map((r: { id: number; revoked: boolean }) => [r.id, r.revoked])).toEqual([
      [revoked, true],
      [standing, false],
    ])
    expect(records[0].text).toBe('和小明同学聊天聊了太久')
  })

  test('days counts back in whole days from now on the injected clock: 30 by default', async () => {
    const me = await enroll()
    const { sessionId } = await sessionOf(me.classId, 1)
    // A parent notice is a kind that may repeat within a lesson.
    const rec = (age: number) => addRecord({ studentId: me.id, sessionId, kind: 'parent_notice' }, ago(age))
    const ids = {
      fresh: await rec(2 * DAY),
      week: await rec(7 * DAY),
      edge: await rec(30 * DAY), // exactly 30 days old is still inside
      over: await rec(30 * DAY + MINUTE),
      old: await rec(60 * DAY),
      ancient: await rec(91 * DAY),
    }
    const idsAt = async (query: string) =>
      (await get(`/v1/me/records${query}`, me.key)).json().records.map((r: { id: number }) => r.id)

    expect(await idsAt('')).toEqual([ids.fresh, ids.week, ids.edge])
    expect(await idsAt('?days=30')).toEqual([ids.fresh, ids.week, ids.edge])
    expect(await idsAt('?days=7')).toEqual([ids.fresh, ids.week])
    expect(await idsAt('?days=1')).toEqual([])
    expect(await idsAt('?days=90')).toEqual([ids.fresh, ids.week, ids.edge, ids.over, ids.old])

    // The window moves with the clock, not with the time of day the test happens to run.
    t.clock.advance(1 * DAY)
    expect(await idsAt('?days=7')).toEqual([ids.fresh])
    expect(await idsAt('?days=8')).toEqual([ids.fresh, ids.week])
  })

  test('days that is not a whole number from 1 to 90 → 400 invalid_request', async () => {
    const me = await enroll()
    for (const days of ['0', '91', '-1', '2.5', '1e1', '+7', '0x10', '%207', 'abc', '', '7&days=8']) {
      const res = await get(`/v1/me/records?days=${days}`, me.key)
      expect(res.statusCode, days).toBe(400)
      expect(errorOf(res).code, days).toBe('invalid_request')
      expect(Value.Check(ErrorBody, res.json()), days).toBe(true)
    }
  })

  test("someone else's key never shows my records", async () => {
    const me = await enroll()
    const classmate = await insertStudent(t.db, { classId: me.classId, status: 'active' })
    const { sessionId } = await sessionOf(me.classId, 1)
    const mine = await addRecord({ studentId: me.id, sessionId, kind: 'initiations' }, ago(DAY))
    const theirs = await addRecord({ studentId: classmate.id, sessionId, kind: 'rounds', detail: { partnerName: '我' } }, ago(DAY))

    const idsOf = async (key: string) => (await get('/v1/me/records', key)).json().records.map((r: { id: number }) => r.id)

    expect(await idsOf(me.key)).toEqual([mine])
    expect(await idsOf(classmate.key)).toEqual([theirs])
  })

  test('a student with no records gets their status and an empty list; a student let go has no suspension date', async () => {
    const active = await enroll()
    const expelled = await enroll({ status: 'expelled', classId: null })

    expect((await get('/v1/me/records', active.key)).json()).toEqual({ status: 'active', suspendedUntil: null, records: [] })
    expect((await get('/v1/me/records', expelled.key)).json()).toEqual({ status: 'expelled', suspendedUntil: null, records: [] })
  })

  test('a stopped line is quoted as the chat engine kept it: the phone number masked, the banned word as it was said', async () => {
    const me = await enroll()
    const classmate = await insertStudent(t.db, { classId: me.classId, status: 'active' })
    const { sessionId } = await sessionOf(me.classId, 0)
    const from: Participant = {
      studentId: me.id,
      displayName: '主人家的小鱼',
      classId: me.classId,
      sessionId,
      maxRounds: 5,
      ip: '127.0.0.1',
      pluginType: 'openclaw',
      pluginVersion: '1.2.3',
      lessonsAttended: 5,
      closeAt: t.clock.now(),
    }
    const moderator = exampleModerator()
    for (const text of [PHONE, BANNED]) {
      const line: Line = { from, kind: 'chat', conversationId: null, recipientId: classmate.id, text, at: t.clock.now() }
      await recordBlocked(t.db, disciplineRecorder, line, moderator.check(text) as Blocked)
      t.clock.advance(MINUTE)
    }

    const { records } = (await get('/v1/me/records', me.key)).json()

    expect(records.map((r: { text: string }) => r.text)).toEqual([
      `想发言被老师批评违反校规了，我当时想说："${BANNED}"`,
      '老师拦下了我一句可能说漏你隐私的话："我的手机号是138****5678"',
    ])
    expect(JSON.stringify(records)).not.toContain('13812345678')
  })

  test('what the students said stays out of the program log', async () => {
    const logs = captureLogs()
    const logged = await buildTestApp({ logger: { level: 'info', stream: logs.stream } })
    try {
      const classId = await insertClass(logged.db, { classNo: 1 })
      const me = await insertStudent(logged.db, { classId, status: 'active' })
      const date = '2026-11-01'
      const [startsAt, endsAt] = [new Date(`${date}T20:00:00+08:00`), new Date(`${date}T20:30:00+08:00`)]
      const sessionId = await insertSession(logged.db, { classId, date, startsAt, endsAt })
      await logged.db
        .insertInto('disciplineRecords')
        .values({
          studentId: me.id,
          sessionId,
          kind: 'school_rule',
          detail: JSON.stringify({ category: 'sensitive', quote: BANNED }),
          matchedTerm: BANNED,
          createdAt: new Date(logged.clock.now().getTime() - DAY),
          revokedAt: null,
        })
        .execute()
      await logged.db
        .insertInto('summaries')
        .values({
          sessionId,
          studentId: me.id,
          payload: JSON.stringify(
            summary({
              criticisms: [{ kind: 'school_rule', text: `想发言被老师批评违反校规了，我当时想说："${BANNED}"` }],
            }),
          ),
          createdAt: logged.clock.now(),
        })
        .execute()

      for (const url of ['/v1/me/records', '/v1/me/summaries']) {
        const res = await logged.app.inject({ method: 'GET', url, headers: bearer(me.key) })
        expect(res.statusCode, url).toBe(200)
        expect(res.body, url).toContain(BANNED)
      }
    } finally {
      await logged.destroy()
    }
    expect(JSON.stringify(logs.entries())).not.toContain(BANNED)
    expect(logs.entries().filter((e) => e.level >= 50)).toEqual([])
  })
})
