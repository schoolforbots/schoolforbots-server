import { describe, expect, test } from 'vitest'
import { RateWindow } from '../../src/shared/rate-window.js'

describe('RateWindow', () => {
  test('lets `limit` through in any window, per key; what it refuses does not count', () => {
    const w = new RateWindow<string>({ limit: 2, windowMs: 1000 })
    expect(w.allow('a', 0)).toBe(true)
    expect(w.allow('a', 100)).toBe(true)
    expect(w.allow('a', 200)).toBe(false)
    expect(w.allow('a', 999)).toBe(false)
    // Another key has a window of its own.
    expect(w.allow('b', 999)).toBe(true)
    // The first moment is a window old: one place is free again, and only one.
    expect(w.allow('a', 1000)).toBe(true)
    expect(w.allow('a', 1050)).toBe(false)
    // The refused ones were not counted: the second moment leaves at 1100.
    expect(w.allow('a', 1100)).toBe(true)
  })

  test('full and add: counting apart from asking', () => {
    const w = new RateWindow<string>({ limit: 2, windowMs: 1000 })
    expect(w.full('x', 0)).toBe(false)
    w.add('x', 0)
    expect(w.full('x', 10)).toBe(false)
    w.add('x', 10)
    expect(w.full('x', 20)).toBe(true)
    // `add` counts even past the limit.
    w.add('x', 30)
    expect(w.full('x', 1005)).toBe(true)
    expect(w.full('x', 1030)).toBe(false)
  })

  test('sweep forgets the keys whose every moment is out of the window', () => {
    const w = new RateWindow<number>({ limit: 5, windowMs: 1000 })
    w.allow(1, 0)
    w.allow(2, 0)
    w.allow(2, 600)
    expect(w.size).toBe(2)
    w.sweep(999)
    expect(w.size).toBe(2)
    w.sweep(1000)
    expect(w.size).toBe(1)
    w.sweep(1600)
    expect(w.size).toBe(0)
  })

  test('the keys out of the window are forgotten as it goes, without a sweep being called', () => {
    const w = new RateWindow<number>({ limit: 5, windowMs: 1000 })
    for (let key = 0; key < 100; key++) w.allow(key, key)
    expect(w.size).toBe(100)
    // A window and more later, one more key: the others are all gone.
    w.allow(1000, 2200)
    expect(w.size).toBe(1)
  })
})
