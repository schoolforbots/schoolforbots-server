import { describe, expect, test } from 'vitest'
import { percentile, summarize, verdict, type Report, type Samples } from '../../src/tools/sim-report.js'

describe('percentile (nearest rank)', () => {
  test('is null for no values', () => {
    expect(percentile([], 99)).toBeNull()
  })

  test('is the one value for one value, whatever p is', () => {
    for (const p of [0, 50, 99, 100]) expect(percentile([42], p)).toBe(42)
  })

  test('takes the value at rank ceil(p/100 * n) of the sorted list, never an in-between value', () => {
    // p99 of two values lies between them: the larger one is taken.
    expect(percentile([10, 20], 99)).toBe(20)
    expect(percentile([20, 10], 50)).toBe(10)
    const hundred = Array.from({ length: 100 }, (_, i) => i + 1)
    expect(percentile(hundred, 99)).toBe(99)
    expect(percentile(hundred, 50)).toBe(50)
    expect(percentile(hundred, 100)).toBe(100)
    expect(percentile(hundred, 0)).toBe(1)
    // 101 values: p99 is rank 100.
    expect(percentile([...hundred, 101], 99)).toBe(100)
  })

  test('does not reorder its input', () => {
    const values = [3, 1, 2]
    percentile(values, 50)
    expect(values).toEqual([3, 1, 2])
  })

  test('refuses a p outside 0 to 100', () => {
    expect(() => percentile([1], 101)).toThrow(RangeError)
    expect(() => percentile([1], -1)).toThrow(RangeError)
  })
})

describe('summarize', () => {
  test('counts and gives the percentiles and the maximum of each list', () => {
    const samples: Samples = {
      segmentMs: [5, 1, 3],
      chatMs: [],
      unexpectedDisconnects: 2,
      errors: { initiation_cap: 4 },
    }
    expect(summarize(samples)).toEqual({
      segment: { count: 3, p50: 3, p90: 5, p99: 5, max: 5 },
      chat: { count: 0, p50: null, p90: null, p99: null, max: null },
      unexpectedDisconnects: 2,
      errors: { initiation_cap: 4 },
    })
  })
})

describe('verdict', () => {
  const report = (over: Partial<Report> = {}): Report => ({
    ...summarize({
      segmentMs: [100, 5000],
      chatMs: [10, 1000],
      unexpectedDisconnects: 0,
      errors: {},
    }),
    ...over,
  })

  test('passes exactly on the line', () => {
    expect(verdict(report(), { segmentMs: 5000, chatMs: 1000 })).toEqual({
      pass: true,
      failures: [],
    })
  })

  test('fails one millisecond over, and says which', () => {
    const slow = summarize({
      segmentMs: [100, 5001],
      chatMs: [10, 1001],
      unexpectedDisconnects: 0,
      errors: {},
    })
    const result = verdict(slow, { segmentMs: 5000, chatMs: 1000 })
    expect(result.pass).toBe(false)
    expect(result.failures).toHaveLength(2)
    expect(result.failures[0]).toContain('课文延迟')
    expect(result.failures[1]).toContain('搭话延迟')
    expect(verdict(slow, { segmentMs: 5000 }).failures).toHaveLength(1)
  })

  test('fails on one unexpected disconnect, with or without limits', () => {
    const dropped = report({ unexpectedDisconnects: 1 })
    expect(verdict(dropped, { segmentMs: 5000, chatMs: 1000 })).toMatchObject({
      pass: false,
    })
    expect(verdict(dropped, {}).failures).toEqual(['有 1 次意外断开'])
  })

  test('checks only the limits it is given', () => {
    expect(verdict(report(), {})).toEqual({ pass: true, failures: [] })
  })

  test('a limit with no samples to measure fails', () => {
    const empty = summarize({
      segmentMs: [],
      chatMs: [],
      unexpectedDisconnects: 0,
      errors: {},
    })
    expect(verdict(empty, { segmentMs: 5000 }).pass).toBe(false)
    expect(verdict(empty, {}).pass).toBe(true)
  })
})
