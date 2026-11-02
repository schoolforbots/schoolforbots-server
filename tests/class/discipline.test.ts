import { randomUUID } from 'node:crypto'
import type { Kysely } from 'kysely'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { applyPenalties, calloutsForWindow, disciplineRecorder } from '../../src/class/discipline.js'
import type { ActiveSession } from '../../src/class/runtime.js'
import { calloutInitiations, calloutRounds, calloutSchoolRule } from '../../src/class/teacher.js'
import { runDailyJob } from '../../src/registration/daily-job.js'
import { displayName } from '../../src/shared/identity.js'
import { addDaysToDate } from '../../src/shared/local-time.js'
import type { Database, DisciplineKind, SessionMember } from '../../src/shared/schema.js'
import { buildTestClassApp } from '../helpers/class-app.js'
import { exampleConfig } from '../helpers/app.js'
import { createTestClock } from '../helpers/clock.js'
import { createTestDb } from '../helpers/db.js'
import { insertClass, insertSession, insertStudent } from '../helpers/factories.js'

const DAY = 24 * 60 * 60_000
const MON = '2026-11-02'
const TUE = '2026-11-03'
const WED = '2026-11-04'

/** A wall-clock time in Beijing (the example config's timezone), `HH:MM` or `HH:MM:SS`, on `date`. */
const at = (time: string, date = MON) => new Date(`${date}T${time.length === 5 ? `${time}:00` : time}+08:00`)
const later = (d: Date, ms: number) => new Date(d.getTime() + ms)

const config = exampleConfig()

let counter = 0

/** The names a seeded student has: `阿N家的小鱼N`. */
function names() {
  const n = ++counter
  return { ownerName: `阿${n}`, aiName: `小鱼${n}`, display: displayName(`阿${n}`, `小鱼${n}`) }
}

// ---- The recorder, the callouts and the penalties, against the database ----

