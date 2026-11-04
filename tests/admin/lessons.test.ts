import { afterEach, describe, expect, test, vi } from 'vitest'
import { reviewQueue } from '../../src/admin/lessons.js'
import { buildLessonPrompt } from '../../src/lessons/prompts.js'
import { approve, editPart, saveDraft, type LessonStoreDeps } from '../../src/lessons/store.js'
import { LlmContentRefused, LlmUnavailable } from '../../src/llm/provider.js'
import type { Division, SchoolConfig } from '../../src/shared/config.js'
import type { LessonContent } from '../../src/shared/schema.js'
import { buildAdminTestApp, CSRF } from '../helpers/admin.js'
import { exampleConfig } from '../helpers/app.js'
import { insertClass, insertSession } from '../helpers/factories.js'
import { examplePrompts, scripted } from '../helpers/llm.js'
import { captureLogs } from '../helpers/logs.js'

// Today is Monday 2026-11-02, noon school time. With lessons made 7 days ahead, the review queue runs from today to
// Monday 11-09: Monday to Friday, then Monday again; the weekend between has study halls, not lessons.
const MON = '2026-11-02'
const TUE = '2026-11-03'
const WED = '2026-11-04'
const THU = '2026-11-05'
const FRI = '2026-11-06'
const SAT = '2026-11-07'
const NEXT_MON = '2026-11-09'
const NEXT_TUE = '2026-11-10'
const DIVISIONS: Division[] = ['primary', 'junior', 'senior']
const LABELS = { primary: '小学部', junior: '初中部', senior: '高中部' }
const WORD = '示例违禁词'
const OTHER_WORD = 'abc违禁'
const STALE = { error: { code: 'stale_version', message: '这节课在别处改过了，刷新后再改。' } }
const LOCKED = { error: { code: 'lesson_locked', message: '这节课已经开课，不能再改。' } }

let t: Awaited<ReturnType<typeof buildAdminTestApp>>
let cookie: string
afterEach(async () => {
  await t.destroy()
})

async function start(opts: Parameters<typeof buildAdminTestApp>[0] = {}): Promise<void> {
  t = await buildAdminTestApp(opts)
  cookie = await t.session()
}

const store = (): LessonStoreDeps => ({ db: t.db, clock: t.clock, moderator: t.moderator })

function api(method: 'GET' | 'PUT' | 'POST', path: string, payload?: object) {
  return t.app.inject({ method, url: t.url(`api/${path}`), headers: { cookie, ...CSRF }, payload })
}

/** The address of the prompt with these parameters; one that is undefined is left out. */
function promptQuery(params: Record<string, string | number | undefined>): string {
  const pairs = Object.entries(params).flatMap(([k, v]) => (v === undefined ? [] : [[k, String(v)]]))
  return `prompts?${new URLSearchParams(pairs).toString()}`
}

const content = (title = '光的折射', over: Partial<LessonContent> = {}): LessonContent => ({
  title,
  subject: '数学',
  segments: Array.from({ length: 5 }, (_, i) => ({ text: `第${i + 1}段讲稿`, gist: `第${i + 1}段要点` })),
  callOnQuestions: { review: '光从空气进到水里会怎样？', extension: '筷子放进水里为什么看起来弯了？' },
  ...over,
})

/** A whole lesson as the model or a pasted reply gives it. */
const lessonReply = (title = '新的一课', segmentCount = 5) =>
  JSON.stringify({
    title,
    segments: Array.from({ length: segmentCount }, (_, i) => ({ text: `新的第${i + 1}段`, gist: `新的第${i + 1}段要点` })),
    callOnQuestions: { review: '新的复习题？', extension: '新的引申题？' },
  })

async function draft(date: string, division: Division, c = content()): Promise<number> {
  return (await saveDraft(store(), { date, division }, c, { source: 'api', change: 'generate' })).lessonId
}

let classNo = 0
/**
 * A class of the division begins the day: its session teaches the lesson `lessonId`, or holds a study hall (`null`).
 * Either way the day is decided for the division.
 */
async function begin(lessonId: number | null, date: string, division: Division): Promise<void> {
  const classId = await insertClass(t.db, { division, slot: 'morning', classNo: ++classNo })
  await insertSession(t.db, {
    classId,
    date,
    slot: 'morning',
    kind: lessonId === null ? 'study' : 'lesson',
    lessonId,
    startsAt: new Date(`${date}T02:00:00Z`),
    endsAt: new Date(`${date}T02:30:00Z`),
  })
}

const manualConfig = (): SchoolConfig => {
  const example = exampleConfig()
  return { ...example, lessonGeneration: { ...example.lessonGeneration, mode: 'manual' } }
}

interface QueueSlot {
  division: Division
  status: string
  lessonId: number | null
  [key: string]: unknown
}
interface Queue {
  mode: string
  today: string
  callOns: unknown[]
  days: { date: string; divisions: QueueSlot[] }[]
}

async function queue(): Promise<Queue> {
  const res = await api('GET', 'lessons/queue')
  expect(res.statusCode).toBe(200)
  return res.json()
}

