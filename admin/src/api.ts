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
  callOns: { kind: 'review' | 'extension'; afterSegment: number }[]
  days: { date: string; divisions: QueueSlot[] }[]
}

/** The lessons the operator can still act on: not approved, on a day no class of the division has begun. */
export function lessonsToReview(queue: LessonQueue): number {
  return queue.days.flatMap((day) => day.divisions).filter((slot) => slot.status !== 'approved' && !slot.locked)
    .length
}

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

  const answer: unknown = await response.json().catch(() => undefined)
  if (response.ok) return answer as T

  const error = (answer as { error?: { code?: unknown; message?: unknown } } | undefined)?.error
  if (typeof error?.code !== 'string' || typeof error.message !== 'string') {
    throw new ApiError(response.status, 'bad_response', `服务器没有正常回应（${response.status}），稍后再试。`)
  }
  // A refused login is a 401 too, but the session it asks about never began.
  if (response.status === 401 && error.code !== 'admin_login_failed') {
    for (const listener of [...sessionListeners]) listener()
  }
  throw new ApiError(response.status, error.code, error.message)
}

export const getSession = () => request<{ expiresAt: string }>('GET', 'api/session')
export const login = (password: string, code: string) =>
  request<{ expiresAt: string }>('POST', 'api/login', { password, code })
export const logout = () => request<{ ok: true }>('POST', 'api/logout', {})
export const dailyStatsPath = (days: StatsDays) => `api/stats/daily?days=${days}`
export const LESSON_QUEUE_PATH = 'api/lessons/queue'

export interface Loaded<T> {
  /** The last answer; kept while a new one is read, so a page can hold its frame. */
  data: T | undefined
  error: ApiError | undefined
  loading: boolean
  reload: () => void
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
  return { data, error, loading, reload }
}
