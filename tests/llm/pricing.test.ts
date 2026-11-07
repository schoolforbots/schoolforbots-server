import { describe, expect, test } from 'vitest'
import { costYuan } from '../../src/llm/pricing.js'
import type { ModelPrice } from '../../src/shared/config.js'

const TZ = 'Asia/Shanghai'
const tokens = { input: 1_000_000, cachedInput: 600_000, output: 100_000 }
const base: ModelPrice = { inputYuanPerMillion: 2, cachedInputYuanPerMillion: 0.2, outputYuanPerMillion: 8 }

describe('costYuan', () => {
  test('prices cached input apart', () => {
    expect(costYuan(base, tokens, new Date('2026-11-09T04:00:00Z'), TZ)).toBeCloseTo(0.4 * 2 + 0.6 * 0.2 + 0.1 * 8, 9)
  })

  test('uses the input price for cached tokens when no cached price is set', () => {
    const { cachedInputYuanPerMillion: _unused, ...plain } = base
    expect(costYuan(plain, tokens, new Date('2026-11-09T04:00:00Z'), TZ)).toBeCloseTo(1 * 2 + 0.1 * 8, 9)
  })

  describe('windows', () => {
    const price: ModelPrice = {
      inputYuanPerMillion: 1,
      outputYuanPerMillion: 4,
      windows: [{ inputYuanPerMillion: 2, outputYuanPerMillion: 8, weekdays: [1, 2, 3, 4, 5], from: '09:00', to: '12:00' }],
    }
    const t = { input: 1_000_000, cachedInput: 0, output: 1_000_000 }
    const at = (iso: string) => costYuan(price, t, new Date(iso), TZ)

    test('uses the first window that holds the moment', () => {
      expect(at('2026-11-09T10:00:00+08:00')).toBeCloseTo(10, 9) // Monday 10:00
      expect(at('2026-11-09T12:00:00+08:00')).toBeCloseTo(5, 9) // the end is exclusive
      expect(at('2026-11-09T09:00:00+08:00')).toBeCloseTo(10, 9) // the start is inclusive
      expect(at('2026-11-14T10:00:00+08:00')).toBeCloseTo(5, 9) // Saturday
      expect(at('2026-11-09T01:30:00Z')).toBeCloseTo(10, 9) // Monday 09:30 in Beijing
    })

    test('takes the first of several windows that hold the moment', () => {
      const two: ModelPrice = {
        ...price,
        windows: [
          { inputYuanPerMillion: 3, outputYuanPerMillion: 3, weekdays: [1], from: '09:00', to: '12:00' },
          { inputYuanPerMillion: 9, outputYuanPerMillion: 9, weekdays: [1], from: '09:00', to: '12:00' },
        ],
      }
      expect(costYuan(two, t, new Date('2026-11-09T10:00:00+08:00'), TZ)).toBeCloseTo(6, 9)
    })

    test('a window without a cached price charges cached tokens at its own input price, not the base cached price', () => {
      const p: ModelPrice = { ...price, cachedInputYuanPerMillion: 0.1, windows: [{ ...price.windows![0]!, weekdays: [1] }] }
      expect(costYuan(p, { input: 1_000_000, cachedInput: 1_000_000, output: 0 }, new Date('2026-11-09T10:00:00+08:00'), TZ)).toBeCloseTo(2, 9)
    })
  })

  test('counts at most the input as cached', () => {
    const over = { input: 1_000_000, cachedInput: 5_000_000, output: 0 }
    expect(costYuan(base, over, new Date('2026-11-09T04:00:00Z'), TZ)).toBeCloseTo(0.2, 9)
  })
})
