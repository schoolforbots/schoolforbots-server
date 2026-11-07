import type { Kysely } from 'kysely'
import type { FastifyBaseLogger } from 'fastify'
import type { Mailer } from '../registration/mailer.js'
import type { Clock } from '../shared/clock.js'
import type { SchoolConfig } from '../shared/config.js'
import type { Database, LlmOutcome } from '../shared/schema.js'
import { checkBudget } from './budget.js'
import { fakeReply } from './fake-replies.js'
import { createOpenAiCompatible } from './openai-compatible.js'
import { LlmContentRefused, LlmUnavailable, type LlmProvider, type LlmResponse } from './provider.js'

export type LlmPurpose = keyof SchoolConfig['llm']['purposes']

export interface Llm {
  call(
    purpose: LlmPurpose,
    prompt: { system: string; user: string },
    opts?: { json?: boolean; maxOutputTokens?: number; timeoutMs?: number },
  ): Promise<LlmResponse>
  /** A reply pasted in by hand: one row with outcome `manual` and no cost. */
  recordManual(purpose: LlmPurpose): Promise<void>
}

const DEFAULT_MAX_OUTPUT_TOKENS = 4000

/**
 * One OpenAI-compatible provider for each provider that some purpose uses, with its key read from `processEnv`.
 * A used provider without a key is a startup error that names the variable (never its value).
 */
export function buildProviders(config: SchoolConfig, processEnv: NodeJS.ProcessEnv): Record<string, LlmProvider> {
  const used = new Set(Object.values(config.llm.purposes).map((p) => p.provider))
  const providers: Record<string, LlmProvider> = {}
  for (const name of used) {
    const conf = config.llm.providers[name]
    if (conf === undefined) throw new Error(`llm.providers: no provider named ${name}`)
    const apiKey = processEnv[conf.apiKeyEnv]
    if (apiKey === undefined || apiKey === '') {
      throw new Error(`Environment variable ${conf.apiKeyEnv} is not set; the model provider ${name} needs it`)
    }
    providers[name] = createOpenAiCompatible({ baseUrl: conf.baseUrl, apiKey, refusalMarkers: conf.contentRefusalMarkers, requestExtras: conf.requestExtras })
  }
  return providers
}

/**
 * The purposes whose calls a lesson is waiting on right now with a short budget: the checks of lines about to be said
 * or sent, and the comment due before the next segment. When a slot frees they go before the others waiting, so a
 * burst of answers or lessons holding the slots cannot run their budgets out in the line.
 */
const FIRST_IN_LINE: ReadonlySet<LlmPurpose> = new Set<LlmPurpose>(['secondLayerTeacher', 'secondLayerChat', 'comment'])

/**
 * Limits how many run at once (per process). A freed slot goes to the longest waiting call of the first line, else of
 * the second; a waiter gives up when its deadline passes.
 */
function createGate(limit: number) {
  let running = 0
  const first: (() => void)[] = []
  const rest: (() => void)[] = []
  return {
    /** Resolves with a release function, or rejects with LlmUnavailable when `ms` passes first. */
    acquire(ms: number, ahead: boolean): Promise<() => void> {
      const release = () => {
        const next = first.shift() ?? rest.shift()
        if (next !== undefined) next()
        else running--
      }
      if (running < limit) {
        running++
        return Promise.resolve(release)
      }
      const line = ahead ? first : rest
      return new Promise((resolve, reject) => {
        const grant = () => {
          clearTimeout(timer)
          resolve(release)
        }
        const timer = setTimeout(() => {
          line.splice(line.indexOf(grant), 1)
          reject(new LlmUnavailable('大模型调用超时（排队中）'))
        }, Math.max(ms, 0))
        line.push(grant)
      })
    },
  }
}

/** The total time ran out; there is nothing left to retry with. */
class TimedOut extends LlmUnavailable {}

