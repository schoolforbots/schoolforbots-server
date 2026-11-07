import { join } from 'node:path'
import type { Kysely, KyselyPlugin } from 'kysely'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { planSession } from '../../src/class/planning.js'
import { openingLesson } from '../../src/class/teacher.js'
import { LessonFormatError } from '../../src/lessons/format.js'
import {
  acceptPasted,
  generateMissing,
  regenerate,
  setTopic,
  SPECIAL_SUBJECT,
  TopicRefused,
  type GeneratorDeps,
} from '../../src/lessons/generator.js'
import { buildLessonPrompt, NotALessonDay } from '../../src/lessons/prompts.js'
import { approve, LessonLocked, LessonNotFound, saveDraft, StaleLessonVersion } from '../../src/lessons/store.js'
import { createLlm } from '../../src/llm/client.js'
import { createFakeLlm } from '../../src/llm/fake.js'
import { loadPrompts, type PromptName, type PromptTemplate } from '../../src/llm/prompts.js'
import { LlmContentRefused, LlmTruncated, LlmUnavailable, type LlmRequest, type LlmResponse } from '../../src/llm/provider.js'
import type { Division, SchoolConfig } from '../../src/shared/config.js'
import type { Database, LessonContent } from '../../src/shared/schema.js'
import { exampleConfig, exampleModerator } from '../helpers/app.js'
import { createTestClock } from '../helpers/clock.js'
import { createTestDb } from '../helpers/db.js'
import { insertClass, insertLesson, insertSession } from '../helpers/factories.js'

// Today is Wednesday 2026-11-04. The lesson days of the next 7 days are Thursday 11-05 (科学), Friday 11-06 (人文),
// Monday 11-09 (语文), Tuesday 11-10 (数学) and Wednesday 11-11 (英语): the weekend has study halls, not lessons.
const TODAY = '2026-11-04'
const THU = '2026-11-05'
const FRI = '2026-11-06'
const SAT = '2026-11-07'
const MON = '2026-11-09'
const TUE = '2026-11-10'
const NEXT_WED = '2026-11-11'
const DIVISIONS: Division[] = ['primary', 'junior', 'senior']

/** The example prompt files, read without the warning that no real ones are there. */
function examplePrompts(): Record<PromptName, PromptTemplate> {
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  try {
    return loadPrompts(join(import.meta.dirname, '../../data/prompts'))
  } finally {
    stderr.mockRestore()
  }
}
const prompts = examplePrompts()
const moderator = exampleModerator()

/** The example school with its two call-ons (review after segment 2, extension after 4). */
function school(
  generation: Partial<SchoolConfig['lessonGeneration']> = {},
  more: Partial<SchoolConfig> = {},
): SchoolConfig {
  const example = exampleConfig()
  return {
    ...example,
    ...more,
    lesson: {
      ...example.lesson,
      callOns: [
        { kind: 'review', afterSegment: 2 },
        { kind: 'extension', afterSegment: 4 },
      ],
    },
    lessonGeneration: { ...example.lessonGeneration, mode: 'api', horizonDays: 7, manualDeadlineSchoolDays: 3, ...generation },
  }
}

const segments = (n = 5, tag = '') =>
  Array.from({ length: n }, (_, i) => ({ text: `${tag}第${i + 1}段讲稿`, gist: `${tag}第${i + 1}段要点` }))
const CALL_ONS = { review: '光从空气进到水里会怎样？', extension: '筷子放进水里为什么看起来弯了？' }

/** A lesson as the model writes it. */
const lessonReply = (title = '光的折射', over: Record<string, unknown> = {}) =>
  JSON.stringify({ title, segments: segments(), callOnQuestions: CALL_ONS, ...over })
const ok = (text: string): LlmResponse => ({ text, inputTokens: 100, outputTokens: 200, cachedInputTokens: 0 })

const content = (over: Partial<LessonContent> = {}): LessonContent => ({
  title: '光的折射',
  subject: '科学',
  segments: segments(),
  callOnQuestions: CALL_ONS,
  ...over,
})

let db: Kysely<Database>
let destroy: () => Promise<void>
const clock = createTestClock(new Date(`${TODAY}T09:00:00+08:00`))

beforeEach(async () => {
  ;({ db, destroy } = await createTestDb())
  clock.set(new Date(`${TODAY}T09:00:00+08:00`))
})

afterEach(async () => {
  await destroy()
})

type Script = (req: LlmRequest) => LlmResponse | Error | Promise<LlmResponse | Error>

/** The generator over a real model client whose provider answers by `script`. */
function make(config: SchoolConfig, script: Script = () => ok(lessonReply())) {
  const provider = createFakeLlm((_, req) => script(req))
  const llm = createLlm({ db, config, clock, providers: { [config.llm.purposes.lesson.provider]: provider } })
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const deps: GeneratorDeps = { db, clock, moderator, config, llm, prompts, log }
  return { deps, provider, log }
}

const lessonRows = () => db.selectFrom('lessons').selectAll().orderBy('date').orderBy('division').execute()
const lessonOf = (date: string, division: Division) =>
  db.selectFrom('lessons').selectAll().where('date', '=', date).where('division', '=', division).executeTakeFirst()
const versionRows = (lessonId: number) =>
  db.selectFrom('lessonVersions').selectAll().where('lessonId', '=', lessonId).orderBy('version').execute()
const failures = () => db.selectFrom('lessonGeneration').selectAll().orderBy('date').orderBy('division').execute()
const llmCalls = () => db.selectFrom('llmCalls').select(['purpose', 'outcome']).orderBy('id').execute()
const topics = () => db.selectFrom('lessonTopics').select(['date', 'division', 'topic']).orderBy('date').execute()

async function rejection(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => null,
    (err: unknown) => err,
  )
}

/** A class of the lesson's division begins it in a session: from then on its day is decided. */
async function beginLesson(lessonId: number, date: string) {
  const { division } = await db.selectFrom('lessons').select('division').where('id', '=', lessonId).executeTakeFirstOrThrow()
  const classId = await insertClass(db, { division, classNo: 1, slot: 'morning' })
  await insertSession(db, {
    classId,
    date,
    slot: 'morning',
    kind: 'lesson',
    lessonId,
    startsAt: new Date(`${date}T10:00:00+08:00`),
    endsAt: new Date(`${date}T10:30:00+08:00`),
  })
}

