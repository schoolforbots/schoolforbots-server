import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import Fastify from 'fastify'
import type { Kysely } from 'kysely'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { buildProviders, createLlm, type LlmPurpose } from '../../src/llm/client.js'
import { createFakeLlm } from '../../src/llm/fake.js'
import { createOpenAiCompatible } from '../../src/llm/openai-compatible.js'
import { extractJson } from '../../src/llm/json.js'
import { LlmContentRefused, LlmTruncated, LlmUnavailable, type LlmResponse } from '../../src/llm/provider.js'
import { MemoryMailer } from '../../src/registration/mailer.js'
import type { Database } from '../../src/shared/schema.js'
import { exampleConfig } from '../helpers/app.js'
import { createTestClock } from '../helpers/clock.js'
import { createTestDb } from '../helpers/db.js'
import { captureLogs } from '../helpers/logs.js'

let db: Kysely<Database>
let destroy: () => Promise<void>

beforeAll(async () => {
  ;({ db, destroy } = await createTestDb())
})
afterAll(() => destroy())
beforeEach(async () => {
  await db.deleteFrom('llmCalls').execute()
  await db.deleteFrom('budgetNotices').execute()
})

const base = exampleConfig()
const price = { inputYuanPerMillion: 2, outputYuanPerMillion: 8 }
const config = {
  ...base,
  llm: {
    ...base.llm,
    providers: {
      a: { kind: 'openai-compatible' as const, baseUrl: 'http://a.invalid', apiKeyEnv: 'KEY_A', models: { 'a-1': price }, contentRefusalMarkers: [] },
      b: { kind: 'openai-compatible' as const, baseUrl: 'http://b.invalid', apiKeyEnv: 'KEY_B', models: { 'b-1': { inputYuanPerMillion: 1, outputYuanPerMillion: 1 } }, contentRefusalMarkers: [] },
    },
    purposes: {
      ...base.llm.purposes,
      lesson: { provider: 'a', model: 'a-1' },
      answer: { provider: 'b', model: 'b-1' },
      comment: { provider: 'a', model: 'a-1' },
      weekly: { provider: 'a', model: 'a-1' },
      secondLayerTeacher: { provider: 'a', model: 'a-1' },
      secondLayerChat: { provider: 'a', model: 'a-1' },
      wordList: { provider: 'a', model: 'a-1' },
    },
    timeoutSeconds: 5,
    retries: 1,
    maxConcurrent: 16,
    monthlyBudgetYuan: 1000,
  },
}
const clock = createTestClock(new Date('2026-11-10T04:00:00Z'))
const ok = (text = 'hi', i = 1000, o = 500): LlmResponse => ({ text, inputTokens: i, outputTokens: o })
const prompt = { system: '系统提示词SECRET', user: '用户提问SECRET' }
const rows = () => db.selectFrom('llmCalls').selectAll().orderBy('id').execute()

describe('routing and recording', () => {
  test('each purpose uses its own provider and model, and the cost follows the price table', async () => {
    const a = createFakeLlm(() => ok())
    const b = createFakeLlm(() => ok('b', 1_000_000, 1_000_000))
    const llm = createLlm({ db, config, clock, providers: { a, b } })
    await llm.call('lesson', prompt, { json: true, maxOutputTokens: 77 })
    await llm.call('answer', prompt)
    expect(a.calls.map((c) => c.model)).toEqual(['a-1'])
    expect(a.calls[0]?.req).toMatchObject({ system: prompt.system, user: prompt.user, json: true, maxOutputTokens: 77 })
    expect(b.calls.map((c) => c.model)).toEqual(['b-1'])
    const [first, second] = await rows()
    expect(first).toMatchObject({ purpose: 'lesson', provider: 'a', model: 'a-1', inputTokens: 1000, outputTokens: 500, outcome: 'ok' })
    expect(Number(first?.costYuan)).toBeCloseTo(0.006, 9)
    expect(first?.createdAt).toEqual(clock.now())
    expect(second).toMatchObject({ purpose: 'answer', provider: 'b', outcome: 'ok' })
    expect(Number(second?.costYuan)).toBeCloseTo(2, 9)
  })

  test('recordManual writes a manual row at no cost', async () => {
    const llm = createLlm({ db, config, clock, providers: {} })
    await llm.recordManual('lesson')
    expect(await rows()).toMatchObject([{ purpose: 'lesson', provider: 'a', model: 'a-1', inputTokens: 0, outputTokens: 0, outcome: 'manual', ms: 0 }])
    expect(Number((await rows())[0]?.costYuan)).toBe(0)
  })
})

