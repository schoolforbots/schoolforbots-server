import { afterEach, expect, test } from 'vitest'
import { recordBlocked } from '../../src/class/chat.js'
import type { Participant } from '../../src/class/connection.js'
import { applyPenalties, disciplineRecorder } from '../../src/class/discipline.js'
import type { ActiveSession } from '../../src/class/runtime.js'
import { addDaysToDate } from '../../src/shared/local-time.js'
import type { MessageModeration } from '../../src/shared/schema.js'
import { runWeeklyReview } from '../../src/weekly/review.js'
import { storedStats, weeklyStats } from '../../src/weekly/stats.js'
import { buildAdminTestApp, CSRF } from '../helpers/admin.js'
import { createTestClock } from '../helpers/clock.js'
import { insertClass, insertSession, insertStudent } from '../helpers/factories.js'
import { examplePrompts, scripted } from '../helpers/llm.js'
import { captureLogs } from '../helpers/logs.js'

// Today is Wednesday 4 November 2026, noon school time (UTC+8): the last week that has ended ran from Monday 26
// October to Sunday 1 November.
const NOW = new Date('2026-11-04T12:00:00+08:00')
const WEEK = '2026-10-26'
const at = (date: string, time = '20:10:00') => new Date(`${date}T${time}+08:00`)
const WORD = '示例违禁词'

let t: Awaited<ReturnType<typeof buildAdminTestApp>>
let cookie: string
afterEach(async () => {
  await t.destroy()
})

async function start(opts: { logs?: ReturnType<typeof captureLogs> } = {}): Promise<void> {
  const logger = opts.logs === undefined ? undefined : { level: 'info', stream: opts.logs.stream }
  t = await buildAdminTestApp({ now: NOW, logger })
  cookie = await t.session()
}

async function get(path: string) {
  return t.app.inject({ method: 'GET', url: t.url(path), headers: { cookie } })
}

async function exclude(payload: unknown, headers: Record<string, string> = CSRF) {
  const url = t.url('api/exclusions')
  return t.app.inject({ method: 'POST', url, headers: { cookie, ...headers }, payload: payload as object })
}

