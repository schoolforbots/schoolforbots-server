import type { WsHandshakeConfig } from './config.js'
import { RateWindow } from './rate-window.js'

/** The window `wsHandshake` counts an address's upgrades in, by default: a minute. */
export const HANDSHAKE_WINDOW_MS = 60_000

/** The body of an upgrade refused for coming too often from its address (HTTP 429), in the shape of the 401's. */
export const HANDSHAKE_RATE_LIMITED = {
  error: { code: 'rate_limited', message: '请求太频繁了，请稍后再试。' },
} as const

/**
 * The WebSocket upgrades of each address, counted before anything is read from the database (see `wsHandshake` in the
 * config): an address past `upgradesPerIpPerMinute` upgrades, or with `authFailuresPerIpPerMinute` missing or unknown
 * keys, in the last window, is refused until the window has moved on. What it holds is forgotten as it is used, once
 * every address in it is out of the window.
 *
 * The moments are in milliseconds on a clock that only goes forward, such as `performance.now()`.
 */
export class HandshakeGuard {
  private readonly upgrades: RateWindow<string>
  private readonly failures: RateWindow<string>

  /** What a refused upgrade's `Retry-After` says, in seconds: the window, rounded up. */
  readonly retryAfterSeconds: number

  constructor(limits: WsHandshakeConfig, windowMs: number = HANDSHAKE_WINDOW_MS) {
    this.retryAfterSeconds = Math.ceil(windowMs / 1000)
    this.upgrades = new RateWindow({ limit: limits.upgradesPerIpPerMinute, windowMs })
    this.failures = new RateWindow({ limit: limits.authFailuresPerIpPerMinute, windowMs })
  }

  /** How many entries are held, an address counting once for its upgrades and once for its failed keys. */
  get size(): number {
    return this.upgrades.size + this.failures.size
  }

  /**
   * Whether an upgrade from `ip` at `now` may go on to have its key looked up; when it may, it is counted. One refused
   * is not counted, so an address that keeps trying does not keep itself out longer.
   */
  admit(ip: string, now: number): boolean {
    // A failed key is counted only once its lookup has come back, so the upgrades of one address that arrive together
    // with unknown keys are all looked up: the lookups such a burst gets are bounded by `upgradesPerIpPerMinute`, not
    // by `authFailuresPerIpPerMinute`.
    if (this.failures.full(ip, now)) return false
    return this.upgrades.allow(ip, now)
  }

  /** Counts an upgrade from `ip` at `now` whose key was missing or unknown. */
  failed(ip: string, now: number): void {
    this.failures.add(ip, now)
  }
}
