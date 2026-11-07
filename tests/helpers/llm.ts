import { vi } from 'vitest'
import type { Llm, LlmPurpose } from '../../src/llm/client.js'
import { loadPrompts, type PromptName, type PromptTemplate } from '../../src/llm/prompts.js'
import type { SecondLayer, SecondVerdict } from '../../src/moderation/second-layer.js'
import type { SwitchName, Switches } from '../../src/shared/switches.js'

/** The example prompt files, read without the warning that no real ones are there. */
export function examplePrompts(): Record<PromptName, PromptTemplate> {
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  try {
    return loadPrompts(new URL('../../data/prompts', import.meta.url).pathname)
  } finally {
    stderr.mockRestore()
  }
}

/** Switches fixed as given; the rest are on, except the second layer for chat. */
export function switches(on: Partial<Record<SwitchName, boolean>> = {}): Switches {
  const all = { teacherLlm: true, secondLayerTeacher: true, secondLayerChat: false, ...on }
  return { isOn: (n) => all[n], refresh: async () => {}, stop: () => {} }
}

export interface ModelCall {
  purpose: LlmPurpose
  system: string
  user: string
  opts: { json?: boolean; maxOutputTokens?: number; timeoutMs?: number } | undefined
}
export type Reply = string | Error | Promise<string | Error>

/** A model that gives the replies in order, one per call; a call past the last one fails the test. */
export function scripted(replies: (Reply | ((call: ModelCall) => Reply))[] = []) {
  const calls: ModelCall[] = []
  const llm: Llm = {
    async call(purpose, prompt, opts) {
      const call = { purpose, system: prompt.system, user: prompt.user, opts }
      calls.push(call)
      const next = replies.shift()
      if (next === undefined) throw new Error('The model was called once too often')
      const out = await (typeof next === 'function' ? next(call) : next)
      if (out instanceof Error) throw out
      return { text: out, inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 }
    },
    async recordManual() {},
  }
  return { llm, calls }
}

/** A second layer that gives the verdicts in order, then passes. */
export function layer(verdicts: SecondVerdict[] = []) {
  const checked: { source: string; text: string }[] = []
  const secondLayer: SecondLayer = {
    async check(source, text) {
      checked.push({ source, text })
      return verdicts.shift() ?? 'pass'
    },
  }
  return { secondLayer, checked }
}

export function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}
