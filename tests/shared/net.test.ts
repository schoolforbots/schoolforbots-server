import { describe, expect, test } from 'vitest'
import { inetAddress } from '../../src/shared/net.js'

describe('inetAddress', () => {
  test.each([
    ['127.0.0.1', '127.0.0.1'],
    ['::1', '::1'],
    ['fe80::1%en0', 'fe80::1'],
    ['fe80::1%25', 'fe80::1'],
  ])('keeps the address %s as %s', (raw, ip) => {
    expect(inetAddress(raw)).toBe(ip)
  })

  test.each([undefined, '', 'localhost', '%en0', '999.1.1.1'])('has no address for %j', (raw) => {
    expect(inetAddress(raw)).toBeNull()
  })
})
