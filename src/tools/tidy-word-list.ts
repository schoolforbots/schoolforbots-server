import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { parseArgs } from 'node:util'
import { buildProviders, createLlm, type Llm } from '../llm/client.js'
import { extractJson } from '../llm/json.js'
import { fillPrompt, loadPrompts, type PromptTemplate } from '../llm/prompts.js'
import { LlmContentRefused, LlmUnavailable } from '../llm/provider.js'
import { loadBlockedWords } from '../moderation/load.js'
import { systemClock } from '../shared/clock.js'
import { loadClassEnv, loadSchoolConfig } from '../shared/config.js'
import { createDb } from '../shared/db.js'
import { localDate } from '../shared/local-time.js'
import { isEntryPoint } from './entry-point.js'

// `npm run words:tidy -- --out <file.md> [--batch 200]`: for the operator, before launch. Hands the word list to the
// model in batches and asks which entries would block ordinary maths, science or literature lessons, then writes the
// answer as a Markdown list. It only suggests: no word-list file is ever changed, and the one file it writes is the
// output file. The console gets counts only, because the words and the reasons are moderation data.

const DEFAULT_BATCH = 200
const USAGE = '用法：npm run words:tidy -- --out <输出文件.md> [--batch <每批词数，默认 200>]'

/** The reply shape the parser accepts; code owns it, the prompt file only places it with {{format}}. */
const FORMAT = [
  '只回复一个 JSON 对象，不要加任何其他文字：',
  '{"suggestions":[{"word":"<词表里的原词，一字不改>","reason":"<一句中文理由>"}]}',
  'suggestions 里只放建议删除的词；没有要建议的词就回复 {"suggestions":[]}。',
].join('\n')

const MAX_OUTPUT_TOKENS = 8000

export interface TidyEntry {
  word: string
  reason: string
}

export interface TidyResult {
  /** How many batches the word list was cut into (a split after a refusal is not counted again). */
  batches: number
  /** Words the model would drop, with its reason. */
  suggestions: TidyEntry[]
  /** Words nobody judged, with why. */
  undecided: TidyEntry[]
}

export interface TidyDeps {
  llm: Llm
  /** The `word-list-tidy` prompt. */
  prompt: PromptTemplate
}

export interface TidyOptions {
  batchSize: number
}

class BadReply extends Error {}

/** The suggestions of a reply that are about words of the batch, each word once. */
function parseSuggestions(text: string, batch: ReadonlySet<string>): TidyEntry[] {
  let json: unknown
  try {
    json = extractJson(text)
  } catch {
    throw new BadReply()
  }
  const list = (json as { suggestions?: unknown }).suggestions
  if (!Array.isArray(list)) throw new BadReply()
  const seen = new Set<string>()
  const out: TidyEntry[] = []
  for (const item of list) {
    const { word, reason } = (item ?? {}) as { word?: unknown; reason?: unknown }
    if (typeof word !== 'string' || !batch.has(word) || seen.has(word)) continue
    seen.add(word)
    out.push({ word, reason: typeof reason === 'string' ? reason : '' })
  }
  return out
}

/**
 * Asks the model about the words, batch by batch. A batch the vendor refuses is split in halves and asked again,
 * recursively, so a single word is what ends up undecided; a batch the model cannot be reached for, or whose reply is
 * not in the agreed shape, is undecided as a whole and the run goes on.
 */
