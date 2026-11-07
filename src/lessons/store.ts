import type { Kysely, Selectable, Transaction } from 'kysely'
import type { ModerationCategory, Moderator } from '../moderation/moderator.js'
import type { Clock } from '../shared/clock.js'
import type { Division } from '../shared/config.js'
import { lessonLockKey, lock } from '../shared/db.js'
import type {
  CallOnKind,
  Database,
  LessonChange,
  LessonContent,
  LessonFlag,
  LessonSource,
  LessonsTable,
} from '../shared/schema.js'
import {
  LessonFormatError,
  lessonText,
  MAX_CALL_ON_QUESTION_CHARS,
  MAX_GIST_CHARS,
  MAX_SEGMENT_TEXT_CHARS,
  MAX_TITLE_CHARS,
  PART_NAMES,
} from './format.js'

export type { LessonFlag } from '../shared/schema.js'

// The lessons waiting for review and the rules for changing them. Every save keeps the whole content as a numbered
// version, runs it through the word list (the red marks) and sends the lesson back to review. Each write names the
// version it was made from and is refused when the lesson has moved on since, so two tabs cannot overwrite each other.
// Every write runs under the lesson's lock (`lessonLockKey`), the one the class runtime takes to decide what the day
// is: a lesson is approved either before its doors open, and taught as approved, or not at all. Once a class of the
// division has begun the day, with the lesson or with a study hall, nothing about the lesson changes.

/**
 * A text of a lesson that can be edited by hand: the title, a segment's text (`segment`) or gist (`gist`), with
 * `index` the segment (0-based), or a call-on question. The parts are the places a red mark can be on.
 */
export type LessonPart =
  | { part: 'title' }
  | { part: 'segment'; index: number }
  | { part: 'gist'; index: number }
  | { part: 'review' }
  | { part: 'extension' }

/** The rule a privacy hit is flagged under: privacy hits name no rule of their own. */
export const PRIVACY_FLAG_RULE = '隐私信息'

/** The kind of red mark each category of hit makes, so the page can say which it is without guessing from the rule. */
const FLAG_KIND: Record<ModerationCategory, LessonFlag['kind']> = {
  sensitive: 'word',
  injection: 'pattern',
  privacy: 'privacy',
}

export interface LessonStoreDeps {
  db: Kysely<Database>
  clock: Clock
  moderator: Moderator
}

/**
 * The write was made from a version the lesson has moved on from, or from a day the writer saw without a lesson that
 * has one now (or the other way round). `lessonId` is null when the day has no lesson.
 */
export class StaleLessonVersion extends Error {
  constructor(readonly lessonId: number | null) {
    super('这节课在别处改过了，刷新后再改')
    this.name = 'StaleLessonVersion'
  }
}

/**
 * A class has begun the lesson's day (see `LockRule`), so it can no longer change. `lessonId` is null when the day has
 * no lesson.
 */
export class LessonLocked extends Error {
  constructor(readonly lessonId: number | null) {
    super('这节课已经开课，不能再改')
    this.name = 'LessonLocked'
  }
}

/** The lesson still has red marks: each has to be fixed or marked a false positive before it can be approved. */
export class LessonHasFlags extends Error {
  constructor(
    readonly lessonId: number,
    readonly count: number,
  ) {
    super(`这节课还有 ${count} 处红笔标记，改掉或标为误伤以后才能通过`)
    this.name = 'LessonHasFlags'
  }
}

/** No such lesson, or no such version of it. */
export class LessonNotFound extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LessonNotFound'
  }
}

type LessonRow = Selectable<LessonsTable>

/** The content a lesson row holds. */
export const contentOf = (row: LessonRow): LessonContent => ({
  title: row.title,
  subject: row.subject,
  segments: row.segments,
  callOnQuestions: row.callOnQuestions,
})

/** The lesson columns that hold its content. */
const contentColumns = (content: LessonContent) => ({
  subject: content.subject,
  title: content.title,
  segments: JSON.stringify(content.segments),
  callOnQuestions: content.callOnQuestions === null ? null : JSON.stringify(content.callOnQuestions),
})

/**
 * The red marks of a lesson: one for each rule that hits a part, in the order a reviewer reads them (the title, each
 * segment's text and then its gist, the review and the extension question), less the rules marked false positives.
 * Every rule is looked for, so a false positive never hides another rule of the same part.
 */