const slotOf = (q: Queue, date: string, division: Division) =>
  q.days.find((d) => d.date === date)?.divisions.find((s) => s.division === division)

describe('the review queue', () => {
  const FAILED = '大模型暂时不可用（超时、网络出错或服务繁忙）'
  const empty = { flags: 0, lessonId: null, version: null, topic: null, generationFailed: null, locked: false }
  const slot = (division: Division, more: object) => ({ ...empty, division, label: LABELS[division], ...more })

  test('names today as the school’s calendar has it, not the server’s clock', async () => {
    // Half past midnight on Tuesday in the school, still Monday afternoon in UTC.
    await start({ now: new Date('2026-11-03T00:30:00+08:00') })
    const q = await queue()
    expect(q.today).toBe(TUE)
    expect(q.days[0]?.date).toBe(TUE)
  })

  test('lists every lesson day from today to the horizon, the weekend left out, each division with its state', async () => {
    await start()
    const taught = await draft(MON, 'junior')
    await approve(store(), taught, 1)
    await begin(taught, MON, 'junior')
    // Not approved when a primary class began the day with a study hall: no longer to be taught or changed today.
    const waiting = await draft(MON, 'primary')
    await begin(null, MON, 'primary')
    const flagged = await draft(TUE, 'primary', content(`${WORD}的故事`))
    await editPart(store(), flagged, 1, { part: 'segment', index: 0 }, `讲到${OTHER_WORD}的时候`)
    const approved = await draft(TUE, 'junior')
    await approve(store(), approved, 1)
    const now = t.clock.now()
    const failure = (date: string, attempts: number, lastError: string) =>
      ({ date, division: 'senior', attempts, firstFailedAt: now, lastFailedAt: now, lastError }) as const
    // A day gone by is not in the queue.
    await t.db.insertInto('lessonGeneration').values([failure(TUE, 2, FAILED), failure('2026-11-01', 1, '旧的失败')]).execute()
    await t.db.insertInto('lessonTopics').values({ date: WED, division: 'junior', topic: '儿童节', createdAt: now }).execute()
    // Neither the weekend nor a day past the horizon is listed, whatever lessons they have.
    await draft(SAT, 'junior')
    await draft(NEXT_TUE, 'junior')

    const q = await queue()
    expect(q.mode).toBe('api')
    expect(q.callOns).toEqual([
      { kind: 'review', afterSegment: 2 },
      { kind: 'extension', afterSegment: 4 },
    ])
    expect(q.days.map((d) => d.date)).toEqual([MON, TUE, WED, THU, FRI, NEXT_MON])
    for (const day of q.days) {
      expect(day.divisions.map((s) => [s.division, s.label])).toEqual(DIVISIONS.map((d) => [d, LABELS[d]]))
    }

    expect(slotOf(q, MON, 'primary')).toEqual(
      slot('primary', { status: 'pending', lessonId: waiting, version: 1, locked: true }),
    )
    expect((await api('GET', `lessons/${waiting}`)).json().locked).toBe(true)
    expect(slotOf(q, MON, 'junior')).toEqual(
      slot('junior', { status: 'approved', lessonId: taught, version: 1, locked: true }),
    )
    // No senior class has begun today: the day is still open for the division.
    expect(slotOf(q, MON, 'senior')).toEqual(slot('senior', { status: 'missing' }))
    expect(slotOf(q, TUE, 'primary')).toEqual(
      slot('primary', { status: 'flagged', flags: 2, lessonId: flagged, version: 2 }),
    )
    expect(slotOf(q, TUE, 'junior')).toEqual(slot('junior', { status: 'approved', lessonId: approved, version: 1 }))
    expect(slotOf(q, TUE, 'senior')).toEqual(
      slot('senior', { status: 'missing', generationFailed: { attempts: 2, lastError: FAILED } }),
    )
    expect(slotOf(q, WED, 'junior')).toEqual(slot('junior', { status: 'missing', topic: '儿童节' }))
    const others = q.days.filter((d) => d.date !== MON && d.date !== TUE).flatMap((d) => d.divisions)
    expect(others.filter((s) => s.status !== 'missing')).toEqual([])
  })

  test('goes by the school calendar: no lessons before the opening day, in a break, or in one with no end', async () => {
    await start()
    const example = exampleConfig()
    const days = async (calendar: SchoolConfig['calendar'], weekendStudy = true) => {
      const config = { ...example, calendar, lesson: { ...example.lesson, weekendStudy } }
      return (await reviewQueue({ db: t.db, config, clock: t.clock })).map((d) => d.date)
    }
    expect(await days(undefined, false)).toEqual([MON, TUE, WED, THU, FRI, NEXT_MON])
    expect(await days({ openingDay: TUE, breaks: [] })).toEqual([TUE, WED, THU, FRI, NEXT_MON])
    expect(await days({ breaks: [{ from: THU, reopensOn: NEXT_MON }] })).toEqual([MON, TUE, WED, NEXT_MON])
    expect(await days({ breaks: [{ from: WED, reopensOn: null }] })).toEqual([MON, TUE])
    expect(await days({ openingDay: '2026-12-01', breaks: [] })).toEqual([])
  })

  test('says which mode lessons are made in', async () => {
    await start({ config: manualConfig() })
    expect((await queue()).mode).toBe('manual')
  })
})

