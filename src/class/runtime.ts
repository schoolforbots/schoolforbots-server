import type { Kysely, Transaction } from 'kysely'
import type { Moderator } from '../moderation/moderator.js'
import type { Clock } from '../shared/clock.js'
import type { Division, SchoolConfig, Slot } from '../shared/config.js'
import { lessonLockKey, lock, MEMBER_STATUSES } from '../shared/db.js'
import { displayName } from '../shared/identity.js'
import { atLocalTime, localDate } from '../shared/local-time.js'
import type { Database, LessonSegment, SessionKind, SessionMember } from '../shared/schema.js'
import { appendClassEvent, classEventMessage, NOOP, stepWritten } from './events.js'
import type { LessonHooks } from './hooks.js'
import type { Hub } from './hub.js'
import { planSession } from './planning.js'
import * as teacher from './teacher.js'
import { lessonSteps, type StepName } from './timeline.js'

/** A class session from the moment its doors open until it closes. */
export interface ActiveSession {
  sessionId: number
  classId: number
  division: Division
  slot: Slot
  kind: SessionKind
  startsAt: Date
  /** The dismissal. */
  endsAt: Date
  /** The end of the closing grace period after the dismissal, when the session closes. */
  closeAt: Date
}

export interface ClassRuntime {
  /** Opens the sessions whose doors have opened and runs every step that is due and has not run yet, in order. */
  tick(): Promise<void>
  /** The class's session from its doors until its close, or null. */
  currentSession(classId: number): ActiveSession | null
}

export interface ClassRuntimeDeps {
  db: Kysely<Database>
  config: SchoolConfig
  clock: Clock
  hub: Hub
  /** For the hooks; the runtime's own lines are template lines and approved lesson text. */
  moderator: Moderator
  /** Timeline speed: 1 is real time (see `lessonSteps`). */
  speed: number
  hooks: LessonHooks
  /** A program log line. Only step names and numbers go into it, never what anyone said. */
  log?: (obj: object, msg: string) => void
}

/**
 * How late after a session's close its steps still run live, at real-time speed (the timeline speed divides it): any
 * later, the service was down through the close, and the session is finished quietly. The service ticks well within
 * it, so a close it was up for is never that late.
 */
export const LIVE_TOLERANCE_MS = 30_000

const SLOTS: readonly Slot[] = ['morning', 'afternoon', 'evening']
const DIVISIONS: readonly Division[] = ['primary', 'junior', 'senior']

/** The `closing` message sent to whoever is still connected when the session closes. */
const SESSION_OVER = {
  type: 'closing',
  reason: 'session_over',
  message: '这节课已经下课了，下次上课再见。',
} as const

/** What the teacher calls himself when the class's persona is no longer in the config. */
const FALLBACK_TEACHER = '老师'

interface LessonContent {
  subject: string
  title: string
  segments: LessonSegment[]
}

/** A session the runtime is running, from its doors until its close step has run. */
interface Tracked {
  session: ActiveSession
  date: string
  lessonId: number | null
  teacher: string
  doorsAt: Date
  /** The steps after the doors, in order, with the moment each is due. */
  steps: { step: StepName; at: Date }[]
  /** The steps already run: by this runtime, or (read back after a restart) by an earlier one. */
  done: Set<string>
  lesson?: LessonContent
}

/** An event before it is written: `step` is its key in the session's event log. */
interface PendingEvent {
  step: string
  kind: string
  payload: Record<string, unknown>
}

type Said = Omit<PendingEvent, 'step'>

const teacherLine = (text: string): Said => ({ kind: 'teacher', payload: { kind: 'teacher', text } })

/** Keys the events of one step: the first one carries the step's name, so it marks the step as done. */
const keyed = (base: string, said: Said[]): PendingEvent[] =>
  said.map((s, i) => ({ ...s, step: i === 0 ? base : `${base}#${i + 1}` }))

const before = (a: Date, b: Date) => a.getTime() < b.getTime()

/**
 * Runs the class sessions from the clock: at the doors of a slot it opens a session for every class that has
 * members, and then runs each step of each session once, in order, when it is due. A step writes its events, commits,
 * and only then pushes them to whoever is online. Steps are recorded in the database, so a runtime started after a
 * restart, or a tick that comes late, runs the steps it missed in order and never one that already ran.
 */
