import type { FastifyBaseLogger } from 'fastify'
import type { Llm, LlmPurpose } from '../llm/client.js'
import { extractJson } from '../llm/json.js'
import { fillPrompt, neutralizeStudentText, type PromptName, type PromptTemplate } from '../llm/prompts.js'
import { LlmContentRefused } from '../llm/provider.js'
import type { SchoolConfig } from '../shared/config.js'
import type { Switches } from '../shared/switches.js'

export type SecondLayerSource = 'teacher' | 'chat'
export type SecondVerdict = 'pass' | 'blocked'

export interface SecondLayer {
  check(source: SecondLayerSource, text: string): Promise<SecondVerdict>
}

export interface SecondLayerDeps {
  config: Pick<SchoolConfig, 'secondLayer'>
  llm: Llm | null
  switches: Switches
  prompts: Record<PromptName, PromptTemplate>
  log?: Pick<FastifyBaseLogger, 'warn'>
}

/** One model call carries at most this many lines; a larger batch is split into chunks sent in parallel. */
const MAX_ITEMS_PER_CALL = 50

const SOURCES: Record<SecondLayerSource, { purpose: LlmPurpose; switch: 'secondLayerTeacher' | 'secondLayerChat'; label: string }> = {
  teacher: { purpose: 'secondLayerTeacher', switch: 'secondLayerTeacher', label: '要在课堂上当众念出的话' },
  chat: { purpose: 'secondLayerChat', switch: 'secondLayerChat', label: '同学之间的消息' },
}

const FORMAT =
  '只回复一个 JSON 对象，格式为 {"results":[{"id":<编号>,"verdict":"pass"或"block"}]}。' +
  '每个编号恰好回答一条；适合发出的写 "pass"，不适合发出的写 "block"。不要写别的内容。'

/** The verdict per id, or null when the reply is not exactly one `pass`/`block` entry per id. */
function parseVerdicts(text: string, count: number): SecondVerdict[] | null {
  let json: unknown
  try {
    json = extractJson(text)
  } catch {
    return null
  }
  const results = (json as { results?: unknown } | null)?.results
  if (!Array.isArray(results) || results.length !== count) return null
  const out: (SecondVerdict | undefined)[] = new Array(count).fill(undefined)
  for (const r of results as unknown[]) {
    const { id, verdict } = (r ?? {}) as { id?: unknown; verdict?: unknown }
    if (typeof id !== 'number' || !Number.isInteger(id) || id < 1 || id > count || out[id - 1] !== undefined) return null
    if (verdict !== 'pass' && verdict !== 'block') return null
    out[id - 1] = verdict === 'block' ? 'blocked' : 'pass'
  }
  return out as SecondVerdict[]
}

interface Pending {
  text: string
  resolve: (v: SecondVerdict) => void
}

/**
 * The model-based second moderation layer. Lines from the same source that arrive within `batchMillis` are checked
 * in one call. The layer fails open: an unavailable model, a timeout or a reply that does not match the ids lets the
 * lines pass. The vendor refusing a single line blocks it; a refused batch is halved within the first call's time
 * budget, and lines it cannot sort out by then are blocked. It holds no database transaction and logs counts,
 * the source and error names only, never a line or the reply.
 */
export function createSecondLayer(deps: SecondLayerDeps): SecondLayer {
  const { config, llm, switches, prompts, log } = deps
  const { batchMillis, timeoutSeconds } = config.secondLayer
  const open: Partial<Record<SecondLayerSource, Pending[]>> = {}

  /**
   * Checks the lines against one shared `deadline`. `refused` means an earlier call on these lines was refused by the
   * vendor: lines such a batch cannot sort out (no time left, the call failed, the reply did not match) are blocked,
   * while in a batch nobody refused they pass.
   */
  async function checkChunk(source: SecondLayerSource, texts: string[], deadline: number, refused: boolean): Promise<SecondVerdict[]> {
    const unsorted = (reason: string, err?: unknown): SecondVerdict[] => {
      const fields = { source, items: texts.length, ...(err === undefined ? {} : { err: err instanceof Error ? err.name : 'unknown' }) }
      if (refused) {
        log?.warn(fields, 'second layer could not sort out a refused batch, the lines are blocked')
        return texts.map((): SecondVerdict => 'blocked')
      }
      log?.warn(fields, `second layer ${reason}, the lines pass`)
      return texts.map((): SecondVerdict => 'pass')
    }
    let prompt: { system: string; user: string }
    try {
      const items = texts.map((text, i) => ({ id: i + 1, text: neutralizeStudentText(text) }))
      prompt = fillPrompt(prompts['second-layer'], { source: SOURCES[source].label, items: JSON.stringify(items), format: FORMAT })
    } catch (err) {
      return unsorted('prompt could not be built', err)
    }
    const left = deadline - performance.now()
    if (left <= 0) return unsorted('ran out of time')
    try {
      const reply = await llm!.call(SOURCES[source].purpose, prompt, {
        json: true,
        maxOutputTokens: 100 + 25 * texts.length,
        timeoutMs: Math.ceil(left),
      })
      const verdicts = parseVerdicts(reply.text, texts.length)
      if (verdicts) return verdicts
      return unsorted('reply did not match the ids')
    } catch (err) {
      if (err instanceof LlmContentRefused) {
        if (texts.length === 1) return ['blocked']
        const mid = Math.ceil(texts.length / 2)
        const halves = await Promise.all([
          checkChunk(source, texts.slice(0, mid), deadline, true),
          checkChunk(source, texts.slice(mid), deadline, true),
        ])
        return halves.flat()
      }
      return unsorted('call failed', err)
    }
  }

  async function runBatch(source: SecondLayerSource, batch: Pending[]): Promise<void> {
    const chunks: Pending[][] = []
    for (let i = 0; i < batch.length; i += MAX_ITEMS_PER_CALL) chunks.push(batch.slice(i, i + MAX_ITEMS_PER_CALL))
    await Promise.all(
      chunks.map(async (chunk) => {
        let verdicts: SecondVerdict[]
        try {
          verdicts = await checkChunk(source, chunk.map((p) => p.text), performance.now() + timeoutSeconds * 1000, false)
        } catch (err) {
          // Not expected (checkChunk handles model errors); still, no check may hang.
          log?.warn({ source, err: err instanceof Error ? err.name : 'unknown' }, 'second layer failed, the lines pass')
          verdicts = chunk.map(() => 'pass')
        }
        chunk.forEach((p, i) => p.resolve(verdicts[i] ?? 'pass'))
      }),
    )
  }

  return {
    check(source, text) {
      if (llm === null || config.secondLayer.implementation !== 'llm' || !switches.isOn(SOURCES[source].switch)) {
        return Promise.resolve('pass')
      }
      return new Promise<SecondVerdict>((resolve) => {
        const existing = open[source]
        if (existing) {
          existing.push({ text, resolve })
          return
        }
        const batch: Pending[] = [{ text, resolve }]
        open[source] = batch
        setTimeout(() => {
          delete open[source]
          void runBatch(source, batch)
        }, batchMillis).unref()
      })
    },
  }
}