describe('retries and refusals', () => {
  test('LlmUnavailable is retried once, then thrown; one failed row per call', async () => {
    const a = createFakeLlm(() => new LlmUnavailable('x'))
    const llm = createLlm({ db, config, clock, providers: { a } })
    await expect(llm.call('lesson', prompt)).rejects.toBeInstanceOf(LlmUnavailable)
    expect(a.calls).toHaveLength(2)
    expect(await rows()).toMatchObject([{ outcome: 'failed', inputTokens: 0, outputTokens: 0 }])
    expect(Number((await rows())[0]?.costYuan)).toBe(0)
  })

  test('a retry that succeeds returns the reply', async () => {
    let n = 0
    const a = createFakeLlm(() => (++n === 1 ? new LlmUnavailable('x') : ok('second')))
    const res = await createLlm({ db, config, clock, providers: { a } }).call('lesson', prompt)
    expect(res.text).toBe('second')
    expect(await rows()).toMatchObject([{ outcome: 'ok' }])
  })

  test('LlmTruncated is not retried, and is recorded as failed with the tokens that were billed', async () => {
    const a = createFakeLlm(() => new LlmTruncated('cut off', 1000, 8000))
    await expect(createLlm({ db, config, clock, providers: { a } }).call('lesson', prompt)).rejects.toBeInstanceOf(LlmTruncated)
    expect(a.calls).toHaveLength(1)
    const [row] = await rows()
    expect(row).toMatchObject({ outcome: 'failed', inputTokens: 1000, outputTokens: 8000 })
    expect(Number(row?.costYuan)).toBeCloseTo(0.066, 9)
  })

  test('LlmContentRefused is not retried and is recorded as refused', async () => {
    const a = createFakeLlm(() => new LlmContentRefused('x'))
    await expect(createLlm({ db, config, clock, providers: { a } }).call('lesson', prompt)).rejects.toBeInstanceOf(LlmContentRefused)
    expect(a.calls).toHaveLength(1)
    expect(await rows()).toMatchObject([{ outcome: 'refused' }])
  })
})