function flagsOf(moderator: Moderator, content: LessonContent, falsePositives: readonly string[]): LessonFlag[] {
  const skipped = new Set(falsePositives)
  const flags: LessonFlag[] = []
  const mark = (part: LessonFlag['part'], index: number | null, text: string) => {
    // Each rule once, in the order of its first hit.
    const kinds = new Map<string, LessonFlag['kind']>()
    for (const hit of moderator.checkAll(text)) {
      const rule = hit.rule ?? PRIVACY_FLAG_RULE
      if (!kinds.has(rule)) kinds.set(rule, FLAG_KIND[hit.category])
    }
    for (const [rule, kind] of kinds) if (!skipped.has(rule)) flags.push({ part, index, kind, rule })
  }
  mark('title', null, content.title)
  content.segments.forEach((s, i) => {
    mark('segment', i, s.text)
    mark('gist', i, s.gist)
  })
  if (content.callOnQuestions !== null) {
    mark('review', null, content.callOnQuestions.review)
    mark('extension', null, content.callOnQuestions.extension)
  }
  return flags
}

/** Whether two lists hold the same marks in the same order (the stored ones come back with their keys reordered). */
function sameFlags(a: readonly LessonFlag[], b: readonly LessonFlag[]): boolean {
  const key = (f: LessonFlag) => JSON.stringify([f.part, f.index, f.kind, f.rule])
  return a.length === b.length && a.every((f, i) => key(f) === key(b[i]!))
}

interface VersionMeta {
  change: LessonChange
  reason?: string | null
  segmentIndex?: number | null
  /** For a `rewrite_segment`: the call-ons that are based on the segment, to be looked at again. */
  flagCallOns?: readonly CallOnKind[]
}

const CALL_ON_ORDER: readonly CallOnKind[] = ['review', 'extension']

/**
 * The call-on questions to look at again after a save. A lesson without questions has none, and a new lesson or a
 * rewrite of the whole lesson starts over. Otherwise a question stays flagged until its text changes, and a segment
 * rewrite adds the questions that are based on the segment (`flagCallOns`) that the new content has.
 */
export function nextCallOnChecks(
  before: readonly CallOnKind[],
  old: LessonContent,
  next: LessonContent,
  meta: Pick<VersionMeta, 'change' | 'flagCallOns'>,
): CallOnKind[] {
  const questions = next.callOnQuestions
  if (questions === null) return []
  if (meta.change === 'generate' || meta.change === 'rewrite_lesson' || meta.change === 'topic') return []
  const kept = before.filter((k) => old.callOnQuestions?.[k] === questions[k])
  const added = meta.change === 'rewrite_segment' ? (meta.flagCallOns ?? []) : []
  return CALL_ON_ORDER.filter((k) => kept.includes(k) || added.includes(k))
}

async function insertVersion(
  trx: Transaction<Database>,
  lessonId: number,
  version: number,
  content: LessonContent,
  meta: VersionMeta,
  callOnChecks: readonly CallOnKind[],
  now: Date,
): Promise<void> {
  // Only the content's own fields, whatever else the object passed in carries.
  const kept: LessonContent = {
    title: content.title,
    subject: content.subject,
    segments: content.segments,
    callOnQuestions: content.callOnQuestions,
  }
  await trx
    .insertInto('lessonVersions')
    .values({
      lessonId,
      version,
      content: JSON.stringify(kept),
      change: meta.change,
      segmentIndex: meta.segmentIndex ?? null,
      reason: meta.reason ?? null,
      callOnChecks: JSON.stringify(callOnChecks),
      createdAt: now,
    })
    .execute()
}

/**
 * Saves new content over a lesson as its next version: flags it against the word list, keeps the version and sends
 * the lesson back to review.
 */
async function saveVersion(
  trx: Transaction<Database>,
  deps: LessonStoreDeps,
  lesson: LessonRow,
  content: LessonContent,
  meta: VersionMeta,
  also: { source?: LessonSource; topic?: string | null } = {},
  /** The reminders to store as they are (a restored version's own), in place of working them out. */
  callOnChecksOverride?: CallOnKind[],
): Promise<{ version: number; flags: LessonFlag[] }> {
  const now = deps.clock.now()
  const callOnChecks = callOnChecksOverride ?? nextCallOnChecks(lesson.callOnChecks, contentOf(lesson), content, meta)
  const flags = flagsOf(deps.moderator, content, lesson.falsePositives)
  const version = lesson.version + 1
  await trx
    .updateTable('lessons')
    .set({
      ...contentColumns(content),
      ...also,
      flags: JSON.stringify(flags),
      callOnChecks: JSON.stringify(callOnChecks),
      version,
      approvedAt: null,
      updatedAt: now,
    })
    .where('id', '=', lesson.id)
    .execute()
  await insertVersion(trx, lesson.id, version, content, meta, callOnChecks, now)
  return { version, flags }
}

