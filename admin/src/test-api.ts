import { render } from '@testing-library/react'
import { ConfigProvider } from 'antd'
import { createElement, type ReactElement, type ReactNode } from 'react'
import { vi } from 'vitest'
import type {
  DailyStats,
  DayNumbers,
  LessonDetail,
  LessonQueue,
  QueueSlot,
  SeriesDay,
  Session,
  Student,
  StudentMessage,
  StudentRecord,
  SwitchState,
  WeeklyPage,
  WeeklyStats,
} from './api.js'
import { antdSettings } from './theme.js'

/** Renders `ui` inside the same Ant Design settings as the real pages. */
export function show(ui: ReactElement) {
  return render(ui, {
    wrapper: ({ children }: { children: ReactNode }) => createElement(ConfigProvider, antdSettings, children),
  })
}

/** A request the page sent, as the fake server saw it. */
export interface Call {
  method: string
  path: string
  headers: Record<string, string>
  credentials: RequestCredentials | undefined
  body: unknown
}

export type Reply = { status: number; body?: unknown; raw?: string } | { networkError: true } | { pending: true }
export type Route = Reply | ((call: Call) => Reply)

export const ok = (body: unknown): Reply => ({ status: 200, body })
export const fail = (status: number, code: string, message: string): Reply => ({
  status,
  body: { error: { code, message } },
})

/**
 * Replaces `fetch` with a server that answers from `routes`, keyed `METHOD path` (the path as the page wrote it,
 * query included). A route not listed answers 404. Every call is recorded in `calls`.
 */
export function fakeServer(routes: Record<string, Route>) {
  const calls: Call[] = []
  const fetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const call: Call = {
      method: init.method ?? 'GET',
      path: String(input),
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      credentials: init.credentials,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    }
    calls.push(call)
    const route = routes[`${call.method} ${call.path}`]
    const found = route ?? fail(404, 'not_found', '没有找到对应的记录。')
    const reply = typeof found === 'function' ? found(call) : found
    if ('networkError' in reply) throw new TypeError('Failed to fetch')
    if ('pending' in reply) return new Promise<Response>(() => {})
    const text = reply.raw ?? (reply.body === undefined ? null : JSON.stringify(reply.body))
    return new Response(text, {
      status: reply.status,
      headers: { 'content-type': reply.raw === undefined ? 'application/json' : 'text/html' },
    })
  })
  vi.stubGlobal('fetch', fetch)
  return { calls, routes }
}

export const YESTERDAY = '2026-11-03'

/** `date` moved by `days` calendar days. */
export function shiftDate(date: string, days: number): string {
  const moment = new Date(`${date}T00:00:00Z`)
  moment.setUTCDate(moment.getUTCDate() + days)
  return moment.toISOString().slice(0, 10)
}

export function dayNumbers(date: string, numbers: Partial<DayNumbers> = {}): DayNumbers {
  return {
    date,
    dau: 0,
    dauBySlot: { morning: 0, afternoon: 0, evening: 0 },
    chat: 0,
    blocked: 0,
    blockedByCategory: { sensitive: 0, injection: 0, privacy: 0 },
    violations: 0,
    suspensions: 0,
    expulsions: 0,
    registrations: 0,
    costYuan: 0,
    ...numbers,
  }
}

export function seriesDay(date: string, numbers: Partial<SeriesDay> = {}): SeriesDay {
  return {
    date,
    dauBySlot: { morning: 0, afternoon: 0, evening: 0 },
    chat: 0,
    blockedByCategory: { sensitive: 0, injection: 0, privacy: 0 },
    costByPurpose: {
      lesson: 0,
      answer: 0,
      comment: 0,
      weekly: 0,
      secondLayerTeacher: 0,
      secondLayerChat: 0,
      wordList: 0,
    },
    ...numbers,
  }
}

/** The answer of `api/stats/daily` for `days` days ending yesterday, all zeros unless `stats` says otherwise. */
export function dailyStats(days: number, stats: Partial<DailyStats> = {}): DailyStats {
  return {
    yesterday: dayNumbers(YESTERDAY),
    sameDayLastWeek: dayNumbers(shiftDate(YESTERDAY, -7)),
    month: { costYuan: 0, budgetYuan: 300, overBudget: false },
    reminders: { unreviewed: [], generationFailed: [] },
    series: Array.from({ length: days }, (_, i) => seriesDay(shiftDate(YESTERDAY, i - days + 1))),
    switchChanges: [],
    timeZone: 'Asia/Shanghai',
    ...stats,
  }
}

export function queueSlot(division: QueueSlot['division'], slot: Partial<QueueSlot> = {}): QueueSlot {
  const labels = { primary: '小学部', junior: '初中部', senior: '高中部' }
  return {
    division,
    label: labels[division],
    status: 'approved',
    flags: 0,
    lessonId: 1,
    version: 1,
    topic: null,
    generationFailed: null,
    locked: false,
    ...slot,
  }
}

export function lessonQueue(days: LessonQueue['days'] = []): LessonQueue {
  return {
    mode: 'api',
    today: '2026-11-04',
    callOns: [
      { kind: 'review', afterSegment: 2 },
      { kind: 'extension', afterSegment: 4 },
    ],
    days,
  }
}