describe('a lesson', () => {
  test('reads with its content, red marks, false positives and its versions, newest first, without their content', async () => {
    await start()
    const id = await draft(TUE, 'primary', content(`${WORD}的故事`))
    const firstAt = t.clock.now().toISOString()
    t.clock.advance(60_000)
    await editPart(store(), id, 1, { part: 'review' }, '新的复习题？')

    const res = await api('GET', `lessons/${id}`)
    expect(res.statusCode).toBe(200)
    const c = content(`${WORD}的故事`)
    expect(res.json()).toEqual({
      id,
      date: TUE,
      division: 'primary',
      subject: '数学',
      title: `${WORD}的故事`,
      topic: null,
      source: 'api',
      version: 2,
      approvedAt: null,
      locked: false,
      content: { ...c, callOnQuestions: { review: '新的复习题？', extension: c.callOnQuestions?.extension } },
      flags: [{ part: 'title', index: null, kind: 'word', rule: WORD }],
      falsePositives: [],
      versions: [
        { version: 2, change: 'edit', reason: null, segmentIndex: null, createdAt: t.clock.now().toISOString() },
        { version: 1, change: 'generate', reason: null, segmentIndex: null, createdAt: firstAt },
      ],
    })
  })

  test('that does not exist is a 404, and so is an id that is not a lesson number', async () => {
    await start()
    for (const id of ['12345', 'abc', '0', '-1', '1.5', '99999999999']) {
      const res = await api('GET', `lessons/${id}`)
      expect(res.statusCode, id).toBe(404)
      expect(res.json().error.code).toBe('not_found')
    }
    expect((await api('POST', 'lessons/12345/approve', { baseVersion: 1 })).statusCode).toBe(404)
  })
})