/**
 * When a lesson stops changing. `day_decided`, the rule: once a class of its division has begun its day, teaching it or
 * holding a study hall, since the first class decides the day for every class of the division and the lesson is then
 * taught as it is, or not at all. `lesson_taught`, kept for the import tool alone: only once a class teaches the lesson
 * itself, so a lesson can still be imported (and approved) for a day a study hall decided, where it is not taught.
 */
export type LockRule = 'day_decided' | 'lesson_taught'

/** Whether a class of the division has begun the day, with its lesson or a study hall: the day is decided. */
export async function dayDecided(db: Kysely<Database>, date: string, division: Division): Promise<boolean> {
  const session = await db
    .selectFrom('classSessions as s')
    .innerJoin('classes as c', 'c.id', 's.classId')
    .select('s.id')
    .where('s.date', '=', date)
    .where('c.division', '=', division)
    .limit(1)
    .executeTakeFirst()
  return session !== undefined
}

/** Throws `LessonLocked` when the lesson can no longer change by `rule`. */
export async function assertUnlocked(
  db: Kysely<Database>,
  lesson: { id: number; date: string; division: Division },
  rule: LockRule = 'day_decided',
): Promise<void> {
  if (rule === 'day_decided') {
    if (await dayDecided(db, lesson.date, lesson.division)) throw new LessonLocked(lesson.id)
    return
  }
  const taught = await db.selectFrom('classSessions').select('id').where('lessonId', '=', lesson.id).limit(1).executeTakeFirst()
  if (taught !== undefined) throw new LessonLocked(lesson.id)
}

/**
 * Reads the lesson under its lock, `for update`, and runs `write` on it once it is sure the lesson is still at
 * `baseVersion` and can still change (`rule`). The class runtime decides the day under the same lock, so a session of
 * the day is either there to be seen here, or written after this transaction, from what it leaves.
 */
async function changeLesson<T>(
  deps: LessonStoreDeps,
  lessonId: number,
  baseVersion: number,
  write: (trx: Transaction<Database>, lesson: LessonRow) => Promise<T>,
  rule: LockRule = 'day_decided',
): Promise<T> {
  const { db } = deps
  // The lock is named by the lesson's day and division, which never change.
  const key = await db.selectFrom('lessons').select(['date', 'division']).where('id', '=', lessonId).executeTakeFirst()
  if (key === undefined) throw new LessonNotFound(`没有编号 ${lessonId} 的课程`)
  return db.transaction().execute(async (trx) => {
    await lock(trx, lessonLockKey(key.date, key.division))
    const lesson = await trx.selectFrom('lessons').selectAll().where('id', '=', lessonId).forUpdate().executeTakeFirst()
    if (lesson === undefined) throw new LessonNotFound(`没有编号 ${lessonId} 的课程`)
    if (lesson.version !== baseVersion) throw new StaleLessonVersion(lessonId)
    await assertUnlocked(trx, lesson, rule)
    return write(trx, lesson)
  })
}

/**
 * Stores content for a day and division: a new lesson at version 1, or, when the day already has one, its next
 * version. Either way it is a draft. The source is stored as given; the topic only when given (a new lesson has none
 * otherwise). Throws `LessonLocked` once the day is decided (by `lockedWhen`, see `LockRule`).
 *
 * `expectVersion` is what the writer saw of the day: the version of its lesson, or null for no lesson. When the day
 * has moved on from it (a lesson pasted in by another tab, or made by the model, meanwhile), `StaleLessonVersion` and
 * nothing is stored. Left out, whatever is there is replaced.
 */
