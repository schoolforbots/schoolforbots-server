import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import Fastify from 'fastify'
import type { Kysely } from 'kysely'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
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
const ok = (text = 'hi', i = 1000, o = 500, c = 0): LlmResponse => ({ text, inputTokens: i, outputTokens: o, cachedInputTokens: c })
const prompt = { system: '系统提示词SECRET', user: '用户提问SECRET' }
const unavailable = (opts: { retryAfterMs?: number | null } = {}) => new LlmUnavailable('x', { retryable: true, ...opts })
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
    const a = createFakeLlm(() => unavailable())
    const llm = createLlm({ db, config, clock, providers: { a }, random: () => 0 })
    await expect(llm.call('lesson', prompt)).rejects.toBeInstanceOf(LlmUnavailable)
    expect(a.calls).toHaveLength(2)
    expect(await rows()).toMatchObject([{ outcome: 'failed', inputTokens: 0, outputTokens: 0 }])
    expect(Number((await rows())[0]?.costYuan)).toBe(0)
  })

  test('a retry that succeeds returns the reply', async () => {
    let n = 0
    const a = createFakeLlm(() => (++n === 1 ? unavailable() : ok('second')))
    const res = await createLlm({ db, config, clock, providers: { a }, random: () => 0 }).call('lesson', prompt)
    expect(res.text).toBe('second')
    expect(await rows()).toMatchObject([{ outcome: 'ok' }])
  })

  describe('the wait before a retry', () => {
    afterEach(() => vi.useRealTimers())

    /** Runs one call that fails once with `err`, on fake timers; returns when each attempt started. */
    async function gaps(err: LlmUnavailable, random: () => number): Promise<number[]> {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
      const starts: number[] = []
      const a = createFakeLlm(() => {
        starts.push(performance.now())
        return starts.length === 1 ? err : ok()
      })
      const done = createLlm({ db, config, clock, providers: { a }, random }).call('lesson', prompt)
      await vi.advanceTimersByTimeAsync(3000)
      await done
      return starts
    }

    test('waits 500 to 1500 ms before a retry', async () => {
      const low = await gaps(unavailable(), () => 0)
      expect(low[1]! - low[0]!).toBeGreaterThanOrEqual(500)
      expect(low[1]! - low[0]!).toBeLessThan(600)
      const high = await gaps(unavailable(), () => 1)
      expect(high[1]! - high[0]!).toBeGreaterThanOrEqual(1500)
      expect(high[1]! - high[0]!).toBeLessThan(1600)
    })

    test('waits as long as Retry-After says', async () => {
      for (const random of [() => 0, () => 1]) {
        const s = await gaps(unavailable({ retryAfterMs: 800 }), random)
        expect(s[1]! - s[0]!).toBeGreaterThanOrEqual(800)
        expect(s[1]! - s[0]!).toBeLessThan(900)
      }
    })

    test('does not retry when the wait leaves less than a second', async () => {
      const a = createFakeLlm(() => unavailable({ retryAfterMs: 500 }))
      await expect(createLlm({ db, config, clock, providers: { a } }).call('lesson', prompt, { timeoutMs: 1200 })).rejects.toBeInstanceOf(LlmUnavailable)
      expect(a.calls).toHaveLength(1)
      expect(await rows()).toMatchObject([{ outcome: 'failed' }])
    })
  })

  test('an error that is not retryable is not retried', async () => {
    const a = createFakeLlm(() => new LlmUnavailable('x', { retryable: false }))
    await expect(createLlm({ db, config, clock, providers: { a } }).call('lesson', prompt)).rejects.toBeInstanceOf(LlmUnavailable)
    expect(a.calls).toHaveLength(1)
    expect(await rows()).toMatchObject([{ outcome: 'failed' }])
  })

  test('an error without options is not retryable and carries the defaults', () => {
    expect(new LlmUnavailable('x')).toMatchObject({ retryable: false, retryAfterMs: null })
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

  // The times below run until the call rejects, so they include writing its `llm_calls` row, and a busy runner can
  // make that and the timer late by a few hundred milliseconds. Each bound only has to tell the call's own 100 ms
  // from the wrong outcomes, which the tests keep at 1.5 s or more.

  test('queue wait counts against the timeout and no request is started for it', async () => {
    const one = { ...config, llm: { ...config.llm, maxConcurrent: 1, retries: 0 } }
    let finish: () => void = () => {}
    const a = createFakeLlm(() => new Promise<LlmResponse>((resolve) => (finish = () => resolve(ok()))))
    const llm = createLlm({ db, config: one, clock, providers: { a } })
    // The first call holds the only slot until the test lets it go, so the second can only give up on its deadline.
    const first = llm.call('lesson', prompt, { timeoutMs: 60_000 })
    try {
      const started = performance.now()
      await expect(llm.call('lesson', prompt, { timeoutMs: 100 })).rejects.toBeInstanceOf(LlmUnavailable)
      // On its own 100 ms, not on the default 5 s.
      expect(performance.now() - started).toBeLessThan(1000)
      expect(a.calls).toHaveLength(1)
    } finally {
      finish()
    }
    await expect(first).resolves.toMatchObject({ text: 'hi' })
    expect(await rows()).toMatchObject([{ outcome: 'failed', inputTokens: 0 }, { outcome: 'ok' }])
  })

  test('the timeout is total: a hung attempt leaves no time for a retry', async () => {
    const a = createFakeLlm(() => new Promise<LlmResponse>(() => {}))
    // The longest pause before a retry: 1.5 s.
    const llm = createLlm({ db, config, clock, providers: { a }, random: () => 1 })
    const started = performance.now()
    await expect(llm.call('lesson', prompt, { timeoutMs: 100 })).rejects.toBeInstanceOf(LlmUnavailable)
    // At the 100 ms deadline: not after a pause for a retry, nor on the default 5 s.
    expect(performance.now() - started).toBeLessThan(1000)
    expect(a.calls).toHaveLength(1)
    expect(a.calls[0]?.req.timeoutMs).toBeLessThanOrEqual(100)
  })

  test('does not retry or hang on a huge Retry-After', async () => {
    const a = createFakeLlm(() => unavailable({ retryAfterMs: 3_600_000 }))
    const llm = createLlm({ db, config, clock, providers: { a } })
    const started = performance.now()
    await expect(llm.call('lesson', prompt, { timeoutMs: 2000 })).rejects.toBeInstanceOf(LlmUnavailable)
    expect(performance.now() - started).toBeLessThan(500)
    expect(a.calls).toHaveLength(1)
    expect(await rows()).toMatchObject([{ outcome: 'failed' }])
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
      return ++n === 1 ? unavailable({ retryAfterMs: 1 }) : ok()
    })
    await createLlm({ db, config, clock, providers: { a } }).call('lesson', prompt, { timeoutMs: 2000 })
    for (const c of a.calls) {
      expect(Number.isInteger(c.req.timeoutMs)).toBe(true)
      expect(c.req.timeoutMs).toBeGreaterThan(0)
    }
  })

  test('a retry gets only the time that is left', async () => {
    let n = 0
    const a = createFakeLlm(async () => {
      await new Promise((r) => setTimeout(r, 60))
      return ++n === 1 ? unavailable({ retryAfterMs: 1 }) : ok()
    })
    await createLlm({ db, config, clock, providers: { a } }).call('lesson', prompt, { timeoutMs: 2000 })
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

  const llmOverHttp = () => createLlm({ db, config, clock, random: () => 0, providers: { a: createOpenAiCompatible({ baseUrl, apiKey: 'sk-test', refusalMarkers: [] }) } })

  test('a call succeeds although the time left is a fraction of a millisecond', async () => {
    await expect(llmOverHttp().call('lesson', prompt, { json: true, timeoutMs: 5000 })).resolves.toEqual({ text: '{"ok":true}', inputTokens: 10, outputTokens: 5, cachedInputTokens: 0 })
    expect(await rows()).toMatchObject([{ outcome: 'ok', inputTokens: 10, outputTokens: 5 }])
  })

  test('a retry after a server error succeeds with whatever time is left', async () => {
    replies = [500]
    await expect(llmOverHttp().call('lesson', prompt, { timeoutMs: 5000 })).resolves.toMatchObject({ text: '{"ok":true}' })
    expect(replies).toEqual([])
    expect(await rows()).toMatchObject([{ outcome: 'ok', httpStatus: null }])
  })

  test('a vendor error status is recorded as http_status on the failed row; a network error leaves it null', async () => {
    replies = [400]
    await expect(llmOverHttp().call('lesson', prompt, { timeoutMs: 5000 })).rejects.toMatchObject({ status: 400 })
    replies = [503, 503]
    await expect(llmOverHttp().call('lesson', prompt, { timeoutMs: 5000 })).rejects.toMatchObject({ status: 503 })
    const dead = createLlm({ db, config, clock, random: () => 0, providers: { a: createOpenAiCompatible({ baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'k', refusalMarkers: [] }) } })
    await expect(dead.call('lesson', prompt, { timeoutMs: 5000 })).rejects.toMatchObject({ status: null })
    expect((await rows()).map((r) => [r.outcome, r.httpStatus])).toEqual([
      ['failed', 400],
      ['failed', 503],
      ['failed', null],
    ])
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

  test('a failed call that was still billed also checks the budget', async () => {
    const tight = { ...config, llm: { ...config.llm, monthlyBudgetYuan: 0.001 } }
    const a = createFakeLlm(() => new LlmTruncated('cut off', 1000, 8000))
    const mailer = new MemoryMailer()
    const llm = createLlm({ db, config: tight, clock, providers: { a }, budget: { mailer, operatorEmail: 'ops@example.com' } })
    await expect(llm.call('lesson', prompt)).rejects.toBeInstanceOf(LlmTruncated)
    expect(mailer.notices).toHaveLength(1)
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

describe('pricing', () => {
  test('records cached tokens and the cost of the moment', async () => {
    const priced = {
      ...config,
      llm: {
        ...config.llm,
        providers: {
          ...config.llm.providers,
          a: {
            ...config.llm.providers.a,
            models: {
              'a-1': {
                ...price,
                cachedInputYuanPerMillion: 0.2,
                windows: [{ inputYuanPerMillion: 4, outputYuanPerMillion: 16, cachedInputYuanPerMillion: 0.4, weekdays: [1, 2, 3, 4, 5], from: '09:00', to: '12:00' }],
              },
            },
          },
        },
      },
    }
    const a = createFakeLlm(() => ok('hi', 1_000_000, 100_000, 600_000))
    // 2026-11-10 is a Tuesday: 04:00 UTC is 12:00 in Beijing, outside the window; 02:00 UTC is 10:00, inside it.
    const at = createTestClock(new Date('2026-11-10T04:00:00Z'))
    const llm = createLlm({ db, config: priced, clock: at, providers: { a } })
    await llm.call('lesson', prompt)
    at.set(new Date('2026-11-10T02:00:00Z'))
    await llm.call('lesson', prompt)
    const [outside, inside] = await rows()
    expect(outside).toMatchObject({ inputTokens: 1_000_000, cachedInputTokens: 600_000 })
    expect(Number(outside?.costYuan)).toBeCloseTo(0.4 * 2 + 0.6 * 0.2 + 0.1 * 8, 6)
    expect(Number(inside?.costYuan)).toBeCloseTo(0.4 * 4 + 0.6 * 0.4 + 0.1 * 16, 6)
  })

  test('a cut-off reply records its cached tokens too', async () => {
    const a = createFakeLlm(() => new LlmTruncated('cut off', 1000, 8000, 400))
    await expect(createLlm({ db, config, clock, providers: { a } }).call('lesson', prompt)).rejects.toBeInstanceOf(LlmTruncated)
    expect(await rows()).toMatchObject([{ outcome: 'failed', inputTokens: 1000, cachedInputTokens: 400 }])
  })
})

describe('fake mode', () => {
  const run = (purpose: LlmPurpose, user = '') => {
    const a = createFakeLlm(() => new Error('must not be called'))
    return createLlm({ db, config, clock, providers: { a }, fake: true }).call(purpose, { system: '', user })
  }

  test('calls no provider, costs nothing and is recorded as ok', async () => {
    const res = await run('comment')
    expect(res).toEqual({ text: '说得不错。', inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 })
    expect(await rows()).toMatchObject([{ purpose: 'comment', outcome: 'ok', inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 }])
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