describe('generateMissing', () => {
  test('in api mode makes the missing lessons of the next 7 days as drafts, and leaves the ones there alone', async () => {
    const { deps, provider } = make(school())
    const there = await saveDraft(deps, { date: THU, division: 'junior' }, content({ title: '已有的课' }), {
      source: 'import',
      change: 'generate',
    })

    expect(await generateMissing(deps)).toEqual({ generated: 14, failed: 0, waitingManual: 0 })
    expect(provider.calls).toHaveLength(14)
    expect(provider.calls.every((c) => c.req.json)).toBe(true)

    const rows = await lessonRows()
    expect(rows.map((r) => `${r.date} ${r.division}`)).toEqual(
      [THU, FRI, MON, TUE, NEXT_WED].flatMap((d) => DIVISIONS.map((div) => `${d} ${div}`)),
    )
    const subjects = Object.fromEntries(rows.map((r) => [r.date, r.subject]))
    expect(subjects).toEqual({ [THU]: '科学', [FRI]: '人文', [MON]: '语文', [TUE]: '数学', [NEXT_WED]: '英语' })
    for (const r of rows.filter((r) => r.id !== there.lessonId)) {
      expect(r).toMatchObject({ title: '光的折射', source: 'api', topic: null, version: 1, approvedAt: null })
      expect(r.callOnQuestions).toEqual(CALL_ONS)
      expect(await versionRows(r.id)).toMatchObject([{ version: 1, change: 'generate', reason: null }])
    }
    expect(await lessonOf(THU, 'junior')).toMatchObject({ id: there.lessonId, title: '已有的课', source: 'import', version: 1 })
    expect(await llmCalls()).toEqual(Array.from({ length: 14 }, () => ({ purpose: 'lesson', outcome: 'ok' })))

    // Nothing is missing any more: the next run calls nothing.
    expect(await generateMissing(deps)).toEqual({ generated: 0, failed: 0, waitingManual: 0 })
    expect(provider.calls).toHaveLength(14)
  })

  test('in manual mode calls the model only for the lessons within manualDeadlineSchoolDays school days', async () => {
    const { deps, provider } = make(school({ mode: 'manual' }))
    // Thursday is 1 school day away, Friday 2 and Monday 3 (the weekend does not count); Tuesday and Wednesday wait.
    expect(await generateMissing(deps)).toEqual({ generated: 9, failed: 0, waitingManual: 6 })
    expect(provider.calls).toHaveLength(9)
    expect([...new Set((await lessonRows()).map((r) => r.date))]).toEqual([THU, FRI, MON])

    // A lesson pasted in is not made again, and the ones still waiting keep waiting.
    expect(await generateMissing(deps)).toEqual({ generated: 0, failed: 0, waitingManual: 6 })
    // Two days later Wednesday's lesson is 3 school days away; the next Thursday and Friday come in and wait.
    clock.set(new Date(`${FRI}T00:05:00+08:00`))
    expect(await generateMissing(deps)).toEqual({ generated: 6, failed: 0, waitingManual: 6 })
    expect([...new Set((await lessonRows()).map((r) => r.date))]).toEqual([THU, FRI, MON, TUE, NEXT_WED])
  })

  test('in manual mode the days of a break do not count toward the deadline, and get no lesson', async () => {
    const config = school({ mode: 'manual' }, { calendar: { breaks: [{ from: MON, reopensOn: NEXT_WED }] } })
    const { deps } = make(config)
    // Monday and Tuesday are a break: next Wednesday is the third school day.
    expect(await generateMissing(deps)).toEqual({ generated: 9, failed: 0, waitingManual: 0 })
    expect([...new Set((await lessonRows()).map((r) => r.date))]).toEqual([THU, FRI, NEXT_WED])
  })

  test('a reply cut off at the token cap is recorded as too long, not as a format problem', async () => {
    const { deps, log } = make(school({ horizonDays: 1 }), () => new LlmTruncated('cut off', 100, 8000))
    const first = clock.now()
    expect(await generateMissing(deps)).toEqual({ generated: 0, failed: 3, waitingManual: 0 })
    expect(await failures()).toEqual(
      DIVISIONS.map((division) => ({
        date: THU,
        division,
        attempts: 1,
        firstFailedAt: first,
        lastFailedAt: first,
        lastError: '大模型的回复太长，被截断了',
      })),
    )
    expect(log.warn).toHaveBeenCalledWith({ date: THU, division: 'junior', outcome: 'failed', err: 'LlmTruncated' }, expect.any(String))
  })

  test('a failure is written to lesson_generation with a reason in Chinese; a retry that succeeds clears it', async () => {
    let failing = true
    const { deps, provider, log } = make(school({ horizonDays: 1 }), () =>
      failing ? new LlmUnavailable('upstream 503 SECRET') : ok(lessonReply()),
    )
    const first = clock.now()
    expect(await generateMissing(deps)).toEqual({ generated: 0, failed: 3, waitingManual: 0 })
    const reason = '大模型暂时不可用（超时、网络出错或服务繁忙）'
    expect(await failures()).toEqual(
      DIVISIONS.map((division) => ({ date: THU, division, attempts: 1, firstFailedAt: first, lastFailedAt: first, lastError: reason })),
    )
    expect(await lessonRows()).toEqual([])
    expect(log.warn).toHaveBeenCalledWith({ date: THU, division: 'junior', outcome: 'failed', err: 'LlmUnavailable' }, expect.any(String))

    clock.advance(60 * 60_000)
    const second = clock.now()
    expect(await generateMissing(deps)).toEqual({ generated: 0, failed: 3, waitingManual: 0 })
    expect(await failures()).toEqual(
      DIVISIONS.map((division) => ({ date: THU, division, attempts: 2, firstFailedAt: first, lastFailedAt: second, lastError: reason })),
    )

    failing = false
    clock.advance(60 * 60_000)
    expect(await generateMissing(deps)).toEqual({ generated: 3, failed: 0, waitingManual: 0 })
    expect(await failures()).toEqual([])
    expect((await lessonRows()).map((r) => r.division)).toEqual(DIVISIONS)
    // The error is not retryable, so each call reaches the provider once, even though llm.retries is 1.
    expect(provider.calls).toHaveLength(3 * 2 + 3)
    expect(JSON.stringify([log.info.mock.calls, log.warn.mock.calls, log.error.mock.calls])).not.toContain('SECRET')
  })

  test.each<[string, () => LlmResponse | Error, string]>([
    ['the model refuses the content', () => new LlmContentRefused('content refused SECRET'), '大模型以内容为由拒绝了这次生成'],
    ['the reply has no JSON', () => ok('抱歉，SECRET 这个我写不了。'), '大模型的回复里没有找到 JSON'],
    [
      'the lesson has the wrong number of segments',
      () => ok(lessonReply('SECRET', { segments: segments(3) })),
      '大模型交回的课程格式不对：课程必须正好有 5 段，这一份有 3 段',
    ],
    [
      'a call-on question is missing',
      () => ok(lessonReply('SECRET', { callOnQuestions: { review: 'SECRET？' } })),
      '大模型交回的课程格式不对：引申题（callOnQuestions.extension）不能为空',
    ],
    [
      'a segment is too long',
      () => ok(lessonReply('SECRET', { segments: [...segments(4), { text: 'SECRET'.repeat(150), gist: '要点' }] })),
      '大模型交回的课程格式不对：第 5 段的正文（text）不能超过 800 个字，现在有 900 个字',
    ],
  ])('when %s, the reason says so and quotes nothing of the reply', async (_, reply, reason) => {
    const { deps, log } = make(school({ horizonDays: 1 }), reply)
    expect(await generateMissing(deps)).toEqual({ generated: 0, failed: 3, waitingManual: 0 })
    expect((await failures()).map((f) => f.lastError)).toEqual([reason, reason, reason])
    expect(await lessonRows()).toEqual([])
    expect(JSON.stringify([log.info.mock.calls, log.warn.mock.calls, log.error.mock.calls])).not.toContain('SECRET')
  })

  test('makes a lesson again when the topic of its day is not the one it was made with, unless a class has begun it', async () => {
    const { deps, provider } = make(school({ horizonDays: 1 }), () => ok(lessonReply('儿童节的故事')))
    const at = (division: Division) => ({ date: THU, division })
    // Each lesson is there; the topics are given behind the generator's back (an import, say).
    const primary = await saveDraft(deps, at('primary'), content(), { source: 'import', change: 'generate' })
    const junior = await saveDraft(deps, at('junior'), content(), { source: 'import', change: 'generate', topic: '旧题目' })
    const senior = await saveDraft(deps, at('senior'), content(), { source: 'import', change: 'generate' })
    await db
      .insertInto('lessonTopics')
      .values(DIVISIONS.map((division) => ({ date: THU, division, topic: '儿童节是怎么来的', createdAt: clock.now() })))
      .execute()
    await beginLesson(senior.lessonId, THU)

    expect(await generateMissing(deps)).toEqual({ generated: 2, failed: 0, waitingManual: 0 })
    expect(provider.calls).toHaveLength(2)
    for (const { lessonId } of [primary, junior]) {
      expect(await lessonOf(THU, lessonId === primary.lessonId ? 'primary' : 'junior')).toMatchObject({
        id: lessonId,
        subject: SPECIAL_SUBJECT,
        topic: '儿童节是怎么来的',
        version: 2,
      })
      expect((await versionRows(lessonId)).map((v) => v.change)).toEqual(['generate', 'topic'])
    }
    expect(await lessonOf(THU, 'senior')).toMatchObject({ subject: '科学', topic: null, version: 1 })
    // They follow their topic now: the next run leaves them alone.
    expect(await generateMissing(deps)).toEqual({ generated: 0, failed: 0, waitingManual: 0 })
  })

  test('a lesson whose topic was taken away is not made again', async () => {
    const { deps, provider } = make(school({ horizonDays: 1 }))
    for (const division of DIVISIONS) {
      await saveDraft(deps, { date: THU, division }, content(), { source: 'api', change: 'generate', topic: '儿童节' })
    }
    expect(await generateMissing(deps)).toEqual({ generated: 0, failed: 0, waitingManual: 0 })
    expect(provider.calls).toHaveLength(0)
  })

  test('drops the failures of days that have the lesson they need, and keeps the others', async () => {
    // The model is down, in manual mode.
    const { deps } = make(school({ mode: 'manual' }), () => new LlmUnavailable('down'))
    const failed = (date: string, division: Division) => ({
      date,
      division,
      attempts: 1,
      firstFailedAt: clock.now(),
      lastFailedAt: clock.now(),
      lastError: '大模型暂时不可用（超时、网络出错或服务繁忙）',
    })
    // Thursday primary: a lesson came since (imported, say). Thursday junior: a lesson, but not with the topic given
    // since. Tuesday junior: still missing, not due yet in manual mode. Last Monday senior: a lesson came, a day gone by.
    await saveDraft(deps, { date: THU, division: 'primary' }, content(), { source: 'import', change: 'generate' })
    await saveDraft(deps, { date: THU, division: 'junior' }, content(), { source: 'import', change: 'generate' })
    await db.insertInto('lessonTopics').values({ date: THU, division: 'junior', topic: '儿童节', createdAt: clock.now() }).execute()
    await insertLesson(db, { date: '2026-11-02', division: 'senior' })
    await db
      .insertInto('lessonGeneration')
      .values([failed(THU, 'primary'), failed(THU, 'junior'), failed(TUE, 'junior'), failed('2026-11-02', 'senior')])
      .execute()

    // Thursday junior fails again, with the missing lessons due by Monday.
    expect(await generateMissing(deps)).toEqual({ generated: 0, failed: 8, waitingManual: 6 })
    const left = (await failures()).map((f) => `${f.date} ${f.division}`)
    expect(left).toContain(`${THU} junior`)
    expect(left).toContain(`${TUE} junior`)
    expect(left).not.toContain(`${THU} primary`)
    expect(left).not.toContain('2026-11-02 senior')
  })

  test('every lesson call has the lesson generation timeout, not the shorter one of the model', async () => {
    const config = school({ timeoutSeconds: 180 })
    expect(config.llm.timeoutSeconds).toBe(60)
    // The reply each format asks for: a whole lesson, a call-on question or a segment.
    const replyTo = (user: string) =>
      user.includes('"callOnQuestions"')
        ? lessonReply()
        : user.includes('{"question"')
          ? '{"question": "新题？"}'
          : '{"text": "新", "gist": "新"}'
    const { deps, provider } = make({ ...config, lessonGeneration: { ...config.lessonGeneration, horizonDays: 1 } }, (req) =>
      ok(replyTo(req.user)),
    )
    await generateMissing(deps)
    const lesson = await lessonOf(THU, 'junior')
    const lessonId = lesson?.id ?? 0
    await regenerate(deps, 'rewrite_segment', { lessonId, baseVersion: 1, segmentIndex: 0, reason: 'r' })
    await regenerate(deps, 'rewrite_call_on', { lessonId, baseVersion: 2, callOn: 'review', reason: 'r' })
    await regenerate(deps, 'rewrite_lesson', { lessonId, baseVersion: 3, reason: 'r' })
    expect(provider.calls).toHaveLength(6)
    for (const call of provider.calls) {
      expect(call.req.timeoutMs).toBeGreaterThan(170_000)
      expect(call.req.timeoutMs).toBeLessThanOrEqual(180_000)
    }
  })

  test('only one run at a time, and nothing is locked while the model writes', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const { deps, provider } = make(school({ horizonDays: 1 }), async () => {
      await gate
      return ok(lessonReply())
    })
    const first = generateMissing(deps)
    await vi.waitFor(() => expect(provider.calls).toHaveLength(1), { timeout: 5000 })

    // A second run while the first waits on the model does nothing.
    expect(await generateMissing(deps)).toEqual({ generated: 0, failed: 0, waitingManual: 0 })
    expect(provider.calls).toHaveLength(1)

    // The reviewer pastes the very lesson the model is writing: no lock holds that up, and the paste wins.
    const pasted = await acceptPasted(deps, { date: THU, division: 'primary', kind: 'generate' }, lessonReply('贴进来的课'))
    expect(pasted).toEqual({ version: 1 })

    release()
    expect(await first).toEqual({ generated: 2, failed: 0, waitingManual: 0 })
    expect(await lessonOf(THU, 'primary')).toMatchObject({ title: '贴进来的课', source: 'manual', version: 1 })
    expect(await lessonOf(THU, 'junior')).toMatchObject({ title: '光的折射', source: 'api' })

    // The run let go of its lock: the next one works.
    await db.deleteFrom('lessons').where('division', '=', 'senior').execute()
    expect(await generateMissing(deps)).toEqual({ generated: 1, failed: 0, waitingManual: 0 })
  })
})

