import type { FastifyBaseLogger } from 'fastify'
import { sql, type Kysely } from 'kysely'
import { PRIVACY_FLAG_RULE } from '../lessons/store.js'
import type { Llm } from '../llm/client.js'
import { extractJson } from '../llm/json.js'
import { fillPrompt, neutralizeStudentText, type PromptName, type PromptTemplate } from '../llm/prompts.js'
import { LlmContentRefused, LlmUnavailable } from '../llm/provider.js'
import { normalizeForPrivacy } from '../moderation/normalize.js'
import { findPrivacyLeak } from '../moderation/privacy.js'
import type { Clock } from '../shared/clock.js'
import type { SchoolConfig } from '../shared/config.js'
import { addDaysToDate, atLocalTime } from '../shared/local-time.js'
import type { Database } from '../shared/schema.js'
import { lastCompletedWeek, RULE_KIND, storedStats, weeklyStats } from './stats.js'

// The weekly review: after the midnight job of a Monday, the numbers of the week that has just ended, and what the
// model makes of two things in it. Only these two go to the model:
//
// - The lines a word-list entry or a phrase rule blocked (never a privacy hit, nor the second layer's, nor any line
//   that went through), grouped by the rule, so it can point out the rules that mostly stop ordinary talk. A rule's hit
//   comes before the privacy check, so such a line may also hold private data: that line is not shown. What the
//   model suggests is kept only for the rules it was shown, with the kind of their group and examples from that
//   group.
// - The reasons given for the week's lesson rewrites, for a few directions to change the lessons by.
//
// Each may fail on its own (the model unavailable or refusing, a reply that does not read); its item is then stored
// as null with the reason, and the numbers are stored all the same. Nothing waits on the model inside a transaction.
// A week is reviewed once: a run finds its review and stops, and two runs at once store one.

export interface WeeklySuggestions {
  removeRules: { kind: 'word' | 'pattern'; value: string; examples: number[] }[]
  directions: string[]
}

/** The suggestions as stored with a review: an item is null when its model task failed. */
export type StoredSuggestions = { [K in keyof WeeklySuggestions]: WeeklySuggestions[K] | null } & {
  /** Why an item is null, as the page says it; null for an item that was made. */
  failures: Record<keyof WeeklySuggestions, string | null>
}

export interface WeeklyReviewDeps {
  db: Kysely<Database>
  config: SchoolConfig
  clock: Clock
  llm: Llm
  prompts: Record<PromptName, PromptTemplate>
  /** Counts, the week, outcomes and error names only: never a line, a rule, a reason or what the model said. */
  log?: Pick<FastifyBaseLogger, 'info' | 'warn'>
}

/** The lines shown to the model for one rule, at most. */
const LINES_PER_GROUP = 20
/** The lines read for one rule, so that some left out for private data still leave enough to show. */
const LINES_READ_PER_GROUP = 2 * LINES_PER_GROUP
/** The rules shown, at most: the ones that blocked the most lines. */
const MAX_GROUPS = 50
/** The reasons shown, at most: the latest. */
const MAX_REASONS = 100
const MAX_DIRECTIONS = 10

/** Why a model task gave nothing, as the page says it. */
const FAILED = {
  unavailable: '大模型暂时调不通',
  refused: '厂商拒绝处理这批内容',
  unreadable: '大模型的回复格式不对',
  other: '生成时出错',
} as const

const RULES_FORMAT =
  '只回复一个 JSON 对象，格式为 {"removeRules":[{"kind":"word"或"pattern","value":"<规则>","examples":[<消息编号>]}]}。' +
  '每条建议对应上面的一组：kind 和 value 照抄那一组的 kind 和 rule，examples 写这一组里能说明拦错了的几条消息的 id。' +
  '只列拦下的大多是正常的话、应该停用的规则；没有就回复 {"removeRules":[]}。不要写别的内容。'

const REASONS_FORMAT =
  '只回复一个 JSON 对象，格式为 {"directions":["<一条建议>"]}。' +
  `把意思相近的理由归成一类，每类写一句以后出课时该怎么改的建议，最多 ${MAX_DIRECTIONS} 条；` +
  '没有可归纳的就回复 {"directions":[]}。不要写别的内容。'

/** The lines one rule blocked in the week. */
interface Group {
  kind: 'word' | 'pattern'
  rule: string
  /** All the lines it blocked, not only the ones shown. */
  hits: number
  lines: { id: number; text: string }[]
}

interface Week {
  from: Date
  to: Date
}

/** Whether a line holds what the privacy rules look for (a phone or ID number, an address, a chat log...). */
const holdsPrivateData = (text: string): boolean => findPrivacyLeak(normalizeForPrivacy(text)) !== null