describe('reviewing a lesson', () => {
  test('editing a part saves the next version; a save from a stale tab is a 409 and changes nothing', async () => {
    await start()
    const id = await draft(TUE, 'junior')

    const edited = await api('PUT', `lessons/${id}/parts`, { baseVersion: 1, part: { part: 'gist', index: 2 }, text: '新的要点' })
    expect(edited.statusCode).toBe(200)
    expect(edited.json().version).toBe(2)
    expect(edited.json().content.segments[2]).toEqual({ text: '第3段讲稿', gist: '新的要点' })
    expect(edited.json().versions[0]).toMatchObject({ version: 2, change: 'edit' })

    // The other tab still shows version 1.
    const stale = await api('PUT', `lessons/${id}/parts`, { baseVersion: 1, part: { part: 'title' }, text: '另一个标题' })
    expect(stale.statusCode).toBe(409)
    expect(stale.json()).toEqual(STALE)
    expect((await api('GET', `lessons/${id}`)).json()).toMatchObject({ version: 2, title: '光的折射' })

    const marked = await api('PUT', `lessons/${id}/parts`, { baseVersion: 2, part: { part: 'title' }, text: `${WORD}的故事` })
    expect(marked.json()).toMatchObject({
      version: 3,
      title: `${WORD}的故事`,
      flags: [{ part: 'title', index: null, kind: 'word', rule: WORD }],
    })
    for (const part of [{ part: 'segment', index: 0 }, { part: 'review' }, { part: 'extension' }]) {
      const version = (await api('GET', `lessons/${id}`)).json().version
      expect((await api('PUT', `lessons/${id}/parts`, { baseVersion: version, part, text: '改好的文字' })).statusCode).toBe(200)
    }
  })

  test('a part that will not do is a 422 with the reason; a body of the wrong shape is a 400', async () => {
    await start()
    const id = await draft(TUE, 'junior')
    const put = (payload: object) => api('PUT', `lessons/${id}/parts`, payload)

    const missing = await put({ baseVersion: 1, part: { part: 'segment', index: 7 }, text: '文字' })
    expect(missing.statusCode).toBe(422)
    expect(missing.json()).toEqual({ error: { code: 'lesson_format', message: '没有第 8 段，这节课只有 5 段' } })
    const blank = await put({ baseVersion: 1, part: { part: 'title' }, text: '   ' })
    expect(blank.json()).toEqual({ error: { code: 'lesson_format', message: '标题（title）不能为空' } })
    const long = await put({ baseVersion: 1, part: { part: 'gist', index: 0 }, text: '长'.repeat(61) })
    expect(long.json().error.message).toBe('第 1 段的要点（gist）不能超过 60 个字，现在有 61 个字')

    for (const payload of [
      { baseVersion: 1, part: { part: 'body' }, text: '文字' },
      { baseVersion: 1, part: { part: 'segment' }, text: '文字' },
      { baseVersion: '1', part: { part: 'title' }, text: '文字' },
      { baseVersion: 1, part: 'title', text: '文字' },
      { baseVersion: 1, part: { part: 'title' } },
      { baseVersion: 1, part: { part: 'title' }, text: '文字', more: true },
    ]) {
      const res = await put(payload)
      expect(res.statusCode, JSON.stringify(payload)).toBe(400)
      expect(res.json().error.code).toBe('invalid_request')
    }
    expect((await api('GET', `lessons/${id}`)).json().version).toBe(1)
  })

  test('a rewrite asks the model with the reason given and saves what it writes', async () => {
    const model = scripted([
      JSON.stringify({ text: '新的第二段讲稿', gist: '新的第二段要点' }),
      JSON.stringify({ question: '新的引申题？' }),
      lessonReply('换了选题的一课'),
    ])
    await start({ llm: model.llm })
    const id = await draft(TUE, 'junior')
    const rewrite = (payload: object) => api('POST', `lessons/${id}/rewrite`, payload)

    const segment = await rewrite({ baseVersion: 1, kind: 'rewrite_segment', segmentIndex: 1, reason: '举个生活里的例子' })
    expect(segment.statusCode).toBe(200)
    expect(segment.json().content.segments[1]).toEqual({ text: '新的第二段讲稿', gist: '新的第二段要点' })
    expect(segment.json().content.segments[0]).toEqual({ text: '第1段讲稿', gist: '第1段要点' })
    expect(segment.json().versions[0]).toMatchObject({ version: 2, change: 'rewrite_segment', reason: '举个生活里的例子', segmentIndex: 1 })
    expect(model.calls[0]).toMatchObject({ purpose: 'lesson' })
    expect(model.calls[0]?.user).toContain('举个生活里的例子')

    const callOn = await rewrite({ baseVersion: 2, kind: 'rewrite_call_on', callOn: 'extension', reason: '太难了' })
    expect(callOn.json().content.callOnQuestions).toEqual({ review: '光从空气进到水里会怎样？', extension: '新的引申题？' })
    expect(callOn.json().versions[0]).toMatchObject({ version: 3, change: 'rewrite_call_on', reason: '太难了', segmentIndex: null })

    const whole = await rewrite({ baseVersion: 3, kind: 'rewrite_lesson', reason: '换个选题' })
    expect(whole.json()).toMatchObject({ version: 4, title: '换了选题的一课', subject: '数学' })

    // Refused before the model is asked: a blank reason (422, with the reason) and a stale version (409).
    const blank = await rewrite({ baseVersion: 4, kind: 'rewrite_segment', segmentIndex: 0, reason: '  ' })
    expect(blank.statusCode).toBe(422)
    expect(blank.json()).toEqual({ error: { code: 'lesson_format', message: '重写要写上理由' } })
    expect((await rewrite({ baseVersion: 3, kind: 'rewrite_lesson', reason: '再换' })).json()).toEqual(STALE)
    const outOfRange = await rewrite({ baseVersion: 4, kind: 'rewrite_segment', segmentIndex: 5, reason: '再改' })
    expect(outOfRange.json().error.message).toBe('没有第 6 段，这节课只有 5 段')
    for (const payload of [
      { baseVersion: 4, kind: 'generate', reason: '再改' },
      { baseVersion: 4, kind: 'rewrite_call_on', callOn: 'both', reason: '再改' },
      { baseVersion: 4, kind: 'rewrite_segment', segmentIndex: -1, reason: '再改' },
      { baseVersion: 4, kind: 'rewrite_lesson' },
    ]) {
      expect((await rewrite(payload)).statusCode, JSON.stringify(payload)).toBe(400)
    }
    expect(model.calls).toHaveLength(3)
  })

  test('the model out of reach or refusing is a 503 llm_unavailable, each with its own message', async () => {
    const model = scripted([new LlmUnavailable('timed out'), new LlmContentRefused('content refused')])
    await start({ llm: model.llm })
    const id = await draft(TUE, 'junior')
    const payload = { baseVersion: 1, kind: 'rewrite_lesson', reason: '换个选题' }

    const down = await api('POST', `lessons/${id}/rewrite`, payload)
    expect(down.statusCode).toBe(503)
    expect(down.json()).toEqual({
      error: { code: 'llm_unavailable', message: '大模型暂时调不通，稍后再试，或者改用手动粘贴。' },
    })
    const refused = await api('POST', `lessons/${id}/rewrite`, payload)
    expect(refused.statusCode).toBe(503)
    expect(refused.json().error.code).toBe('llm_unavailable')
    expect(refused.json().error.message).toContain('拒绝')
    expect(refused.json().error.message).not.toBe(down.json().error.message)
    expect((await api('GET', `lessons/${id}`)).json().version).toBe(1)
  })

  test('without a model a rewrite is a 503, and nothing changes', async () => {
    await start({ llm: null })
    const id = await draft(TUE, 'junior')
    const res = await api('POST', `lessons/${id}/rewrite`, { baseVersion: 1, kind: 'rewrite_lesson', reason: '换个选题' })
    expect(res.statusCode).toBe(503)
    expect(res.json().error.code).toBe('llm_unavailable')
    expect((await api('GET', `lessons/${id}`)).json().version).toBe(1)
  })

  test('restoring an earlier version makes it the next one', async () => {
    await start()
    const id = await draft(TUE, 'junior')
    await api('PUT', `lessons/${id}/parts`, { baseVersion: 1, part: { part: 'title' }, text: '改过的标题' })

    const restored = await api('POST', `lessons/${id}/restore`, { baseVersion: 2, toVersion: 1 })
    expect(restored.statusCode).toBe(200)
    expect(restored.json()).toMatchObject({ version: 3, title: '光的折射', content: content() })
    expect(restored.json().versions.map((v: { version: number; change: string }) => [v.version, v.change])).toEqual([
      [3, 'restore'],
      [2, 'edit'],
      [1, 'generate'],
    ])

    const unknown = await api('POST', `lessons/${id}/restore`, { baseVersion: 3, toVersion: 9 })
    expect(unknown.statusCode).toBe(404)
    expect(unknown.json()).toEqual({ error: { code: 'not_found', message: '这节课没有第 9 版' } })
    expect((await api('POST', `lessons/${id}/restore`, { baseVersion: 2, toVersion: 1 })).json()).toEqual(STALE)
  })

  test('a red mark blocks approval until it is marked a false positive; then the lesson is approved', async () => {
    await start()
    const id = await draft(TUE, 'junior', content(`${WORD}的故事`))

    const blocked = await api('POST', `lessons/${id}/approve`, { baseVersion: 1 })
    expect(blocked.statusCode).toBe(409)
    expect(blocked.json()).toEqual({
      error: { code: 'lesson_has_flags', message: '这节课还有 1 处红笔标记，改掉或标为误伤以后才能通过' },
    })
    const notThere = await api('POST', `lessons/${id}/false-positive`, { baseVersion: 1, rule: '别的词' })
    expect(notThere.statusCode).toBe(422)
    expect(notThere.json().error.message).toBe('这节课现在没有这条红笔标记，刷新后再看')

    const marked = await api('POST', `lessons/${id}/false-positive`, { baseVersion: 1, rule: WORD })
    expect(marked.statusCode).toBe(200)
    expect(marked.json()).toMatchObject({ version: 2, flags: [], falsePositives: [WORD] })
    // A tab that still shows the mark is stale.
    expect((await api('POST', `lessons/${id}/approve`, { baseVersion: 1 })).json()).toEqual(STALE)

    const approved = await api('POST', `lessons/${id}/approve`, { baseVersion: 2 })
    expect(approved.statusCode).toBe(200)
    expect(approved.json()).toMatchObject({ version: 2, approvedAt: t.clock.now().toISOString() })
    expect(slotOf(await queue(), TUE, 'junior')).toMatchObject({ status: 'approved', flags: 0 })
  })

  test('once a class has begun the lesson, every change to it is a 409 lesson_locked', async () => {
    const model = scripted([])
    await start({ llm: model.llm, config: manualConfig() })
    const id = await draft(THU, 'junior')
    await approve(store(), id, 1)
    await begin(id, THU, 'junior')

    const attempts = [
      api('PUT', `lessons/${id}/parts`, { baseVersion: 1, part: { part: 'title' }, text: '新标题' }),
      api('POST', `lessons/${id}/rewrite`, { baseVersion: 1, kind: 'rewrite_lesson', reason: '换个选题' }),
      api('POST', `lessons/${id}/restore`, { baseVersion: 1, toVersion: 1 }),
      api('POST', `lessons/${id}/false-positive`, { baseVersion: 1, rule: WORD }),
      api('POST', `lessons/${id}/approve`, { baseVersion: 1 }),
      api('POST', 'lessons/paste', {
        date: THU,
        division: 'junior',
        kind: 'rewrite_call_on',
        lessonId: id,
        baseVersion: 1,
        callOn: 'review',
        reason: '太难了',
        pasted: '{"question": "新的复习题？"}',
      }),
      api('PUT', `topics/${THU}/junior`, { topic: '儿童节是怎么来的' }),
    ]
    for (const res of await Promise.all(attempts)) {
      expect(res.statusCode, res.body).toBe(409)
      expect(res.json()).toEqual(LOCKED)
    }
    expect((await api('GET', `lessons/${id}`)).json()).toMatchObject({ version: 1, locked: true, title: '光的折射' })
    expect(slotOf(await queue(), THU, 'junior')).toMatchObject({ status: 'approved', locked: true, topic: null })
    expect(model.calls).toHaveLength(0)
  })

  test('once the doors opened on a draft (a study hall that day), approving or editing it is a 409 lesson_locked', async () => {
    await start()
    const id = await draft(MON, 'junior')
    await begin(null, MON, 'junior')
    for (const res of [
      await api('POST', `lessons/${id}/approve`, { baseVersion: 1 }),
      await api('PUT', `lessons/${id}/parts`, { baseVersion: 1, part: { part: 'title' }, text: '开课以后改的' }),
    ]) {
      expect(res.statusCode).toBe(409)
      expect(res.json()).toEqual(LOCKED)
    }
    expect((await api('GET', `lessons/${id}`)).json()).toMatchObject({ version: 1, approvedAt: null, locked: true })
  })
})