describe('buildLessonPrompt', () => {
  test('a new lesson: the subject, the division, the direction, the approved titles before it, the structure and the format', async () => {
    const config = school()
    const { deps } = make(config)
    await insertLesson(db, { date: '2026-10-22', division: 'junior', subject: '科学', title: '声音的传播' })
    await insertLesson(db, { date: '2026-10-29', division: 'junior', subject: '科学', title: '光的直线传播' })
    // A draft, another division, another subject: not in the list.
    await insertLesson(db, { date: '2026-10-15', division: 'junior', subject: '科学', title: '浮力', approvedAt: null })
    await insertLesson(db, { date: '2026-10-29', division: 'primary', subject: '科学', title: '植物的根' })
    await insertLesson(db, { date: '2026-11-02', division: 'junior', subject: '语文', title: '春晓' })

    const p = await buildLessonPrompt(deps, 'generate', { date: THU, division: 'junior' })
    expect(p.system).toBe(prompts['lesson-generate'].system)
    expect(p.user).toContain('学部：初中部')
    expect(p.user).toContain('科目：科学')
    expect(p.user).toContain('本节课的主题：没有指定')
    expect(p.user).toContain(`老师的方向提示：${config.lessonGeneration.direction.join('；')}`)
    // Newest first.
    expect(p.user).toContain('- 光的直线传播\n- 声音的传播')
    for (const left of ['浮力', '植物的根', '春晓']) expect(p.user).not.toContain(left)
    expect(p.user).toContain('共 5 段，每段在课上占大约 5 分钟')
    expect(p.user).toContain('复习题范围：第 1 到第 2 段')
    expect(p.user).toMatch(/引申题的方向：.*第 5 段/)
    expect(p.user).toContain('"callOnQuestions"')
    expect(p.user).toContain('正好 5 项')
    expect(p.user).not.toMatch(/\{\{\w+\}\}/)
  })

  test('the titles leave out a lesson approved for a day a study hall decided, and keep the approved days to come', async () => {
    const { deps } = make(school())
    // Approved after the doors had opened on its draft: the class never had it.
    await insertLesson(db, { date: '2026-10-29', division: 'junior', subject: '科学', title: '没上成的课' })
    const classId = await insertClass(db, { classNo: 1, slot: 'morning' })
    const at = new Date('2026-10-29T10:00:00+08:00')
    await insertSession(db, { classId, date: '2026-10-29', slot: 'morning', kind: 'study', startsAt: at, endsAt: at })
    const taught = await insertLesson(db, { date: '2026-10-22', division: 'junior', subject: '科学', title: '上过的课' })
    await insertSession(db, { classId, date: '2026-10-22', slot: 'morning', kind: 'lesson', lessonId: taught, startsAt: at, endsAt: at })
    // Approved for next week's day, which no class has begun yet.
    await insertLesson(db, { date: '2026-11-12', division: 'junior', subject: '科学', title: '下周要上的课' })

    const p = await buildLessonPrompt(deps, 'generate', { date: THU, division: 'junior' })
    expect(p.user).toContain('- 下周要上的课\n- 上过的课')
    expect(p.user).not.toContain('没上成的课')
  })

  test('a day with a topic: the subject is 专题, the topic is given, and the titles are those of the topic lessons', async () => {
    const { deps } = make(school())
    await insertLesson(db, { date: '2026-10-29', division: 'junior', subject: '科学', title: '光的直线传播' })
    await insertLesson(db, { date: '2026-10-28', division: 'junior', subject: SPECIAL_SUBJECT, title: '重阳节的由来' })
    expect(await setTopic(deps, THU, 'junior', '儿童节是怎么来的')).toBe('stored')

    const p = await buildLessonPrompt(deps, 'generate', { date: THU, division: 'junior' })
    expect(p.user).toContain('科目：专题')
    expect(p.user).toContain('本节课的主题：儿童节是怎么来的')
    expect(p.user).toContain('- 重阳节的由来')
    expect(p.user).not.toContain('光的直线传播')
    // Another division that day has its ordinary subject.
    expect((await buildLessonPrompt(deps, 'generate', { date: THU, division: 'senior' })).user).toContain('科目：科学')
  })

  test('lists the 200 newest titles at most, and says so when there are none', async () => {
    const { deps } = make(school())
    expect((await buildLessonPrompt(deps, 'generate', { date: THU, division: 'junior' })).user).toContain('（还没有）')
    for (let i = 1; i <= 201; i++) {
      const date = new Date(Date.UTC(2026, 10, 3) - i * 86_400_000).toISOString().slice(0, 10)
      await insertLesson(db, { date, division: 'junior', subject: '科学', title: `第${String(i).padStart(3, '0')}课` })
    }
    const user = (await buildLessonPrompt(deps, 'generate', { date: THU, division: 'junior' })).user
    expect(user).toContain('- 第001课')
    expect(user).toContain('- 第200课')
    expect(user).not.toContain('第201课')
  })

  test('the rewrite of a segment gives the lesson, the segment, the reason and its own format', async () => {
    const { deps } = make(school())
    const { lessonId } = await saveDraft(deps, { date: THU, division: 'junior' }, content(), { source: 'api', change: 'generate' })
    const p = await buildLessonPrompt(deps, 'rewrite_segment', {
      date: THU,
      division: 'junior',
      lessonId,
      segmentIndex: 2,
      reason: '太难了，换个例子',
    })
    expect(p.system).toBe(prompts['lesson-rewrite-segment'].system)
    expect(p.user).toContain('重写下面这节课的第 3 段')
    expect(p.user).toContain('课题：光的折射')
    expect(p.user).toContain('修改意见：太难了，换个例子')
    expect(p.user).toContain('需要重写的这一段现在的内容：\n第3段讲稿')
    expect(p.user).toContain('第 1 段：第1段讲稿')
    expect(p.user).toContain('{"text"')
    expect(p.user).not.toContain('"callOnQuestions"')
    expect(p.user).not.toMatch(/\{\{\w+\}\}/)
  })

  test('the rewrite of a call-on question gives the question, what it asks about and its own format', async () => {
    const { deps } = make(school())
    const { lessonId } = await saveDraft(deps, { date: THU, division: 'junior' }, content(), { source: 'api', change: 'generate' })
    const extension = await buildLessonPrompt(deps, 'rewrite_call_on', {
      date: THU,
      division: 'junior',
      lessonId,
      callOn: 'extension',
      reason: '太偏了',
    })
    expect(extension.user).toContain('题目类型：引申题')
    expect(extension.user).toMatch(/出题范围：.*第 5 段/)
    expect(extension.user).toContain(`现在的题目：\n${CALL_ONS.extension}`)
    expect(extension.user).toContain('{"question"')
    const review = await buildLessonPrompt(deps, 'rewrite_call_on', { date: THU, division: 'junior', lessonId, callOn: 'review', reason: '太简单' })
    expect(review.user).toContain('题目类型：复习题')
    expect(review.user).toContain('出题范围：第 1 到第 2 段')
  })

  test('the rewrite of the whole lesson gives the lesson as it is and the reason, with the full format', async () => {
    const { deps } = make(school())
    const { lessonId } = await saveDraft(deps, { date: THU, division: 'junior' }, content(), { source: 'api', change: 'generate' })
    const p = await buildLessonPrompt(deps, 'rewrite_lesson', { date: THU, division: 'junior', lessonId, reason: '选题不合适' })
    expect(p.system).toBe(prompts['lesson-rewrite'].system)
    expect(p.user).toContain('修改意见：选题不合适')
    expect(p.user).toContain('标题：光的折射')
    expect(p.user).toContain(`复习题：${CALL_ONS.review}`)
    expect(p.user).toContain('"callOnQuestions"')
    expect(p.user).not.toMatch(/\{\{\w+\}\}/)
  })

  test('refuses a day without a lesson, and a rewrite that does not say what or why', async () => {
    const { deps } = make(school())
    expect(await rejection(buildLessonPrompt(deps, 'generate', { date: SAT, division: 'junior' }))).toBeInstanceOf(NotALessonDay)
    const { lessonId } = await saveDraft(deps, { date: THU, division: 'junior' }, content(), { source: 'api', change: 'generate' })
    const target = { date: THU, division: 'junior' as const, lessonId, reason: '太难了' }
    for (const build of [
      () => buildLessonPrompt(deps, 'rewrite_lesson', { ...target, reason: '  ' }),
      () => buildLessonPrompt(deps, 'rewrite_lesson', { ...target, lessonId: undefined }),
      () => buildLessonPrompt(deps, 'rewrite_segment', target),
      () => buildLessonPrompt(deps, 'rewrite_segment', { ...target, segmentIndex: 5 }),
      () => buildLessonPrompt(deps, 'rewrite_call_on', target),
    ]) {
      expect(await rejection(build())).toBeInstanceOf(LessonFormatError)
    }
    expect(await rejection(buildLessonPrompt(deps, 'rewrite_lesson', { ...target, lessonId: lessonId + 1 }))).toBeInstanceOf(
      LessonNotFound,
    )
  })
})

