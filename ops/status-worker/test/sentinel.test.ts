import { describe, expect, it } from 'vitest'
import {
  decide,
  decideMail,
  type MailState,
  type Manual,
  type Probe,
  type StoredState,
} from '../src/sentinel.js'

const T0 = Date.parse('2026-11-11T00:00:00Z')
const at = (min: number) => new Date(T0 + min * 60_000)
const AUTO: Manual = { maintenance: false, note: null }
const up: Probe = { healthy: true, maintenance: null }
const dead: Probe = { healthy: false, maintenance: null }

interface Run {
  state: StoredState | null
  writes: number
  mails: string[]
}

function runner() {
  const r: Run = { state: null, writes: 0, mails: [] }
  return {
    r,
    step(min: number, probe: Probe, manual = AUTO) {
      const out = decide(r.state, probe, manual, at(min))
      if (out.write) {
        r.writes++
        r.state = out.next
      }
      if (out.mail) r.mails.push(out.mail)
      return out.next
    },
  }
}

describe('decide', () => {
  it('writes once when always healthy, then nothing', () => {
    const { r, step } = runner()
    step(0, up)
    expect(r.writes).toBe(1)
    for (let m = 1; m <= 60; m++) step(m, up)
    expect(r.writes).toBe(1)
    expect(r.mails).toEqual([])
    expect(r.state).toMatchObject({ status: 'ok', message: null, failingSince: null })
  })

  it('records failingSince, clears it on recovery, sends nothing', () => {
    const { r, step } = runner()
    step(0, up)
    step(1, dead)
    expect(r.writes).toBe(2)
    expect(r.state?.failingSince).toBe(at(1).toISOString())
    expect(r.state?.status).toBe('ok')
    step(2, dead)
    expect(r.writes).toBe(2)
    step(3, up)
    expect(r.writes).toBe(3)
    expect(r.state?.failingSince).toBeNull()
    expect(r.mails).toEqual([])
  })

  it('goes down at exactly 5 minutes, mails once, then stays quiet', () => {
    const { r, step } = runner()
    step(0, up)
    step(1, dead)
    step(5, dead)
    expect(r.state?.status).toBe('ok')
    expect(r.mails).toEqual([])
    const n = step(6, dead)
    expect(n.status).toBe('down')
    expect(n.since).toBe(at(6).toISOString())
    expect(n.message).toBe('学校的服务器出了故障，正在抢修。')
    expect(r.mails).toEqual(['down'])
    const writes = r.writes
    for (let m = 7; m < 60; m++) step(m, dead)
    expect(r.writes).toBe(writes)
    expect(r.mails).toEqual(['down'])
  })

  it('recovers from down with one up mail', () => {
    const { r, step } = runner()
    step(0, dead)
    step(5, dead)
    expect(r.mails).toEqual(['down'])
    const n = step(6, up)
    expect(n.status).toBe('ok')
    expect(n.message).toBeNull()
    expect(n.failingSince).toBeNull()
    expect(r.mails).toEqual(['down', 'up'])
    step(7, up)
    expect(r.mails).toEqual(['down', 'up'])
  })

  it('shows the school maintenance message and never goes down in maintenance', () => {
    const { r, step } = runner()
    step(0, up)
    const m: Probe = { healthy: true, maintenance: { message: '升级中' } }
    expect(step(1, m)).toMatchObject({ status: 'maintenance', message: '升级中' })
    const m2: Probe = { healthy: false, maintenance: { message: '升级中' } }
    for (let i = 2; i <= 12; i++) step(i, m2)
    expect(r.state?.status).toBe('maintenance')
    expect(r.mails).toEqual([])
  })

  it('falls back to a default maintenance message', () => {
    const { step } = runner()
    expect(step(0, { healthy: true, maintenance: { message: '' } }).message).toBe('学校正在维护')
  })

  it('stays in maintenance when the school stops answering during it', () => {
    const { r, step } = runner()
    step(0, { healthy: true, maintenance: { message: '升级中' } })
    for (let i = 1; i <= 10; i++) step(i, dead)
    expect(r.state?.status).toBe('maintenance')
    expect(r.mails).toEqual([])
  })

  it('returns to ok without mail when maintenance ends', () => {
    const { r, step } = runner()
    step(0, { healthy: true, maintenance: { message: '升级中' } })
    expect(step(1, up).status).toBe('ok')
    expect(r.mails).toEqual([])
  })

  it('manual maintenance wins; after removal the 5 minutes count from removal', () => {
    const { r, step } = runner()
    const manual = { maintenance: true, note: null }
    step(0, up, manual)
    expect(r.state?.status).toBe('maintenance')
    for (let i = 1; i <= 20; i++) step(i, dead, manual)
    expect(r.state?.status).toBe('maintenance')
    step(21, dead)
    expect(r.state?.failingSince).toBe(at(21).toISOString())
    expect(r.state?.status).toBe('maintenance')
    step(25, dead)
    expect(r.state?.status).toBe('maintenance')
    expect(r.mails).toEqual([])
    step(26, dead)
    expect(r.state?.status).toBe('down')
    expect(r.mails).toEqual(['down'])
  })

  it('counts 5 minutes from the removal of manual maintenance when the school was ok before', () => {
    const { r, step } = runner()
    const manual = { maintenance: true, note: null }
    step(0, up)
    step(1, up, manual)
    step(2, up)
    expect(r.state?.status).toBe('ok')
    step(3, dead)
    expect(r.state?.failingSince).toBe(at(3).toISOString())
    step(7, dead)
    expect(r.mails).toEqual([])
    step(8, dead)
    expect(r.mails).toEqual(['down'])
  })

  it('note replaces maintenance and failure messages; ok has null', () => {
    const { r, step } = runner()
    const note = { maintenance: false, note: '周末搬家' }
    expect(step(0, up, note).message).toBeNull()
    expect(
      step(1, { healthy: true, maintenance: { message: '升级中' } }, note).message,
    ).toBe('周末搬家')
    const m = { maintenance: true, note: '手动说明' }
    expect(step(2, up, m).message).toBe('手动说明')
    step(3, up)
    step(4, dead, note)
    step(10, dead, note)
    expect(r.state).toMatchObject({ status: 'down', message: '周末搬家' })
  })

  it('writes when only the note changes', () => {
    const { r, step } = runner()
    const man = { maintenance: true, note: 'a' }
    step(0, up, man)
    step(1, up, { maintenance: true, note: 'b' })
    expect(r.writes).toBe(2)
  })
})