export async function saveDraft(
  deps: LessonStoreDeps,
  key: { date: string; division: Division },
  content: LessonContent,
  meta: {
    source: LessonSource
    change: LessonChange
    reason?: string
    segmentIndex?: number
    topic?: string | null
    expectVersion?: number | null
    lockedWhen?: LockRule
  },
): Promise<{ lessonId: number; version: number; flags: LessonFlag[] }> {
  const { db, clock, moderator } = deps
  return db.transaction().execute(async (trx) => {
    await lock(trx, lessonLockKey(key.date, key.division))
    const existing = await trx
      .selectFrom('lessons')
      .selectAll()
      .where('date', '=', key.date)
      .where('division', '=', key.division)
      .forUpdate()
      .executeTakeFirst()
    if (meta.expectVersion !== undefined && (existing?.version ?? null) !== meta.expectVersion) {
      throw new StaleLessonVersion(existing?.id ?? null)
    }
    if ((meta.lockedWhen ?? 'day_decided') === 'day_decided' && (await dayDecided(trx, key.date, key.division))) {
      throw new LessonLocked(existing?.id ?? null)
    }

    if (existing === undefined) {
      const now = clock.now()
      const flags = flagsOf(moderator, content, [])
      const row = await trx
        .insertInto('lessons')
        .values({
          date: key.date,
          division: key.division,
          ...contentColumns(content),
          topic: meta.topic ?? null,
          source: meta.source,
          flags: JSON.stringify(flags),
          version: 1,
          approvedAt: null,
          createdAt: now,
          updatedAt: null,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
      await insertVersion(trx, row.id, 1, content, meta, [], now)
      return { lessonId: row.id, version: 1, flags }
    }

    if (meta.lockedWhen === 'lesson_taught') await assertUnlocked(trx, existing, 'lesson_taught')
    const also = meta.topic === undefined ? { source: meta.source } : { source: meta.source, topic: meta.topic }
    const saved = await saveVersion(trx, deps, existing, content, meta, also)
    return { lessonId: existing.id, ...saved }
  })
}

/** `content` with one part replaced by `text`; throws a `LessonFormatError` when the text or the part will not do. */
function withPart(content: LessonContent, part: LessonPart, text: string): LessonContent {
  switch (part.part) {
    case 'title':
      return { ...content, title: lessonText(text, PART_NAMES.title, MAX_TITLE_CHARS) }
    case 'segment':
    case 'gist': {
      const { index } = part
      const count = content.segments.length
      if (!Number.isInteger(index) || index < 0) throw new LessonFormatError(`段号必须是 0 到 ${count - 1} 的整数`)
      if (index >= count) throw new LessonFormatError(`没有第 ${index + 1} 段，这节课只有 ${count} 段`)
      const changed =
        part.part === 'segment'
          ? { text: lessonText(text, PART_NAMES.segmentText(index), MAX_SEGMENT_TEXT_CHARS) }
          : { gist: lessonText(text, PART_NAMES.segmentGist(index), MAX_GIST_CHARS) }
      return { ...content, segments: content.segments.map((s, i) => (i === index ? { ...s, ...changed } : s)) }
    }
    case 'review':
    case 'extension': {
      const questions = content.callOnQuestions
      if (questions === null) throw new LessonFormatError('这节课没有点名题，没有可改的题目')
      const question = lessonText(text, PART_NAMES[part.part], MAX_CALL_ON_QUESTION_CHARS)
      return { ...content, callOnQuestions: { ...questions, [part.part]: question } }
    }
  }
}

/** Changes one text of the lesson by hand (an `edit`). */
export async function editPart(
  deps: LessonStoreDeps,
  lessonId: number,
  baseVersion: number,
  part: LessonPart,
  text: string,
): Promise<{ version: number; flags: LessonFlag[] }> {
  return changeLesson(deps, lessonId, baseVersion, (trx, lesson) =>
    saveVersion(trx, deps, lesson, withPart(contentOf(lesson), part, text), { change: 'edit' }),
  )
}

/** Puts rewritten content in place of the lesson's, with the reason the reviewer gave for the rewrite. */
export async function replaceContent(
  deps: LessonStoreDeps,
  lessonId: number,
  baseVersion: number,
  content: LessonContent,
  meta: {
    change: 'rewrite_segment' | 'rewrite_lesson' | 'rewrite_call_on'
    reason: string
    segmentIndex?: number
    flagCallOns?: readonly CallOnKind[]
  },
): Promise<{ version: number; flags: LessonFlag[] }> {
  return changeLesson(deps, lessonId, baseVersion, (trx, lesson) => saveVersion(trx, deps, lesson, content, meta))
}

/** Makes an earlier version's content the lesson's again, as a new version, with the reminders it had. */
export async function restoreVersion(
  deps: LessonStoreDeps,
  lessonId: number,
  baseVersion: number,
  toVersion: number,
): Promise<{ version: number; flags: LessonFlag[] }> {
  return changeLesson(deps, lessonId, baseVersion, async (trx, lesson) => {
    const old = await trx
      .selectFrom('lessonVersions')
      .select(['content', 'callOnChecks'])
      .where('lessonId', '=', lessonId)
      .where('version', '=', toVersion)
      .executeTakeFirst()
    if (old === undefined) throw new LessonNotFound(`这节课没有第 ${toVersion} 版`)
    return saveVersion(trx, deps, lesson, old.content, { change: 'restore' }, {}, old.callOnChecks)
  })
}

/**
 * Records that a rule the lesson is flagged for was flagged wrongly: the lesson stops being flagged for it, here and in
 * its later versions. The word list stays as it is. The content does not change, so no version is kept, but the
 * version number moves on all the same: a tab that still shows the flag has to reload before it changes the lesson.
 */
export async function markFalsePositive(
  deps: LessonStoreDeps,
  lessonId: number,
  baseVersion: number,
  rule: string,
): Promise<{ version: number; flags: LessonFlag[] }> {
  return changeLesson(deps, lessonId, baseVersion, async (trx, lesson) => {
    if (!lesson.flags.some((f) => f.rule === rule)) {
      throw new LessonFormatError('这节课现在没有这条红笔标记，刷新后再看')
    }
    const falsePositives = [...lesson.falsePositives, rule]
    const flags = flagsOf(deps.moderator, contentOf(lesson), falsePositives)
    const version = lesson.version + 1
    await trx
      .updateTable('lessons')
      .set({
        falsePositives: JSON.stringify(falsePositives),
        flags: JSON.stringify(flags),
        version,
        updatedAt: deps.clock.now(),
      })
      .where('id', '=', lessonId)
      .execute()
    return { version, flags }
  })
}

/**
 * Records that the reviewer looked at a call-on question again and it is fine: its reminder goes, here and in the
 * versions to come. The content does not change, so no version is kept and the approval stands, but the version number
 * moves on all the same, as for a false positive.
 */
export async function confirmCallOn(
  deps: LessonStoreDeps,
  lessonId: number,
  baseVersion: number,
  kind: CallOnKind,
): Promise<{ version: number }> {
  return changeLesson(deps, lessonId, baseVersion, async (trx, lesson) => {
    if (!lesson.callOnChecks.includes(kind)) throw new LessonFormatError('这道点名题现在没有提醒，刷新后再看')
    const version = lesson.version + 1
    await trx
      .updateTable('lessons')
      .set({
        callOnChecks: JSON.stringify(lesson.callOnChecks.filter((k) => k !== kind)),
        version,
        updatedAt: deps.clock.now(),
      })
      .where('id', '=', lessonId)
      .execute()
    return { version }
  })
}

/**
 * Approves the lesson for teaching, as it is at `baseVersion`. The red marks are worked out again with the word list
 * as it is now: a rule dropped since no longer stands in the way, a word listed since does. While it has any, the
 * approval is refused with `LessonHasFlags`; marks that changed are stored all the same, on the next version number,
 * so a tab that shows the old ones has to reload. Refused with `LessonLocked` once its day is decided (by
 * `lockedWhen`, see `LockRule`). A lesson approved already keeps the time of its approval,
 * unless it has gained red marks: it is back to review then.
 */
export async function approve(
  deps: LessonStoreDeps,
  lessonId: number,
  baseVersion: number,
  opts: { lockedWhen?: LockRule } = {},
): Promise<void> {
  const write = async (trx: Transaction<Database>, lesson: LessonRow): Promise<number> => {
    const flags = flagsOf(deps.moderator, contentOf(lesson), lesson.falsePositives)
    if (!sameFlags(flags, lesson.flags)) {
      // A lesson approved before that now has red marks goes back to review with them.
      await trx
        .updateTable('lessons')
        .set({
          flags: JSON.stringify(flags),
          version: lesson.version + 1,
          updatedAt: deps.clock.now(),
          ...(flags.length > 0 ? { approvedAt: null } : {}),
        })
        .where('id', '=', lessonId)
        .execute()
    }
    if (flags.length > 0) return flags.length
    if (lesson.approvedAt === null) {
      await trx.updateTable('lessons').set({ approvedAt: deps.clock.now() }).where('id', '=', lessonId).execute()
    }
    return 0
  }
  // Thrown once the marks are stored: inside the transaction it would take them back.
  const marks = await changeLesson(deps, lessonId, baseVersion, write, opts.lockedWhen)
  if (marks > 0) throw new LessonHasFlags(lessonId, marks)
}