describe('acceptPasted', () => {
  test('finds the lesson among the words around it, stores it as a manual draft and counts a manual call', async () => {
    const { deps, provider } = make(school({ mode: 'manual' }))
    await db
      .insertInto('lessonGeneration')
      .values({ date: THU, division: 'junior', attempts: 1, firstFailedAt: clock.now(), lastFailedAt: clock.now(), lastError: 'x' })
      .execute()
    const fenced = `好的，下面是这节课：\n\n\`\`\`json\n${lessonReply('光的折射')}\n\`\`\`\n\n需要修改的话告诉我。`
    expect(await acceptPasted(deps, { date: THU, division: 'junior', kind: 'generate' }, fenced)).toEqual({ version: 1 })
    const bare = `结果如下：${lessonReply('人文小课')} 以上。`
    expect(await acceptPasted(deps, { date: FRI, division: 'junior', kind: 'generate' }, bare)).toEqual({ version: 1 })

    const thu = await lessonOf(THU, 'junior')
    expect(thu).toMatchObject({ title: '光的折射', subject: '科学', source: 'manual', version: 1, approvedAt: null, topic: null })
    expect(await versionRows(thu?.id ?? 0)).toMatchObject([{ version: 1, change: 'generate' }])
    expect(await lessonOf(FRI, 'junior')).toMatchObject({ title: '人文小课', subject: '人文', source: 'manual' })
    expect(await llmCalls()).toEqual([
      { purpose: 'lesson', outcome: 'manual' },
      { purpose: 'lesson', outcome: 'manual' },
    ])
    expect(provider.calls).toHaveLength(0)
    // The day is no longer missing its lesson.
    expect(await failures()).toEqual([])
  })

  test('a new lesson pasted over a day that has one since (another tab, or the model) is stale; the lesson stays', async () => {
    const { deps } = make(school({ mode: 'manual' }))
    // Two tabs show Thursday missing: the first pastes and approves.
    await acceptPasted(deps, { date: THU, division: 'junior', kind: 'generate' }, lessonReply('第一个标签页的课'))
    const first = await lessonOf(THU, 'junior')
    await approve(deps, first!.id, 1)
    // The second still shows the day missing, so it names no version.
    const err = await rejection(acceptPasted(deps, { date: THU, division: 'junior', kind: 'generate' }, lessonReply('第二个标签页的课')))
    expect(err).toBeInstanceOf(StaleLessonVersion)
    expect(await lessonOf(THU, 'junior')).toMatchObject({ title: '第一个标签页的课', version: 1, approvedAt: clock.now() })
    expect(await llmCalls()).toEqual([{ purpose: 'lesson', outcome: 'manual' }])
    // Named with the version it has now, a new lesson does replace it.
    await acceptPasted(deps, { date: THU, division: 'junior', kind: 'generate', baseVersion: 1 }, lessonReply('换上的课'))
    expect(await lessonOf(THU, 'junior')).toMatchObject({ title: '换上的课', version: 2, approvedAt: null })
  })

  test('a lesson pasted in after the model read the day as missing is not overwritten by the model\'s', async () => {
    let replied = false
    const { deps: base, log } = make(school(), () => {
      replied = true
      return ok(lessonReply('大模型写的课'))
    })
    // The paste lands between the generator reading the day and storing what the model wrote: right after its read of
    // the day's topic, the last thing it reads.
    const queries = new Set<unknown>()
    let pasted = false
    const racing: KyselyPlugin = {
      transformQuery(args) {
        if (JSON.stringify(args.node).includes('lesson_topics')) queries.add(args.queryId)
        return args.node
      },
      async transformResult(args) {
        if (replied && !pasted && queries.has(args.queryId)) {
          pasted = true
          await acceptPasted({ ...base, db }, { date: THU, division: 'primary', kind: 'generate' }, lessonReply('贴进来的课'))
        }
        return args.result
      },
    }
    const deps = { ...base, db: db.withPlugin(racing), config: school({ horizonDays: 1 }) }
    expect(await generateMissing(deps)).toMatchObject({ failed: 0 })
    expect(pasted).toBe(true)
    expect(await lessonOf(THU, 'primary')).toMatchObject({ title: '贴进来的课', source: 'manual', version: 1 })
    expect(await failures()).toEqual([])
    expect(log.info).toHaveBeenCalledWith({ date: THU, division: 'primary', outcome: 'dropped' }, 'lesson generation')
  })

  test('a lesson pasted for a day with a topic is a topic lesson', async () => {
    const { deps } = make(school({ mode: 'manual' }))
    await setTopic(deps, THU, 'primary', '儿童节是怎么来的')
    await acceptPasted(deps, { date: THU, division: 'primary', kind: 'generate' }, lessonReply('儿童节'))
    expect(await lessonOf(THU, 'primary')).toMatchObject({ subject: SPECIAL_SUBJECT, topic: '儿童节是怎么来的', title: '儿童节' })
  })

  test.each<[string, string, string]>([
    ['no JSON', '抱歉，我没法写这节课。', '没有在粘贴的内容里找到 JSON'],
    ['the wrong number of segments', lessonReply('x', { segments: segments(3) }), '课程必须正好有 5 段，这一份有 3 段'],
    ['no call-on questions', lessonReply('x', { callOnQuestions: undefined }), '缺少点名题'],
    ['a blank title', lessonReply('  '), '标题（title）不能为空'],
  ])('a reply with %s is refused with the reason in Chinese, and nothing is stored', async (_, pasted, reason) => {
    const { deps } = make(school({ mode: 'manual' }))
    const err = await rejection(acceptPasted(deps, { date: THU, division: 'junior', kind: 'generate' }, pasted))
    expect(err).toBeInstanceOf(LessonFormatError)
    expect((err as Error).message).toContain(reason)
    expect(await lessonRows()).toEqual([])
    expect(await llmCalls()).toEqual([])
  })

  test('a pasted rewrite changes only its part, from the version it was copied at', async () => {
    const { deps } = make(school({ mode: 'manual' }))
    const { lessonId } = await saveDraft(deps, { date: THU, division: 'junior' }, content(), { source: 'manual', change: 'generate' })
    const at = { date: THU, division: 'junior' as const, lessonId }

    const segment = await acceptPasted(
      deps,
      { ...at, kind: 'rewrite_segment', baseVersion: 1, segmentIndex: 2, reason: '太难了' },
      '改好了：{"text": "新的第三段", "gist": "新的要点"}',
    )
    expect(segment).toEqual({ version: 2 })
    const callOn = await acceptPasted(
      deps,
      { ...at, kind: 'rewrite_call_on', baseVersion: 2, callOn: 'review', reason: '太简单' },
      '```json\n{"question": "新的复习题？"}\n```',
    )
    expect(callOn).toEqual({ version: 3 })

    const row = await lessonOf(THU, 'junior')
    expect(row?.segments).toEqual(segments().map((s, i) => (i === 2 ? { text: '新的第三段', gist: '新的要点' } : s)))
    expect(row?.callOnQuestions).toEqual({ ...CALL_ONS, review: '新的复习题？' })
    expect(await versionRows(lessonId)).toMatchObject([
      { version: 1, change: 'generate' },
      { version: 2, change: 'rewrite_segment', segmentIndex: 2, reason: '太难了' },
      { version: 3, change: 'rewrite_call_on', segmentIndex: null, reason: '太简单' },
    ])

    // A tab still at version 1 is refused.
    const stale = acceptPasted(deps, { ...at, kind: 'rewrite_lesson', baseVersion: 1, reason: '重来' }, lessonReply('新课'))
    expect(await rejection(stale)).toBeInstanceOf(StaleLessonVersion)
    expect(await acceptPasted(deps, { ...at, kind: 'rewrite_lesson', baseVersion: 3, reason: '重来' }, lessonReply('新课'))).toEqual({
      version: 4,
    })
    expect(await lessonOf(THU, 'junior')).toMatchObject({ title: '新课', subject: '科学', source: 'manual' })
    expect((await llmCalls()).filter((c) => c.outcome === 'manual')).toHaveLength(3)
  })

  test('a pasted segment that is too long, or a rewrite without its version, is refused', async () => {
    const { deps } = make(school({ mode: 'manual' }))
    const { lessonId } = await saveDraft(deps, { date: THU, division: 'junior' }, content(), { source: 'manual', change: 'generate' })
    const long = JSON.stringify({ text: '长'.repeat(801), gist: '要点' })
    const err = await rejection(
      acceptPasted(deps, { date: THU, division: 'junior', kind: 'rewrite_segment', lessonId, baseVersion: 1, segmentIndex: 0, reason: 'r' }, long),
    )
    expect((err as Error).message).toBe('第 1 段的正文（text）不能超过 800 个字，现在有 801 个字')
    const noVersion = acceptPasted(
      deps,
      { date: THU, division: 'junior', kind: 'rewrite_segment', lessonId, segmentIndex: 0, reason: 'r' },
      '{"text": "新", "gist": "新"}',
    )
    expect(await rejection(noVersion)).toBeInstanceOf(LessonFormatError)
    expect((await lessonOf(THU, 'junior'))?.version).toBe(1)
  })
})

