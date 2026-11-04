import { useCallback, useEffect, useRef, useState } from 'react'

// How the pages talk to the admin API. Paths are relative (`api/...`): the pages are served from the admin path, so
// the browser puts them under it. Every request carries the header the server asks of every write, and the session
// cookie. Failures reach the caller as `ApiError`, whose message is Chinese and can be shown as it is.

export type Division = 'primary' | 'junior' | 'senior'
export type Slot = 'morning' | 'afternoon' | 'evening'
export type BlockCategory = 'sensitive' | 'injection' | 'privacy'
export type LlmPurpose =
  | 'lesson'
  | 'answer'
  | 'comment'
  | 'weekly'
  | 'secondLayerTeacher'
  | 'secondLayerChat'
  | 'wordList'
export type SwitchName = 'teacherLlm' | 'secondLayerTeacher' | 'secondLayerChat'

/** One school day's numbers, as `api/stats/daily` gives them. */
export interface DayNumbers {
  date: string
  dau: number
  dauBySlot: Record<Slot, number>
  chat: number
  blocked: number
  blockedByCategory: Record<BlockCategory, number>
  violations: number
  suspensions: number
  expulsions: number
  registrations: number
  /** In yuan, rounded to fen. */
  costYuan: number
}

export interface SeriesDay {
  date: string
  dauBySlot: Record<Slot, number>
  chat: number
  blockedByCategory: Record<BlockCategory, number>
  /** In yuan, to 4 decimal places. */
  costByPurpose: Record<LlmPurpose, number>
}

export interface DailyStats {
  yesterday: DayNumbers
  /** Null when that day came before the school opened. */
  sameDayLastWeek: DayNumbers | null
  month: { costYuan: number; budgetYuan: number; overBudget: boolean }
  reminders: {
    /** `deadline` is when that day's doors open: a lesson not approved by then becomes a study hall. */
    unreviewed: { date: string; division: Division; deadline: string }[]
    generationFailed: { date: string; division: Division; attempts: number; lastError: string }[]
  }
  /** The days up to yesterday, oldest first. */
  series: SeriesDay[]
  switchChanges: { name: SwitchName; on: boolean; at: string }[]
  /** The school's time zone: the clock the deadlines and the switch changes are read on. */
  timeZone: string
}

export type StatsDays = 7 | 30 | 90

export interface QueueSlot {
  division: Division
  label: string
  status: 'approved' | 'flagged' | 'pending' | 'missing'
  flags: number
  lessonId: number | null
  version: number | null
  topic: string | null
  generationFailed: { attempts: number; lastError: string } | null
  /** A class of the division has begun that day: the lesson can no longer change. */
  locked: boolean
}

export interface LessonQueue {
  mode: 'api' | 'manual'
  /** The school's calendar day today (`YYYY-MM-DD`): a topic can be given from the day after it. */
  today: string
  callOns: { kind: 'review' | 'extension'; afterSegment: number }[]
  days: { date: string; divisions: QueueSlot[] }[]
}

/** The lessons the operator can still act on: not approved, on a day no class of the division has begun. */
export function lessonsToReview(queue: LessonQueue): number {
  return queue.days.flatMap((day) => day.divisions).filter((slot) => slot.status !== 'approved' && !slot.locked)
    .length
}

/** Names one slot of the queue: a day and a division. */
export const slotKey = (date: string, division: Division) => `${date}/${division}`

/** A lesson there to read and approve: made, not approved, on a day still open. */
export const awaitsReview = (slot: QueueSlot) =>
  (slot.status === 'pending' || slot.status === 'flagged') && !slot.locked

/** Every slot of the queue in the order it lists them, with its key and its day. */
export function queueSlots(queue: LessonQueue): { key: string; date: string; slot: QueueSlot }[] {
  return queue.days.flatMap((day) =>
    day.divisions.map((slot) => ({ key: slotKey(day.date, slot.division), date: day.date, slot })),
  )
}

/** The first lesson awaiting review after `from` in the queue's order, starting over at the top; null when none is. */
export function nextToReview(queue: LessonQueue, from: string | null): string | null {
  const slots = queueSlots(queue)
  const start = slots.findIndex((entry) => entry.key === from) + 1
  const next = [...slots.slice(start), ...slots.slice(0, start)].find(
    (entry) => entry.key !== from && awaitsReview(entry.slot),
  )
  return next?.key ?? null
}

/** A place in a lesson: the title, a segment's text or gist (`index` 0-based), or a call-on question. */
export type LessonPart =
  | { part: 'title' }
  | { part: 'segment'; index: number }
  | { part: 'gist'; index: number }
  | { part: 'review' }
  | { part: 'extension' }