export async function tidyWordList(deps: TidyDeps, words: readonly string[], opts: TidyOptions): Promise<TidyResult> {
  if (!Number.isInteger(opts.batchSize) || opts.batchSize < 1) throw new Error('每批词数必须是正整数')
  const unique = [...new Set(words)]
  const result: TidyResult = { batches: 0, suggestions: [], undecided: [] }

  async function ask(batch: string[]): Promise<void> {
    const undecided = (reason: string): void => {
      result.undecided.push(...batch.map((word) => ({ word, reason })))
    }
    // One JSON array, so no word can end the data block or pass for text outside it.
    const prompt = fillPrompt(deps.prompt, { words: JSON.stringify(batch), format: FORMAT })
    try {
      const res = await deps.llm.call('wordList', prompt, { json: true, maxOutputTokens: MAX_OUTPUT_TOKENS })
      result.suggestions.push(...parseSuggestions(res.text, new Set(batch)))
    } catch (err) {
      if (err instanceof LlmContentRefused) {
        if (batch.length === 1) return undecided('厂商拒绝判断这个词')
        const half = Math.ceil(batch.length / 2)
        await ask(batch.slice(0, half))
        await ask(batch.slice(half))
      } else if (err instanceof LlmUnavailable) undecided('大模型调不通')
      else if (err instanceof BadReply) undecided('大模型的回复格式不对')
      else throw err
    }
  }

  for (let i = 0; i < unique.length; i += opts.batchSize) {
    result.batches++
    await ask(unique.slice(i, i + opts.batchSize))
  }
  return result
}

const oneLine = (s: string) => s.replace(/\s+/gu, ' ').trim()
const byWord = (a: TidyEntry, b: TidyEntry) => (a.word < b.word ? -1 : a.word > b.word ? 1 : 0)

function section(title: string, entries: TidyEntry[]): string[] {
  const lines = entries.length === 0 ? ['（没有）'] : [...entries].sort(byWord).map((e) => `- ${oneLine(e.word)}：${oneLine(e.reason)}`)
  return [`## ${title}`, '', ...lines, '']
}

/** The Markdown list: title, run date, counts, then the suggestions and the undecided, each sorted by word. */
export function renderSuggestionList(result: TidyResult, date: string): string {
  return [
    '# 词库整理建议',
    '',
    `日期：${date}`,
    '',
    `共 ${result.batches} 批，建议删除 ${result.suggestions.length} 个，没能判断 ${result.undecided.length} 个。`,
    '',
    ...section('建议删除', result.suggestions),
    ...section('没能判断', result.undecided),
  ].join('\n')
}

/** Writes the list, making its directory if need be. */
export function writeSuggestionList(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

function parseTidyArgs(argv: string[]): { out: string; batch: number } | null {
  let values: Record<string, string | undefined>
  try {
    values = parseArgs({ args: argv, options: { out: { type: 'string' }, batch: { type: 'string' } }, strict: true, allowPositionals: false }).values
  } catch {
    return null
  }
  const { out, batch } = values
  if (out === undefined || out === '') return null
  if (batch !== undefined && !/^[1-9][0-9]*$/.test(batch)) return null
  return { out, batch: batch === undefined ? DEFAULT_BATCH : Number(batch) }
}

/** Returns the process exit code: 0 when the list was written, 1 when something failed. */
async function main(argv: string[]): Promise<number> {
  const args = parseTidyArgs(argv)
  if (args === null) {
    console.error(USAGE)
    return 1
  }
  try {
    // The database is only for recording what the calls cost.
    const env = loadClassEnv(process.env)
    const config = loadSchoolConfig(env.configPath)
    const prompts = loadPrompts(env.promptsDir)
    const words = loadBlockedWords(env.moderationDataDir)
    const providers = env.llmFake ? {} : buildProviders(config, process.env)
    const db = createDb(env.databaseUrl, env.databaseTimeouts)
    try {
      const llm = createLlm({ db, config, clock: systemClock, providers, fake: env.llmFake })
      const result = await tidyWordList({ llm, prompt: prompts['word-list-tidy'] }, words, { batchSize: args.batch })
      writeSuggestionList(args.out, renderSuggestionList(result, localDate(systemClock.now(), config.timezone)))
      console.log(`共 ${result.batches} 批，建议删除 ${result.suggestions.length} 个，没能判断 ${result.undecided.length} 个`)
      if (result.undecided.length > 0) console.log('没能判断的词在清单的最后一节，可以换个时间再跑一次')
      console.log(`清单写在 ${args.out}`)
    } finally {
      await db.destroy()
    }
    return 0
  } catch (err) {
    // Only the error's name: a message could carry a word or a reply.
    console.error(`整理失败（${err instanceof Error ? err.name : '未知错误'}）`)
    return 1
  }
}

if (isEntryPoint(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    () => {
      console.error('整理失败')
      process.exit(1)
    },
  )
}
