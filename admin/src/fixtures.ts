// Made-up answers of the admin API, built to the types in api.ts: the tests start from them (through test-api.ts),
// and so does the mock school (mock/school.ts). Plain data, nothing of the test runner.
import type {
  ClubDay,
  DailyStats,
  DoudizhuPage,
  SchoolOverview,
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
  MaintenanceState,
  NoticeView,
  WeeklyPage,
  WeeklyStats,
} from './api.js'

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
    blockedBySecondLayer: 0,
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
/** The school as it stands, empty unless `overview` says otherwise. */
export function schoolOverview(overview: Partial<SchoolOverview> = {}): SchoolOverview {
  const slot = (name: 'morning' | 'afternoon' | 'evening') => ({ slot: name, seated: 0, capacity: 4000, waitlisted: 0, classes: [] })
  return {
    students: { total: 0, pending: 0, waitlisted: 0, active: 0, suspended: 0, dropped: 0, expelled: 0 },
    owners: { inSchool: 0, all: 0 },
    signupsToday: { started: 0, verified: 0 },
    slots: [slot('morning'), slot('afternoon'), slot('evening')],
    classSize: { standard: 100, max: 120 },
    activity: { active: 0, cameThisWeek: 0, droppedTonight: null, droppedWithinWeek: null },
    plugins: [],
    ...overview,
  }
}

export function dailyStats(days: number, stats: Partial<DailyStats> = {}): DailyStats {
  const today = shiftDate(YESTERDAY, 1)
  return {
    overview: schoolOverview(),
    todaySoFar: dayNumbers(today),
    sameTimeLastWeek: dayNumbers(shiftDate(today, -7)),
    // 16:00 at the school (UTC+8), today.
    asOf: `${today}T08:00:00.000Z`,
    todayStatus: { state: 'in_term', breakName: null, schoolDay: true, maintenance: false },
    yesterday: dayNumbers(YESTERDAY),
    sameDayLastWeek: dayNumbers(shiftDate(YESTERDAY, -7)),
    month: { costYuan: 0, budgetYuan: 300, overBudget: false },
    reminders: { unreviewed: [], generationFailed: [] },
    series: Array.from({ length: days }, (_, i) => seriesDay(shiftDate(YESTERDAY, i - days + 1))),
    switchChanges: [],
    timeZone: 'Asia/Shanghai',
    today,
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

/** A queue of these days; a day says `aheadOfGeneration` only when it is. */
export function lessonQueue(
  days: (Omit<LessonQueue['days'][number], 'aheadOfGeneration'> & { aheadOfGeneration?: boolean })[] = [],
): LessonQueue {
  return {
    mode: 'api',
    today: '2026-11-04',
    callOns: [
      { kind: 'review', afterSegment: 2 },
      { kind: 'extension', afterSegment: 4 },
    ],
    days: days.map((d) => ({ ...d, aheadOfGeneration: d.aheadOfGeneration ?? false })),
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
    callOnChecks: [],
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
      attendees: 0,
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

/** What the school says about maintenance: not under it, or since `since` with this `message`. */
export function maintenance(state: Partial<MaintenanceState> | null = null): { maintenance: MaintenanceState | null } {
  return {
    maintenance: state === null ? null : { message: '服务器升级中', since: '2026-11-04T01:00:00.000Z', expectedBackAt: null, ...state },
  }
}

/** Notice 7, a general draft made at 18:00 on 3 November at the school, unless `fields` says otherwise. */
export function notice(fields: Partial<NoticeView> = {}): NoticeView {
  return {
    id: 7,
    title: '期中考试安排',
    body: '下周三期中考试。',
    kind: 'general',
    startsAt: null,
    endsAt: null,
    status: 'draft',
    publishedAt: null,
    updatedAt: null,
    createdAt: '2026-11-03T10:00:00.000Z',
    ...fields,
  }
}

/** One day of the doudizhu club, all zeros unless `numbers` says otherwise. */
export function clubDay(date: string, numbers: Partial<ClubDay> = {}): ClubDay {
  return { date, games: 0, rankedGames: 0, players: 0, newMembers: 0, ...numbers }
}

/** The answer of `api/clubs/doudizhu` for `days` days ending yesterday, empty unless `page` says otherwise. */
export function doudizhuPage(days: number, page: Partial<DoudizhuPage> = {}): DoudizhuPage {
  const today = shiftDate(YESTERDAY, 1)
  return {
    enabled: true,
    members: 0,
    todaySoFar: clubDay(today),
    sameTimeLastWeek: clubDay(shiftDate(today, -7)),
    // 16:00 at the school (UTC+8), today.
    asOf: `${today}T08:00:00.000Z`,
    yesterday: clubDay(YESTERDAY),
    sameDayLastWeek: clubDay(shiftDate(YESTERDAY, -7)),
    series: Array.from({ length: days }, (_, i) => clubDay(shiftDate(YESTERDAY, i - days + 1))),
    week: {
      startsOn: '2026-11-02',
      board: { entries: [], total: 0 },
      conduct: {
        seats: 0,
        timedOut: { seats: 0, times: 0 },
        trustee: { seats: 0, moves: 0 },
        illegal: { seats: 0, moves: 0 },
      },
      sameAddress: { total: 0, games: [] },
      pairs: [],
    },
    timeZone: 'Asia/Shanghai',
    today,
    ...page,
  }
}