export type CallOnKind = 'review' | 'extension'

/**
 * A red mark. `kind` says what hit; `rule` is the word-list word, the anti-trick rule as its line reads, or `隐私信息`
 * for text that looks like private information. `index` is the segment (0-based), null for the parts a lesson has one
 * of.
 */
export interface LessonFlag {
  part: LessonPart['part']
  index: number | null
  kind: 'word' | 'pattern' | 'privacy'
  rule: string
}

export type RewriteKind = 'rewrite_segment' | 'rewrite_lesson' | 'rewrite_call_on'
export type LessonChange = 'generate' | 'edit' | RewriteKind | 'restore' | 'topic'

/** What a rewrite is of: one segment (0-based), one call-on question, or the whole lesson. */
export type RewriteTarget =
  | { kind: 'rewrite_segment'; segmentIndex: number }
  | { kind: 'rewrite_call_on'; callOn: CallOnKind }
  | { kind: 'rewrite_lesson' }

export interface LessonContent {
  title: string
  subject: string
  segments: { text: string; gist: string }[]
  callOnQuestions: { review: string; extension: string } | null
}

/** A saved content of a lesson: what made it, and the reason given for a rewrite. */
export interface LessonVersion {
  version: number
  change: LessonChange
  reason: string | null
  /** The segment a segment rewrite changed (0-based). */
  segmentIndex: number | null
  createdAt: string
}

/** One lesson as `api/lessons/:id` gives it; every write to a lesson answers with it too. */
export interface LessonDetail {
  id: number
  date: string
  division: Division
  subject: string
  title: string
  /** The topic the lesson was made about. */
  topic: string | null
  source: 'api' | 'manual' | 'import'
  /** Moves on with every change, red marks called false positives included. */
  version: number
  approvedAt: string | null
  /** A class of the division has begun that day: the lesson can no longer change. */
  locked: boolean
  content: LessonContent
  flags: LessonFlag[]
  falsePositives: string[]
  /** The saved contents, newest first. */
  versions: LessonVersion[]
}

/** What a prompt is for, and what a reply pasted back in is: a new lesson for a slot, or a rewrite of one. */
export interface PromptTarget {
  kind: 'generate' | RewriteKind
  date: string
  division: Division
  lessonId?: number
  segmentIndex?: number
  callOn?: CallOnKind
  reason?: string
}

export const lessonPath = (id: number) => `api/lessons/${id}`

export const editPart = (lesson: LessonDetail, part: LessonPart, text: string) =>
  request<LessonDetail>('PUT', `${lessonPath(lesson.id)}/parts`, { baseVersion: lesson.version, part, text })
export const rewrite = (lesson: LessonDetail, target: RewriteTarget, reason: string) =>
  request<LessonDetail>('POST', `${lessonPath(lesson.id)}/rewrite`, { baseVersion: lesson.version, ...target, reason })
export const restore = (lesson: LessonDetail, toVersion: number) =>
  request<LessonDetail>('POST', `${lessonPath(lesson.id)}/restore`, { baseVersion: lesson.version, toVersion })
export const markFalsePositive = (lesson: LessonDetail, rule: string) =>
  request<LessonDetail>('POST', `${lessonPath(lesson.id)}/false-positive`, { baseVersion: lesson.version, rule })
export const approve = (lesson: LessonDetail) =>
  request<LessonDetail>('POST', `${lessonPath(lesson.id)}/approve`, { baseVersion: lesson.version })

/** The query is written in a fixed order, each value encoded. */
export function promptPath(target: PromptTarget): string {
  const fields: [string, string | number | undefined][] = [
    ['kind', target.kind],
    ['date', target.date],
    ['division', target.division],
    ['lessonId', target.lessonId],
    ['segmentIndex', target.segmentIndex],
    ['callOn', target.callOn],
    ['reason', target.reason],
  ]
  const query = fields
    .filter((field): field is [string, string | number] => field[1] !== undefined)
    .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
    .join('&')
  return `api/prompts?${query}`
}

export const getPrompt = (target: PromptTarget) => request<{ text: string }>('GET', promptPath(target))

/** A reply pasted in by hand; a rewrite names the version it was made from. Answers with the lesson it made. */
export const paste = (target: PromptTarget & { baseVersion?: number }, pasted: string) =>
  request<LessonDetail>('POST', 'api/lessons/paste', { ...target, pasted })

