import { afterEach, beforeEach, expect, test } from 'vitest'
import { applyPenalties, disciplineRecorder } from '../../src/class/discipline.js'
import type { ActiveSession } from '../../src/class/runtime.js'
import { excludeRule } from '../../src/discipline/revoke.js'
import { runDailyJob } from '../../src/registration/daily-job.js'
import { MAX_SUSPEND_DAYS } from '../../src/admin/students.js'
import { slotOccupancy } from '../../src/registration/capacity.js'
import { loadSchoolRules } from '../../src/shared/school-rules.js'
import { fileURLToPath } from 'node:url'
import { buildAdminTestApp, CSRF } from '../helpers/admin.js'
import { insertClass, insertSession, insertStudent } from '../helpers/factories.js'
import { captureLogs } from '../helpers/logs.js'

const NOW = new Date('2026-11-04T12:00:00+08:00')
const DAY = 24 * 60 * 60_000
const WORD = '示例违禁词'

let t: Awaited<ReturnType<typeof buildAdminTestApp>>
let cookie: string
let logs: ReturnType<typeof captureLogs>

beforeEach(async () => {
  logs = captureLogs()
  t = await buildAdminTestApp({ now: NOW, logger: { level: 'info', stream: logs.stream } })
  cookie = await t.session()
})
afterEach(async () => {
  await t.destroy()
})

const get = (path: string) => t.app.inject({ method: 'GET', url: t.url(path), headers: { cookie } })
const post = (path: string, payload?: object) =>
  t.app.inject({ method: 'POST', url: t.url(path), headers: { cookie, ...CSRF }, payload })
const row = (id: number) => t.db.selectFrom('students').selectAll().where('id', '=', id).executeTakeFirstOrThrow()

let classNo = 0
async function activeStudent(extra: Parameters<typeof insertStudent>[1] = {}) {
  const classId = await insertClass(t.db, { classNo: ++classNo })
  return { classId, ...(await insertStudent(t.db, { status: 'active', classId, ...extra })) }
}

/** What the owner reads about the student. */
async function ownerRecords(key: string) {
  const res = await t.app.inject({ method: 'GET', url: '/v1/me/records', headers: { authorization: `Bearer ${key}` } })
  expect(res.statusCode).toBe(200)
  return res.json().records as { kind: string; text: string; revoked: boolean }[]
}

test('an unknown or malformed student number is a 404 on every route', async () => {
  for (const id of ['99999', 'abc', '-1', '1.5', '99999999999999999999']) {
    for (const path of ['', '/messages', '/records']) expect((await get(`api/students/${id}${path}`)).statusCode).toBe(404)
    for (const path of ['/withdraw', '/lift']) expect((await post(`api/students/${id}${path}`)).statusCode).toBe(404)
    expect((await post(`api/students/${id}/suspend`, { days: 3 })).statusCode).toBe(404)
  }
  expect((await get('api/students/99999')).json()).toMatchObject({ error: { code: 'not_found' } })
})

test('the student page has the profile, the class and the attendance', async () => {
  const { id, classId } = await activeStudent({
    ownerName: '小明',
    aiName: '豆豆',
    email: 'xm@example.com',
    schoolRulesVersion: 'v1',
    lastAttendedAt: new Date('2026-11-03T20:30:00+08:00'),
  })
  await t.db.updateTable('students').set({ lessonsAttended: 4 }).where('id', '=', id).execute()
  const res = await get(`api/students/${id}`)
  expect(res.statusCode).toBe(200)
  const s = await row(id)
  expect(res.json()).toEqual({
    id,
    ownerName: '小明',
    aiName: '豆豆',
    email: 'xm@example.com',
    aiId: s.aiId,
    status: 'active',
    classId,
    className: expect.stringMatching(/班$/),
    suspendedUntil: null,
    registeredAt: s.createdAt.toISOString(),
    registrationIp: '127.0.0.1',
    schoolRulesVersion: 'v1',
    lessonsAttended: 4,
    lastAttendedAt: '2026-11-03T12:30:00.000Z',
  })
  const unassigned = await insertStudent(t.db, { status: 'pending' })
  expect((await get(`api/students/${unassigned.id}`)).json()).toMatchObject({ classId: null, className: null })
})