describe('discipline', () => {
  let db: Kysely<Database>
  let destroy: () => Promise<void>
  let clock: ReturnType<typeof createTestClock>

  beforeEach(async () => {
    ;({ db, destroy } = await createTestDb())
    clock = createTestClock(at('20:31'))
  })

  afterEach(async () => {
    await destroy()
  })

  interface Seeded {
    id: number
    email: string
    installId: string
    display: string
  }

  async function seedStudent(classId: number | null, p: { status?: 'active' | 'suspended' | 'dropped'; suspendedUntil?: Date } = {}): Promise<Seeded> {
    const { ownerName, aiName, display } = names()
    const email = `student${counter}@example.com`
    const installId = randomUUID()
    const { id } = await insertStudent(db, {
      ownerName,
      aiName,
      email,
      installId,
      status: p.status ?? 'active',
      classId,
      assignedAt: at('00:00', MON),
      suspendedUntil: p.suspendedUntil ?? null,
    })
    return { id, email, installId, display }
  }

  let classNo = 0
  const seedClass = () => insertClass(db, { classNo: ++classNo })

  /** A session of the class on `date` whose members are `members`; its close is 20:31. */
  async function newSession(classId: number, date: string, members: Seeded[] = []): Promise<ActiveSession> {
    const startsAt = at('20:00', date)
    const endsAt = at('20:30', date)
    const sessionId = await insertSession(db, {
      classId,
      date,
      startsAt,
      endsAt,
      members: members.map((m): SessionMember => ({ studentId: m.id, displayName: m.display })),
    })
    return { sessionId, classId, division: 'junior', slot: 'evening', kind: 'lesson', startsAt, endsAt, closeAt: at('20:31', date) }
  }

  const record = (
    student: { id: number },
    session: ActiveSession,
    kind: DisciplineKind,
    when: Date,
    extra: { detail?: Record<string, unknown>; matchedTerm?: string | null } = {},
  ) =>
    disciplineRecorder.record(db, {
      studentId: student.id,
      sessionId: session.sessionId,
      kind,
      detail: extra.detail ?? {},
      matchedTerm: extra.matchedTerm,
      at: when,
    })

  /** Records one `rounds` event for a pair: one record for each of the two students, at the same moment. */
  async function recordRounds(a: Seeded, b: Seeded, session: ActiveSession, when: Date) {
    await record(a, session, 'rounds', when, { detail: { partnerId: b.id, partnerName: b.display } })
    await record(b, session, 'rounds', when, { detail: { partnerId: a.id, partnerName: a.display } })
  }

  const student = (id: number) =>
    db
      .selectFrom('students')
      .select(['status', 'classId', 'suspendedUntil'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow()

  const recordsOf = (studentId: number, kind: DisciplineKind) =>
    db
      .selectFrom('disciplineRecords')
      .select(['id', 'sessionId', 'detail', 'matchedTerm', 'createdAt', 'revokedAt'])
      .where('studentId', '=', studentId)
      .where('kind', '=', kind)
      .orderBy('id')
      .execute()

  const revokeAll = (studentId: number, kind: DisciplineKind, limit: number) =>
    db
      .updateTable('disciplineRecords')
      .set({ revokedAt: clock.now() })
      .where(
        'id',
        'in',
        db.selectFrom('disciplineRecords').select('id').where('studentId', '=', studentId).where('kind', '=', kind).orderBy('id').limit(limit),
      )
      .execute()

  /** Closes the session: the clock at its close, then the penalties. */
  const close = (session: ActiveSession, cfg = config) => {
    clock.set(session.closeAt)
    return applyPenalties(db, cfg, clock, session)
  }

  const NOTHING = { suspended: [], expelled: [], parentNotices: [] }

  describe('record', () => {
    test('writes a record with its detail, matched term and time', async () => {
      const classId = await seedClass()
      const s = await seedStudent(classId)
      const session = await newSession(classId, MON)

      const written = await record(s, session, 'school_rule', at('20:07'), { detail: { text: 'x' }, matchedTerm: '词' })

      expect(written).toBe(true)
      expect(await recordsOf(s.id, 'school_rule')).toEqual([
        { id: expect.any(Number), sessionId: session.sessionId, detail: { text: 'x' }, matchedTerm: '词', createdAt: at('20:07'), revokedAt: null },
      ])
    })

    test('a school rule broken ten times in one lesson is one record', async () => {
      const classId = await seedClass()
      const s = await seedStudent(classId)
      const session = await newSession(classId, MON)

      const results: boolean[] = []
      for (let i = 0; i < 10; i++) results.push(await record(s, session, 'school_rule', at('20:07'), { matchedTerm: `词${i}` }))

      expect(results).toEqual([true, ...Array<boolean>(9).fill(false)])
      const rows = await recordsOf(s.id, 'school_rule')
      expect(rows).toHaveLength(1)
      expect(rows[0]!.matchedTerm).toBe('词0')
    })

    test('initiations and rounds are once per lesson too, each kind on its own', async () => {
      const classId = await seedClass()
      const s = await seedStudent(classId)
      const session = await newSession(classId, MON)

      expect(await record(s, session, 'initiations', at('20:05'))).toBe(true)
      expect(await record(s, session, 'initiations', at('20:06'))).toBe(false)
      expect(await record(s, session, 'rounds', at('20:07'))).toBe(true)
      expect(await record(s, session, 'rounds', at('20:08'))).toBe(false)
      expect(await record(s, session, 'school_rule', at('20:09'))).toBe(true)
    })

    test('another lesson or another student is recorded again, and the other kinds repeat', async () => {
      const classId = await seedClass()
      const a = await seedStudent(classId)
      const b = await seedStudent(classId)
      const monday = await newSession(classId, MON)
      const tuesday = await newSession(classId, TUE)

      expect(await record(a, monday, 'school_rule', at('20:05'))).toBe(true)
      expect(await record(a, tuesday, 'school_rule', at('20:05', TUE))).toBe(true)
      expect(await record(b, monday, 'school_rule', at('20:05'))).toBe(true)
      expect(await record(a, monday, 'privacy_block', at('20:06'))).toBe(true)
      expect(await record(a, monday, 'privacy_block', at('20:07'))).toBe(true)
      expect(await recordsOf(a.id, 'privacy_block')).toHaveLength(2)
    })

    test('a refused duplicate leaves the transaction usable', async () => {
      const classId = await seedClass()
      const s = await seedStudent(classId)
      const session = await newSession(classId, MON)
      await record(s, session, 'school_rule', at('20:05'))

      await db.transaction().execute(async (trx) => {
        const again = await disciplineRecorder.record(trx, {
          studentId: s.id,
          sessionId: session.sessionId,
          kind: 'school_rule',
          detail: {},
          at: at('20:06'),
        })
        expect(again).toBe(false)
        const other = await disciplineRecorder.record(trx, {
          studentId: s.id,
          sessionId: session.sessionId,
          kind: 'initiations',
          detail: {},
          at: at('20:06'),
        })
        expect(other).toBe(true)
      })

      expect(await recordsOf(s.id, 'initiations')).toHaveLength(1)
    })
  })

  describe('calloutsForWindow', () => {
    test('says nothing when nothing was recorded', async () => {
      const classId = await seedClass()
      const s = await seedStudent(classId)
      const session = await newSession(classId, MON, [s])
      expect(await calloutsForWindow(db, session, at('19:45'), at('20:10'))).toEqual([])
    })

    test('everyone who talked too much is named in one sentence', async () => {
      const classId = await seedClass()
      const [a, b, c] = [await seedStudent(classId), await seedStudent(classId), await seedStudent(classId)] as [Seeded, Seeded, Seeded]
      const session = await newSession(classId, MON, [a, b, c])
      await record(b, session, 'initiations', at('20:06'))
      await record(a, session, 'initiations', at('20:07'))

      expect(await calloutsForWindow(db, session, at('19:45'), at('20:10'))).toEqual([calloutInitiations([b.display, a.display])])
    })

    test('a pair who talked too long is called out once, not once for each of them', async () => {
      const classId = await seedClass()
      const [a, b, c, d] = [
        await seedStudent(classId),
        await seedStudent(classId),
        await seedStudent(classId),
        await seedStudent(classId),
      ] as [Seeded, Seeded, Seeded, Seeded]
      const session = await newSession(classId, MON, [a, b, c, d])
      await recordRounds(a, b, session, at('20:06'))
      await recordRounds(d, c, session, at('20:08'))

      expect(await calloutsForWindow(db, session, at('19:45'), at('20:10'))).toEqual([
        calloutRounds(a.display, b.display),
        calloutRounds(d.display, c.display),
      ])
    })

    test('a school-rule break is one sentence that names no one', async () => {
      const classId = await seedClass()
      const [a, b] = [await seedStudent(classId), await seedStudent(classId)] as [Seeded, Seeded]
      const session = await newSession(classId, MON, [a, b])
      await record(a, session, 'school_rule', at('20:06'), { matchedTerm: '词' })
      await record(b, session, 'school_rule', at('20:07'), { matchedTerm: '词' })

      const lines = await calloutsForWindow(db, session, at('19:45'), at('20:10'))

      expect(lines).toEqual([calloutSchoolRule()])
      expect(lines.join('')).not.toContain(a.display)
    })

    test('a window with all three says initiations, then each pair, then the school rule', async () => {
      const classId = await seedClass()
      const [a, b, c] = [await seedStudent(classId), await seedStudent(classId), await seedStudent(classId)] as [Seeded, Seeded, Seeded]
      const session = await newSession(classId, MON, [a, b, c])
      await record(c, session, 'school_rule', at('20:05'))
      await recordRounds(a, b, session, at('20:06'))
      await record(c, session, 'initiations', at('20:07'))

      expect(await calloutsForWindow(db, session, at('19:45'), at('20:10'))).toEqual([
        calloutInitiations([c.display]),
        calloutRounds(a.display, b.display),
        calloutSchoolRule(),
      ])
    })

    test('only what was recorded in [from, to) of this lesson counts, and not what was revoked', async () => {
      const classId = await seedClass()
      const [a, b, c, d, e] = [
        await seedStudent(classId),
        await seedStudent(classId),
        await seedStudent(classId),
        await seedStudent(classId),
        await seedStudent(classId),
      ] as [Seeded, Seeded, Seeded, Seeded, Seeded]
      const session = await newSession(classId, MON, [a, b, c, d, e])
      const other = await newSession(await seedClass(), MON, [])
      await record(a, session, 'initiations', at('20:09:59.999'))
      await record(b, session, 'initiations', at('20:10'))
      await record(c, session, 'initiations', at('20:05'))
      await record(d, other, 'initiations', at('20:07'))
      await record(e, session, 'initiations', at('20:07'))
      await revokeAll(e.id, 'initiations', 1)

      // [20:05, 20:10): c is in (the window includes its start), a too; b is at the end, d is in another lesson, e is revoked.
      expect(await calloutsForWindow(db, session, at('20:05'), at('20:10'))).toEqual([calloutInitiations([c.display, a.display])])
      // The next window starts where this one ended.
      expect(await calloutsForWindow(db, session, at('20:10'), at('20:15'))).toEqual([calloutInitiations([b.display])])
    })

    test('a pair is not called out again when the second record falls in the next window', async () => {
      const classId = await seedClass()
      const [a, b] = [await seedStudent(classId), await seedStudent(classId)] as [Seeded, Seeded]
      const session = await newSession(classId, MON, [a, b])
      await record(a, session, 'rounds', at('20:09:59.999'), { detail: { partnerId: b.id, partnerName: b.display } })
      await record(b, session, 'rounds', at('20:10'), { detail: { partnerId: a.id, partnerName: a.display } })

      expect(await calloutsForWindow(db, session, at('19:45'), at('20:10'))).toEqual([calloutRounds(a.display, b.display)])
      expect(await calloutsForWindow(db, session, at('20:10'), at('20:15'))).toEqual([])
    })

    test('names come from the members of the lesson, and from the student rows for anyone not among them', async () => {
      const classId = await seedClass()
      const [a, b] = [await seedStudent(classId), await seedStudent(classId)] as [Seeded, Seeded]
      // Only a is on the list, and under the name the lesson opened with.
      const session = await newSession(classId, MON, [{ ...a, display: '开课时的名字' }])
      await record(a, session, 'initiations', at('20:06'))
      await record(b, session, 'initiations', at('20:07'))

      expect(await calloutsForWindow(db, session, at('19:45'), at('20:10'))).toEqual([calloutInitiations(['开课时的名字', b.display])])
    })

    test('asking again for the same window says the same thing', async () => {
      const classId = await seedClass()
      const [a, b] = [await seedStudent(classId), await seedStudent(classId)] as [Seeded, Seeded]
      const session = await newSession(classId, MON, [a, b])
      await recordRounds(a, b, session, at('20:06'))
      const first = await calloutsForWindow(db, session, at('19:45'), at('20:10'))
      expect(await calloutsForWindow(db, session, at('19:45'), at('20:10'))).toEqual(first)
    })
  })

  describe('applyPenalties', () => {
    test('three lessons with a school-rule break suspend the student only after the third closes', async () => {
      const classId = await seedClass()
      const s = await seedStudent(classId)
      const sessions = [await newSession(classId, MON), await newSession(classId, TUE), await newSession(classId, WED)]

      for (const [i, session] of sessions.entries()) {
        const date = addDaysToDate(MON, i)
        await record(s, session, 'school_rule', at('20:10', date))
        // In the middle of the lesson nothing has changed.
        expect(await student(s.id)).toMatchObject({ status: 'active', suspendedUntil: null })
        const report = await close(session)
        if (i < 2) {
          expect(report).toEqual(NOTHING)
          expect(await student(s.id)).toMatchObject({ status: 'active', suspendedUntil: null })
        } else {
          expect(report).toEqual({ ...NOTHING, suspended: [s.id] })
        }
      }

      const until = later(at('20:31', WED), 3 * DAY)
      expect(await student(s.id)).toEqual({ status: 'suspended', classId, suspendedUntil: until })
      expect(await recordsOf(s.id, 'suspension')).toEqual([
        {
          id: expect.any(Number),
          sessionId: sessions[2]!.sessionId,
          detail: { until: until.toISOString() },
          matchedTerm: null,
          createdAt: at('20:31', WED),
          revokedAt: null,
        },
      ])
      expect(await recordsOf(s.id, 'expulsion')).toEqual([])
    })

    test('records that were revoked do not count', async () => {
      const classId = await seedClass()
      const s = await seedStudent(classId)
      const sessions = [await newSession(classId, MON), await newSession(classId, TUE), await newSession(classId, WED)]
      for (const [i, session] of sessions.entries()) await record(s, session, 'school_rule', at('20:10', addDaysToDate(MON, i)))
      await revokeAll(s.id, 'school_rule', 1)

      expect(await close(sessions[2]!)).toEqual(NOTHING)
      expect(await student(s.id)).toMatchObject({ status: 'active', suspendedUntil: null })
    })

    test('only the last 30 days count, the day itself included', async () => {
      const classId = await seedClass()
      const edge = await seedStudent(classId)
      const stale = await seedStudent(classId)
      const now = at('20:31', WED)
      const far = await newSession(classId, '2026-10-05')
      const mid = await newSession(classId, '2026-10-25')
      const session = await newSession(classId, WED)
      // `edge` broke the rule exactly 30 days ago, 10 days ago and today; `stale` did so a millisecond earlier than
      // 30 days ago, 10 days ago and today.
      await record(edge, far, 'school_rule', later(now, -30 * DAY))
      await record(stale, far, 'school_rule', later(now, -30 * DAY - 1))
      for (const s of [edge, stale]) await record(s, mid, 'school_rule', later(now, -10 * DAY))
      for (const s of [edge, stale]) await record(s, session, 'school_rule', at('20:10', WED))

      expect(await close(session)).toEqual({ ...NOTHING, suspended: [edge.id] })
      expect(await student(stale.id)).toMatchObject({ status: 'active' })
    })

    test('only students with a new record in this lesson are looked at', async () => {
      const classId = await seedClass()
      const quiet = await seedStudent(classId)
      const loud = await seedStudent(classId)
      const earlier = [await newSession(classId, MON), await newSession(classId, TUE)]
      for (const [i, e] of earlier.entries()) {
        await record(quiet, e, 'school_rule', at('20:10', addDaysToDate(MON, i)))
        await record(loud, e, 'school_rule', at('20:10', addDaysToDate(MON, i)))
      }
      // `quiet` has a third record, but from another lesson; this lesson only has one from `loud`.
      const third = await newSession(await seedClass(), WED)
      await record(quiet, third, 'school_rule', at('20:10', WED))
      const session = await newSession(classId, WED)
      await record(loud, session, 'school_rule', at('20:10', WED))

      expect(await close(session)).toEqual({ ...NOTHING, suspended: [loud.id] })
      expect(await student(quiet.id)).toMatchObject({ status: 'active' })
    })

    test('class rules alone never suspend again a student back from a suspension; a new school-rule break does', async () => {
      const classId = await seedClass()
      const s = await seedStudent(classId)
      const partner = await seedStudent(classId)
      for (let i = 0; i < 3; i++) {
        const session = await newSession(classId, addDaysToDate(MON, i))
        await record(s, session, 'school_rule', at('20:10', addDaysToDate(MON, i)))
        await close(session)
      }
      expect(await student(s.id)).toMatchObject({ status: 'suspended' })
      // The nightly job lets the student back; the three breaks are still in the 30 days.
      await db.updateTable('students').set({ status: 'active', suspendedUntil: null }).where('id', '=', s.id).execute()

      // Talking too much, then too long: noted and called out, but class rules are never added up into a penalty.
      const talkative = await newSession(classId, addDaysToDate(MON, 7))
      await record(s, talkative, 'initiations', at('20:10', addDaysToDate(MON, 7)))
      expect(await close(talkative)).toEqual(NOTHING)
      const long = await newSession(classId, addDaysToDate(MON, 8))
      await recordRounds(s, partner, long, at('20:10', addDaysToDate(MON, 8)))
      expect(await close(long)).toEqual(NOTHING)
      expect(await student(s.id)).toMatchObject({ status: 'active', suspendedUntil: null })
      expect(await recordsOf(s.id, 'suspension')).toHaveLength(1)

      // A fourth school-rule break in the 30 days suspends the student again.
      const broken = await newSession(classId, addDaysToDate(MON, 9))
      await record(s, broken, 'school_rule', at('20:10', addDaysToDate(MON, 9)))
      expect(await close(broken)).toEqual({ ...NOTHING, suspended: [s.id] })
      expect(await recordsOf(s.id, 'suspension')).toHaveLength(2)
    })

    test('the thresholds and the days come from the config', async () => {
      const classId = await seedClass()
      const s = await seedStudent(classId)
      const sessions = [await newSession(classId, MON), await newSession(classId, TUE)]
      for (const [i, session] of sessions.entries()) await record(s, session, 'school_rule', at('20:10', addDaysToDate(MON, i)))
      const strict = {
        ...config,
        discipline: { ...config.discipline, suspension: { schoolRuleCount: 2, windowDays: 30, days: 5 } },
      }

      expect(await close(sessions[1]!, strict)).toEqual({ ...NOTHING, suspended: [s.id] })
      expect(await student(s.id)).toMatchObject({ status: 'suspended', suspendedUntil: later(at('20:31', TUE), 5 * DAY) })
    })

    test('six lessons with a school-rule break expel the student: no class, bans on the email and the install, 30 days', async () => {
      const classId = await seedClass()
      const s = await seedStudent(classId)
      const other = await seedStudent(classId)
      // The student was suspended once and has been let back, with the date left over from then.
      await db.updateTable('students').set({ status: 'suspended', suspendedUntil: at('00:00', MON) }).where('id', '=', s.id).execute()

      const sessions: ActiveSession[] = []
      for (let i = 0; i < 6; i++) {
        const date = addDaysToDate(MON, i)
        const session = await newSession(classId, date)
        sessions.push(session)
        await record(s, session, 'school_rule', at('20:10', date))
        const report = await close(session)
        if (i < 2) expect(report).toEqual(NOTHING)
        // The third, fourth and fifth suspend it again and again; the sixth expels it.
        else if (i < 5) expect(report).toEqual({ ...NOTHING, suspended: [s.id] })
        else expect(report).toEqual({ ...NOTHING, expelled: [s.id] })
      }

      const closedAt = at('20:31', addDaysToDate(MON, 5))
      expect(await student(s.id)).toEqual({ status: 'expelled', classId: null, suspendedUntil: null })
      const banUntil = later(closedAt, 30 * DAY)
      const bans = await db.selectFrom('bans').select(['email', 'installId', 'until', 'reason', 'createdAt']).execute()
      expect(bans).toHaveLength(2)
      expect(bans).toEqual(
        expect.arrayContaining([
          { email: s.email, installId: null, until: banUntil, reason: 'expelled', createdAt: closedAt },
          { email: null, installId: s.installId, until: banUntil, reason: 'expelled', createdAt: closedAt },
        ]),
      )
      expect(await recordsOf(s.id, 'expulsion')).toEqual([
        {
          id: expect.any(Number),
          sessionId: sessions[5]!.sessionId,
          detail: { until: banUntil.toISOString() },
          matchedTerm: null,
          createdAt: closedAt,
          revokedAt: null,
        },
      ])
      // The sixth lesson expelled instead of suspending.
      expect((await recordsOf(s.id, 'suspension')).map((r) => r.sessionId)).toEqual(
        sessions.slice(2, 5).map((x) => x.sessionId),
      )
      expect(await student(other.id)).toMatchObject({ status: 'active', classId })
    })

    test('the ban lasts as many days as the config says', async () => {
      const classId = await seedClass()
      const s = await seedStudent(classId)
      const sessions = [await newSession(classId, MON), await newSession(classId, TUE)]
      for (const [i, session] of sessions.entries()) await record(s, session, 'school_rule', at('20:10', addDaysToDate(MON, i)))
      const strict = {
        ...config,
        discipline: { ...config.discipline, expulsion: { schoolRuleCount: 2, windowDays: 30, banDays: 45 } },
      }

      expect(await close(sessions[1]!, strict)).toEqual({ ...NOTHING, expelled: [s.id] })
      const bans = await db.selectFrom('bans').select('until').execute()
      expect(bans.map((b) => b.until)).toEqual(Array(2).fill(later(at('20:31', TUE), 45 * DAY)))
    })

    test('a student who is no longer in the class is not penalised', async () => {
      const classId = await seedClass()
      const gone = await seedStudent(null, { status: 'dropped' })
      const sessions = [await newSession(classId, MON), await newSession(classId, TUE), await newSession(classId, WED)]
      for (const [i, session] of sessions.entries()) await record(gone, session, 'school_rule', at('20:10', addDaysToDate(MON, i)))

      expect(await close(sessions[2]!)).toEqual(NOTHING)
      expect(await student(gone.id)).toMatchObject({ status: 'dropped' })
    })

    describe('the parent notice', () => {
      /** A lesson on `date` in which `s` breaks the class rules named in `kinds`. */
      async function lessonWith(classId: number, s: Seeded, partner: Seeded, date: string, kinds: DisciplineKind[]) {
        const session = await newSession(classId, date)
        for (const kind of kinds) {
          const detail = kind === 'rounds' ? { partnerId: partner.id, partnerName: partner.display } : {}
          await record(s, session, kind, at('20:10', date), { detail })
        }
        return session
      }

      test('the fifth class-rule break in 7 days brings one notice, and no second one that week', async () => {
        const classId = await seedClass()
        const s = await seedStudent(classId)
        const partner = await seedStudent(classId)
        const day = (i: number) => addDaysToDate(MON, i)

        expect(await close(await lessonWith(classId, s, partner, day(0), ['initiations', 'rounds']))).toEqual(NOTHING)
        expect(await close(await lessonWith(classId, s, partner, day(1), ['initiations', 'rounds']))).toEqual(NOTHING)
        expect(await recordsOf(s.id, 'parent_notice')).toEqual([])

        // The fifth: 2 + 2 + 1 in three lessons.
        const third = await lessonWith(classId, s, partner, day(2), ['initiations'])
        expect(await close(third)).toEqual({ ...NOTHING, parentNotices: [s.id] })
        expect(await recordsOf(s.id, 'parent_notice')).toEqual([
          {
            id: expect.any(Number),
            sessionId: third.sessionId,
            detail: { classRuleCount: 5, windowDays: 7 },
            matchedTerm: null,
            createdAt: at('20:31', day(2)),
            revokedAt: null,
          },
        ])

        // The sixth, the next day: the week already has its notice.
        expect(await close(await lessonWith(classId, s, partner, day(3), ['rounds']))).toEqual(NOTHING)
        expect(await recordsOf(s.id, 'parent_notice')).toHaveLength(1)
        // Class rules never suspend a student.
        expect(await student(s.id)).toMatchObject({ status: 'active', suspendedUntil: null })
      })

      test('a week after the notice another five bring another', async () => {
        const classId = await seedClass()
        const s = await seedStudent(classId)
        const partner = await seedStudent(classId)
        const day = (i: number) => addDaysToDate(MON, i)
        await close(await lessonWith(classId, s, partner, day(0), ['initiations', 'rounds']))
        await close(await lessonWith(classId, s, partner, day(1), ['initiations', 'rounds']))
        await close(await lessonWith(classId, s, partner, day(2), ['initiations']))
        expect(await recordsOf(s.id, 'parent_notice')).toHaveLength(1)

        // Ten days later the first five are out of the window; the next five start a new count.
        await close(await lessonWith(classId, s, partner, day(10), ['initiations', 'rounds']))
        await close(await lessonWith(classId, s, partner, day(11), ['initiations', 'rounds']))
        expect(await recordsOf(s.id, 'parent_notice')).toHaveLength(1)
        expect(await close(await lessonWith(classId, s, partner, day(12), ['initiations']))).toEqual({
          ...NOTHING,
          parentNotices: [s.id],
        })
        expect(await recordsOf(s.id, 'parent_notice')).toHaveLength(2)
      })

      test('only the last 7 days count, and only initiations and rounds', async () => {
        const classId = await seedClass()
        const s = await seedStudent(classId)
        const partner = await seedStudent(classId)
        const day = (i: number) => addDaysToDate(MON, i)
        // Four class-rule breaks, then three more 10 days later: 3 in the window, 7 in all.
        for (const [i, kinds] of [
          [0, ['initiations', 'rounds']],
          [1, ['initiations', 'rounds']],
          [10, ['initiations']],
          [11, ['initiations']],
          [12, ['rounds']],
        ] as const) {
          expect(await close(await lessonWith(classId, s, partner, day(i), [...kinds]))).toEqual(NOTHING)
        }

        // A school-rule break is not a class rule, and neither is a privacy block: still 3 in the window.
        const last = await newSession(classId, day(13))
        await record(s, last, 'school_rule', at('20:10', day(13)))
        await record(s, last, 'privacy_block', at('20:11', day(13)))
        expect(await close(last)).toEqual(NOTHING)
        expect(await recordsOf(s.id, 'parent_notice')).toEqual([])
      })
    })

    test('running it again for the same lesson changes nothing', async () => {
      const classId = await seedClass()
      const suspended = await seedStudent(classId)
      const expelled = await seedStudent(classId)
      const noticed = await seedStudent(classId)
      const partner = await seedStudent(classId)
      const earlier = [await newSession(classId, MON), await newSession(classId, TUE)]
      for (const [i, e] of earlier.entries()) {
        const date = addDaysToDate(MON, i)
        await record(suspended, e, 'school_rule', at('20:10', date))
        await record(expelled, e, 'school_rule', at('20:10', date))
        await record(noticed, e, 'initiations', at('20:10', date))
        await record(noticed, e, 'rounds', at('20:10', date), { detail: { partnerId: partner.id, partnerName: partner.display } })
      }
      for (let i = 2; i < 5; i++) {
        const e = await newSession(await seedClass(), addDaysToDate(MON, i))
        await record(expelled, e, 'school_rule', at('20:10', addDaysToDate(MON, i)))
      }
      const session = await newSession(classId, addDaysToDate(MON, 5))
      await record(suspended, session, 'school_rule', at('20:10', addDaysToDate(MON, 5)))
      await record(expelled, session, 'school_rule', at('20:10', addDaysToDate(MON, 5)))
      await record(noticed, session, 'initiations', at('20:10', addDaysToDate(MON, 5)))

      const first = await close(session)
      expect(first).toEqual({ suspended: [suspended.id], expelled: [expelled.id], parentNotices: [noticed.id] })
      const snapshot = async () => ({
        students: await db.selectFrom('students').select(['id', 'status', 'classId', 'suspendedUntil']).orderBy('id').execute(),
        records: await db.selectFrom('disciplineRecords').selectAll().orderBy('id').execute(),
        bans: await db.selectFrom('bans').selectAll().orderBy('id').execute(),
      })
      const before = await snapshot()
      expect(before.bans).toHaveLength(2)

      // The service crashed after the penalties and runs the lesson's close again, an hour later.
      clock.set(later(session.closeAt, 60 * 60_000))
      expect(await applyPenalties(db, config, clock, session)).toEqual(NOTHING)
      expect(await snapshot()).toEqual(before)

      // Nor does it suspend again a student the nightly job has let back by the time the lesson is closed again.
      await db.updateTable('students').set({ status: 'active', suspendedUntil: null }).where('id', '=', suspended.id).execute()
      clock.set(later(session.closeAt, 4 * DAY))
      expect(await applyPenalties(db, config, clock, session)).toEqual(NOTHING)
      expect(await student(suspended.id)).toEqual({ status: 'active', classId, suspendedUntil: null })
      expect(await recordsOf(suspended.id, 'suspension')).toHaveLength(1)
    })
  })

  describe('through the nightly job', () => {
    test('a suspended student comes back with no date left over', async () => {
      const classId = await seedClass()
      const s = await seedStudent(classId)
      const sessions = [await newSession(classId, MON), await newSession(classId, TUE), await newSession(classId, WED)]
      for (const [i, session] of sessions.entries()) {
        await record(s, session, 'school_rule', at('20:10', addDaysToDate(MON, i)))
        await close(session)
      }
      expect(await student(s.id)).toMatchObject({ status: 'suspended' })

      // Suspended until Saturday 20:31: Saturday's midnight is too early, Sunday's is not.
      clock.set(at('00:00:05', '2026-11-07'))
      expect(await runDailyJob({ db, config, clock })).toMatchObject({ reinstated: 0 })
      clock.set(at('00:00:05', '2026-11-08'))
      expect(await runDailyJob({ db, config, clock })).toMatchObject({ reinstated: 1 })
      expect(await student(s.id)).toEqual({ status: 'active', classId, suspendedUntil: null })
    })
  })
})

// ---- Review Focus 5: the whole thing, through the lesson runtime and its hooks ----

describe('discipline through the class service', () => {
  type Service = Awaited<ReturnType<typeof buildTestClassApp>>
  let service: Service | undefined

  afterEach(async () => {
    await service?.destroy()
    service = undefined
  })

  /** A student's connection in the class service, as far as these tests need it: what the server sends first. */
  async function firstMessage(s: Service, key: string): Promise<Record<string, any>> {
    let received!: (message: Record<string, any>) => void
    const message = new Promise<Record<string, any>>((resolve) => (received = resolve))
    const ws = await s.app.injectWS(
      '/v1/class',
      { headers: { authorization: `Bearer ${key}` } },
      {
        onInit(socket) {
          socket.once('message', (data) => received(JSON.parse(String(data))))
        },
      },
    )
    try {
      return await message
    } finally {
      ws.terminate()
    }
  }

  test('Review Focus 5: one record a lesson, suspension and expulsion only after the close, back by the nightly job', async () => {
    service = await buildTestClassApp()
    const s = service
    const { db, clock, runtime } = s
    const classId = await insertClass(db, { classNo: 1 })
    const { ownerName, aiName, display } = names()
    const { id, key } = await insertStudent(db, {
      ownerName,
      aiName,
      email: 'jie@example.com',
      installId: '8f2b1c3e-0f4a-4d57-9a64-7a1f4f6d2c11',
      status: 'active',
      classId,
      assignedAt: at('00:00', '2026-11-01'),
    })

    const status = () =>
      db.selectFrom('students').select(['status', 'classId', 'suspendedUntil']).where('id', '=', id).executeTakeFirstOrThrow()
    const records = (kind: DisciplineKind) =>
      db.selectFrom('disciplineRecords').select(['sessionId', 'kind', 'detail']).where('studentId', '=', id).where('kind', '=', kind).orderBy('id').execute()
    const tickAt = async (when: Date) => {
      clock.set(when)
      await runtime.tick()
    }
    const teacherLines = async () =>
      (await db.selectFrom('classEvents').select('payload').where('kind', '=', 'teacher').orderBy('id').execute()).map((e) => e.payload.text)

    /** One evening lesson: opens, the student breaks the school rule ten times at 20:07 (when `breaks`), and it closes. */
    async function lesson(date: string, breaks: boolean) {
      await tickAt(at('19:45', date))
      await tickAt(at('20:05', date))
      if (breaks) {
        const session = runtime.currentSession(classId)!
        const results: boolean[] = []
        for (let i = 0; i < 10; i++) {
          clock.set(at('20:07', date))
          results.push(
            await disciplineRecorder.record(db, {
              studentId: id,
              sessionId: session.sessionId,
              kind: 'school_rule',
              detail: {},
              matchedTerm: `词${i}`,
              at: clock.now(),
            }),
          )
        }
        expect(results.filter(Boolean)).toHaveLength(1)
      }
      await tickAt(at('20:10', date))
      const during = await status()
      await tickAt(at('20:30', date))
      const dismissed = await status()
      await tickAt(at('20:31', date))
      return { during, dismissed, after: await status() }
    }

    // Monday and Tuesday: one record each, nothing else.
    const monday = await lesson(MON, true)
    expect(await records('school_rule')).toHaveLength(1)
    expect([monday.during, monday.dismissed, monday.after]).toEqual(Array(3).fill({ status: 'active', classId, suspendedUntil: null }))
    // The teacher said it once, in the callouts after the break, and named no one.
    expect((await teacherLines()).filter((t) => t === calloutSchoolRule())).toHaveLength(1)
    expect((await teacherLines()).join('')).not.toContain(display)

    const tuesday = await lesson(TUE, true)
    expect(tuesday.after).toEqual({ status: 'active', classId, suspendedUntil: null })
    expect(await records('school_rule')).toHaveLength(2)

    // Wednesday: the status holds through the lesson and the dismissal, and changes when the lesson closes.
    const wednesday = await lesson(WED, true)
    expect(await records('school_rule')).toHaveLength(3)
    expect(wednesday.during).toEqual({ status: 'active', classId, suspendedUntil: null })
    expect(wednesday.dismissed).toEqual({ status: 'active', classId, suspendedUntil: null })
    const until = at('20:31', '2026-11-07')
    expect(wednesday.after).toEqual({ status: 'suspended', classId, suspendedUntil: until })
    expect(await records('suspension')).toEqual([
      { sessionId: expect.any(Number), kind: 'suspension', detail: { until: until.toISOString() } },
    ])

    // During the suspension the connection is refused with the reason.
    clock.set(at('19:50', '2026-11-05'))
    expect(await firstMessage(s, key)).toEqual({
      type: 'closing',
      reason: 'suspended',
      message: '你正在停课，11月7日 20:31 以后才能回来上课。',
    })

    // The nightly job brings the student back once the three days are over, and not before.
    const nightly = async (date: string) => {
      clock.set(at('00:00:05', date))
      return runDailyJob({ db, config: s.config, clock })
    }
    expect(await nightly('2026-11-07')).toMatchObject({ reinstated: 0 })
    expect(await status()).toMatchObject({ status: 'suspended' })
    expect(await nightly('2026-11-08')).toMatchObject({ reinstated: 1 })
    expect(await status()).toEqual({ status: 'active', classId, suspendedUntil: null })

    // The fourth and fifth lessons suspend again; the sixth expels.
    expect((await lesson('2026-11-09', true)).after).toMatchObject({ status: 'suspended' })
    expect(await nightly('2026-11-13')).toMatchObject({ reinstated: 1 })
    expect((await lesson('2026-11-13', true)).after).toMatchObject({ status: 'suspended' })
    expect(await nightly('2026-11-17')).toMatchObject({ reinstated: 1 })
    const sixth = await lesson('2026-11-17', true)
    expect(sixth.during).toEqual({ status: 'active', classId, suspendedUntil: null })
    expect(sixth.dismissed).toEqual({ status: 'active', classId, suspendedUntil: null })
    expect(sixth.after).toEqual({ status: 'expelled', classId: null, suspendedUntil: null })
    expect(await records('school_rule')).toHaveLength(6)
    expect(await records('expulsion')).toHaveLength(1)

    const banUntil = later(at('20:31', '2026-11-17'), 30 * DAY)
    const bans = await db.selectFrom('bans').select(['email', 'installId', 'until', 'reason']).execute()
    expect(bans).toHaveLength(2)
    expect(bans).toEqual(
      expect.arrayContaining([
        { email: 'jie@example.com', installId: null, until: banUntil, reason: 'expelled' },
        { email: null, installId: '8f2b1c3e-0f4a-4d57-9a64-7a1f4f6d2c11', until: banUntil, reason: 'expelled' },
      ]),
    )
  })

  test('the teacher calls out the pair and the talkative ones in the step that follows, and only once', async () => {
    service = await buildTestClassApp()
    const { db, clock, runtime } = service
    const classId = await insertClass(db, { classNo: 1 })
    const a = names()
    const b = names()
    const c = names()
    const mk = (n: ReturnType<typeof names>) => insertStudent(db, { ownerName: n.ownerName, aiName: n.aiName, classId, status: 'active', assignedAt: at('00:00', '2026-11-01') })
    const [sa, sb, sc] = [await mk(a), await mk(b), await mk(c)]

    clock.set(at('20:05'))
    await runtime.tick()
    const session = runtime.currentSession(classId)!
    clock.set(at('20:12'))
    await disciplineRecorder.record(db, { studentId: sa.id, sessionId: session.sessionId, kind: 'rounds', detail: { partnerId: sb.id, partnerName: b.display }, at: clock.now() })
    await disciplineRecorder.record(db, { studentId: sb.id, sessionId: session.sessionId, kind: 'rounds', detail: { partnerId: sa.id, partnerName: a.display }, at: clock.now() })
    await disciplineRecorder.record(db, { studentId: sc.id, sessionId: session.sessionId, kind: 'initiations', detail: {}, at: clock.now() })

    // callouts-2 is at minute 15 and covers [callouts-1 at minute 10, minute 15).
    clock.set(at('20:15'))
    await runtime.tick()
    clock.set(at('20:31'))
    await runtime.tick()

    const lines = (await db.selectFrom('classEvents').select('payload').where('kind', '=', 'teacher').orderBy('seq').execute()).map((e) => e.payload.text)
    expect(lines.filter((t) => t === calloutRounds(a.display, b.display))).toHaveLength(1)
    expect(lines.filter((t) => t === calloutInitiations([c.display]))).toHaveLength(1)
    expect(lines.indexOf(calloutInitiations([c.display]))).toBeLessThan(lines.indexOf(calloutRounds(a.display, b.display)))
  })
})