/** Gives a day's division a topic, or takes it away (`null`). `regenerating`: its lesson is being made again. */
export const putTopic = (date: string, division: Division, topic: string | null) =>
  request<{ result: 'stored' | 'regenerating' }>('PUT', `api/topics/${date}/${division}`, { topic })

export class ApiError extends Error {
  /** 0 when the server could not be reached. */
  readonly status: number
  /** The server's error code, or `network` / `bad_response` when there is no answer from it. */
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

/** What `response.json()` gives for a body that is not JSON. */
const NOT_JSON = Symbol('not JSON')

const sessionListeners = new Set<() => void>()

/** Calls `listener` whenever a request finds the session gone (401). Returns the function that stops it. */
export function onSessionEnded(listener: () => void): () => void {
  sessionListeners.add(listener)
  return () => {
    sessionListeners.delete(listener)
  }
}

export async function request<T>(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { 'X-Requested-With': 'admin' }
  if (body !== undefined) headers['Content-Type'] = 'application/json'

  let response: Response
  try {
    response = await fetch(path, {
      method,
      headers,
      credentials: 'same-origin',
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    throw new ApiError(0, 'network', '连不上服务器，检查网络后再试。')
  }

  const answer: unknown = await response.json().catch(() => NOT_JSON)
  // Every answer of the server is JSON; anything else (a proxy's page, say) is no answer at all.
  if (response.ok && answer !== NOT_JSON) return answer as T

  const error = answer === NOT_JSON ? undefined : (answer as { error?: { code?: unknown; message?: unknown } } | null)?.error
  if (typeof error?.code !== 'string' || typeof error.message !== 'string') {
    throw new ApiError(response.status, 'bad_response', `服务器没有正常回应（${response.status}），稍后再试。`)
  }
  // A refused login is a 401 too, but the session it asks about never began.
  if (response.status === 401 && error.code !== 'admin_login_failed') {
    for (const listener of [...sessionListeners]) listener()
  }
  throw new ApiError(response.status, error.code, error.message)
}

/** A session, and the school's time zone: every time the pages show is on its clock. */
export interface Session {
  expiresAt: string
  timeZone: string
}

export const getSession = () => request<Session>('GET', 'api/session')
export const login = (password: string, code: string) => request<Session>('POST', 'api/login', { password, code })
export const logout = () => request<{ ok: true }>('POST', 'api/logout', {})
export const dailyStatsPath = (days: StatsDays) => `api/stats/daily?days=${days}`
export const LESSON_QUEUE_PATH = 'api/lessons/queue'

export interface Loaded<T> {
  /** The last answer; kept while a new one is read, so a page can hold its frame. */
  data: T | undefined
  error: ApiError | undefined
  loading: boolean
  reload: () => void
  /** Puts in an answer the page already has (what a write answered with), in place of any read still under way. */
  set: (data: T) => void
}

/** Reads `path` with GET, again whenever it changes or `reload` is called. A late answer to an old path is dropped. */
export function useLoad<T>(path: string): Loaded<T> {
  const [data, setData] = useState<T>()
  const [error, setError] = useState<ApiError>()
  const [loading, setLoading] = useState(true)
  const [attempt, setAttempt] = useState(0)
  const latest = useRef(0)

  useEffect(() => {
    const id = ++latest.current
    setLoading(true)
    setError(undefined)
    request<T>('GET', path).then(
      (answer) => {
        if (id !== latest.current) return
        setData(answer)
        setLoading(false)
      },
      // `request` fails with nothing but an ApiError.
      (failure: ApiError) => {
        if (id !== latest.current) return
        setError(failure)
        setLoading(false)
      },
    )
  }, [path, attempt])

  const reload = useCallback(() => setAttempt((n) => n + 1), [])
  const set = useCallback((answer: T) => {
    latest.current++
    setData(answer)
    setError(undefined)
    setLoading(false)
  }, [])
  return { data, error, loading, reload, set }
}

/** A rule of the word list: a word, or an anti-trick (phrase) rule. */
export type RuleKind = 'word' | 'pattern'

/** A student's line, as the weekly review shows it. */
export interface ShownLine {
  messageId: number
  text: string
  at: string
}

/** One week's numbers, Monday to Sunday, as `api/weekly` gives them. */
export interface WeeklyStats {
  weekStart: string
  callOn: {
    /** Answered over called, 0 to 1. */
    rate: number
    byDivision: Record<Division, { called: number; answered: number }>
    byPlugin: { type: string; version: string; called: number; answered: number }[]
  }
  questions: { total: number; segmentsWithAnswer: number; segmentsWithout: number }
  reconnects: { type: string; version: string; count: number }[]
  lessons: { studyHallsForUnreviewed: number; edits: number; segmentRewrites: number; lessonRewrites: number }
  teacher: { llmFailures: number; fallbacks: number; blockedLines: number; refusals: number }
  moderation: {
    /** Monday to Sunday. */
    byDay: { date: string; sensitive: number; injection: number; privacy: number; secondLayer: number }[]
    topRules: { rule: string; kind: RuleKind; count: number }[]
    falsePositiveMarks: string[]
    secondLayerChat: ShownLine[]
  }
  students: { newcomers: number; cameBackForSecond: number; dropped: number; suspended: number; expelled: number }
  /** In yuan, to 4 decimal places. */
  cost: { byPurpose: Record<LlmPurpose, number>; perAttendee: number }
}

export interface SuggestedRule {
  kind: RuleKind
  value: string
  examples: ShownLine[]
}

export interface WeeklyPage {
  stats: WeeklyStats
  /** Null before the week is reviewed. An item is null when the model did not make it; `failures` says why. */
  suggestions: {
    removeRules: SuggestedRule[] | null
    directions: string[] | null
    failures: { removeRules: string | null; directions: string | null }
  } | null
  /** Every rule dropped so far, the latest first. */
  exclusions: { kind: RuleKind; value: string; createdAt: string }[]
}

/** The week starting on Monday `weekStart`; without one, the last week that has ended. */
export const weeklyPath = (weekStart?: string) =>
  weekStart === undefined ? 'api/weekly' : `api/weekly?weekStart=${weekStart}`
/** The Mondays of the weeks that have a review, newest first. */
export const WEEKS_PATH = 'api/weekly/weeks'

/** Drops a rule: how many school-rule breaks it took back, and the students whose penalty was lifted. */
export const dropRule = (kind: RuleKind, value: string) =>
  request<{ revoked: number; lifted: number[] }>('POST', 'api/exclusions', { kind, value })

export type StudentStatus = 'pending' | 'waitlisted' | 'active' | 'suspended' | 'dropped' | 'expelled'

/** A student as `api/students/:id` gives it; every action on the student answers with it too. */
export interface Student {
  id: number
  ownerName: string
  aiName: string
  email: string
  aiId: string
  status: StudentStatus
  classId: number | null
  className: string | null
  /** As stored: it may be past, until the nightly job clears it. */
  suspendedUntil: string | null
  registeredAt: string
  registrationIp: string
  schoolRulesVersion: string | null
  lessonsAttended: number
  lastAttendedAt: string | null
}

export type MessageKind = 'chat' | 'question' | 'answer' | 'closing'

export interface StudentMessage {
  id: number
  kind: MessageKind
  text: string
  moderation: BlockCategory | 'second_layer' | null
  matchedTerm: string | null
  delivered: boolean
  ip: string | null
  pluginType: string
  pluginVersion: string
  createdAt: string
  sessionId: number
}

/** A page of messages, newest first; `nextBefore` reads the page before it, null at the first message. */
export interface StudentMessages {
  messages: StudentMessage[]
  nextBefore: number | null
}

export interface StudentRecord {
  id: number
  kind: string
  at: string
  /** What the owner reads for it. */
  text: string
  revoked: boolean
  revokedAt: string | null
  sessionId: number | null
  matchedTerm: string | null
  /** 'admin' for what was done by hand here, null for what the school did. */
  by: 'admin' | null
}

export const studentPath = (id: number) => `api/students/${id}`
export const messagesPath = (id: number, before: number | null) =>
  before === null ? `${studentPath(id)}/messages` : `${studentPath(id)}/messages?before=${before}`
export const recordsPath = (id: number) => `${studentPath(id)}/records`
export const getStudent = (id: number) => request<Student>('GET', studentPath(id))
export const getMessages = (id: number, before: number | null) =>
  request<StudentMessages>('GET', messagesPath(id, before))
export const suspend = (id: number, days: number) => request<Student>('POST', `${studentPath(id)}/suspend`, { days })
export const withdraw = (id: number) => request<Student>('POST', `${studentPath(id)}/withdraw`)
export const liftPenalty = (id: number) => request<Student>('POST', `${studentPath(id)}/lift`)

export interface SwitchState {
  name: SwitchName
  on: boolean
  /** When it was last switched; null while it holds the default of the config. */
  updatedAt: string | null
}

export const SWITCHES_PATH = 'api/switches'
export const setSwitch = (name: SwitchName, on: boolean) => request<SwitchState>('PUT', `api/switches/${name}`, { on })