describe('call-on reminders after a segment rewrite', () => {
  test('a pasted segment rewrite flags the call-ons as a model rewrite does', async () => {
    const { deps } = make(school({ mode: 'manual' }), () => ok('{"text": "模型改的第三段", "gist": "新要点"}'))
    const a = await saveDraft(deps, { date: THU, division: 'junior' }, content(), { source: 'manual', change: 'generate' })
    const b = await saveDraft(deps, { date: FRI, division: 'junior' }, content(), { source: 'manual', change: 'generate' })
    const pasted = '{"text": "贴回来的第三段", "gist": "新要点"}'
    await acceptPasted(
      deps,
      { date: THU, division: 'junior', kind: 'rewrite_segment', lessonId: a.lessonId, baseVersion: 1, segmentIndex: 2, reason: 'r' },
      pasted,
    )
    await regenerate(deps, 'rewrite_segment', { lessonId: b.lessonId, baseVersion: 1, segmentIndex: 2, reason: 'r' })
    const checks = async (id: number) => (await db.selectFrom('lessons').select('callOnChecks').where('id', '=', id).executeTakeFirstOrThrow()).callOnChecks
    expect(await checks(a.lessonId)).toEqual(['extension'])
    expect(await checks(b.lessonId)).toEqual(['extension'])
  })
})

