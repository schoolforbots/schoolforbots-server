import { describe, expect, test } from 'vitest'
import { bankLeftAt, deadlineOf, dueAt, shownSeconds, stepLimitMs } from '../../src/club/doudizhu-clock.js'
import { DEFAULT_DOUDIZHU_RULES } from '../../src/club/doudizhu/index.js'

const rules = { ...DEFAULT_DOUDIZHU_RULES, bidSeconds: 15, playSeconds: 25 }

describe('the clock of a step', () => {
  test('a bid has the bid limit, a play or a pass the play limit', () => {
    expect(stepLimitMs(rules, 'bidding')).toBe(15_000)
    expect(stepLimitMs(rules, 'playing')).toBe(25_000)
    expect(deadlineOf(1_000, 15_000)).toBe(16_000)
  })

  test('the bank is all there up to the deadline, then runs down to the millisecond, and never below 0', () => {
    const deadline = 100_000
    expect(bankLeftAt(30_000, deadline, 50_000)).toBe(30_000)
    expect(bankLeftAt(30_000, deadline, deadline)).toBe(30_000)
    expect(bankLeftAt(30_000, deadline, deadline + 1)).toBe(29_999)
    expect(bankLeftAt(30_000, deadline, deadline + 12_345)).toBe(17_655)
    expect(bankLeftAt(30_000, deadline, deadline + 30_000)).toBe(0)
    expect(bankLeftAt(30_000, deadline, deadline + 99_000)).toBe(0)
    expect(bankLeftAt(0, deadline, deadline + 1)).toBe(0)
  })

  test('a step is due when the bank runs out, or at the deadline in trusteeship', () => {
    expect(dueAt(100_000, 30_000, false)).toBe(130_000)
    expect(dueAt(100_000, 0, false)).toBe(100_000)
    expect(dueAt(100_000, 30_000, true)).toBe(100_000)
  })

  test('the bank is shown in whole seconds, rounded down', () => {
    expect(shownSeconds(30_000)).toBe(30)
    expect(shownSeconds(29_999)).toBe(29)
    expect(shownSeconds(999)).toBe(0)
    expect(shownSeconds(0)).toBe(0)
    expect(shownSeconds(-5)).toBe(0)
  })
})
