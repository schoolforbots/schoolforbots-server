import type {
  BlockCategory,
  Division,
  LlmPurpose,
  MessageKind,
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

/**
 * Where a slot of the review queue stands, as its list says it. A day a class of the division has begun is settled:
 * its lesson was taught (已开课), or the day became a study hall (当天已定).
 */
export function slotStatus(slot: QueueSlot): string {
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
      return failed ? '生成失败' : '待生成'
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
  return { date: `${part('year')}-${part('month')}-${part('day')}`, time: `${part('hour')}:${part('minute')}` }
}

/** The calendar day of an instant in `timeZone`, as `YYYY-MM-DD`. */
export const localDay = (instant: string, timeZone: string) => onClock(instant, timeZone).date

/** The time of an instant in `timeZone`, as 09:45. */
export const clockTime = (instant: string, timeZone: string) => onClock(instant, timeZone).time

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