describe('regenerate', () => {
  test('rewrites one segment by the model and keeps the rest; the reason and the segment are kept with the version', async () => {
    const { deps, provider } = make(school(), () => ok('{"text": "换了例子的第二段", "gist": "换了例子"}'))
    const { lessonId } = await saveDraft(deps, { date: THU, division: 'junior' }, content(), { source: 'api', change: 'generate' })
    await approve(deps, lessonId, 1)

    expect(await regenerate(deps, 'rewrite_segment', { lessonId, baseVersion: 1, segmentIndex: 1, reason: '例子太难' })).toEqual({
      version: 2,
    })
    expect(provider.calls[0]?.req.user).toContain('修改意见：例子太难')
    const row = await lessonOf(THU, 'junior')
    expect(row?.segments).toEqual(segments().map((s, i) => (i === 1 ? { text: '换了例子的第二段', gist: '换了例子' } : s)))
    expect(row).toMatchObject({ version: 2, approvedAt: null, source: 'api' })
    expect(await versionRows(lessonId)).toMatchObject([
      { version: 1 },
      { version: 2, change: 'rewrite_segment', segmentIndex: 1, reason: '例子太难' },
    ])
    expect(await failures()).toEqual([])
  })

  test('rewrites a call-on question, or the whole lesson', async () => {
    let reply = '{"question": "新的引申题？"}'
    const { deps } = make(school(), () => ok(reply))
    const { lessonId } = await saveDraft(deps, { date: THU, division: 'junior' }, content(), { source: 'api', change: 'generate' })
    await regenerate(deps, 'rewrite_call_on', { lessonId, baseVersion: 1, callOn: 'extension', reason: '太偏' })
    expect((await lessonOf(THU, 'junior'))?.callOnQuestions).toEqual({ ...CALL_ONS, extension: '新的引申题？' })

    reply = lessonReply('全新的一课', { segments: segments(5, '新') })
    expect(await regenerate(deps, 'rewrite_lesson', { lessonId, baseVersion: 2, reason: '选题不好' })).toEqual({ version: 3 })
    expect(await lessonOf(THU, 'junior')).toMatchObject({ title: '全新的一课', subject: '科学', segments: segments(5, '新') })
    expect((await versionRows(lessonId)).map((v) => v.change)).toEqual(['generate', 'rewrite_call_on', 'rewrite_lesson'])
  })

  test('a stale version is refused before the model is called, and one saved while the model writes is refused after', async () => {
    let onCall = async () => {}
    const { deps, provider } = make(school(), async () => {
      await onCall()
      return ok('{"question": "新题？"}')
    })
    const { lessonId } = await saveDraft(deps, { date: THU, division: 'junior' }, content(), { source: 'api', change: 'generate' })
    await saveDraft(deps, { date: THU, division: 'junior' }, content({ title: '第二版' }), { source: 'api', change: 'generate' })

    const stale = regenerate(deps, 'rewrite_call_on', { lessonId, baseVersion: 1, callOn: 'review', reason: 'r' })
    expect(await rejection(stale)).toBeInstanceOf(StaleLessonVersion)
    expect(provider.calls).toHaveLength(0)

    // Another tab saves while the model writes.
    onCall = async () => {
      await saveDraft(deps, { date: THU, division: 'junior' }, content({ title: '第三版' }), { source: 'manual', change: 'generate' })
    }
    const raced = regenerate(deps, 'rewrite_call_on', { lessonId, baseVersion: 2, callOn: 'review', reason: 'r' })
    expect(await rejection(raced)).toBeInstanceOf(StaleLessonVersion)
    expect(await lessonOf(THU, 'junior')).toMatchObject({ title: '第三版', version: 3, callOnQuestions: CALL_ONS })
  })

  test('a model failure goes to the caller and changes nothing; a begun lesson is refused without a call', async () => {
    const { deps, provider } = make(school(), () => new LlmUnavailable('down'))
    const { lessonId } = await saveDraft(deps, { date: THU, division: 'junior' }, content(), { source: 'api', change: 'generate' })
    const failed = regenerate(deps, 'rewrite_lesson', { lessonId, baseVersion: 1, reason: 'r' })
    expect(await rejection(failed)).toBeInstanceOf(LlmUnavailable)
    expect((await lessonOf(THU, 'junior'))?.version).toBe(1)
    expect(await failures()).toEqual([])

    const calls = provider.calls.length
    await beginLesson(lessonId, THU)
    const locked = regenerate(deps, 'rewrite_lesson', { lessonId, baseVersion: 1, reason: 'r' })
    expect(await rejection(locked)).toBeInstanceOf(LessonLocked)
    expect(provider.calls).toHaveLength(calls)
  })
})

