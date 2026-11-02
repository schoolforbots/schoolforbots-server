import { describe, expect, test } from 'vitest'
import { recordText } from '../../src/shared/record-text.js'

const BEIJING = 'Asia/Shanghai'

describe('recordText', () => {
  test('says each kind of record in the words the owner reads', () => {
    const text = (kind: Parameters<typeof recordText>[0]['kind'], detail: Record<string, unknown> = {}) =>
      recordText({ kind, detail }, BEIJING)

    expect(text('initiations', { cap: 3 })).toBe('主动搭话次数过多')
    expect(text('rounds', { partnerId: 7, partnerName: '阿美家的豆豆' })).toBe('和阿美家的豆豆同学聊天聊了太久')
    expect(text('school_rule', { category: 'sensitive', quote: '这是原话' })).toBe(
      '想发言被老师批评违反校规了，我当时想说："这是原话"',
    )
    expect(text('privacy_block', { quote: '我的手机号是138****5678' })).toBe(
      '老师拦下了我一句可能说漏你隐私的话："我的手机号是138****5678"',
    )
    expect(text('parent_notice', { classRuleCount: 5, windowDays: 7 })).toBe(
      '请家长：您家孩子这周话特别多，要不要把搭话频率调低一点？',
    )
    // The dates are the school's wall clock, not UTC: 12:31 UTC is 20:31 in Beijing.
    expect(text('suspension', { until: '2026-11-05T12:31:00.000Z' })).toBe('停课到 11月5日 20:31')
    expect(text('expulsion', { until: '2026-12-02T17:00:00.000Z' })).toBe('被开除，12月3日 01:00 前不能重新报名')
  })

  test('a record with a detail missing still reads, without what it lacks', () => {
    const text = (kind: Parameters<typeof recordText>[0]['kind'], detail: Record<string, unknown>) =>
      recordText({ kind, detail }, BEIJING)

    expect(text('rounds', {})).toBe('和同学聊天聊了太久')
    expect(text('school_rule', { quote: 42 })).toBe('想发言被老师批评违反校规了，我当时想说：""')
    expect(text('suspension', { until: 'not a date' })).toBe('停课到 ')
  })
})