/**
 * The rules of the word list and the phrase rules that blocked lines in the week, and not dropped since: the ones that
 * blocked the most first, each with the first lines it blocked that read differently and hold no private data. A rule
 * left with no such line is not among them.
 */
async function blockedGroups(db: Kysely<Database>, w: Week): Promise<Group[]> {
  type Row = { id: number; category: 'sensitive' | 'injection'; rule: string; text: string; hits: string }
  const { rows } = await sql<Row>`
    with blocked as (
      select m.id, m.moderation as category, m.matched_term as rule, m.text
      from messages m
      where m.delivered = false
        and m.moderation in ('sensitive', 'injection')
        and m.matched_term is not null
        and m.created_at >= ${w.from} and m.created_at < ${w.to}
        and not exists (
          select 1 from moderation_exclusions e
          where e.value = m.matched_term
            and e.kind = case m.moderation when 'sensitive' then 'word' else 'pattern' end
        )
    ),
    counted as (select category, rule, count(*) as hits from blocked group by category, rule),
    distinct_lines as (
      select distinct on (category, rule, text) id, category, rule, text from blocked order by category, rule, text, id
    ),
    ranked as (
      select id, category, rule, text, row_number() over (partition by category, rule order by id) as n
      from distinct_lines
    )
    select r.id, r.category, r.rule, r.text, c.hits
    from ranked r join counted c on c.category = r.category and c.rule = r.rule
    where r.n <= ${LINES_READ_PER_GROUP}
    order by r.id
  `.execute(db)

  const groups = new Map<string, Group>()
  for (const r of rows) {
    const key = JSON.stringify([r.category, r.rule])
    const group = groups.get(key) ?? { kind: RULE_KIND[r.category], rule: r.rule, hits: Number(r.hits), lines: [] }
    if (group.lines.length >= LINES_PER_GROUP || holdsPrivateData(r.text)) continue
    group.lines.push({ id: r.id, text: r.text })
    groups.set(key, group)
  }
  const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
  return [...groups.values()]
    .sort((a, b) => b.hits - a.hits || byText(a.rule, b.rule) || byText(a.kind, b.kind))
    .slice(0, MAX_GROUPS)
}

/** The reasons written for the week's lesson rewrites, the latest at most, in the order they were written. */
async function rewriteReasons(db: Kysely<Database>, w: Week): Promise<string[]> {
  const rows = await db
    .selectFrom('lessonVersions')
    .select('reason')
    .where('reason', 'is not', null)
    .where('createdAt', '>=', w.from)
    .where('createdAt', '<', w.to)
    .orderBy('createdAt', 'desc')
    .orderBy('id', 'desc')
    .limit(MAX_REASONS)
    .$narrowType<{ reason: string }>()
    .execute()
  return rows
    .map((r) => r.reason.trim())
    .filter((reason) => reason !== '')
    .reverse()
}

function rulesPrompt(deps: WeeklyReviewDeps, groups: Group[], marked: Set<string>) {
  const max = deps.config.chat.maxMessageChars
  // One group a line. The lines are the students' words: neutralised, they cannot close the block or the JSON.
  const lines = groups.map((g, i) =>
    JSON.stringify({
      group: i + 1,
      kind: g.kind,
      rule: g.rule,
      hits: g.hits,
      markedWrongInLessonReview: marked.has(g.rule),
      lines: g.lines.map((l) => ({ id: l.id, text: neutralizeStudentText(l.text, max) })),
    }),
  )
  return fillPrompt(deps.prompts['weekly-false-positives'], { groups: lines.join('\n'), format: RULES_FORMAT })
}

function reasonsPrompt(deps: WeeklyReviewDeps, reasons: string[]) {
  const lines = reasons.map((reason, i) => `${i + 1}. ${neutralizeStudentText(reason)}`)
  return fillPrompt(deps.prompts['weekly-reasons'], { reasons: lines.join('\n'), format: REASONS_FORMAT })
}

const field = (text: string, name: string): unknown => {
  try {
    return (extractJson(text) as Record<string, unknown>)[name]
  } catch {
    return undefined
  }
}

/**
 * The rules to drop in a reply, or null when it does not read. A suggestion is kept only for a rule among `groups`
 * (the privacy mark never), with that group's kind and only the examples shown in that group; the rest is left out.
 */