describe('decideMail', () => {
  const stepper = () => {
    const s = { state: null as MailState | null, writes: 0, mails: [] as string[] }
    return {
      s,
      step(min: number, ok: boolean | null, maint = false) {
        const out = decideMail(s.state, ok, maint, at(min))
        if (out.write) {
          s.writes++
          s.state = out.next
        }
        if (out.mail) s.mails.push(out.mail)
      },
    }
  }

  it('mails once when it breaks, quiet while healthy', () => {
    const { s, step } = stepper()
    step(0, true)
    step(1, true)
    expect(s.writes).toBe(0)
    step(2, false)
    expect(s.mails).toEqual(['mail_down'])
    expect(s.state).toEqual({ badSince: at(2).toISOString(), notifiedAt: at(2).toISOString() })
  })

  it('does not repeat at 59 minutes but does at 60', () => {
    const { s, step } = stepper()
    step(0, false)
    step(59, false)
    expect(s.mails).toEqual(['mail_down'])
    step(60, false)
    expect(s.mails).toEqual(['mail_down', 'mail_down'])
    expect(s.state?.badSince).toBe(at(0).toISOString())
    step(61, false)
    expect(s.mails.length).toBe(2)
  })

  it('mails once on recovery and clears the state', () => {
    const { s, step } = stepper()
    step(0, false)
    step(5, true)
    expect(s.mails).toEqual(['mail_down', 'mail_up'])
    expect(s.state).toEqual({ badSince: null, notifiedAt: null })
    step(6, true)
    expect(s.mails.length).toBe(2)
  })

  it('does nothing when unreadable', () => {
    const { s, step } = stepper()
    step(0, false)
    const w = s.writes
    step(70, null)
    expect(s.writes).toBe(w)
    expect(s.mails).toEqual(['mail_down'])
  })

  it('does nothing in maintenance', () => {
    const { s, step } = stepper()
    step(0, false, true)
    expect(s.mails).toEqual([])
    expect(s.writes).toBe(0)
    step(1, false)
    step(100, true, true)
    expect(s.mails).toEqual(['mail_down'])
  })

  it('leaves status ok while mail is bad: decide ignores mail', () => {
    const { r, step } = runner()
    const mail = decideMail(null, false, false, at(0))
    expect(mail.mail).toBe('mail_down')
    step(0, up)
    step(1, up)
    expect(r.state?.status).toBe('ok')
  })
})