describe('pasting a reply in', () => {
  test('a reply that is not in the format is a 422 with the reason, and nothing is stored', async () => {
    await start({ config: manualConfig() })
    const paste = (pasted: string, more: object = {}) =>
      api('POST', 'lessons/paste', { date: WED, division: 'senior', kind: 'generate', pasted, ...more })

    const noJson = await paste('好的，下面是这节课。')
    expect(noJson.statusCode).toBe(422)
    expect(noJson.json()).toEqual({ error: { code: 'lesson_format', message: '没有在粘贴的内容里找到 JSON' } })
    const short = await paste(lessonReply('短的一课', 3))
    expect(short.statusCode).toBe(422)
    expect(short.json()).toEqual({ error: { code: 'lesson_format', message: '课程必须正好有 5 段，这一份有 3 段' } })
    expect(await t.db.selectFrom('lessons').select('id').execute()).toEqual([])

    const weekend = await api('POST', 'lessons/paste', { date: SAT, division: 'senior', kind: 'generate', pasted: lessonReply() })
    expect(weekend.statusCode).toBe(422)
    expect(weekend.json().error.code).toBe('not_a_lesson_day')
    expect(weekend.json().error.message).toContain('不上课')
  })

  test('a reply in the format becomes a draft, and a pasted rewrite its next version', async () => {
    await start({ config: manualConfig() })
    const stored = await api('POST', 'lessons/paste', {
      date: WED,
      division: 'senior',
      kind: 'generate',
      pasted: `好的，这是课程：\n\`\`\`json\n${lessonReply('英语里的时态')}\n\`\`\`\n希望有用。`,
    })
    expect(stored.statusCode).toBe(200)
    expect(stored.json()).toMatchObject({
      date: WED,
      division: 'senior',
      subject: '英语',
      title: '英语里的时态',
      source: 'manual',
      version: 1,
    })
    const id = stored.json().id
    expect(slotOf(await queue(), WED, 'senior')).toMatchObject({ status: 'pending', lessonId: id, version: 1 })

    const rewritten = await api('POST', 'lessons/paste', {
      date: WED,
      division: 'senior',
      kind: 'rewrite_segment',
      lessonId: id,
      baseVersion: 1,
      segmentIndex: 0,
      reason: '太长了',
      pasted: JSON.stringify({ text: '短一点的第一段', gist: '第一段要点' }),
    })
    expect(rewritten.statusCode).toBe(200)
    expect(rewritten.json().content.segments[0]).toEqual({ text: '短一点的第一段', gist: '第一段要点' })
    expect(rewritten.json().versions[0]).toMatchObject({ version: 2, change: 'rewrite_segment', reason: '太长了', segmentIndex: 0 })

    const stale = await api('POST', 'lessons/paste', {
      date: WED,
      division: 'senior',
      kind: 'rewrite_lesson',
      lessonId: id,
      baseVersion: 1,
      reason: '换个选题',
      pasted: lessonReply(),
    })
    expect(stale.json()).toEqual(STALE)
    const noVersion = await api('POST', 'lessons/paste', {
      date: WED,
      division: 'senior',
      kind: 'rewrite_lesson',
      lessonId: id,
      reason: '换个选题',
      pasted: lessonReply(),
    })
    expect(noVersion.statusCode).toBe(422)
    expect(noVersion.json().error.message).toBe('重写要带上复制提示词时这节课的版本号')
  })

  test('a new lesson pasted for a day that has one is a 409 unless it names the version it replaces', async () => {
    await start({ config: manualConfig() })
    const paste = (more: object = {}) =>
      api('POST', 'lessons/paste', { date: WED, division: 'senior', kind: 'generate', pasted: lessonReply('后贴的课'), ...more })
    // The model made the day's lesson (its deadline came) while a tab still showed the day missing.
    const id = await draft(WED, 'senior')
    await approve(store(), id, 1)
    const stale = await paste()
    expect(stale.statusCode).toBe(409)
    expect(stale.json()).toEqual(STALE)
    expect(slotOf(await queue(), WED, 'senior')).toMatchObject({ status: 'approved', lessonId: id, version: 1 })
    expect((await paste({ baseVersion: 2 })).json()).toEqual(STALE)
    const replaced = await paste({ baseVersion: 1 })
    expect(replaced.statusCode).toBe(200)
    expect(replaced.json()).toMatchObject({ id, title: '后贴的课', version: 2, approvedAt: null })
  })

  test('a body of the wrong shape is a 400', async () => {
    await start({ config: manualConfig() })
    for (const payload of [
      { date: WED, division: 'senior', kind: 'generate' },
      { date: '2026-02-30', division: 'senior', kind: 'generate', pasted: lessonReply() },
      { date: WED, division: 'middle', kind: 'generate', pasted: lessonReply() },
      { date: WED, division: 'senior', kind: 'regenerate', pasted: lessonReply() },
      { date: WED, division: 'senior', kind: 'rewrite_lesson', lessonId: 'one', baseVersion: 1, reason: '换', pasted: '{}' },
    ]) {
      const res = await api('POST', 'lessons/paste', payload)
      expect(res.statusCode, JSON.stringify(payload)).toBe(400)
    }
    expect(await t.db.selectFrom('lessons').select('id').execute()).toEqual([])
  })
})

