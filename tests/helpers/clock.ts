import type { Clock } from '../../src/shared/clock.js'

export function createTestClock(start: Date): Clock & { set(d: Date): void; advance(ms: number): void } {
  let current = start.getTime()
  return {
    now: () => new Date(current),
    set(d: Date) {
      current = d.getTime()
    },
    advance(ms: number) {
      current += ms
    },
  }
}
