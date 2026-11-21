import { describe, expect, test } from 'vitest'
import { HandshakeGuard } from '../../src/shared/ws-handshake.js'

describe('HandshakeGuard', () => {
  const limits = { upgradesPerIpPerMinute: 3, authFailuresPerIpPerMinute: 2 }

  test('lets `upgradesPerIpPerMinute` upgrades of an address through in any window', () => {
    const guard = new HandshakeGuard(limits, 1000)
    expect([0, 10, 20, 30].map((now) => guard.admit('10.0.0.1', now))).toEqual([true, true, true, false])
    // Another address has a window of its own.
    expect(guard.admit('10.0.0.2', 30)).toBe(true)
    // The first upgrade is a window old: one place is free again.
    expect(guard.admit('10.0.0.1', 1000)).toBe(true)
    expect(guard.admit('10.0.0.1', 1005)).toBe(false)
  })

  test('once an address has `authFailuresPerIpPerMinute` failed keys, it is refused until the window passes', () => {
    const guard = new HandshakeGuard({ upgradesPerIpPerMinute: 100, authFailuresPerIpPerMinute: 2 }, 1000)
    expect(guard.admit('10.0.0.1', 0)).toBe(true)
    guard.failed('10.0.0.1', 0)
    expect(guard.admit('10.0.0.1', 10)).toBe(true)
    guard.failed('10.0.0.1', 10)
    expect(guard.admit('10.0.0.1', 20)).toBe(false)
    expect(guard.admit('10.0.0.1', 999)).toBe(false)
    expect(guard.admit('10.0.0.2', 999)).toBe(true)
    // The first failure has left the window: the address may try again.
    expect(guard.admit('10.0.0.1', 1000)).toBe(true)
  })

  test('an upgrade refused for failed keys does not use up the upgrades', () => {
    const guard = new HandshakeGuard({ upgradesPerIpPerMinute: 2, authFailuresPerIpPerMinute: 1 }, 1000)
    expect(guard.admit('10.0.0.1', 0)).toBe(true)
    guard.failed('10.0.0.1', 0)
    for (const now of [100, 200, 300]) expect(guard.admit('10.0.0.1', now)).toBe(false)
    // Out of the failure's window: the upgrade at 0 has left too, and both places are free.
    expect(guard.admit('10.0.0.1', 1000)).toBe(true)
    expect(guard.admit('10.0.0.1', 1001)).toBe(true)
    expect(guard.admit('10.0.0.1', 1002)).toBe(false)
  })

  test('forgets the addresses out of the window as it is used', () => {
    const guard = new HandshakeGuard(limits, 1000)
    for (let i = 0; i < 50; i++) {
      guard.admit(`10.0.1.${i}`, i)
      guard.failed(`10.0.1.${i}`, i)
    }
    // Each address in both windows: its upgrade and its failure.
    expect(guard.size).toBe(100)
    guard.admit('10.0.0.9', 2000)
    expect(guard.size).toBe(1)
  })
})
