import { describe, expect, it } from 'vitest'
import { clockInput, instantOf } from './labels.js'

describe('times entered on the school clock', () => {
  it('reads a field on the clock of the zone it is given', () => {
    expect(instantOf('2026-11-24T02:00', 'Asia/Shanghai')).toBe('2026-11-23T18:00:00.000Z')
    expect(instantOf('2026-11-24T02:00', 'America/New_York')).toBe('2026-11-24T07:00:00.000Z')
    // Summer time.
    expect(instantOf('2026-07-01T12:00', 'America/New_York')).toBe('2026-07-01T16:00:00.000Z')
  })

  it('gives null for a time the clock skips, and for what is not a field value', () => {
    expect(instantOf('2026-03-08T02:30', 'America/New_York')).toBeNull()
    expect(instantOf('', 'Asia/Shanghai')).toBeNull()
    expect(instantOf('2026-11-24 02:00', 'Asia/Shanghai')).toBeNull()
    expect(instantOf('2026-02-30T02:00', 'Asia/Shanghai')).toBeNull()
  })

  it('gives one of the two instants of a time the clock shows twice', () => {
    expect(['2026-11-01T05:30:00.000Z', '2026-11-01T06:30:00.000Z']).toContain(
      instantOf('2026-11-01T01:30', 'America/New_York'),
    )
  })

  it('reads years below 100 as they are written, not as 19xx', () => {
    expect(instantOf('0099-01-01T08:00', 'UTC')).toBe('0099-01-01T08:00:00.000Z')
    expect(clockInput('0099-01-01T08:00:00.000Z', 'UTC')).toBe('0099-01-01T08:00')
  })

  it('writes an instant back as the field holds it', () => {
    expect(clockInput('2026-11-23T18:00:00.000Z', 'Asia/Shanghai')).toBe('2026-11-24T02:00')
  })
})