describe('the prompt to copy', () => {
  test('is the system and user prompt in one, with the subject of the day and the topic given for it', async () => {
    await start()
    expect((await api('PUT', `topics/${WED}/junior`, { topic: '儿童节是怎么来的' })).json()).toEqual({ result: 'stored' })

    const topical = await api('GET', promptQuery({ kind: 'generate', date: WED, division: 'junior' }))
    expect(topical.statusCode).toBe(200)
    expect(topical.json().text).toContain('科目：专题')
    expect(topical.json().text).toContain('本节课的主题：儿童节是怎么来的')
    const plain = await api('GET', promptQuery({ kind: 'generate', date: WED, division: 'primary' }))
    expect(plain.json().text).toContain('科目：英语')
    expect(plain.json().text).toContain('学部：小学部')

    const prompt = await buildLessonPrompt({ db: t.db, config: t.config, prompts: examplePrompts() }, 'generate', {
      date: WED,
      division: 'primary',
    })
    expect(plain.json()).toEqual({ text: `${prompt.system}\n\n${prompt.user}` })
    // The reply format comes last.
    expect(plain.json().text.endsWith('每个字段都必须是不为空的文字。')).toBe(true)
  })

  test('of a rewrite has the reason and the part; a missing reason is a 422, bad parameters a 400', async () => {
    await start()
    const id = await draft(TUE, 'junior')
    const base = { date: TUE, division: 'junior', lessonId: id }

    const segment = await api('GET', promptQuery({ ...base, kind: 'rewrite_segment', segmentIndex: 1, reason: '举个生活里的例子' }))
    expect(segment.statusCode).toBe(200)
    expect(segment.json().text).toContain('请重写下面这节课的第 2 段')
    expect(segment.json().text).toContain('修改意见：举个生活里的例子')
    const callOn = await api('GET', promptQuery({ ...base, kind: 'rewrite_call_on', callOn: 'review', reason: '太难了' }))
    expect(callOn.json().text).toContain('复习题')
    expect((await api('GET', promptQuery({ ...base, kind: 'rewrite_lesson', reason: '换个选题' }))).statusCode).toBe(200)

    const noReason = await api('GET', promptQuery({ ...base, kind: 'rewrite_lesson' }))
    expect(noReason.statusCode).toBe(422)
    expect(noReason.json()).toEqual({ error: { code: 'lesson_format', message: '重写要写上理由' } })
    const weekend = await api('GET', promptQuery({ kind: 'generate', date: SAT, division: 'junior' }))
    expect(weekend.statusCode).toBe(422)
    expect(weekend.json().error.code).toBe('not_a_lesson_day')
    const unknown = await api('GET', promptQuery({ ...base, lessonId: 12345, kind: 'rewrite_lesson', reason: '换' }))
    expect(unknown.statusCode).toBe(404)

    for (const params of [
      { kind: 'nonsense', date: TUE, division: 'junior' },
      { kind: 'generate', date: '2026-02-30', division: 'junior' },
      { kind: 'generate', date: TUE, division: 'middle' },
      { kind: 'generate', date: TUE },
      { kind: 'generate', division: 'junior' },
      { ...base, lessonId: 'abc', kind: 'rewrite_lesson', reason: '换' },
      { ...base, kind: 'rewrite_segment', segmentIndex: '-1', reason: '换' },
      { ...base, kind: 'rewrite_call_on', callOn: 'both', reason: '换' },
    ]) {
      expect((await api('GET', promptQuery(params))).statusCode, JSON.stringify(params)).toBe(400)
    }
    const twice = `${promptQuery({ kind: 'generate', date: TUE })}&division=junior&division=senior`
    expect((await api('GET', twice)).statusCode).toBe(400)
  })
})

