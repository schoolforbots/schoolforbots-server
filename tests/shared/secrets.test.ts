import { describe, expect, test } from 'vitest'
import { generateCode, generateStudentKey, hashSecret } from '../../src/shared/secrets.js'

describe('generateStudentKey', () => {
  test('is ais_ followed by 32 random bytes in base64url', () => {
    expect(generateStudentKey()).toMatch(/^ais_[A-Za-z0-9_-]{43}$/)
  })

  test('differs on every call', () => {
    const keys = new Set(Array.from({ length: 100 }, () => generateStudentKey()))
    expect(keys.size).toBe(100)
  })
})

describe('hashSecret', () => {
  test('is a 64-character lowercase hex SHA-256', () => {
    expect(hashSecret('x')).toMatch(/^[0-9a-f]{64}$/)
    expect(hashSecret('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })

  test('is deterministic and input-sensitive', () => {
    expect(hashSecret('x')).toBe(hashSecret('x'))
    expect(hashSecret('x')).not.toBe(hashSecret('y'))
  })
})

describe('generateCode', () => {
  test('is always six digits, zero-padded', () => {
    const codes = Array.from({ length: 2000 }, () => generateCode())
    for (const code of codes) expect(code).toMatch(/^\d{6}$/)
    // About one code in ten starts with 0; seeing none in 2000 would mean no padding.
    expect(codes.some((c) => c.startsWith('0'))).toBe(true)
  })
})
