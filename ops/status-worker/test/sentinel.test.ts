import { describe, expect, it } from 'vitest'
import {
  type ClubState,
  decide,
  decideClub,
  decideMail,
  decideNotices,
  type MailState,
  type Manual,
  type NoticeItem,
  parseNotices,
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

  it('counts towards down once the school is past its expected time by half an hour and still not answering', () => {
    const { r, step } = runner()
    step(0, { healthy: true, maintenance: { message: '升级中', expectedBackAt: at(60).toISOString() } })
    for (let i = 1; i <= 89; i++) step(i, dead)
    expect(r.state).toMatchObject({ status: 'maintenance', message: '升级中', failingSince: null })
    step(90, dead)
    expect(r.state).toMatchObject({ status: 'maintenance', message: '升级中', failingSince: at(90).toISOString() })
    step(94, dead)
    expect(r.mails).toEqual([])
    step(95, dead)
    expect(r.state?.status).toBe('down')
    expect(r.mails).toEqual(['down'])
    step(96, up)
    expect(r.mails).toEqual(['down', 'up'])
  })

  it('with no expected time, counts towards down four hours after the maintenance began', () => {
    const { r, step } = runner()
    step(0, { healthy: true, maintenance: { message: '升级中' } })
    step(1, dead)
    step(239, dead)
    expect(r.state).toMatchObject({ status: 'maintenance', failingSince: null })
    step(240, dead)
    expect(r.state?.failingSince).toBe(at(240).toISOString())
    step(245, dead)
    expect(r.state?.status).toBe('down')
    expect(r.mails).toEqual(['down'])
  })

  it('a later expected time moves the deadline, as long as the school still says it', () => {
    const { r, step } = runner()
    step(0, { healthy: true, maintenance: { message: '升级中', expectedBackAt: at(60).toISOString() } })
    step(50, { healthy: true, maintenance: { message: '升级中', expectedBackAt: at(180).toISOString() } })
    step(51, dead)
    step(209, dead)
    expect(r.state).toMatchObject({ status: 'maintenance', failingSince: null })
    step(210, dead)
    expect(r.state?.failingSince).toBe(at(210).toISOString())
  })

  it('a school that stops answering late in a maintenance still gets half an hour', () => {
    const { r, step } = runner()
    // Answering in maintenance for five hours with no expected time, then stopped for the work.
    for (let i = 0; i <= 300; i += 10) step(i, { healthy: true, maintenance: { message: '升级中' } })
    step(301, dead)
    step(330, dead)
    expect(r.state).toMatchObject({ status: 'maintenance', failingSince: null })
    step(331, dead)
    expect(r.state?.failingSince).toBe(at(331).toISOString())
    step(336, dead)
    expect(r.state?.status).toBe('down')
    expect(r.mails).toEqual(['down'])
  })

  it('a school that answers again in maintenance gets its half hour afresh the next time it stops', () => {
    const { r, step } = runner()
    const m: Probe = { healthy: true, maintenance: { message: '升级中' } }
    step(0, m)
    step(280, dead)
    step(290, m)
    step(300, dead)
    step(329, dead)
    expect(r.state).toMatchObject({ status: 'maintenance', failingSince: null })
    step(330, dead)
    expect(r.state?.failingSince).toBe(at(330).toISOString())
  })

  it('a school still answering in maintenance past its expected time sends nothing', () => {
    const { r, step } = runner()
    const m: Probe = { healthy: true, maintenance: { message: '升级中', expectedBackAt: at(60).toISOString() } }
    for (let i = 0; i <= 600; i += 10) step(i, m)
    expect(r.state).toMatchObject({ status: 'maintenance', failingSince: null })
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

describe('decide: note in the keep-maintenance and counting branches', () => {
  it('applies a note added while a stopped school stays in maintenance', () => {
    const { r, step } = runner()
    step(0, { healthy: true, maintenance: { message: '升级中' } })
    step(1, dead)
    expect(r.state?.message).toBe('升级中')
    step(2, dead, { maintenance: false, note: '新说明' })
    expect(r.state).toMatchObject({ status: 'maintenance', message: '新说明' })
  })

  it('applies a note while counting after manual maintenance was removed', () => {
    const { r, step } = runner()
    step(0, up, { maintenance: true, note: null })
    step(1, dead)
    step(2, dead, { maintenance: false, note: '说明' })
    expect(r.state).toMatchObject({ status: 'maintenance', message: '说明' })
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

describe('decideClub', () => {
  const stepper = () => {
    const s = { state: null as ClubState | null, writes: 0, mails: [] as string[] }
    return {
      s,
      step(min: number, ok: boolean | null, maint = false) {
        const out = decideClub(s.state, ok, maint, at(min))
        if (out.write) {
          s.writes++
          s.state = out.next
        }
        if (out.mail) s.mails.push(out.mail)
      },
    }
  }

  it('is quiet and writes nothing while healthy', () => {
    const { s, step } = stepper()
    for (let m = 0; m < 10; m++) step(m, true)
    expect(s.writes).toBe(0)
    expect(s.mails).toEqual([])
  })

  it('mails only after 5 minutes of failing, once', () => {
    const { s, step } = stepper()
    step(0, false)
    expect(s.state).toEqual({ badSince: at(0).toISOString(), notifiedAt: null })
    for (let m = 1; m <= 4; m++) step(m, false)
    expect(s.mails).toEqual([])
    expect(s.writes).toBe(1)
    step(5, false)
    expect(s.mails).toEqual(['club_down'])
    expect(s.state).toEqual({ badSince: at(0).toISOString(), notifiedAt: at(5).toISOString() })
    step(6, false)
    expect(s.mails).toEqual(['club_down'])
  })

  it('a short failure, such as a restart, mails nothing', () => {
    const { s, step } = stepper()
    step(0, false)
    step(1, false)
    step(2, true)
    expect(s.mails).toEqual([])
    expect(s.state).toEqual({ badSince: null, notifiedAt: null })
    step(3, false)
    step(7, false)
    expect(s.mails).toEqual([])
    step(8, false)
    expect(s.mails).toEqual(['club_down'])
  })

  it('repeats every hour while it stays down, not every minute', () => {
    const { s, step } = stepper()
    step(0, false)
    step(5, false)
    for (let m = 6; m < 65; m++) step(m, false)
    expect(s.mails).toEqual(['club_down'])
    step(65, false)
    expect(s.mails).toEqual(['club_down', 'club_down'])
  })

  it('mails the recovery once, only after a down was mailed', () => {
    const { s, step } = stepper()
    step(0, false)
    step(5, false)
    step(6, true)
    expect(s.mails).toEqual(['club_down', 'club_up'])
    expect(s.state).toEqual({ badSince: null, notifiedAt: null })
    step(7, true)
    expect(s.mails.length).toBe(2)
  })

  it('drops a count not yet mailed when the probe says nothing, and mails nothing', () => {
    const { s, step } = stepper()
    step(0, false)
    step(10, null)
    expect(s.state).toEqual({ badSince: null, notifiedAt: null })
    expect(s.mails).toEqual([])
    const w = s.writes
    step(11, null)
    expect(s.writes).toBe(w)
    step(12, false)
    step(16, false)
    expect(s.mails).toEqual([])
    step(17, false)
    expect(s.mails).toEqual(['club_down'])
  })

  it('keeps a mailed down while the probe says nothing', () => {
    const { s, step } = stepper()
    step(0, false)
    step(5, false)
    const w = s.writes
    step(100, null)
    expect(s.writes).toBe(w)
    step(101, true)
    expect(s.mails).toEqual(['club_down', 'club_up'])
  })

  it('mails nothing in maintenance, and restarts a count not yet mailed', () => {
    const { s, step } = stepper()
    step(0, false)
    step(3, false, true)
    expect(s.state).toEqual({ badSince: null, notifiedAt: null })
    for (let m = 4; m <= 30; m++) step(m, false, true)
    expect(s.mails).toEqual([])
    step(31, false)
    step(35, false)
    expect(s.mails).toEqual([])
    step(36, false)
    expect(s.mails).toEqual(['club_down'])
  })

  it('keeps a mailed down through maintenance, and mails the recovery after it', () => {
    const { s, step } = stepper()
    step(0, false)
    step(5, false)
    step(6, true, true)
    step(200, false, true)
    expect(s.mails).toEqual(['club_down'])
    step(201, true)
    expect(s.mails).toEqual(['club_down', 'club_up'])
  })
})

const notice = (id: number, over: Partial<NoticeItem> = {}): NoticeItem => ({
  id,
  title: `t${id}`,
  body: `b${id}`,
  kind: 'general',
  window: null,
  publishedAt: '2026-11-20T08:00:00.000Z',
  updatedAt: null,
  ...over,
})

describe('parseNotices', () => {
  it('accepts the school answer and keeps only the known fields', () => {
    const m = notice(2, {
      kind: 'maintenance',
      window: { startsAt: '2026-11-23T01:00:00.000Z', endsAt: null },
      updatedAt: '2026-11-21T00:00:00.000Z',
    })
    const out = parseNotices({ notices: [{ ...notice(1), extra: 'x' }, m], more: false })
    expect(out).toEqual([notice(1), m])
  })

  it('accepts an empty list', () => {
    expect(parseNotices({ notices: [], more: false })).toEqual([])
  })

  it('keeps at most 5 items', () => {
    const out = parseNotices({ notices: [1, 2, 3, 4, 5, 6, 7].map((i) => notice(i)), more: true })
    expect(out?.map((n) => n.id)).toEqual([1, 2, 3, 4, 5])
  })

  it.each([
    ['not an object', 'x'],
    ['null', null],
    ['no notices array', { notices: 'x' }],
    ['id not a positive integer', { notices: [notice(0)] }],
    ['id not an integer', { notices: [notice(1.5)] }],
    ['title not a string', { notices: [{ ...notice(1), title: 3 }] }],
    ['body missing', { notices: [{ ...notice(1), body: undefined }] }],
    ['unknown kind', { notices: [{ ...notice(1), kind: 'urgent' }] }],
    ['window without startsAt', { notices: [notice(1, { window: { endsAt: null } as never })] }],
    ['window endsAt a number', { notices: [notice(1, { window: { startsAt: 'a', endsAt: 3 } as never })] }],
    ['publishedAt missing', { notices: [{ ...notice(1), publishedAt: null }] }],
    ['updatedAt a number', { notices: [{ ...notice(1), updatedAt: 1 }] }],
    ['publishedAt not a time', { notices: [{ ...notice(1), publishedAt: '' }] }],
    ['updatedAt not a time', { notices: [{ ...notice(1), updatedAt: 'soon' }] }],
    ['startsAt not a time', { notices: [notice(1, { window: { startsAt: 'x', endsAt: null } })] }],
    ['one bad item among good ones', { notices: [notice(1), { id: 2 }] }],
  ])('rejects an answer with %s', (_name, body) => {
    expect(parseNotices(body)).toBeNull()
  })
})

describe('decideNotices', () => {
  const items = [notice(1)]

  it('stores the first good read', () => {
    expect(decideNotices(null, items, at(0))).toEqual({
      next: { fetchedAt: at(0).toISOString(), items },
      write: true,
    })
  })

  it('keeps nothing when it has never read and the read fails', () => {
    expect(decideNotices(null, null, at(0))).toEqual({ next: null, write: false })
  })

  it('keeps the last copy when the read fails', () => {
    const prev = { fetchedAt: at(0).toISOString(), items }
    expect(decideNotices(prev, null, at(500))).toEqual({ next: prev, write: false })
  })

  it('does not write unchanged items until the copy is an hour old', () => {
    const prev = { fetchedAt: at(0).toISOString(), items }
    expect(decideNotices(prev, [notice(1)], at(59))).toEqual({ next: prev, write: false })
    expect(decideNotices(prev, [notice(1)], at(60))).toEqual({
      next: { fetchedAt: at(60).toISOString(), items },
      write: true,
    })
  })

  it('writes at once when the items change', () => {
    const prev = { fetchedAt: at(0).toISOString(), items }
    const changed = [notice(1, { title: 'new' })]
    expect(decideNotices(prev, changed, at(1))).toEqual({
      next: { fetchedAt: at(1).toISOString(), items: changed },
      write: true,
    })
    expect(decideNotices(prev, [], at(2)).write).toBe(true)
  })
})