describe('concurrency and time budget', () => {
  test('the 17th call waits until one of the first 16 finishes', async () => {
    const waiting: (() => void)[] = []
    const a = createFakeLlm(() => new Promise<LlmResponse>((resolve) => waiting.push(() => resolve(ok()))))
    const llm = createLlm({ db, config, clock, providers: { a } })
    const calls = Array.from({ length: 17 }, () => llm.call('lesson', prompt))
    await new Promise((r) => setTimeout(r, 50))
    expect(a.calls).toHaveLength(16)
    waiting[0]?.()
    await new Promise((r) => setTimeout(r, 50))
    expect(a.calls).toHaveLength(17)
    waiting.forEach((release) => release())
    await Promise.all(calls)
    expect(await rows()).toHaveLength(17)
  })

  test('when a slot frees, waiting checks and comments go before waiting answers, lessons and the rest', async () => {
    const one = { ...config, llm: { ...config.llm, maxConcurrent: 1, purposes: { ...config.llm.purposes, answer: { provider: 'a', model: 'a-1' } } } }
    let finish: () => void = () => {}
    const a = createFakeLlm((_m, req) => (req.user === 'lesson' ? new Promise<LlmResponse>((resolve) => (finish = () => resolve(ok()))) : ok()))
    const llm = createLlm({ db, config: one, clock, providers: { a } })
    const run = (purpose: LlmPurpose) => llm.call(purpose, { system: '', user: purpose })
    const holder = run('lesson')
    const waiting = (['answer', 'secondLayerTeacher', 'weekly', 'comment', 'answer', 'secondLayerChat', 'wordList'] as const).map(run)
    await new Promise((r) => setTimeout(r, 20))
    finish()
    await Promise.all([holder, ...waiting])
    expect(a.calls.map((c) => c.req.user)).toEqual(['lesson', 'secondLayerTeacher', 'comment', 'secondLayerChat', 'answer', 'weekly', 'answer', 'wordList'])
  })

  test('a burst of answers holding every slot does not push a second-layer check past its budget', async () => {
    const answer = createFakeLlm(async () => {
      await new Promise((r) => setTimeout(r, 200))
      return ok()
    })
    const check = createFakeLlm(() => ok('{"results":[]}'))
    const routed = { ...config, llm: { ...config.llm, purposes: { ...config.llm.purposes, answer: { provider: 'b', model: 'b-1' }, secondLayerTeacher: { provider: 'a', model: 'a-1' } } } }
    const llm = createLlm({ db, config: routed, clock, providers: { a: check, b: answer } })
    // Five waves of answers for the 16 slots: in a first-come line the check would wait for four of them.
    const answers = Array.from({ length: 80 }, () => llm.call('answer', prompt, { timeoutMs: 5000 }))
    try {
      await new Promise((r) => setTimeout(r, 20))
      await expect(llm.call('secondLayerTeacher', prompt, { timeoutMs: 500 })).resolves.toMatchObject({ text: '{"results":[]}' })
    } finally {
      await Promise.allSettled(answers)
    }
  })

  test('queue wait counts against the timeout and no request is started for it', async () => {
    const one = { ...config, llm: { ...config.llm, maxConcurrent: 1, retries: 0 } }
    const a = createFakeLlm(() => new Promise<LlmResponse>(() => {})) // hangs forever
    const llm = createLlm({ db, config: one, clock, providers: { a } })
    const first = llm.call('lesson', prompt, { timeoutMs: 400 })
    const second = llm.call('lesson', prompt, { timeoutMs: 100 })
    const started = Date.now()
    await expect(second).rejects.toBeInstanceOf(LlmUnavailable)
    expect(Date.now() - started).toBeLessThan(300)
    expect(a.calls).toHaveLength(1)
    await expect(first).rejects.toBeInstanceOf(LlmUnavailable)
    expect(await rows()).toMatchObject([{ outcome: 'failed', inputTokens: 0 }, { outcome: 'failed', inputTokens: 0 }])
  })

  test('the timeout is total: a hung attempt leaves no time for a retry', async () => {
    const a = createFakeLlm(() => new Promise<LlmResponse>(() => {}))
    const llm = createLlm({ db, config, clock, providers: { a } })
    const started = Date.now()
    await expect(llm.call('lesson', prompt, { timeoutMs: 100 })).rejects.toBeInstanceOf(LlmUnavailable)
    expect(Date.now() - started).toBeLessThan(400)
    expect(a.calls).toHaveLength(1)
    expect(a.calls[0]?.req.timeoutMs).toBeLessThanOrEqual(100)
  })

  test('a deadline that has already passed starts no request, even with a free slot', async () => {
    const a = createFakeLlm(() => ok())
    await expect(createLlm({ db, config, clock, providers: { a } }).call('lesson', prompt, { timeoutMs: 0 })).rejects.toBeInstanceOf(LlmUnavailable)
    expect(a.calls).toHaveLength(0)
    expect(await rows()).toMatchObject([{ outcome: 'failed' }])
  })

  test('each attempt is given a whole number of milliseconds', async () => {
    let n = 0
    const a = createFakeLlm(async () => {
      await new Promise((r) => setTimeout(r, 7))
      return ++n === 1 ? new LlmUnavailable('x') : ok()
    })
    await createLlm({ db, config, clock, providers: { a } }).call('lesson', prompt, { timeoutMs: 1000 })
    for (const c of a.calls) {
      expect(Number.isInteger(c.req.timeoutMs)).toBe(true)
      expect(c.req.timeoutMs).toBeGreaterThan(0)
    }
  })

  test('a retry gets only the time that is left', async () => {
    let n = 0
    const a = createFakeLlm(async () => {
      await new Promise((r) => setTimeout(r, 60))
      return ++n === 1 ? new LlmUnavailable('x') : ok()
    })
    await createLlm({ db, config, clock, providers: { a } }).call('lesson', prompt, { timeoutMs: 1000 })
    expect(a.calls).toHaveLength(2)
    expect(a.calls[1]!.req.timeoutMs).toBeLessThan(a.calls[0]!.req.timeoutMs - 50)
  })
})

