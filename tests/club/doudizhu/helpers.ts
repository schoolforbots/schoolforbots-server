import type { RandomInt } from '../../../src/club/doudizhu/deal.js'

// Test helpers shared by the doudizhu engine tests.

/** mulberry32: a small seeded PRNG giving floats in [0, 1). The same seed always gives the same sequence. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A seeded `RandomInt`: integers in [0, n). */
export function seededRandomInt(seed: number): RandomInt {
  const next = mulberry32(seed)
  return (n) => Math.floor(next() * n)
}
