// A sliding window of moments, kept per key: how many times something happened for each key in the last `windowMs`.
// The moments are the caller's, in milliseconds on any clock that only goes forward (such as `performance.now()`), so
// the window can be tested without waiting.
//
// What it holds stays bounded: a key keeps at most `limit` moments when only `allow` counts, and a key whose every
// moment is out of the window is forgotten, by `sweep` or as the window is used (once a window at the most).

export interface RateWindowOptions {
  /** The most moments a key may have in any window. */
  limit: number
  /** The window's length, in milliseconds. */
  windowMs: number
}

export class RateWindow<K> {
  readonly limit: number
  readonly windowMs: number
  // The moments of each key still in the window, oldest first.
  private readonly moments = new Map<K, number[]>()
  // When the keys out of the window were last forgotten (see `sweepIfDue`).
  private sweptAt: number | null = null

  constructor(options: RateWindowOptions) {
    this.limit = options.limit
    this.windowMs = options.windowMs
  }

  /** How many keys are held. */
  get size(): number {
    return this.moments.size
  }

  /** Whether `key` may have one more moment at `now`; when it may, the moment is counted. One refused is not. */
  allow(key: K, now: number): boolean {
    if (this.full(key, now)) return false
    this.add(key, now)
    return true
  }

  /** Whether `key` has `limit` moments or more in the window that ends at `now`. Nothing is counted. */
  full(key: K, now: number): boolean {
    this.sweepIfDue(now)
    const list = this.moments.get(key)
    if (list === undefined) return false
    this.drop(list, now)
    if (list.length === 0) {
      this.moments.delete(key)
      return false
    }
    return list.length >= this.limit
  }

  /** Counts a moment of `key` at `now`, whether or not it has its `limit` already. */
  add(key: K, now: number): void {
    this.sweepIfDue(now)
    const list = this.moments.get(key)
    if (list === undefined) {
      this.moments.set(key, [now])
      return
    }
    this.drop(list, now)
    list.push(now)
  }

  /** Forgets every key whose moments are all out of the window that ends at `now`. */
  sweep(now: number): void {
    this.sweptAt = now
    for (const [key, list] of this.moments) {
      const last = list[list.length - 1]
      if (last === undefined || now - last >= this.windowMs) this.moments.delete(key)
    }
  }

  // Sweeps when a window has gone by since the last sweep: the keys nobody uses again do not pile up.
  private sweepIfDue(now: number): void {
    if (this.sweptAt === null) this.sweptAt = now
    else if (now - this.sweptAt >= this.windowMs) this.sweep(now)
  }

  // Drops the moments of `list` out of the window that ends at `now`.
  private drop(list: number[], now: number): void {
    while (list.length > 0 && now - (list[0] ?? now) >= this.windowMs) list.shift()
  }
}