test('the messages are paged, newest first, with their moderation and plugin', async () => {
  const { id, classId } = await activeStudent()
  const other = await insertStudent(t.db, { status: 'active', classId })
  const sessionId = await insertSession(t.db, { classId, date: '2026-11-04', startsAt: NOW, endsAt: new Date(NOW.getTime() + 1800_000) })
  const ids: number[] = []
  for (let i = 0; i < 5; i++) {
    const m = await t.db
      .insertInto('messages')
      .values({
        sessionId,
        classId,
        senderId: i === 2 ? other.id : id,
        kind: 'chat',
        text: `第${i}句`,
        moderation: i === 4 ? 'sensitive' : null,
        matchedTerm: i === 4 ? WORD : null,
        delivered: i !== 4,
        ip: '10.0.0.1',
        pluginType: 'test',
        pluginVersion: '1.2.3',
        createdAt: new Date(NOW.getTime() + i * 1000),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    ids.push(m.id)
  }
  const first = await get(`api/students/${id}/messages?limit=2`)
  const body = first.json()
  expect(body.messages.map((m: { text: string }) => m.text)).toEqual(['第4句', '第3句'])
  expect(body.messages[0]).toEqual({
    id: ids[4],
    kind: 'chat',
    text: '第4句',
    moderation: 'sensitive',
    matchedTerm: WORD,
    delivered: false,
    ip: '10.0.0.1',
    pluginType: 'test',
    pluginVersion: '1.2.3',
    createdAt: new Date(NOW.getTime() + 4000).toISOString(),
    sessionId,
  })
  expect(body.nextBefore).toBe(ids[3])
  const second = (await get(`api/students/${id}/messages?limit=2&before=${body.nextBefore}`)).json()
  // The other student's line is not here.
  expect(second.messages.map((m: { text: string }) => m.text)).toEqual(['第1句', '第0句'])
  expect(second.nextBefore).toBeNull()
  expect((await get(`api/students/${id}/messages`)).json().messages).toHaveLength(4)

  for (const q of ['limit=0', 'limit=51', 'limit=x', 'before=x', 'before=-1']) {
    expect((await get(`api/students/${id}/messages?${q}`)).statusCode).toBe(400)
  }
})

test('the records include the revoked ones, newest first', async () => {
  const { id } = await activeStudent()
  const insert = (kind: 'school_rule' | 'suspension', at: Date, revokedAt: Date | null, detail: object) =>
    t.db
      .insertInto('disciplineRecords')
      .values({ studentId: id, sessionId: null, kind, detail: JSON.stringify(detail), matchedTerm: kind === 'school_rule' ? WORD : null, createdAt: at, revokedAt })
      .execute()
  await insert('school_rule', new Date(NOW.getTime() - DAY), NOW, { category: 'sensitive', quote: '原话' })
  await insert('suspension', NOW, null, { until: new Date(NOW.getTime() + DAY).toISOString(), alsoApplied: [] })
  const { records } = (await get(`api/students/${id}/records`)).json()
  expect(records.map((r: { kind: string; revoked: boolean; by: unknown }) => [r.kind, r.revoked, r.by])).toEqual([
    ['suspension', false, null],
    ['school_rule', true, null],
  ])
  expect(records[1]).toMatchObject({ matchedTerm: WORD, revokedAt: NOW.toISOString(), sessionId: null })
})

test('a manual suspension takes effect at once for every student of the AI id, expires, and the owner reads it', async () => {
  const { id, classId, key } = await activeStudent()
  const aiId = (await row(id)).aiId
  const sibling = await insertStudent(t.db, { status: 'dropped', aiId, email: 'other@example.com' })

  const res = await post(`api/students/${id}/suspend`, { days: 3 })
  expect(res.statusCode).toBe(200)
  const until = new Date(NOW.getTime() + 3 * DAY)
  expect(res.json()).toMatchObject({ id, status: 'suspended', classId, suspendedUntil: until.toISOString() })
  // In class stays in class (the next connection is refused by the status); the one outside class gets the date.
  expect(await row(id)).toMatchObject({ status: 'suspended', classId, suspendedUntil: until })
  expect(await row(sibling.id)).toMatchObject({ status: 'dropped', classId: null, suspendedUntil: until })

  const record = await t.db.selectFrom('disciplineRecords').selectAll().where('studentId', '=', id).executeTakeFirstOrThrow()
  expect(record).toMatchObject({ kind: 'suspension', sessionId: null, revokedAt: null })
  expect(record.detail).toEqual({ by: 'admin', days: 3, until: until.toISOString(), alsoApplied: [sibling.id] })
  expect((await ownerRecords(key))[0]).toMatchObject({ kind: 'suspension', text: expect.stringMatching(/^老师手动给你停课 3 天/) })

  // Not over before the date, over once it has come.
  await runDailyJob({ db: t.db, config: t.config, clock: t.clock })
  expect(await row(id)).toMatchObject({ status: 'suspended' })
  t.clock.advance(3 * DAY + 1000)
  await runDailyJob({ db: t.db, config: t.config, clock: t.clock })
  expect(await row(id)).toMatchObject({ status: 'active', suspendedUntil: null })
})

test('the days of a suspension are a whole number from 1 to the maximum, else 422', async () => {
  const { id } = await activeStudent()
  for (const days of [0, -1, 1.5, MAX_SUSPEND_DAYS + 1, '3', null, undefined]) {
    const res = await post(`api/students/${id}/suspend`, days === undefined ? {} : { days })
    expect(res.statusCode).toBe(422)
  }
  expect((await row(id)).status).toBe('active')
  expect((await post(`api/students/${id}/suspend`, { days: MAX_SUSPEND_DAYS })).statusCode).toBe(200)
  const expelled = await insertStudent(t.db, { status: 'expelled' })
  expect((await post(`api/students/${expelled.id}/suspend`, { days: 3 })).statusCode).toBe(409)
})

test('withdrawing frees the seat and the owner reads it', async () => {
  const { id, key } = await activeStudent()
  expect(await slotOccupancy(t.db, 'evening')).toBe(1)
  const res = await post(`api/students/${id}/withdraw`)
  expect(res.statusCode).toBe(200)
  expect(res.json()).toMatchObject({ id, status: 'dropped', classId: null })
  expect(await slotOccupancy(t.db, 'evening')).toBe(0)
  const record = await t.db.selectFrom('disciplineRecords').select(['kind', 'detail']).where('studentId', '=', id).executeTakeFirstOrThrow()
  expect(record).toEqual({ kind: 'withdrawal', detail: { by: 'admin' } })
  expect((await ownerRecords(key))[0]).toMatchObject({ kind: 'withdrawal', text: '老师手动给你办了退学' })
  // Nobody to withdraw twice.
  expect((await post(`api/students/${id}/withdraw`)).statusCode).toBe(409)
})

/** An expelled student with the three breaks and the expulsion the class service writes. */
async function expelled() {
  const s = await activeStudent()
  const sessionId = await insertSession(t.db, { classId: s.classId, date: '2026-11-04', startsAt: NOW, endsAt: new Date(NOW.getTime() + 1800_000) })
  const session = { sessionId, classId: s.classId } as unknown as ActiveSession
  await disciplineRecorder.record(t.db, {
    studentId: s.id,
    sessionId,
    kind: 'school_rule',
    detail: { category: 'sensitive', quote: '原话' },
    matchedTerm: WORD,
    at: NOW,
  })
  // The example config's thresholds are low enough for a single break to be punished after class; make sure it is.
  await applyPenalties(t.db, { ...t.config, discipline: { ...t.config.discipline, suspension: { ...t.config.discipline.suspension, schoolRuleCount: 1 }, expulsion: { ...t.config.discipline.expulsion, schoolRuleCount: 1 } } }, t.clock, session)
  return s
}

test('lifting an expulsion takes back the penalty and the breaks, and the student can re-enrol', async () => {
  const s = await expelled()
  expect(await row(s.id)).toMatchObject({ status: 'expelled' })
  expect(await t.db.selectFrom('bans').select('id').execute()).toHaveLength(2)

  const res = await post(`api/students/${s.id}/lift`)
  expect(res.statusCode).toBe(200)
  expect(res.json()).toMatchObject({ id: s.id, status: 'dropped', classId: null })
  expect(await t.db.selectFrom('bans').select('id').execute()).toHaveLength(0)
  const records = (await get(`api/students/${s.id}/records`)).json().records
  expect(records.map((r: { kind: string; revoked: boolean; by: unknown }) => [r.kind, r.revoked, r.by])).toEqual([
    ['penalty_lift', false, 'admin'],
    ['expulsion', true, null],
    ['school_rule', true, null],
  ])
  expect((await ownerRecords(s.key))[0]).toMatchObject({ text: '老师手动解除了处罚' })

  const reEnrol = await t.app.inject({
    method: 'POST',
    url: '/v1/me/re-enroll',
    headers: { authorization: `Bearer ${s.key}` },
    payload: { schoolRulesVersion: loadSchoolRules(fileURLToPath(new URL('../../school-rules', import.meta.url))).current.version },
  })
  expect(reEnrol.statusCode).toBe(200)
  expect((await row(s.id)).status).toMatch(/^(pending|waitlisted)$/)
})

test('lifting a manual suspension puts the student back in class; lifting with nothing to lift is a 409', async () => {
  const { id } = await activeStudent()
  expect((await post(`api/students/${id}/lift`)).statusCode).toBe(409)
  await post(`api/students/${id}/suspend`, { days: 5 })
  const res = await post(`api/students/${id}/lift`)
  expect(res.statusCode).toBe(200)
  expect(res.json()).toMatchObject({ status: 'active', suspendedUntil: null })
})

test('lifting a penalty that came from an AI-id sibling revokes only the looked-up student’s breaks', async () => {
  const offender = await activeStudent()
  const aiId = (await row(offender.id)).aiId
  const sibling = await insertStudent(t.db, { status: 'dropped', aiId, email: 'sib@example.com' })
  const hours = { classId: offender.classId, startsAt: NOW, endsAt: new Date(NOW.getTime() + 1800_000) }
  const earlier = await insertSession(t.db, { ...hours, date: '2026-11-03' })
  const lesson = await insertSession(t.db, { ...hours, date: '2026-11-04' })
  const brk = (studentId: number, sessionId: number) =>
    disciplineRecorder.record(t.db, { studentId, sessionId, kind: 'school_rule', detail: { category: 'sensitive', quote: '原话' }, matchedTerm: WORD, at: NOW })
  await brk(sibling.id, earlier)
  await brk(offender.id, lesson)
  const discipline = { ...t.config.discipline, expulsion: { ...t.config.discipline.expulsion, schoolRuleCount: 1 } }
  await applyPenalties(t.db, { ...t.config, discipline }, t.clock, { sessionId: lesson, classId: offender.classId } as unknown as ActiveSession)
  expect((await row(sibling.id)).status).toBe('expelled')

  // Lifted from the offender's page: the penalty goes for the whole AI id, but only the offender's break is taken back.
  expect((await post(`api/students/${offender.id}/lift`)).statusCode).toBe(200)
  expect((await row(sibling.id)).status).toBe('dropped')
  const breaks = await t.db.selectFrom('disciplineRecords').select(['studentId', 'revokedAt']).where('kind', '=', 'school_rule').execute()
  expect(breaks.find((b) => b.studentId === offender.id)?.revokedAt).not.toBeNull()
  expect(breaks.find((b) => b.studentId === sibling.id)?.revokedAt).toBeNull()
})

test('a rule dropped as a false hit does not take back a penalty the admin gave', async () => {
  const s = await activeStudent()
  const sessionId = await insertSession(t.db, { classId: s.classId, date: '2026-11-04', startsAt: NOW, endsAt: new Date(NOW.getTime() + 1800_000) })
  await disciplineRecorder.record(t.db, { studentId: s.id, sessionId, kind: 'school_rule', detail: { category: 'sensitive', quote: '原话' }, matchedTerm: WORD, at: NOW })
  await post(`api/students/${s.id}/suspend`, { days: 5 })

  const out = await excludeRule({ db: t.db, config: t.config, clock: t.clock }, 'word', WORD)
  expect(out).toEqual({ revoked: 1, lifted: [] })
  expect(await row(s.id)).toMatchObject({ status: 'suspended' })
  const suspension = await t.db.selectFrom('disciplineRecords').select('revokedAt').where('kind', '=', 'suspension').executeTakeFirstOrThrow()
  expect(suspension.revokedAt).toBeNull()
})

test('the log names the student number and the action, nothing else', async () => {
  const { id } = await activeStudent({ ownerName: '小明', aiName: '豆豆', email: 'secret-owner@example.com' })
  await post(`api/students/${id}/suspend`, { days: 2 })
  const mine = logs.entries().filter((e) => e.msg === 'admin penalty')
  expect(mine).toHaveLength(1)
  expect(mine[0]).toMatchObject({ studentId: id, action: 'suspend' })
  const text = JSON.stringify(mine)
  for (const secret of ['小明', '豆豆', 'secret-owner', '127.0.0.1']) expect(text).not.toContain(secret)
})
