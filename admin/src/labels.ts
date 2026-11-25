import type {
  BlockCategory,
  BroadcastImportance,
  BroadcastStatus,
  Division,
  LlmPurpose,
  MessageKind,
  NoticeKind,
  NoticeStatus,
  QueueSlot,
  RuleKind,
  Slot,
  StudentStatus,
  SwitchName,
} from './api.js'

// The Chinese names the pages give the API's keys. Object key order is the order they are listed in.

export const DIVISION_NAMES: Record<Division, string> = { primary: '小学部', junior: '初中部', senior: '高中部' }

export const SLOT_NAMES: Record<Slot, string> = { morning: '上午班', afternoon: '下午班', evening: '晚班' }

export const BLOCK_NAMES: Record<BlockCategory, string> = { sensitive: '违规内容', privacy: '隐私', injection: '骗 AI' }

export const PURPOSE_NAMES: Record<LlmPurpose, string> = {
  lesson: '备课',
  answer: '答疑',
  comment: '点评',
  weekly: '每周复盘',
  secondLayerTeacher: '复查老师',
  secondLayerChat: '审查同学',
  wordList: '整理词库',
}

export const SWITCH_NAMES: Record<SwitchName, string> = {
  teacherLlm: '老师用大模型',
  secondLayerTeacher: '第二层·复查老师',
  secondLayerChat: '第二层·审查同学',
}

export const RULE_KIND_NAMES: Record<RuleKind, string> = { word: '词', pattern: '话术规则' }

export const STATUS_NAMES: Record<StudentStatus, string> = {
  pending: '等分班',
  waitlisted: '排队等座位',
  active: '在读',
  suspended: '停课中',
  dropped: '已退学',
  expelled: '已开除',
}

export const MESSAGE_KIND_NAMES: Record<MessageKind, string> = {
  chat: '聊天',
  question: '提问',
  answer: '点名回答',
  closing: '下课前最后一句',
}

export const NOTICE_KIND_NAMES: Record<NoticeKind, string> = { general: '普通', maintenance: '维护' }

export const BROADCAST_STATUS_NAMES: Record<BroadcastStatus, string> = {
  draft: '草稿',
  published: '已发布',
  withdrawn: '已撤回',
}

export const BROADCAST_IMPORTANCE_NAMES: Record<BroadcastImportance, string> = { normal: '普通', important: '重要' }

export const NOTICE_STATUS_NAMES: Record<NoticeStatus, string> = {
  draft: '草稿',
  published: '已发布',
  withdrawn: '已撤下',
}

/**
 * Where a slot of the review queue stands, as its list says it. A day a class of the division has begun is settled:
 * its lesson was taught (已开课), or the day became a study hall (当天已定). `ahead`: the slot's day is past the days the
 * model makes lessons for, so a lesson missing there is not made yet by design (还没到自动生成).
 */
export function slotStatus(slot: QueueSlot, ahead = false): string {
  if (slot.locked) return slot.status === 'approved' ? '已开课' : '当天已定'
  const failed = slot.generationFailed !== null
  switch (slot.status) {
    case 'approved':
      return '已通过'
    case 'flagged':
      return failed ? `红笔 ${slot.flags} 处，重新生成失败` : `红笔 ${slot.flags} 处`
    case 'pending':
      // A lesson there already fails to be made again only for a new topic; the old one waits meanwhile.
      return failed ? '待审，重新生成失败' : '待审'
    case 'missing':
      if (failed) return '生成失败'
      return ahead ? '还没到自动生成' : '待生成'
  }
}

/** A text that ends a sentence, with the full stop it may lack. */
export const sentence = (text: string) => (/[。！？.!?]$/.test(text) ? text : `${text}。`)

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/** `YYYY-MM-DD` as the weekday it falls on: 周二. */
export function weekdayOf(date: string): string {
  return WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()] ?? ''
}

/** `YYYY-MM-DD` as 11 月 3 日（周二）. */
export function dayName(date: string): string {
  const [, month, day] = date.split('-').map(Number)
  return `${month} 月 ${day} 日（${weekdayOf(date)}）`
}

