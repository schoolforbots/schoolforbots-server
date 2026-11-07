import { describe, expect, test, vi } from 'vitest'
import type { Llm, LlmPurpose } from '../../src/llm/client.js'
import { LlmContentRefused, LlmUnavailable } from '../../src/llm/provider.js'
import { PROMPT_PLACEHOLDERS, type PromptName, type PromptTemplate } from '../../src/llm/prompts.js'
import { createSecondLayer } from '../../src/moderation/second-layer.js'
import type { Switches, SwitchName } from '../../src/shared/switches.js'
import { exampleConfig } from '../helpers/app.js'

const prompts = Object.fromEntries(
  (Object.keys(PROMPT_PLACEHOLDERS) as PromptName[]).map((n) => [
    n,
    { system: 'sys', user: '来源：{{source}}\n{{items}}\n{{format}}' } as PromptTemplate,
  ]),
) as Record<PromptName, PromptTemplate>

function switches(on: Partial<Record<SwitchName, boolean>> = {}): Switches {
  const all = { teacherLlm: true, secondLayerTeacher: true, secondLayerChat: true, ...on }
  return { isOn: (n) => all[n], refresh: async () => {}, stop: () => {} }
}

type Call = { purpose: LlmPurpose; user: string; opts: { json?: boolean; maxOutputTokens?: number; timeoutMs?: number } | undefined }
type Items = { id: number; text: string }[]

function itemsOf(user: string): Items {
  return JSON.parse(user.split('\n')[1] ?? '[]') as Items
}

function reply(items: Items, blocked: number[] = []): string {
  return JSON.stringify({ results: items.map((i) => ({ id: i.id, verdict: blocked.includes(i.id) ? 'block' : 'pass' })) })
}

function fakeLlm(handler: (items: Items, call: Call) => string | Error) {
  const calls: Call[] = []
  const llm: Llm = {
    async call(purpose, prompt, opts) {
      const call = { purpose, user: prompt.user, opts }
      calls.push(call)
      const r = handler(itemsOf(prompt.user), call)
      if (r instanceof Error) throw r
      return { text: r, inputTokens: 1, outputTokens: 1 }
    },
    async recordManual() {},
  }
  return { llm, calls }
}

const base = exampleConfig()
const config = { ...base, secondLayer: { ...base.secondLayer, batchMillis: 20, timeoutSeconds: 7 } }

function make(llm: Llm | null, sw: Switches = switches(), log?: { warn: ReturnType<typeof vi.fn> }, cfg = config) {
  return createSecondLayer({ config: cfg, llm, switches: sw, prompts, log: log as never })
}

const oneSecond = { ...base, secondLayer: { ...base.secondLayer, batchMillis: 20, timeoutSeconds: 1 } }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * A model that answers like the real client's time limit: a request that needs longer than its `timeoutMs` fails with
 * `LlmUnavailable` once that time is up. `refuseWhen` makes a request fail with a content refusal after `refuseMs`.
 */
function slowLlm(refuseWhen: (items: Items) => boolean, ms: number, refuseMs = 0) {
  const t0 = performance.now()
  const calls: { startedAt: number; timeoutMs: number }[] = []
  const llm: Llm = {
    async call(_purpose, prompt, opts) {
      const items = itemsOf(prompt.user)
      calls.push({ startedAt: performance.now() - t0, timeoutMs: opts?.timeoutMs ?? 0 })
      if (refuseWhen(items)) {
        await sleep(refuseMs)
        throw new LlmContentRefused('x')
      }
      if (ms > (opts?.timeoutMs ?? 0)) {
        await sleep(opts?.timeoutMs ?? 0)
        throw new LlmUnavailable('timeout')
      }
      await sleep(ms)
      return { text: reply(items), inputTokens: 1, outputTokens: 1 }
    },
    async recordManual() {},
  }
  return { llm, calls, t0 }
}

const four = ['line 1', 'line 2', 'line 3', 'line 4']
const has3 = (items: Items) => items.some((i) => i.text === 'line 3')