describe('the topic of a day', () => {
  test('is stored trimmed and taken away with null; a topic that will not do is a 422 with the reason', async () => {
    await start()
    const put = (date: string, division: string, payload: object) => api('PUT', `topics/${date}/${division}`, payload)

    expect((await put(THU, 'primary', { topic: '  儿童节是怎么来的  ' })).json()).toEqual({ result: 'stored' })
    expect(await t.db.selectFrom('lessonTopics').select(['date', 'division', 'topic']).execute()).toEqual([
      { date: THU, division: 'primary', topic: '儿童节是怎么来的' },
    ])
    expect(slotOf(await queue(), THU, 'primary')).toMatchObject({ topic: '儿童节是怎么来的' })
    expect((await put(THU, 'primary', { topic: null })).json()).toEqual({ result: 'stored' })
    expect(await t.db.selectFrom('lessonTopics').select('topic').execute()).toEqual([])

    const refusals: [string, object, string][] = [
      [THU, { topic: '   ' }, '题目不能为空'],
      [THU, { topic: '题'.repeat(61) }, '题目不能超过 60 个字，现在有 61 个字'],
      [SAT, { topic: '周末的题目' }, `${SAT} 不上课（周末、放假或还没开学），不能指定题目`],
      [MON, { topic: '今天的题目' }, '今天的课已经定了，只能给明天以后的上学日指定题目'],
    ]
    for (const [date, payload, message] of refusals) {
      const res = await put(date, 'primary', payload)
      expect(res.statusCode, message).toBe(422)
      expect(res.json()).toEqual({ error: { code: 'topic_refused', message } })
    }
    expect((await put(THU, 'primary', { topic: '题'.repeat(60) })).statusCode).toBe(200)

    for (const [date, division, payload] of [
      ['2026-13-01', 'primary', { topic: '题目' }],
      ['tomorrow', 'primary', { topic: '题目' }],
      [THU, 'middle', { topic: '题目' }],
      [THU, 'primary', {}],
      [THU, 'primary', { topic: 5 }],
    ] as const) {
      expect((await put(date, division, payload)).statusCode, `${date} ${division} ${JSON.stringify(payload)}`).toBe(400)
    }
  })

  test('are listed from today on, for any later school day, in date and division order', async () => {
    await start()
    const put = (date: string, division: string, topic: string) => api('PUT', `topics/${date}/${division}`, { topic })
    // Months ahead, far past the days the lessons are made for.
    const CHILDRENS_DAY = '2027-06-01'
    expect((await put(CHILDRENS_DAY, 'senior', '儿童节是怎么来的')).statusCode).toBe(200)
    expect((await put(CHILDRENS_DAY, 'primary', '儿童节')).statusCode).toBe(200)
    expect((await put(THU, 'junior', '冬至')).statusCode).toBe(200)
    // A topic of a day gone by stays in the table but is not listed.
    await t.db.insertInto('lessonTopics').values({ date: '2026-10-30', division: 'junior', topic: '旧题目', createdAt: t.clock.now() }).execute()

    const res = await api('GET', 'topics')
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      topics: [
        { date: THU, division: 'junior', topic: '冬至' },
        { date: CHILDRENS_DAY, division: 'primary', topic: '儿童节' },
        { date: CHILDRENS_DAY, division: 'senior', topic: '儿童节是怎么来的' },
      ],
    })
    expect(await t.db.selectFrom('lessons').select('id').execute()).toEqual([])
  })

  test('given for a day whose lesson is made already sends it back to be made again with the topic', async () => {
    const model = scripted([lessonReply('中秋节的故事')])
    await start({ llm: model.llm })
    const id = await draft(FRI, 'senior')
    await approve(store(), id, 1)

    const res = await api('PUT', `topics/${FRI}/senior`, { topic: '中秋节' })
    expect(res.json()).toEqual({ result: 'regenerating' })
    await vi.waitFor(
      async () => {
        const lesson = (await api('GET', `lessons/${id}`)).json()
        expect(lesson).toMatchObject({ version: 3, title: '中秋节的故事', subject: '专题', topic: '中秋节', approvedAt: null })
      },
      { timeout: 5000 },
    )
    expect(model.calls[0]?.user).toContain('中秋节')
  })
})