describe('through a real provider over HTTP', () => {
  let server: Server
  let replies: number[]
  let baseUrl: string

  beforeAll(async () => {
    server = createServer((req, res) => {
      req.resume()
      req.on('end', () => {
        const status = replies.shift() ?? 200
        res.statusCode = status
        res.setHeader('content-type', 'application/json')
        res.end(status === 200 ? JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }) : '{}')
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
  })
  afterAll(async () => {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  })
  beforeEach(() => {
    replies = []
  })

  const llmOverHttp = () => createLlm({ db, config, clock, providers: { a: createOpenAiCompatible({ baseUrl, apiKey: 'sk-test', refusalMarkers: [] }) } })

  test('a call succeeds although the time left is a fraction of a millisecond', async () => {
    await expect(llmOverHttp().call('lesson', prompt, { json: true, timeoutMs: 5000 })).resolves.toEqual({ text: '{"ok":true}', inputTokens: 10, outputTokens: 5 })
    expect(await rows()).toMatchObject([{ outcome: 'ok', inputTokens: 10, outputTokens: 5 }])
  })

  test('a retry after a server error succeeds with whatever time is left', async () => {
    replies = [500]
    await expect(llmOverHttp().call('lesson', prompt, { timeoutMs: 5000 })).resolves.toMatchObject({ text: '{"ok":true}' })
    expect(replies).toEqual([])
    expect(await rows()).toMatchObject([{ outcome: 'ok' }])
  })
})

describe('the slot is released on every path', () => {
  const one = { ...config, llm: { ...config.llm, maxConcurrent: 1, retries: 0 } }
  const later = (llm: ReturnType<typeof createLlm>) => llm.call('lesson', prompt, { timeoutMs: 500 })

  test('a purpose whose provider is missing', async () => {
    const a = createFakeLlm(() => ok('fine'))
    const llm = createLlm({ db, config: one, clock, providers: { a } })
    for (let i = 0; i < 3; i++) await expect(llm.call('answer', prompt)).rejects.toThrow()
    await expect(later(llm)).resolves.toMatchObject({ text: 'fine' })
  })

  test.each([
    ['a refusal', () => new LlmContentRefused('x')],
    ['a non-Llm error', () => new TypeError('bug')],
  ])('after %s', async (_name, error) => {
    let fail = true
    const a = createFakeLlm(() => (fail ? error() : ok('fine')))
    const llm = createLlm({ db, config: one, clock, providers: { a } })
    await expect(llm.call('lesson', prompt)).rejects.toThrow()
    fail = false
    await expect(later(llm)).resolves.toMatchObject({ text: 'fine' })
  })

  test('after a timeout', async () => {
    let hang = true
    const a = createFakeLlm(() => (hang ? new Promise<LlmResponse>(() => {}) : ok('fine')))
    const llm = createLlm({ db, config: one, clock, providers: { a } })
    await expect(llm.call('lesson', prompt, { timeoutMs: 50 })).rejects.toBeInstanceOf(LlmUnavailable)
    hang = false
    await expect(later(llm)).resolves.toMatchObject({ text: 'fine' })
  })

  test('a waiter that timed out in the queue leaves the queue intact', async () => {
    let finish: () => void = () => {}
    let first = true
    const a = createFakeLlm(() => {
      if (!first) return ok('fine')
      first = false
      return new Promise<LlmResponse>((resolve) => (finish = () => resolve(ok('held'))))
    })
    const llm = createLlm({ db, config: one, clock, providers: { a } })
    const holder = llm.call('lesson', prompt, { timeoutMs: 2000 })
    await expect(llm.call('lesson', prompt, { timeoutMs: 50 })).rejects.toBeInstanceOf(LlmUnavailable)
    const third = llm.call('lesson', prompt, { timeoutMs: 2000 })
    finish()
    await expect(holder).resolves.toMatchObject({ text: 'held' })
    await expect(third).resolves.toMatchObject({ text: 'fine' })
    expect(a.calls).toHaveLength(2)
  })
})

describe('budget notice after a call', () => {
  test('crossing the budget mails once; a failing mailer does not fail the call', async () => {
    const tight = { ...config, llm: { ...config.llm, monthlyBudgetYuan: 0.001 } }
    const a = createFakeLlm(() => ok())
    const mailer = new MemoryMailer()
    const llm = createLlm({ db, config: tight, clock, providers: { a }, budget: { mailer, operatorEmail: 'ops@example.com' } })
    await llm.call('lesson', prompt)
    await llm.call('lesson', prompt)
    expect(mailer.notices).toHaveLength(1)

    await db.deleteFrom('budgetNotices').execute()
    const broken = { ...mailer, sendNotice: async () => { throw new Error('smtp down') } } as unknown as MemoryMailer
    const llm2 = createLlm({ db, config: tight, clock, providers: { a }, budget: { mailer: broken, operatorEmail: 'ops@example.com' } })
    await expect(llm2.call('lesson', prompt)).resolves.toMatchObject({ text: 'hi' })
  })
})

describe('logs', () => {
  test('hold purpose, provider, model, outcome, tokens and time, never prompt or reply text', async () => {
    const logs = captureLogs()
    const log = Fastify({ logger: { level: 'info', stream: logs.stream } }).log
    const a = createFakeLlm((_m, req) => (req.user.includes('boom') ? new LlmUnavailable('upstream said REPLYSECRET') : ok('REPLYSECRET')))
    const llm = createLlm({ db, config, clock, providers: { a }, log })
    await llm.call('lesson', prompt)
    await expect(llm.call('lesson', { ...prompt, user: 'boom SECRET' })).rejects.toThrow()
    const text = JSON.stringify(logs.entries())
    expect(text).not.toContain('SECRET')
    expect(logs.entries()[0]).toMatchObject({ purpose: 'lesson', provider: 'a', model: 'a-1', outcome: 'ok', inputTokens: 1000, outputTokens: 500 })
  })
})

describe('fake mode', () => {
  const run = (purpose: LlmPurpose, user = '') => {
    const a = createFakeLlm(() => new Error('must not be called'))
    return createLlm({ db, config, clock, providers: { a }, fake: true }).call(purpose, { system: '', user })
  }

  test('calls no provider, costs nothing and is recorded as ok', async () => {
    const res = await run('comment')
    expect(res).toEqual({ text: '说得不错。', inputTokens: 0, outputTokens: 0 })
    expect(await rows()).toMatchObject([{ purpose: 'comment', outcome: 'ok', inputTokens: 0, outputTokens: 0 }])
    expect(Number((await rows())[0]?.costYuan)).toBe(0)
  })

  test('the lesson reply is a whole lesson that is also a segment and a call-on rewrite, within the limits', async () => {
    const lesson = extractJson((await run('lesson')).text) as any
    expect(lesson.segments).toHaveLength(config.lesson.segmentMinutes.length)
    expect(lesson.title.length).toBeLessThanOrEqual(40)
    for (const s of lesson.segments) {
      expect(s.text.length).toBeGreaterThan(0)
      expect(s.text.length).toBeLessThanOrEqual(800)
      expect(s.gist.length).toBeGreaterThan(0)
      expect(s.gist.length).toBeLessThanOrEqual(60)
    }
    expect(lesson.subject).toBeTruthy()
    for (const q of [lesson.callOnQuestions.review, lesson.callOnQuestions.extension, lesson.question]) {
      expect(q.length).toBeGreaterThan(0)
      expect(q.length).toBeLessThanOrEqual(120)
    }
    expect(lesson.text.length).toBeLessThanOrEqual(800)
    expect(lesson.gist.length).toBeLessThanOrEqual(60)
  })

  test('the other purposes give their fixed shapes', async () => {
    expect(extractJson((await run('answer')).text)).toMatchObject({ pick: 1, answer: expect.any(String) })
    expect(extractJson((await run('weekly')).text)).toEqual({ removeRules: [], directions: [] })
    expect(extractJson((await run('wordList')).text)).toEqual({ suggestions: [] })
    const items = JSON.stringify([{ id: 4, text: 'a' }, { id: 9, text: 'b' }])
    for (const purpose of ['secondLayerTeacher', 'secondLayerChat'] as const) {
      expect(extractJson((await run(purpose, items)).text)).toEqual({
        results: [{ id: 4, verdict: 'pass' }, { id: 9, verdict: 'pass' }],
      })
    }
    expect(extractJson((await run('secondLayerChat', '[]')).text)).toEqual({ results: [] })
  })
})

describe('buildProviders', () => {
  test('builds the used providers and names the variable of a missing key, not any value', () => {
    expect(Object.keys(buildProviders(config, { KEY_A: 'sk-a', KEY_B: 'sk-b' })).sort()).toEqual(['a', 'b'])
    expect(() => buildProviders(config, { KEY_A: 'sk-a' })).toThrow(/KEY_B/)
    expect(() => buildProviders(config, { KEY_A: 'sk-a', KEY_B: '' })).toThrow(/KEY_B/)
    try {
      buildProviders(config, { KEY_A: 'sk-secret' })
    } catch (err) {
      expect(String(err)).not.toContain('sk-secret')
    }
  })

  test('skips a provider no purpose uses', () => {
    const onlyA = {
      ...config,
      llm: { ...config.llm, purposes: Object.fromEntries(Object.keys(config.llm.purposes).map((p) => [p, { provider: 'a', model: 'a-1' }])) as typeof config.llm.purposes },
    }
    expect(Object.keys(buildProviders(onlyA, { KEY_A: 'sk-a' }))).toEqual(['a'])
  })
})
