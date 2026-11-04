import type { BlockCategory, Division, LlmPurpose, Slot, SwitchName } from './api.js'

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

/** `YYYY-MM-DD` as 11/3 周二, where room is short. */
export function shortDayName(date: string): string {
  const [, month, day] = date.split('-').map(Number)
  return `${month}/${day} ${weekdayOf(date)}`
}

/** The calendar day of an instant on this computer's clock, as `YYYY-MM-DD`. */
export function localDay(instant: string): string {
  const at = new Date(instant)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
}

/** The time of an instant on this computer's clock, as 09:45. */
export function clockTime(instant: string): string {
  const at = new Date(instant)
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
}