test('the log names lessons and actions, never a lesson text, a prompt, a reason or a pasted reply', async () => {
  const SECRET = 'SECRET不该进日志'
  const logs = captureLogs()
  const model = scripted([JSON.stringify({ text: `${SECRET}的第一段`, gist: '要点' })])
  await start({ llm: model.llm, logger: { level: 'info', stream: logs.stream } })
  const id = await draft(TUE, 'junior', content(`${SECRET}标题`))

  expect((await api('GET', `lessons/${id}`)).statusCode).toBe(200)
  const edited = await api('PUT', `lessons/${id}/parts`, { baseVersion: 1, part: { part: 'review' }, text: `${SECRET}？` })
  expect(edited.statusCode).toBe(200)
  const rewritten = await api('POST', `lessons/${id}/rewrite`, {
    baseVersion: 2,
    kind: 'rewrite_segment',
    segmentIndex: 0,
    reason: SECRET,
  })
  expect(rewritten.statusCode).toBe(200)
  const prompt = await api(
    'GET',
    promptQuery({ kind: 'rewrite_lesson', date: TUE, division: 'junior', lessonId: id, reason: SECRET }),
  )
  expect(prompt.json().text).toContain(SECRET)
  const paste = (pasted: string) => api('POST', 'lessons/paste', { date: WED, division: 'junior', kind: 'generate', pasted })
  expect((await paste(SECRET)).statusCode).toBe(422)
  expect((await paste(lessonReply(SECRET))).statusCode).toBe(200)
  expect((await api('PUT', `topics/${THU}/junior`, { topic: SECRET })).statusCode).toBe(200)

  const entries = logs.entries()
  expect(JSON.stringify(entries)).not.toContain('SECRET')
  expect(entries.filter((e) => e.msg === 'lesson review').map((e) => [e.action, e.lessonId])).toEqual([
    ['edit', id],
    ['rewrite_segment', id],
    ['paste_generate', expect.any(Number)],
  ])
})