function parseRemoveRules(text: string, groups: Group[]): WeeklySuggestions['removeRules'] | null {
  const list = field(text, 'removeRules')
  if (!Array.isArray(list)) return null
  const out: WeeklySuggestions['removeRules'] = []
  for (const item of list as unknown[]) {
    if (item === null || typeof item !== 'object') continue
    const { kind, value, examples } = item as Record<string, unknown>
    if (typeof value !== 'string' || value === PRIVACY_FLAG_RULE) continue
    // A word and a phrase rule may read alike: the kind given picks between them, else the one group of that text.
    const alike = groups.filter((g) => g.rule === value)
    const group = alike.find((g) => g.kind === kind) ?? (alike.length === 1 ? alike[0] : undefined)
    if (group === undefined || out.some((s) => s.kind === group.kind && s.value === group.rule)) continue
    const shown = new Set(group.lines.map((l) => l.id))
    const given: unknown[] = Array.isArray(examples) ? examples : []
    const ids = given.filter((id): id is number => typeof id === 'number' && shown.has(id))
    out.push({ kind: group.kind, value: group.rule, examples: [...new Set(ids)] })
  }
  return out
}

/** The directions in a reply (non-empty, trimmed, the first few), or null when it does not read. */
function parseDirections(text: string): string[] | null {
  const list = field(text, 'directions')
  if (!Array.isArray(list)) return null
  return (list as unknown[])
    .filter((d): d is string => typeof d === 'string')
    .map((d) => d.trim())
    .filter((d) => d !== '')
    .slice(0, MAX_DIRECTIONS)
}

type Outcome<T> = { value: T; failure: null } | { value: null; failure: string }

const made = <T>(value: T): Outcome<T> => ({ value, failure: null })

/** Asks the model one of the two tasks: what it made, or why there is nothing. */
async function ask<T>(
  deps: WeeklyReviewDeps,
  what: { weekStart: string; task: keyof WeeklySuggestions },
  prompt: () => { system: string; user: string },
  parse: (text: string) => T | null,
): Promise<Outcome<T>> {
  try {
    const reply = await deps.llm.call('weekly', prompt(), { json: true })
    const value = parse(reply.text)
    if (value !== null) return made(value)
    deps.log?.warn({ ...what, err: 'UnreadableReply' }, 'weekly review task failed')
    return { value: null, failure: FAILED.unreadable }
  } catch (err) {
    const name = err instanceof Error ? err.constructor.name : 'unknown'
    deps.log?.warn({ ...what, err: name }, 'weekly review task failed')
    if (err instanceof LlmContentRefused) return { value: null, failure: FAILED.refused }
    if (err instanceof LlmUnavailable) return { value: null, failure: FAILED.unavailable }
    return { value: null, failure: FAILED.other }
  }
}

/**
 * Reviews the last week that has ended, unless it has a review: its numbers, and the two suggestions of the model
 * (none asked for when there is nothing to show it). Writes one `weekly_reviews` row.
 */
export async function runWeeklyReview(deps: WeeklyReviewDeps): Promise<void> {
  const { db, config, clock, log } = deps
  const weekStart = lastCompletedWeek(clock.now(), config.timezone)
  const reviewed = await db
    .selectFrom('weeklyReviews')
    .select('weekStart')
    .where('weekStart', '=', weekStart)
    .executeTakeFirst()
  if (reviewed !== undefined) {
    log?.info({ weekStart, outcome: 'exists' }, 'weekly review')
    return
  }

  const tz = config.timezone
  const week: Week = {
    from: atLocalTime(weekStart, '00:00', tz),
    to: atLocalTime(addDaysToDate(weekStart, 7), '00:00', tz),
  }
  const stats = await weeklyStats(db, config, weekStart)
  const groups = await blockedGroups(db, week)
  const reasons = await rewriteReasons(db, week)

  const marked = new Set(stats.moderation.falsePositiveMarks)
  const rules =
    groups.length === 0
      ? made([])
      : await ask(deps, { weekStart, task: 'removeRules' }, () => rulesPrompt(deps, groups, marked), (text) =>
          parseRemoveRules(text, groups),
        )
  const directions =
    reasons.length === 0
      ? made([])
      : await ask(deps, { weekStart, task: 'directions' }, () => reasonsPrompt(deps, reasons), parseDirections)

  const suggestions: StoredSuggestions = {
    removeRules: rules.value,
    directions: directions.value,
    failures: { removeRules: rules.failure, directions: directions.failure },
  }
  const stored = await db
    .insertInto('weeklyReviews')
    .values({
      weekStart,
      stats: JSON.stringify(storedStats(stats)),
      suggestions: JSON.stringify(suggestions),
      createdAt: clock.now(),
    })
    .onConflict((oc) => oc.column('weekStart').doNothing())
    .returning('weekStart')
    .executeTakeFirst()
  log?.info(
    {
      weekStart,
      outcome: stored === undefined ? 'exists' : 'stored',
      groups: groups.length,
      lines: groups.reduce((n, g) => n + g.lines.length, 0),
      reasons: reasons.length,
      removeRules: rules.value?.length ?? null,
      directions: directions.value?.length ?? null,
    },
    'weekly review',
  )
}