/** `date` (`YYYY-MM-DD`) moved by `days` calendar days. */
export function addDays(date: string, days: number): string {
  const at = new Date(`${date}T00:00:00Z`)
  at.setUTCDate(at.getUTCDate() + days)
  return at.toISOString().slice(0, 10)
}

/** `YYYY-MM-DD` as 11/3 周二, where room is short. */
export function shortDayName(date: string): string {
  const [, month, day] = date.split('-').map(Number)
  return `${month}/${day} ${weekdayOf(date)}`
}

/** An instant as the school's clock reads it (`timeZone`, IANA): its calendar day and its time. */
function onClock(instant: string, timeZone: string): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(instant))
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? ''
  return { date: `${part('year').padStart(4, '0')}-${part('month')}-${part('day')}`, time: `${part('hour')}:${part('minute')}` }
}

/** The calendar day of an instant in `timeZone`, as `YYYY-MM-DD`. */
export const localDay = (instant: string, timeZone: string) => onClock(instant, timeZone).date

/** The time of an instant in `timeZone`, as 09:45. */
export const clockTime = (instant: string, timeZone: string) => onClock(instant, timeZone).time

/** An instant in `timeZone` as a `datetime-local` field holds it: 2026-11-24T02:00. */
export function clockInput(instant: string, timeZone: string): string {
  const { date, time } = onClock(instant, timeZone)
  return `${date}T${time}`
}

/** `YYYY-MM-DDTHH:mm` read as if it were UTC, in milliseconds; NaN for anything else. */
function asUtc(input: string): number {
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(input)
  if (parts === null) return NaN
  const [year, month, day, hour, minute] = parts.slice(1).map(Number) as [number, number, number, number, number]
  // Date.UTC would read a year below 100 as 19xx; the year is set on its own.
  const at = new Date(Date.UTC(2000, month - 1, day, hour, minute))
  at.setUTCFullYear(year)
  return at.getTime()
}

/**
 * What a `datetime-local` field holds (2026-11-24T02:00), read on the clock of `timeZone`, as the instant it is (UTC
 * ISO, as `toISOString` writes it). Null for anything else, and for a time that clock skips (when it is put forward).
 */
export function instantOf(input: string, timeZone: string): string | null {
  const wanted = asUtc(input)
  if (Number.isNaN(wanted)) return null
  // The zone's offset at a first guess, then at the instant that gives, which settles it across a change of offset.
  let instant = wanted
  for (let i = 0; i < 2; i++) instant += wanted - asUtc(clockInput(new Date(instant).toISOString(), timeZone))
  const iso = new Date(instant).toISOString()
  return clockInput(iso, timeZone) === input ? iso : null
}

/** An instant in `timeZone`, with its year: 2026 年 11 月 4 日 09:45. */
export function moment(instant: string, timeZone: string): string {
  const { date, time } = onClock(instant, timeZone)
  const [year, month, day] = date.split('-').map(Number)
  return `${year} 年 ${month} 月 ${day} 日 ${time}`
}

/** An instant in `timeZone` within a week the page names: 10/27 周二 20:15. */
export function weekMoment(instant: string, timeZone: string): string {
  const { date, time } = onClock(instant, timeZone)
  return `${shortDayName(date)} ${time}`
}

/** An instant in `timeZone` as a day and a time: 11 月 4 日（周三）09:45. */
export function dayMoment(instant: string, timeZone: string): string {
  const { date, time } = onClock(instant, timeZone)
  return `${dayName(date)}${time}`
}

/** A count, with thousands separated: 12,483. */
export const count = (value: number) => value.toLocaleString('zh-CN')
/** Yuan, to the fen. */
export const yuan = (value: number) => `¥${value.toFixed(2)}`
/** Yuan, up to the 4 decimal places the API gives, but at least fen. */
export const preciseYuan = (value: number) => `¥${value.toFixed(4).replace(/(\.\d\d[1-9]*)0+$/, '$1')}`
/** A share from 0 to 1 as a percentage: 75.0%. */
export const percent = (share: number) => `${(share * 100).toFixed(1)}%`