let classNo = 0
/** A class with one active student and its lesson on `date`, where the student is stopped saying each of `lines`. */
async function blockedLines(date: string, lines: { text: string; moderation: MessageModeration; rule: string | null }[]) {
  const classId = await insertClass(t.db, { classNo: ++classNo })
  const { id: senderId } = await insertStudent(t.db, { status: 'active', classId })
  const [startsAt, endsAt] = [at(date, '20:00:00'), at(date, '20:30:00')]
  const sessionId = await insertSession(t.db, { classId, date, startsAt, endsAt })
  const ids: number[] = []
  for (const line of lines) {
    const row = await t.db
      .insertInto('messages')
      .values({
        sessionId,
        classId,
        senderId,
        kind: 'chat',
        text: line.text,
        moderation: line.moderation,
        matchedTerm: line.rule,
        delivered: false,
        pluginType: 'test',
        pluginVersion: '0.0.0',
        createdAt: at(date),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    ids.push(row.id)
  }
  return ids
}

test('without a review, the last week’s numbers are counted as they stand and there are no suggestions', async () => {
  await start()
  await blockedLines('2026-10-27', [{ text: '示例违禁词啊', moderation: 'sensitive', rule: WORD }])

  const res = await get('api/weekly')
  expect(res.statusCode).toBe(200)
  const body = res.json()
  expect(Object.keys(body).sort()).toEqual(['exclusions', 'stats', 'suggestions'])
  expect(body.stats).toEqual(JSON.parse(JSON.stringify(await weeklyStats(t.db, t.config, WEEK))))
  expect(body.stats.weekStart).toBe(WEEK)
  expect(body.stats.moderation.topRules).toEqual([{ rule: WORD, kind: 'word', count: 1 }])
  expect(body.suggestions).toBeNull()
  expect(body.exclusions).toEqual([])

  // Any Monday can be looked at.
  const earlier = (await get('api/weekly?weekStart=2026-10-19')).json()
  expect(earlier.stats.weekStart).toBe('2026-10-19')
  expect(earlier.stats.moderation.topRules).toEqual([])
})

test('a stored review is shown as it was stored, with the lines of its examples', async () => {
  await start()
  const [first, second, third, kept, purged] = await blockedLines('2026-10-27', [
    { text: '今天学正常的话', moderation: 'sensitive', rule: WORD },
    { text: '另一句正常的话', moderation: 'sensitive', rule: WORD },
    { text: '第三句正常的话', moderation: 'sensitive', rule: WORD },
    { text: '第二层拦下的一句', moderation: 'second_layer', rule: null },
    { text: '第二层拦下的另一句', moderation: 'second_layer', rule: null },
  ])
  const llm = scripted([
    (call) =>
      call.user.includes('removeRules')
        ? JSON.stringify({ removeRules: [{ kind: 'word', value: WORD, examples: [first, third, second] }] })
        : '{"directions":[]}',
  ]).llm
  const clock = createTestClock(at('2026-11-02', '00:00:30'))
  await runWeeklyReview({ db: t.db, config: t.config, clock, llm, prompts: examplePrompts() })
  const counted = JSON.parse(JSON.stringify(await weeklyStats(t.db, t.config, WEEK)))
  expect(counted.moderation.secondLayerChat.map((l: { messageId: number }) => l.messageId)).toEqual([kept, purged])
  // A line blocked after the review, and lines purged since (an example, one the second layer stopped): the page shows
  // the review as it was stored, less the lines that are gone.
  await blockedLines('2026-10-28', [{ text: '后来补上的', moderation: 'sensitive', rule: WORD }])
  await t.db.deleteFrom('messages').where('id', 'in', [third!, purged!]).execute()

  const body = (await get(`api/weekly?weekStart=${WEEK}`)).json()
  expect(body.stats).toEqual({
    ...counted,
    moderation: {
      ...counted.moderation,
      secondLayerChat: [{ messageId: kept, text: '第二层拦下的一句', at: at('2026-10-27').toISOString() }],
    },
  })
  expect(body.suggestions).toEqual({
    removeRules: [
      {
        kind: 'word',
        value: WORD,
        examples: [
          { messageId: first, text: '今天学正常的话', at: at('2026-10-27').toISOString() },
          { messageId: second, text: '另一句正常的话', at: at('2026-10-27').toISOString() },
        ],
      },
    ],
    directions: [],
    failures: { removeRules: null, directions: null },
  })
})

test('the weeks with a review, newest first', async () => {
  await start()
  expect((await get('api/weekly/weeks')).json()).toEqual({ weeks: [] })
  const failures = { removeRules: '大模型暂时调不通', directions: '大模型的回复格式不对' }
  for (const weekStart of ['2026-10-12', WEEK, '2026-10-19']) {
    const stats = JSON.stringify(storedStats(await weeklyStats(t.db, t.config, weekStart)))
    const suggestions = JSON.stringify({ removeRules: null, directions: null, failures })
    await t.db.insertInto('weeklyReviews').values({ weekStart, stats, suggestions, createdAt: NOW }).execute()
  }
  expect((await get('api/weekly/weeks')).json()).toEqual({ weeks: [WEEK, '2026-10-19', '2026-10-12'] })

  // A stored review whose model tasks both failed: each says why.
  const body = (await get('api/weekly?weekStart=2026-10-19')).json()
  expect(body.suggestions).toEqual({ removeRules: null, directions: null, failures })
})

const NOT_WEEKS = ['2026-10-27', '2026-11-01', '2026-02-30', '2026-1-05', 'monday', '']
test.each(NOT_WEEKS)('weekStart=%s is refused', async (weekStart) => {
  await start()
  const res = await get(`api/weekly?weekStart=${weekStart}`)
  expect(res.statusCode).toBe(400)
  expect(res.json().error.code).toBe('invalid_request')
})

test('a week given twice is refused', async () => {
  await start()
  expect((await get(`api/weekly?weekStart=${WEEK}&weekStart=${WEEK}`)).statusCode).toBe(400)
})

test('dropping a word revokes the breaks it made and lifts the suspension they earned', async () => {
  const logs = captureLogs()
  await start({ logs })
  const classId = await insertClass(t.db, { classNo: ++classNo })
  const s = await insertStudent(t.db, { status: 'active', classId, assignedAt: at('2026-10-01') })
  // Three lessons from Monday, each with the word said once: the third earns a suspension.
  for (let day = 0; day < 3; day++) {
    const date = addDaysToDate(WEEK, day)
    const [startsAt, endsAt] = [at(date, '20:00:00'), at(date, '20:30:00')]
    const sessionId = await insertSession(t.db, { classId, date, startsAt, endsAt })
    const closeAt = at(date, '20:31:00')
    const lesson: ActiveSession = {
      sessionId,
      classId,
      division: 'junior',
      slot: 'evening',
      kind: 'lesson',
      startsAt,
      endsAt,
      closeAt,
    }
    const from: Participant = {
      studentId: s.id,
      displayName: '某某',
      classId,
      sessionId,
      maxRounds: 5,
      ip: '127.0.0.1',
      pluginType: 'test',
      pluginVersion: '0.0.0',
      lessonsAttended: 5,
      closeAt: lesson.closeAt,
    }
    const text = `我想说${WORD}`
    const blocked = t.moderator.check(text)
    if (blocked.verdict !== 'blocked') throw new Error('the example word list lets this through')
    const line = { from, kind: 'chat' as const, conversationId: null, recipientId: null, text, at: at(date) }
    await recordBlocked(t.db, disciplineRecorder, line, blocked)
    const clock = createTestClock(lesson.closeAt)
    await applyPenalties(t.db, t.config, clock, lesson)
  }
  const status = async () =>
    (await t.db.selectFrom('students').select('status').where('id', '=', s.id).executeTakeFirstOrThrow()).status
  expect(await status()).toBe('suspended')

  const res = await exclude({ kind: 'word', value: `  ${WORD} ` })
  expect(res.statusCode).toBe(200)
  expect(res.json()).toEqual({ revoked: 3, lifted: [s.id] })
  expect(await status()).toBe('active')

  // Dropped again: nothing more to take back.
  expect((await exclude({ kind: 'word', value: WORD })).json()).toEqual({ revoked: 0, lifted: [] })

  const { exclusions } = (await get('api/weekly')).json()
  expect(exclusions).toEqual([{ kind: 'word', value: WORD, createdAt: NOW.toISOString() }])

  const entries = logs.entries().filter((e) => e.msg === 'rule excluded')
  expect(entries.map((e) => [e.kind, e.revoked, e.lifted])).toEqual([
    ['word', 3, 1],
    ['word', 0, 0],
  ])
  expect(JSON.stringify(logs.entries())).not.toContain(WORD)
})

test('the dropped rules are listed newest first, phrase rules too', async () => {
  await start()
  expect((await exclude({ kind: 'pattern', value: '某条规则' })).statusCode).toBe(200)
  t.clock.advance(60_000)
  expect((await exclude({ kind: 'word', value: '某个词' })).statusCode).toBe(200)
  const { exclusions } = (await get('api/weekly')).json()
  expect(exclusions).toEqual([
    { kind: 'word', value: '某个词', createdAt: new Date(NOW.getTime() + 60_000).toISOString() },
    { kind: 'pattern', value: '某条规则', createdAt: NOW.toISOString() },
  ])
})

test('a drop that is not a word or a phrase rule is refused', async () => {
  await start()
  for (const payload of [
    { kind: 'word', value: '   ' },
    { kind: 'word', value: '' },
    { kind: 'regex', value: '某个词' },
    { kind: 'word' },
    { kind: 'word', value: '某个词', extra: 1 },
    { kind: 'word', value: 3 },
  ]) {
    const res = await exclude(payload)
    expect(res.statusCode, JSON.stringify(payload)).toBe(400)
    expect(res.json().error.code).toBe('invalid_request')
  }
  expect((await exclude({ kind: 'word', value: '某个词' }, {})).statusCode).toBe(403)
  expect(await t.db.selectFrom('moderationExclusions').selectAll().execute()).toEqual([])
})

test('the weekly pages need a login', async () => {
  await start()
  for (const path of ['api/weekly', 'api/weekly/weeks']) {
    expect((await t.app.inject({ method: 'GET', url: t.url(path) })).statusCode).toBe(401)
  }
  const payload = { kind: 'word', value: WORD }
  const res = await t.app.inject({ method: 'POST', url: t.url('api/exclusions'), headers: CSRF, payload })
  expect(res.statusCode).toBe(401)
})