/** Runs `work` but gives up with LlmUnavailable after `ms`, aborting what it started. */
async function within<T>(ms: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController()
  let timer: NodeJS.Timeout | undefined
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new TimedOut('大模型调用超时'))
    }, ms)
  })
  try {
    return await Promise.race([work(controller.signal), expired])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Routes each model call to the provider and model of its purpose, within the concurrency limit (checks and comments
 * first in line) and a total time budget (queue wait and every attempt), retrying only `LlmUnavailable`. Writes one `llm_calls` row per call. Elapsed
 * time is measured with a monotonic timer, not the injected clock, because timeouts run on real timers; `createdAt`
 * comes from the injected clock. Logs hold only purpose, provider, model, outcome, token counts and time.
 */
export function createLlm(deps: {
  db: Kysely<Database>
  config: SchoolConfig
  clock: Clock
  providers: Record<string, LlmProvider>
  log?: Pick<FastifyBaseLogger, 'info' | 'error'>
  /** From `env.llmFake`: no provider is called, every call gets the fixed reply of its purpose. */
  fake?: boolean
  /** When given, the monthly budget is checked after each successful call. */
  budget?: { mailer: Mailer; operatorEmail: string | null }
}): Llm {
  const { db, config, clock, providers, log, fake, budget } = deps
  const gate = createGate(config.llm.maxConcurrent)

  async function record(
    purpose: LlmPurpose,
    outcome: LlmOutcome,
    tokens: { input: number; output: number },
    ms: number,
  ): Promise<void> {
    const { provider, model } = config.llm.purposes[purpose]
    const price = config.llm.providers[provider]?.models[model]
    const cost = price === undefined ? 0 : (tokens.input * price.inputYuanPerMillion + tokens.output * price.outputYuanPerMillion) / 1_000_000
    await db
      .insertInto('llmCalls')
      .values({
        purpose,
        provider,
        model,
        inputTokens: tokens.input,
        outputTokens: tokens.output,
        costYuan: cost.toFixed(6),
        outcome,
        ms: Math.round(ms),
        createdAt: clock.now(),
      })
      .execute()
    log?.info({ purpose, provider, model, outcome, inputTokens: tokens.input, outputTokens: tokens.output, ms: Math.round(ms) }, 'llm call')
  }

  async function runBudgetCheck(): Promise<void> {
    if (budget === undefined) return
    try {
      await checkBudget({ db, config, clock, mailer: budget.mailer, operatorEmail: budget.operatorEmail })
    } catch (err) {
      log?.error({ err: err instanceof Error ? err.name : 'unknown' }, 'budget check failed')
    }
  }

  async function attempts(
    purpose: LlmPurpose,
    prompt: { system: string; user: string },
    opts: { json?: boolean; maxOutputTokens?: number },
    deadline: number,
  ): Promise<LlmResponse> {
    const { provider, model } = config.llm.purposes[purpose]
    const vendor = providers[provider]
    if (vendor === undefined) throw new Error(`No provider ${provider} is set up`)
    for (let attempt = 0; ; attempt++) {
      const left = deadline - performance.now()
      // A passed deadline starts no request, even when a slot was free; timers only take whole positive milliseconds.
      if (left <= 0) throw new TimedOut('大模型调用超时')
      const remaining = Math.max(1, Math.ceil(left))
      try {
        return await within(remaining, (signal) =>
          vendor.complete(
            model,
            { ...prompt, json: opts.json ?? false, maxOutputTokens: opts.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS, timeoutMs: remaining },
            signal,
          ),
        )
      } catch (err) {
        const canRetry = err instanceof LlmUnavailable && !(err instanceof TimedOut) && attempt < config.llm.retries && deadline - performance.now() > 0
        if (!canRetry) throw err
      }
    }
  }

  return {
    async call(purpose, prompt, opts = {}) {
      const started = performance.now()
      const { provider, model } = config.llm.purposes[purpose]
      if (fake === true) {
        const text = fakeReply(purpose, prompt.user, config)
        await record(purpose, 'ok', { input: 0, output: 0 }, performance.now() - started)
        return { text, inputTokens: 0, outputTokens: 0 }
      }
      const deadline = started + (opts.timeoutMs ?? config.llm.timeoutSeconds * 1000)
      let res: LlmResponse
      try {
        const release = await gate.acquire(deadline - performance.now(), FIRST_IN_LINE.has(purpose))
        try {
          res = await attempts(purpose, prompt, opts, deadline)
        } finally {
          release()
        }
      } catch (err) {
        const outcome = err instanceof LlmContentRefused ? 'refused' : 'failed'
        if (!(err instanceof LlmContentRefused) && !(err instanceof LlmUnavailable)) {
          log?.error({ purpose, provider, model, err: err instanceof Error ? err.name : 'unknown' }, 'llm call crashed')
        }
        await record(purpose, outcome, { input: 0, output: 0 }, performance.now() - started)
        throw err
      }
      await record(purpose, 'ok', { input: res.inputTokens, output: res.outputTokens }, performance.now() - started)
      await runBudgetCheck()
      return res
    },
    async recordManual(purpose) {
      await record(purpose, 'manual', { input: 0, output: 0 }, 0)
    },
  }
}