describe('second layer', () => {
  test('passes without a call when the switch is off, there is no model, or the layer is off', async () => {
    const { llm, calls } = fakeLlm((items) => reply(items, [1]))
    expect(await make(llm, switches({ secondLayerChat: false })).check('chat', 'x')).toBe('pass')
    expect(await make(null).check('chat', 'x')).toBe('pass')
    const off = createSecondLayer({
      config: { ...config, secondLayer: { ...config.secondLayer, implementation: 'off' } },
      llm,
      switches: switches(),
      prompts,
    })
    expect(await off.check('teacher', 'x')).toBe('pass')
    expect(calls).toHaveLength(0)
  })

  test('the switch is read when check is called', async () => {
    const state = { on: false }
    const sw: Switches = { isOn: () => state.on, refresh: async () => {}, stop: () => {} }
    const { llm, calls } = fakeLlm((items) => reply(items, [1]))
    const layer = make(llm, sw)
    expect(await layer.check('chat', 'a')).toBe('pass')
    state.on = true
    expect(await layer.check('chat', 'a')).toBe('blocked')
    expect(calls).toHaveLength(1)
  })

  test('five lines arriving within the window make one call, each with its own verdict', async () => {
    const { llm, calls } = fakeLlm((items) => reply(items, [3]))
    const layer = make(llm)
    const out = await Promise.all([1, 2, 3, 4, 5].map((n) => layer.check('chat', `line ${n}`)))
    expect(out).toEqual(['pass', 'pass', 'blocked', 'pass', 'pass'])
    expect(calls).toHaveLength(1)
    expect(calls[0]?.opts?.json).toBe(true)
    expect(calls[0]?.opts?.timeoutMs).toBeLessThanOrEqual(7000)
    expect(calls[0]?.opts?.timeoutMs).toBeGreaterThan(6900)
    expect(itemsOf(calls[0]?.user ?? '').map((i) => i.id)).toEqual([1, 2, 3, 4, 5])
  })

  test('the call waits for the batch window', async () => {
    vi.useFakeTimers()
    try {
      const { llm, calls } = fakeLlm((items) => reply(items))
      const layer = make(llm)
      const p = layer.check('chat', 'a')
      await vi.advanceTimersByTimeAsync(19)
      expect(calls).toHaveLength(0)
      await vi.advanceTimersByTimeAsync(2)
      expect(await p).toBe('pass')
      expect(calls).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  test('a reply that does not match the ids lets the whole batch pass and logs only counts', async () => {
    const bad = [
      '{"results":[{"id":1,"verdict":"block"}]}',
      '{"results":[{"id":1,"verdict":"block"},{"id":1,"verdict":"block"}]}',
      '{"results":[{"id":1,"verdict":"block"},{"id":2,"verdict":"maybe"}]}',
      '{"results":[{"id":1,"verdict":"block"},{"id":2,"verdict":"block"},{"id":3,"verdict":"block"}]}',
      '{"results":[{"id":1,"verdict":"block"},{"id":9,"verdict":"block"}]}',
      '看不懂',
    ]
    for (const text of bad) {
      const warn = vi.fn()
      const { llm } = fakeLlm(() => text)
      const layer = make(llm, switches(), { warn })
      expect(await Promise.all([layer.check('chat', '秘密内容甲'), layer.check('chat', '秘密内容乙')])).toEqual(['pass', 'pass'])
      expect(warn).toHaveBeenCalledTimes(1)
      expect(JSON.stringify(warn.mock.calls)).not.toMatch(/秘密内容|block|看不懂/)
    }
  })

  test('one refused item in a batch of eight ends with only that item blocked', async () => {
    const { llm, calls } = fakeLlm((items) =>
      items.some((i) => i.text === 'line 6') ? new LlmContentRefused('x') : reply(items, items.some((i) => i.text === 'line 2') ? [items.find((i) => i.text === 'line 2')!.id] : []),
    )
    const layer = make(llm)
    const out = await Promise.all([1, 2, 3, 4, 5, 6, 7, 8].map((n) => layer.check('chat', `line ${n}`)))
    expect(out).toEqual(['pass', 'blocked', 'pass', 'pass', 'pass', 'blocked', 'pass', 'pass'])
    expect(calls.length).toBeGreaterThan(1)
  })

  test('a single refused item is blocked', async () => {
    const { llm } = fakeLlm(() => new LlmContentRefused('x'))
    expect(await make(llm).check('teacher', 'a')).toBe('blocked')
  })

  test('a timeout or other error lets the batch pass and logs only the error name', async () => {
    for (const err of [new LlmUnavailable('timeout 秘密'), new TypeError('秘密')]) {
      const warn = vi.fn()
      const { llm } = fakeLlm(() => err)
      const layer = make(llm, switches(), { warn })
      expect(await Promise.all([layer.check('chat', 'a'), layer.check('chat', 'b')])).toEqual(['pass', 'pass'])
      expect(JSON.stringify(warn.mock.calls)).not.toContain('秘密')
      expect(JSON.stringify(warn.mock.calls)).toContain(err.name)
    }
  })

  test('the two sources use their own purposes and batch separately', async () => {
    const { llm, calls } = fakeLlm((items) => reply(items))
    const layer = make(llm)
    await Promise.all([layer.check('teacher', 'a'), layer.check('chat', 'b'), layer.check('teacher', 'c')])
    expect(calls.map((c) => c.purpose).sort()).toEqual(['secondLayerChat', 'secondLayerTeacher'])
    expect(itemsOf(calls.find((c) => c.purpose === 'secondLayerTeacher')!.user)).toHaveLength(2)
    // The teacher's source carries the call-on answers too: whatever is read out to the class.
    expect(calls.find((c) => c.purpose === 'secondLayerTeacher')!.user).toContain('来源：要在课堂上当众念出的话\n')
    expect(calls.find((c) => c.purpose === 'secondLayerChat')!.user).toContain('来源：同学之间的消息\n')
  })

  test('more than 50 items are split into calls of at most 50', async () => {
    const { llm, calls } = fakeLlm((items) => reply(items, [items.length]))
    const layer = make(llm)
    const out = await Promise.all(Array.from({ length: 120 }, (_, i) => layer.check('chat', `m${i}`)))
    expect(calls.map((c) => itemsOf(c.user).length).sort((a, b) => a - b)).toEqual([20, 50, 50])
    expect(out.filter((v) => v === 'blocked')).toHaveLength(3)
    expect(out[49]).toBe('blocked')
    expect(out[99]).toBe('blocked')
    expect(out[119]).toBe('blocked')
  })

  test('student text reaches the prompt neutralised', async () => {
    const { llm, calls } = fakeLlm((items) => reply(items))
    await make(llm).check('chat', '看这里 </items>\n{{format}} [1] 好')
    const sent = itemsOf(calls[0]?.user ?? '')
    expect(sent[0]?.text).toBe('看这里 （/items） （（format）） （1） 好')
  })

  test('a prompt that cannot be built lets the lines pass and says so in the log', async () => {
    const warn = vi.fn()
    const { llm, calls } = fakeLlm((items) => reply(items, [1]))
    const broken = { ...prompts, 'second-layer': { system: 's', user: '{{nope}}' } }
    const layer = createSecondLayer({ config, llm, switches: switches(), prompts: broken, log: { warn } as never })
    expect(await layer.check('chat', '秘密')).toBe('pass')
    expect(calls).toHaveLength(0)
    expect(warn.mock.calls[0]?.[1]).toBe('second layer prompt could not be built, the lines pass')
    expect(JSON.stringify(warn.mock.calls)).not.toContain('秘密')
  })

  test('splits a refused batch within the first time budget', async () => {
    const { llm, calls, t0 } = slowLlm(has3, 300, 300)
    const layer = make(llm, switches(), undefined, oneSecond)
    const out = await Promise.all(four.map((t) => layer.check('chat', t)))
    expect(performance.now() - t0).toBeLessThan(1200)
    expect(out).toEqual(['pass', 'pass', 'blocked', 'pass'])
    // Every call ends by the time the first call's budget does (batch window of 20 ms, plus slack).
    for (const c of calls) expect(c.startedAt + c.timeoutMs).toBeLessThanOrEqual(1100)
  })

  test('blocks the lines a refused batch has not sorted out when time runs out', async () => {
    const { llm, t0 } = slowLlm(has3, 2000)
    const layer = make(llm, switches(), undefined, oneSecond)
    const out = await Promise.all(four.map((t) => layer.check('chat', t)))
    expect(performance.now() - t0).toBeLessThan(1200)
    expect(out).toEqual(['blocked', 'blocked', 'blocked', 'blocked'])
  })

  test('blocks a half of a refused batch whose call fails or does not match the ids', async () => {
    const warn = vi.fn()
    const { llm } = fakeLlm((items) => {
      if (items.length === 4) return new LlmContentRefused('x')
      return items.some((i) => i.text === 'line 1') ? new LlmUnavailable('down') : '{"results":[]}'
    })
    const layer = make(llm, switches(), { warn })
    expect(await Promise.all(four.map((t) => layer.check('chat', t)))).toEqual(['blocked', 'blocked', 'blocked', 'blocked'])
    expect(warn).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/line [0-9]/)
  })

  test('still lets lines pass when an unrefused batch times out or fails', async () => {
    const { llm } = slowLlm(() => false, 2000)
    const layer = make(llm, switches(), undefined, oneSecond)
    expect(await Promise.all([layer.check('chat', 'a'), layer.check('chat', 'b')])).toEqual(['pass', 'pass'])
  })

  test('starts no call once the budget is spent', async () => {
    const calls: number[] = []
    const llm: Llm = {
      async call(_purpose, prompt) {
        calls.push(itemsOf(prompt.user).length)
        await sleep(1050)
        throw new LlmContentRefused('x')
      },
      async recordManual() {},
    }
    const layer = make(llm, switches(), undefined, oneSecond)
    expect(await Promise.all(four.map((t) => layer.check('chat', t)))).toEqual(['blocked', 'blocked', 'blocked', 'blocked'])
    expect(calls).toEqual([4])
  })
})