export function createClassRuntime(deps: ClassRuntimeDeps): ClassRuntime {
  const { db, config, clock, hub, hooks, speed } = deps
  const log = deps.log ?? (() => {})
  const tracked = new Map<number, Tracked>()
  let loaded = false
  let openedDay: string | null = null
  const openedSlots = new Set<Slot>()
  let running: Promise<void> = Promise.resolve()
  // How late after its close a session's step still runs live, so the close itself (a tick after it) stays live.
  const liveToleranceMs = LIVE_TOLERANCE_MS / speed

  const teacherName = (personaId: string): string =>
    config.teacherPersonas.find((p) => p.id === personaId)?.name ?? FALLBACK_TEACHER

  function timesOf(startsAt: Date, kind: SessionKind) {
    const all = lessonSteps(startsAt, kind, config.lesson, speed)
    const atOf = (name: StepName): Date => {
      const found = all.find((s) => s.step === name)
      if (found === undefined) throw new Error(`The timeline has no ${name} step`)
      return found.at
    }
    return {
      steps: all.filter((s) => s.step !== 'doors'),
      doorsAt: atOf('doors'),
      endsAt: atOf('dismissal'),
      closeAt: atOf('close'),
    }
  }

  // ---- Sessions ----

  /** Starts tracking the sessions not yet dismissed (all of them, or those of one slot on one day). */
  async function loadSessions(filter?: { date: string; slot: Slot }): Promise<void> {
    let query = db
      .selectFrom('classSessions as s')
      .innerJoin('classes as c', 'c.id', 's.classId')
      .select(['s.id', 's.classId', 's.date', 's.slot', 's.kind', 's.lessonId', 's.startsAt', 's.endsAt'])
      .select(['c.division', 'c.teacherPersonaId'])
      .where('s.dismissedAt', 'is', null)
    if (filter !== undefined) query = query.where('s.date', '=', filter.date).where('s.slot', '=', filter.slot)
    const rows = (await query.orderBy('s.startsAt').orderBy('s.id').execute()).filter((r) => !tracked.has(r.id))
    if (rows.length === 0) return

    const written = await db
      .selectFrom('classEvents')
      .select(['sessionId', 'step'])
      .where('sessionId', 'in', rows.map((r) => r.id))
      .execute()
    for (const r of rows) {
      const { steps, doorsAt, closeAt } = timesOf(r.startsAt, r.kind)
      tracked.set(r.id, {
        session: {
          sessionId: r.id,
          classId: r.classId,
          division: r.division,
          slot: r.slot,
          kind: r.kind,
          startsAt: r.startsAt,
          endsAt: r.endsAt,
          closeAt,
        },
        date: r.date,
        lessonId: r.lessonId,
        teacher: teacherName(r.teacherPersonaId),
        doorsAt,
        steps,
        done: new Set(written.filter((w) => w.sessionId === r.id).map((w) => w.step)),
      })
    }
  }

  /**
   * What a division does today, decided inside the transaction that opens the sessions. A lesson is checked again
   * under the importer's lock: the importer may have turned it back into a draft since `planSession` read it, and a
   * draft is never taught. The share lock on its row keeps it as it is until the sessions are written.
   */
  async function decide(
    trx: Transaction<Database>,
    date: string,
    division: Division,
  ): Promise<{ kind: SessionKind; lessonId: number | null }> {
    const plan = await planSession(trx, config, { date, division })
    if (plan.kind === 'study') return { kind: 'study', lessonId: null }
    await lock(trx, lessonLockKey(date, division))
    const lesson = await trx
      .selectFrom('lessons')
      .select('approvedAt')
      .where('id', '=', plan.lessonId)
      .forShare()
      .executeTakeFirst()
    if (lesson === undefined || lesson.approvedAt === null) return { kind: 'study', lessonId: null }
    return { kind: 'lesson', lessonId: plan.lessonId }
  }

  /**
   * Opens the sessions of a slot for every class of it that has members, with who they are, in one transaction:
   * `planSession` reads the sessions already opened that day, so the first one of a division decides for the others.
   */
  async function openSessions(date: string, slot: Slot, startsAt: Date, endsAt: Date): Promise<number> {
    return db.transaction().execute(async (trx) => {
      // One opening at a time per day, so two openings cannot both be "the first of the day".
      await lock(trx, `class-sessions:${date}`)
      const classes = await trx
        .selectFrom('classes')
        .select(['id', 'division'])
        .where('slot', '=', slot)
        .orderBy('id')
        .execute()
      if (classes.length === 0) return 0
      const students = await trx
        .selectFrom('students')
        .select(['id', 'classId', 'ownerName', 'aiName'])
        .where('classId', 'in', classes.map((c) => c.id))
        .where('status', 'in', [...MEMBER_STATUSES])
        .orderBy('id')
        .execute()
      const members = new Map<number, SessionMember[]>()
      for (const s of students) {
        if (s.classId === null) continue
        const list = members.get(s.classId) ?? []
        list.push({ studentId: s.id, displayName: displayName(s.ownerName, s.aiName) })
        members.set(s.classId, list)
      }

      let opened = 0
      for (const division of DIVISIONS) {
        const due = classes.filter((c) => c.division === division && members.has(c.id))
        if (due.length === 0) continue
        const { kind, lessonId } = await decide(trx, date, division)
        const inserted = await trx
          .insertInto('classSessions')
          .values(
            due.map((c) => ({
              classId: c.id,
              date,
              slot,
              kind,
              lessonId,
              startsAt,
              endsAt,
              members: JSON.stringify(members.get(c.id) ?? []),
            })),
          )
          .onConflict((oc) => oc.columns(['classId', 'date']).doNothing())
          .returning('id')
          .execute()
        opened += inserted.length
      }
      return opened
    })
  }

  /** Opens today's slots whose doors have opened and whose close has not come yet, each once. */
  async function openDueSlots(now: Date): Promise<void> {
    const today = localDate(now, config.timezone)
    if (openedDay !== today) {
      openedDay = today
      openedSlots.clear()
    }
    for (const slot of SLOTS) {
      if (openedSlots.has(slot)) continue
      const startsAt = atLocalTime(today, config.slots[slot].start, config.timezone)
      // The doors and the close do not depend on the kind of session.
      const { doorsAt, endsAt, closeAt } = timesOf(startsAt, 'lesson')
      if (before(now, doorsAt) || !before(now, closeAt)) continue
      // Opening again is harmless (a class's session for the day is written once), so a slot only counts as open
      // once its sessions are tracked.
      const opened = await openSessions(today, slot, startsAt, endsAt)
      await loadSessions({ date: today, slot })
      openedSlots.add(slot)
      if (opened > 0) log({ date: today, slot, sessions: opened }, 'class sessions opened')
    }
  }

  /**
   * Whether a step of the session runs live: no later than its close plus a short tolerance (30 seconds of lesson
   * time), and while no later session of its class has opened. A session caught up after that (the service was down
   * through its close) is finished quietly: its steps are written and its after-class work is done, but nothing is
   * pushed, nobody is disconnected or called on, and pending renames are left for the class's next opening.
   */
  function isLive(t: Tracked, now: Date): boolean {
    if (now.getTime() > t.session.closeAt.getTime() + liveToleranceMs) return false
    for (const other of tracked.values()) {
      if (
        other.session.classId === t.session.classId &&
        before(t.session.startsAt, other.session.startsAt) &&
        !before(now, other.doorsAt)
      ) {
        return false
      }
    }
    return true
  }

  // ---- Writing and pushing events ----

  /**
   * Writes events in one transaction and, once it has committed, pushes those the class sees. `build` returns the
   * events, or null to write nothing. Returns the numbers of the events written for the class, or null.
   */
  async function commitAndPush(
    t: Tracked,
    now: Date,
    live: boolean,
    build: (trx: Transaction<Database>) => Promise<PendingEvent[] | null>,
  ): Promise<number[] | null> {
    const { sessionId, classId } = t.session
    const written = await db.transaction().execute(async (trx) => {
      const pending = await build(trx)
      if (pending === null) return null
      const out: (PendingEvent & { seq: number })[] = []
      for (const e of pending) {
        const { step, kind, payload } = e
        const result = await appendClassEvent(trx, { sessionId, step, kind, payload, at: now })
        if (result !== null && e.kind !== NOOP) out.push({ ...e, seq: result.seq })
      }
      return out
    })
    if (written === null) return null
    for (const e of written) {
      t.done.add(e.step)
      if (live) hub.broadcast(classId, classEventMessage({ ...e, at: now }, false))
    }
    return written.map((e) => e.seq)
  }

  /** The renames in the class not yet announced, as events, marked announced as of `now`. */
  async function renameEvents(trx: Transaction<Database>, t: Tracked, now: Date): Promise<PendingEvent[]> {
    const renames = await trx
      .selectFrom('renameEvents')
      .select(['id', 'studentId', 'oldDisplayName', 'newDisplayName'])
      .where('classId', '=', t.session.classId)
      .where('announcedAt', 'is', null)
      .orderBy('createdAt')
      .orderBy('id')
      .forUpdate()
      .execute()
    if (renames.length === 0) return []
    await trx
      .updateTable('renameEvents')
      .set({ announcedAt: now })
      .where('id', 'in', renames.map((r) => r.id))
      .execute()
    return renames.flatMap((r) =>
      keyed(`rename-${r.id}`, [
        {
          kind: 'rename',
          payload: { kind: 'rename', studentId: r.studentId, oldName: r.oldDisplayName, newName: r.newDisplayName },
        },
        teacherLine(teacher.renameAnnouncement(r.oldDisplayName, r.newDisplayName)),
      ]),
    )
  }

  /**
   * Runs a step that writes its own events: nothing when it has already run, else the new renames (before the
   * step's events, or after them at the opening) and what `said` returns; a marker when that is nothing.
   */
  function writeStep(
    t: Tracked,
    step: StepName,
    now: Date,
    live: boolean,
    said: (trx: Transaction<Database>) => Promise<Said[]>,
    renames: 'before' | 'after' = 'before',
  ): Promise<number[] | null> {
    return commitAndPush(t, now, live, async (trx) => {
      if (await stepWritten(trx, t.session.sessionId, step)) return null
      const content = keyed(step, await said(trx))
      if (content.length === 0) content.push({ step, kind: NOOP, payload: {} })
      // A session finished quietly leaves the renames to the class's live session.
      const announced = live ? await renameEvents(trx, t, now) : []
      return renames === 'before' ? [...announced, ...content] : [...content, ...announced]
    })
  }

  // ---- What each step says ----

  async function lessonOf(trx: Transaction<Database>, t: Tracked): Promise<LessonContent> {
    if (t.lesson !== undefined) return t.lesson
    if (t.lessonId === null) throw new Error(`Lesson session ${t.session.sessionId} names no lesson`)
    const row = await trx
      .selectFrom('lessons')
      .select(['subject', 'title', 'segments'])
      .where('id', '=', t.lessonId)
      .executeTakeFirstOrThrow()
    t.lesson = row
    return row
  }

  async function openingLine(trx: Transaction<Database>, t: Tracked): Promise<string> {
    if (t.session.kind === 'lesson') {
      const lesson = await lessonOf(trx, t)
      return teacher.openingLesson(t.teacher, lesson.subject, lesson.title)
    }
    // A study hall that day: at the weekend it looks back on the week's lessons.
    const plan = await planSession(trx, config, { date: t.date, division: t.session.division })
    const titles = plan.kind === 'study' ? plan.weekTitles : []
    return titles.length > 0 ? teacher.openingWeekend(t.teacher, titles) : teacher.openingStudy(t.teacher)
  }

  /** Who joined and who left the class since its previous session; nothing for the class's first session. */
  async function rosterChange(
    trx: Transaction<Database>,
    t: Tracked,
  ): Promise<{ joined: SessionMember[]; left: SessionMember[] } | null> {
    const { sessionId, classId, startsAt } = t.session
    const current = await trx
      .selectFrom('classSessions')
      .select('members')
      .where('id', '=', sessionId)
      .executeTakeFirstOrThrow()
    const previous = await trx
      .selectFrom('classSessions')
      .select('members')
      .where('classId', '=', classId)
      .where('startsAt', '<', startsAt)
      .orderBy('startsAt', 'desc')
      .orderBy('id', 'desc')
      .limit(1)
      .executeTakeFirst()
    if (previous === undefined) return null
    const was = new Set(previous.members.map((m) => m.studentId))
    const is = new Set(current.members.map((m) => m.studentId))
    const joined = current.members.filter((m) => !was.has(m.studentId))
    const left = previous.members.filter((m) => !is.has(m.studentId))
    return joined.length > 0 || left.length > 0 ? { joined, left } : null
  }

  async function opening(trx: Transaction<Database>, t: Tracked): Promise<Said[]> {
    const said = [teacherLine(await openingLine(trx, t))]
    const roster = await rosterChange(trx, t)
    if (roster !== null) {
      const classmate = (m: SessionMember) => ({ studentId: m.studentId, displayName: m.displayName })
      const { joined, left } = roster
      said.push({ kind: 'roster', payload: { kind: 'roster', joined: joined.map(classmate), left: left.map(classmate) } })
      // Welcome by name the ones who joined; the ones who left are not named aloud.
      if (joined.length > 0) said.push(teacherLine(teacher.welcomeNewcomers(joined.map((m) => m.displayName))))
    }
    return said
  }

  async function segment(trx: Transaction<Database>, t: Tracked, k: number): Promise<Said[]> {
    const text = (await lessonOf(trx, t)).segments[k - 1]?.text
    // The lesson was imported with as many segments as the config had then; one the config added since has none.
    if (text === undefined) return []
    const said: Said[] = k >= 2 ? [teacherLine(teacher.transition(k))] : []
    said.push({ kind: 'segment', payload: { kind: 'segment', index: k, text } })
    return said
  }

  /** The window a callouts step looks back on: since the previous callouts, or since the doors for the first. */
  function calloutWindow(t: Tracked, step: StepName): { from: Date; to: Date } {
    const i = t.steps.findIndex((s) => s.step === step)
    const earlier = t.steps.slice(0, i).filter((s) => s.step.startsWith('callouts-'))
    return { from: earlier[earlier.length - 1]?.at ?? t.doorsAt, to: t.steps[i]?.at ?? t.doorsAt }
  }

  /** Runs one step; returns the numbers of the events it pushed, or null when it had already run. */
  async function runStep(t: Tracked, step: StepName, now: Date): Promise<number[] | null> {
    const live = isLive(t, now)
    const s = t.session

    if (step === 'opening') return writeStep(t, step, now, live, (trx) => opening(trx, t), 'after')

    if (step.startsWith('segment-')) {
      const k = Number(step.slice('segment-'.length))
      return writeStep(t, step, now, live, (trx) => segment(trx, t, k))
    }

    if (step.startsWith('callouts-')) {
      const { from, to } = calloutWindow(t, step)
      const lines = await hooks.callouts(s, from, to)
      return writeStep(t, step, now, live, async () => lines.map(teacherLine))
    }

    if (step === 'call-on' || step === 'call-on-close') {
      // The hook may write the step's events itself; the marker written after it only counts when it did not.
      const announced = live ? await commitAndPush(t, now, live, (trx) => renameEvents(trx, t, now)) : []
      if (live) await (step === 'call-on' ? hooks.callOn(s) : hooks.callOnClose(s))
      await commitAndPush(t, now, false, async () => [{ step, kind: NOOP, payload: {} }])
      return announced ?? []
    }

    if (step === 'dismissal') {
      const seqs = await writeStep(t, step, now, live, async () => [
        teacherLine(teacher.dismissal()),
        { kind: 'dismissal', payload: { kind: 'dismissal' } },
      ])
      if (seqs !== null && live) hooks.startClosing(s.classId)
      return seqs
    }

    // close
    if (live) hooks.endAll(s.classId)
    await hooks.afterClass(s, { live })
    const closed = await db
      .updateTable('classSessions')
      .set({ dismissedAt: now })
      .where('id', '=', s.sessionId)
      .where('dismissedAt', 'is', null)
      .executeTakeFirst()
    if (live) for (const studentId of hub.online(s.classId)) hub.disconnect(studentId, SESSION_OVER)
    return closed.numUpdatedRows > 0n ? [] : null
  }

  /** Runs the session's steps that are due and have not run, in order. */
  async function advance(t: Tracked, now: Date): Promise<void> {
    const { sessionId, classId } = t.session
    for (const { step, at } of t.steps) {
      if (before(now, at)) break
      if (t.done.has(step)) continue
      let seqs: number[] | null
      try {
        seqs = await runStep(t, step, now)
      } catch (err) {
        throw new Error(`Class step ${step} of session ${sessionId} (class ${classId}) failed`, { cause: err })
      }
      t.done.add(step)
      if (seqs !== null) log({ sessionId, classId, step, seqs }, 'class step')
      if (step === 'close') tracked.delete(sessionId)
    }
  }

  async function runTick(): Promise<void> {
    const now = clock.now()
    const failures: unknown[] = []
    try {
      if (!loaded) {
        await loadSessions()
        loaded = true
      }
      await openDueSlots(now)
    } catch (err) {
      failures.push(err)
    }
    // Earlier sessions first; one class's failure does not hold up the others.
    const order = [...tracked.values()].sort(
      (a, b) =>
        a.session.startsAt.getTime() - b.session.startsAt.getTime() || a.session.sessionId - b.session.sessionId,
    )
    for (const t of order) {
      try {
        await advance(t, now)
      } catch (err) {
        failures.push(err)
      }
    }
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'Several class sessions failed this tick')
  }

  return {
    // A tick that is called while one is running waits for it, so no two ever run at once.
    tick() {
      const next = running.then(runTick)
      running = next.catch(() => {})
      return next
    },

    currentSession(classId) {
      const now = clock.now()
      let found: ActiveSession | null = null
      for (const t of tracked.values()) {
        const s = t.session
        if (s.classId !== classId || before(now, t.doorsAt) || !before(now, s.closeAt)) continue
        if (found === null || before(found.startsAt, s.startsAt)) found = s
      }
      return found
    },
  }
}