/** A lesson of five segments with both call-on questions, version 1, not approved, no red marks. */
export function lessonDetail(lesson: Partial<LessonDetail> = {}): LessonDetail {
  const detail: LessonDetail = {
    id: 1,
    date: '2026-11-05',
    division: 'primary',
    subject: '自然',
    title: '秋天的叶子为什么会变色',
    topic: null,
    source: 'api',
    version: 1,
    approvedAt: null,
    locked: false,
    content: {
      title: '秋天的叶子为什么会变色',
      subject: '自然',
      segments: [
        { text: '天气变冷以后，叶子里的叶绿素慢慢分解，绿色就退了。', gist: '绿色退去是叶绿素分解了' },
        { text: '叶子里本来就有黄色的胡萝卜素，夏天被绿色盖住了。', gist: '黄色一直都在' },
        { text: '枫叶变红，是因为秋天叶子里生成了花青素。', gist: '红色是秋天新生成的' },
        { text: '树在冬天前落叶，可以少丢一些水分。', gist: '落叶为了保住水分' },
        { text: '落下的叶子烂在土里，又变成树的养料。', gist: '落叶回到土里' },
      ],
      callOnQuestions: { review: '叶子变黄，是因为什么东西分解了？', extension: '为什么松树冬天也不落叶？' },
    },
    flags: [],
    falsePositives: [],
    versions: [
      { version: 1, change: 'generate', reason: null, segmentIndex: null, createdAt: '2026-11-04T16:00:00.000Z' },
    ],
    ...lesson,
  }
  // A title given on its own is the content's title too.
  if (lesson.title !== undefined && lesson.content === undefined) detail.content.title = lesson.title
  return detail
}

export const SESSION: Session = { expiresAt: '2026-11-04T12:00:00.000Z', timeZone: 'Asia/Shanghai' }

/** A week of nothing: every number zero, Monday 26 October to Sunday 1 November. */
export function weeklyStats(stats: Partial<WeeklyStats> = {}): WeeklyStats {
  const monday = '2026-10-26'
  return {
    weekStart: monday,
    callOn: {
      rate: 0,
      byDivision: { primary: { called: 0, answered: 0 }, junior: { called: 0, answered: 0 }, senior: { called: 0, answered: 0 } },
      byPlugin: [],
    },
    questions: { total: 0, segmentsWithAnswer: 0, segmentsWithout: 0 },
    reconnects: [],
    lessons: { studyHallsForUnreviewed: 0, edits: 0, segmentRewrites: 0, lessonRewrites: 0 },
    teacher: { llmFailures: 0, fallbacks: 0, blockedLines: 0, refusals: 0 },
    moderation: {
      byDay: Array.from({ length: 7 }, (_, i) => ({
        date: shiftDate(monday, i),
        sensitive: 0,
        injection: 0,
        privacy: 0,
        secondLayer: 0,
      })),
      topRules: [],
      falsePositiveMarks: [],
      secondLayerChat: [],
    },
    students: { newcomers: 0, cameBackForSecond: 0, dropped: 0, suspended: 0, expelled: 0 },
    cost: {
      byPurpose: {
        lesson: 0,
        answer: 0,
        comment: 0,
        weekly: 0,
        secondLayerTeacher: 0,
        secondLayerChat: 0,
        wordList: 0,
      },
      perAttendee: 0,
    },
    ...stats,
  }
}

/** The weekly page of a week not reviewed yet, nothing dropped, unless `page` says otherwise. */
export function weeklyPage(page: Partial<WeeklyPage> = {}): WeeklyPage {
  return { stats: weeklyStats(), suggestions: null, exclusions: [], ...page }
}

/** Student 12, in class, nothing against them. */
export function student(fields: Partial<Student> = {}): Student {
  return {
    id: 12,
    ownerName: '王老师',
    aiName: '小鱼',
    email: 'owner@example.com',
    aiId: 'ai-12',
    status: 'active',
    classId: 3,
    className: '初中部晚班 3 班',
    suspendedUntil: null,
    registeredAt: '2026-10-20T12:00:00.000Z',
    registrationIp: '203.0.113.7',
    schoolRulesVersion: '2026-10-01',
    lessonsAttended: 9,
    lastAttendedAt: '2026-11-03T12:30:00.000Z',
    ...fields,
  }
}

export function studentMessage(id: number, fields: Partial<StudentMessage> = {}): StudentMessage {
  return {
    id,
    kind: 'chat',
    text: `第 ${id} 条消息`,
    moderation: null,
    matchedTerm: null,
    delivered: true,
    ip: '203.0.113.7',
    pluginType: 'openclaw',
    pluginVersion: '1.2.0',
    createdAt: '2026-11-03T12:10:00.000Z',
    sessionId: 40,
    ...fields,
  }
}

export function studentRecord(id: number, fields: Partial<StudentRecord> = {}): StudentRecord {
  return {
    id,
    kind: 'school_rule',
    at: '2026-11-03T12:20:00.000Z',
    text: '想发言被老师批评违反校规了，我当时想说："示例"',
    revoked: false,
    revokedAt: null,
    sessionId: 40,
    matchedTerm: '示例违禁词',
    by: null,
    ...fields,
  }
}

/** The three switches as a fresh school has them: the defaults, never switched. */
export function switches(states: Partial<Record<SwitchState['name'], Partial<SwitchState>>> = {}): {
  switches: SwitchState[]
} {
  const defaults: SwitchState[] = [
    { name: 'teacherLlm', on: true, updatedAt: null },
    { name: 'secondLayerTeacher', on: true, updatedAt: null },
    { name: 'secondLayerChat', on: false, updatedAt: null },
  ]
  return { switches: defaults.map((state) => ({ ...state, ...states[state.name] })) }
}