describe('setTopic', () => {
  test('is refused for a weekend, a break, a day before the opening, today, a day gone by, and a blank topic', async () => {
    const { deps } = make(school())
    // The example school has study halls at the weekend; still no lesson then.
    for (const [date, division, topic] of [
      [SAT, 'junior', '周末的题目'],
      [TODAY, 'junior', '今天的题目'],
      ['2026-11-03', 'junior', '昨天的题目'],
      [THU, 'junior', '   '],
    ] as const) {
      expect(await rejection(setTopic(deps, date, division, topic)), date).toBeInstanceOf(TopicRefused)
    }
    const calendar = make(
      school({}, { calendar: { openingDay: FRI, breaks: [{ from: MON, reopensOn: NEXT_WED }] } }),
    ).deps
    for (const date of [THU, MON, TUE]) {
      expect(await rejection(setTopic(calendar, date, 'junior', '假期的题目')), date).toBeInstanceOf(TopicRefused)
    }
    expect(await topics()).toEqual([])
    // Tomorrow is the first day a topic can be given for.
    expect(await setTopic(deps, THU, 'junior', '明天的题目')).toBe('stored')
    expect(await topics()).toEqual([{ date: THU, division: 'junior', topic: '明天的题目' }])
  })

  test('for a day without a lesson, stores the topic; the lesson made then is a topic lesson, opened as one', async () => {
    const { deps, provider } = make(school({ horizonDays: 1 }), (req) =>
      ok(lessonReply(req.user.includes('儿童节是怎么来的') ? '儿童节的故事' : '光的折射')),
    )
    expect(await setTopic(deps, THU, 'primary', '  儿童节是怎么来的 ')).toBe('stored')
    expect(provider.calls).toHaveLength(0)
    expect(await generateMissing(deps)).toEqual({ generated: 3, failed: 0, waitingManual: 0 })

    const primary = await lessonOf(THU, 'primary')
    expect(primary).toMatchObject({ subject: SPECIAL_SUBJECT, topic: '儿童节是怎么来的', title: '儿童节的故事' })
    expect(await lessonOf(THU, 'junior')).toMatchObject({ subject: '科学', topic: null, title: '光的折射' })

    await approve(deps, primary?.id ?? 0, 1)
    const plan = await planSession(db, deps.config, { date: THU, division: 'primary' })
    expect(plan).toMatchObject({ kind: 'lesson', subject: SPECIAL_SUBJECT, title: '儿童节的故事' })
    if (plan.kind !== 'lesson') throw new Error('not a lesson')
    expect(openingLesson('林老师', plan.subject, plan.title)).toBe(
      '同学们好，我是林老师。今天我们上一节专题课，题目是《儿童节的故事》。',
    )
  })

  test('in api mode, a lesson made already goes back to review at once and is made again with the topic', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const { deps, provider, log } = make(school(), async () => {
      await gate
      return ok(lessonReply('儿童节的故事'))
    })
    const { lessonId } = await saveDraft(deps, { date: THU, division: 'junior' }, content(), { source: 'api', change: 'generate' })
    await approve(deps, lessonId, 1)

    expect(await setTopic(deps, THU, 'junior', '儿童节是怎么来的')).toBe('regenerating')
    // While the model writes, the replaced lesson is no longer approved, and a tab still showing it is stale.
    expect(await lessonOf(THU, 'junior')).toMatchObject({ title: '光的折射', subject: '科学', version: 2, approvedAt: null })
    expect(await versionRows(lessonId)).toHaveLength(1)
    expect(await rejection(approve(deps, lessonId, 1))).toBeInstanceOf(StaleLessonVersion)

    release()
    await vi.waitFor(
      () => expect(log.info).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'generated' }), expect.any(String)),
      { timeout: 5000 },
    )

    expect(provider.calls[0]?.req.user).toContain('本节课的主题：儿童节是怎么来的')
    expect(await lessonOf(THU, 'junior')).toMatchObject({
      id: lessonId,
      title: '儿童节的故事',
      subject: SPECIAL_SUBJECT,
      topic: '儿童节是怎么来的',
      source: 'api',
      version: 3,
      approvedAt: null,
    })
    expect(await versionRows(lessonId)).toMatchObject([{ version: 1, change: 'generate' }, { version: 3, change: 'topic' }])
  })

  test('in api mode, a regeneration that fails is recorded, and the next run tries it again', async () => {
    let failing = true
    const { deps, log } = make(school({ horizonDays: 1 }), () =>
      failing ? new LlmUnavailable('down') : ok(lessonReply('儿童节的故事')),
    )
    const { lessonId } = await saveDraft(deps, { date: THU, division: 'junior' }, content(), { source: 'api', change: 'generate' })
    await approve(deps, lessonId, 1)
    expect(await setTopic(deps, THU, 'junior', '儿童节是怎么来的')).toBe('regenerating')
    await vi.waitFor(
      () => expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failed' }), expect.any(String)),
      { timeout: 5000 },
    )
    expect(await failures()).toMatchObject([{ date: THU, division: 'junior', attempts: 1 }])
    // The old content stays, but not approved: it is not taught while the new lesson is pending.
    expect(await lessonOf(THU, 'junior')).toMatchObject({ id: lessonId, version: 2, subject: '科学', approvedAt: null })

    // The next run fails again for it (and the two missing lessons of the day) ...
    expect(await generateMissing(deps)).toEqual({ generated: 0, failed: 3, waitingManual: 0 })
    expect((await failures()).find((f) => f.division === 'junior')).toMatchObject({ attempts: 2 })
    // ... and the one after makes it, which clears its failure.
    failing = false
    expect(await generateMissing(deps)).toEqual({ generated: 3, failed: 0, waitingManual: 0 })
    expect(await lessonOf(THU, 'junior')).toMatchObject({
      id: lessonId,
      title: '儿童节的故事',
      subject: SPECIAL_SUBJECT,
      topic: '儿童节是怎么来的',
      version: 3,
      approvedAt: null,
    })
    expect((await versionRows(lessonId)).map((v) => v.change)).toEqual(['generate', 'topic'])
    expect(await failures()).toEqual([])
  })

  test('in manual mode, a lesson made already is taken back to waiting for one, its versions kept', async () => {
    const { deps, provider } = make(school({ mode: 'manual' }))
    const { lessonId } = await saveDraft(deps, { date: TUE, division: 'junior' }, content(), { source: 'manual', change: 'generate' })

    expect(await setTopic(deps, TUE, 'junior', '儿童节是怎么来的')).toBe('stored')
    expect(await lessonOf(TUE, 'junior')).toBeUndefined()
    expect(await versionRows(lessonId)).toHaveLength(1)
    expect(await topics()).toEqual([{ date: TUE, division: 'junior', topic: '儿童节是怎么来的' }])
    expect(provider.calls).toHaveLength(0)
  })

  test('the topic the lesson has already changes nothing about it', async () => {
    const { deps, provider } = make(school({ mode: 'manual' }))
    await setTopic(deps, TUE, 'junior', '儿童节是怎么来的')
    await acceptPasted(deps, { date: TUE, division: 'junior', kind: 'generate' }, lessonReply('儿童节'))
    expect(await setTopic(deps, TUE, 'junior', '儿童节是怎么来的')).toBe('stored')
    expect(await lessonOf(TUE, 'junior')).toMatchObject({ title: '儿童节', version: 1 })
    expect(provider.calls).toHaveLength(0)
  })

  test('a lesson a class has begun is refused with LessonLocked, and the topic is not stored', async () => {
    const { deps } = make(school())
    const { lessonId } = await saveDraft(deps, { date: THU, division: 'junior' }, content(), { source: 'api', change: 'generate' })
    await beginLesson(lessonId, THU)
    expect(await rejection(setTopic(deps, THU, 'junior', '儿童节'))).toBeInstanceOf(LessonLocked)
    expect(await topics()).toEqual([])
  })

  test('null takes the topic away and leaves the lesson made with it as it is', async () => {
    const { deps } = make(school({ mode: 'manual' }))
    await setTopic(deps, TUE, 'junior', '儿童节是怎么来的')
    await acceptPasted(deps, { date: TUE, division: 'junior', kind: 'generate' }, lessonReply('儿童节'))
    expect(await setTopic(deps, TUE, 'junior', null)).toBe('stored')
    expect(await topics()).toEqual([])
    expect(await lessonOf(TUE, 'junior')).toMatchObject({ title: '儿童节', subject: SPECIAL_SUBJECT, topic: '儿童节是怎么来的', version: 1 })
  })

  test('a topic set while the model writes the lesson of that day: what it wrote is dropped, and the next run follows the topic', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const { deps, provider } = make(school({ horizonDays: 1 }), async (req) => {
      await gate
      return ok(lessonReply(req.user.includes('儿童节是怎么来的') ? '儿童节的故事' : '光的折射'))
    })
    const run = generateMissing(deps)
    // The model is writing the primary lesson, the first of the day.
    await vi.waitFor(() => expect(provider.calls).toHaveLength(1), { timeout: 5000 })
    expect(await setTopic(deps, THU, 'primary', '儿童节是怎么来的')).toBe('stored')
    release()
    expect(await run).toEqual({ generated: 2, failed: 0, waitingManual: 0 })
    expect(await lessonOf(THU, 'primary')).toBeUndefined()

    expect(await generateMissing(deps)).toEqual({ generated: 1, failed: 0, waitingManual: 0 })
    expect(await lessonOf(THU, 'primary')).toMatchObject({ subject: SPECIAL_SUBJECT, title: '儿童节的故事' })
  })
})
