import { sql, type Kysely } from 'kysely'
import type { Static } from 'typebox'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { lockSession } from '../../src/class/events.js'
import { noopHooks, type LessonHooks } from '../../src/class/hooks.js'
import { RecordingHub, type RecordedMessage } from '../../src/class/hub.js'
import { createClassRuntime, type ActiveSession } from '../../src/class/runtime.js'
import {
  dismissal,
  lessonIntro,
  openingLesson,
  openingStudy,
  openingWeekend,
  renameAnnouncement,
  studyIntro,
  transition,
  weekendIntro,
  welcomeNewcomers,
} from '../../src/class/teacher.js'
import { createModerator } from '../../src/moderation/moderator.js'
import type { ClassEventMessage, ClosingMessage } from '../../src/protocol/ws.js'
import type { Division, SchoolConfig, Slot } from '../../src/shared/config.js'
import { lessonLockKey, lock } from '../../src/shared/db.js'
import { displayName } from '../../src/shared/identity.js'
import type { Database, StudentStatus } from '../../src/shared/schema.js'
import { createTestClock } from '../helpers/clock.js'
import { exampleConfigWithOneCallOn } from '../helpers/app.js'
import { createTestDb } from '../helpers/db.js'
import { insertClass, insertLesson, insertSession, insertStudent } from '../helpers/factories.js'

const config = exampleConfigWithOneCallOn()
// The runtime only says template lines and approved lesson text; an empty word list is enough here.
const moderator = createModerator({ blockedWords: [], injectionPatterns: [] })

const MON = '2026-11-02'
const SUN = '2026-11-01'
const SAT = '2026-11-07'
const TUE = '2026-11-03'
const MINUTE = 60_000

/** A wall-clock time in Beijing (the example config's timezone) on `date`. */
const at = (time: string, date = MON) => new Date(`${date}T${time.length === 5 ? `${time}:00` : time}+08:00`)
const hhmm = (d: Date) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d)

const SEGMENTS = [1, 2, 3, 4, 5].map((i) => ({ text: `光的折射第${i}段`, gist: `要点${i}` }))
const segmentText = (k: number) => `光的折射第${k}段`

type EventMessage = Static<typeof ClassEventMessage>
type Closing = Static<typeof ClosingMessage>

/** One recorded message as a short line, for comparing whole timelines. */
function show(m: RecordedMessage): string {
  if (m.to === 'disconnect') return `closing ${m.studentId} ${(m.message as Closing).reason}`
  const message = m.message as EventMessage
  if (message.type !== 'class.event') return message.type
  const e = message.event
  switch (e.kind) {
    case 'teacher':
      return `teacher ${e.text}`
    case 'segment':
      return `segment ${e.index} ${e.text}`
    case 'rename':
      return `rename ${e.studentId} ${e.oldName} -> ${e.newName}`
    case 'roster':
      return `roster +[${e.joined.map((c) => `${c.studentId} ${c.displayName}`).join(', ')}] -[${e.left.map((c) => `${c.studentId} ${c.displayName}`).join(', ')}]`
    default:
      return e.kind
  }
}

/** A RecordingHub that also writes each message into a shared trace, next to the hook calls. */
class TracingHub extends RecordingHub {
  constructor(private readonly trace: string[]) {
    super()
  }
  override broadcast(classId: number, message: object): void {
    super.broadcast(classId, message)
    this.trace.push(show(this.messages[this.messages.length - 1]!))
  }
  override send(studentId: number, message: object): void {
    super.send(studentId, message)
    this.trace.push(show(this.messages[this.messages.length - 1]!))
  }
  override disconnect(studentId: number, message: object): void {
    super.disconnect(studentId, message)
    this.trace.push(show(this.messages[this.messages.length - 1]!))
  }
}

/** Hooks that write each call into `trace`; `callouts` returns what `lines` gives for the window. */
function recordingHooks(trace: string[], lines: (from: Date, to: Date) => string[] = () => []): LessonHooks & {
  sessions: ActiveSession[]
} {
  const sessions: ActiveSession[] = []
  return {
    sessions,
    async callouts(session, from, to) {
      sessions.push(session)
      trace.push(`hook callouts ${hhmm(from)}-${hhmm(to)}`)
      return lines(from, to)
    },
    async callOn(session) {
      sessions.push(session)
      trace.push('hook callOn')
    },
    async callOnClose(session) {
      sessions.push(session)
      trace.push('hook callOnClose')
    },
    startClosing(classId) {
      trace.push(`hook startClosing ${classId}`)
    },
    endAll(classId) {
      trace.push(`hook endAll ${classId}`)
    },
    onDisconnect(studentId) {
      trace.push(`hook onDisconnect ${studentId}`)
    },
    async afterClass(session, { live }) {
      sessions.push(session)
      trace.push(`hook afterClass ${session.sessionId} ${live ? 'live' : 'quiet'}`)
    },
  }
}

/** Polls `check` until it holds (for waiting on another database connection), failing after 5 seconds. */
async function waitFor(check: () => Promise<boolean>): Promise<void> {
  for (let waited = 0; waited < 5000; waited += 10) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Timed out waiting')
}

let db: Kysely<Database>
let destroy: () => Promise<void>

beforeEach(async () => {
  ;({ db, destroy } = await createTestDb())
})

afterEach(async () => {
  await destroy()
})

interface Member {
  id: number
  name: string
}

let nameCounter = 0

async function addStudent(classId: number | null, p: { division?: Division; slot?: Slot; status?: StudentStatus } = {}): Promise<Member> {
  const n = ++nameCounter
  const ownerName = `阿${n}`
  const aiName = `小鱼${n}`
  const { id } = await insertStudent(db, {
    classId,
    division: p.division ?? 'junior',
    slot: p.slot ?? 'evening',
    status: p.status ?? 'active',
    ownerName,
    aiName,
  })
  return { id, name: displayName(ownerName, aiName) }
}

/** A class with `members` active students. */
async function seedClass(p: { division?: Division; slot?: Slot; classNo?: number; members?: number } = {}) {
  const division = p.division ?? 'junior'
  const slot = p.slot ?? 'evening'
  const classId = await insertClass(db, { division, slot, classNo: p.classNo ?? 1 })
  const members: Member[] = []
  for (let i = 0; i < (p.members ?? 2); i++) members.push(await addStudent(classId, { division, slot }))
  return { classId, members }
}

function newRuntime(p: {
  clock: ReturnType<typeof createTestClock>
  hub: RecordingHub
  hooks?: LessonHooks
  speed?: number
  logs?: [object, string][]
  config?: SchoolConfig
}) {
  return createClassRuntime({
    db,
    config: p.config ?? config,
    clock: p.clock,
    hub: p.hub,
    moderator,
    speed: p.speed ?? 1,
    hooks: p.hooks ?? noopHooks,
    log: (obj, msg) => void p.logs?.push([obj, msg]),
  })
}

/** Ticks once a minute from the clock's next minute up to and including `until`, writing what each minute pushed. */
async function runUntil(
  runtime: ReturnType<typeof newRuntime>,
  clock: ReturnType<typeof createTestClock>,
  hub: RecordingHub,
  until: Date,
): Promise<[string, string[]][]> {
  const timeline: [string, string[]][] = []
  while (clock.now().getTime() < until.getTime()) {
    clock.advance(MINUTE)
    const before = hub.messages.length
    await runtime.tick()
    const pushed = hub.messages.slice(before).map(show)
    if (pushed.length > 0) timeline.push([hhmm(clock.now()), pushed])
  }
  return timeline
}

const sessionRows = () =>
  db
    .selectFrom('classSessions')
    .select(['id', 'classId', 'date', 'slot', 'kind', 'lessonId', 'startsAt', 'endsAt', 'dismissedAt', 'members'])
    .orderBy('id')
    .execute()

const classEvents = (hub: RecordingHub) =>
  hub.messages.flatMap((m) => {
    const message = m.message as EventMessage
    return m.to === 'class' && message.type === 'class.event' ? [{ classId: m.classId, ...message }] : []
  })

describe('a lesson day', () => {
  test('opens at the doors, teaches every step at its minute and closes after the grace period', async () => {
    const lessonId = await insertLesson(db, { date: MON, title: '光的折射', subject: '科学', segments: SEGMENTS })
    const { classId, members } = await seedClass({ members: 2 })
    const clock = createTestClock(at('19:44'))
    const hub = new RecordingHub()
    for (const m of members) hub.join(classId, m.id)
    const runtime = newRuntime({ clock, hub })

    await runtime.tick()
    expect(await sessionRows()).toEqual([])
    expect(runtime.currentSession(classId)).toBeNull()

    clock.set(at('19:45'))
    await runtime.tick()
    const [row] = await sessionRows()
    expect(row).toEqual({
      id: expect.any(Number),
      classId,
      date: MON,
      slot: 'evening',
      kind: 'lesson',
      lessonId,
      startsAt: at('20:00'),
      endsAt: at('20:30'),
      dismissedAt: null,
      members: members.map((m) => ({ studentId: m.id, displayName: m.name })),
    })
    expect(runtime.currentSession(classId)).toEqual({
      sessionId: row!.id,
      classId,
      division: 'junior',
      slot: 'evening',
      kind: 'lesson',
      startsAt: at('20:00'),
      endsAt: at('20:30'),
      closeAt: at('20:31'),
    })
    expect(hub.messages).toEqual([])

    const timeline = await runUntil(runtime, clock, hub, at('20:33'))
    expect(timeline).toEqual([
      ['20:00', [`teacher ${openingLesson('老周', '科学', '光的折射')}`]],
      ['20:05', [`segment 1 ${segmentText(1)}`]],
      ['20:10', [`teacher ${transition(2)}`, `segment 2 ${segmentText(2)}`]],
      ['20:15', [`teacher ${transition(3)}`, `segment 3 ${segmentText(3)}`]],
      ['20:20', [`teacher ${transition(4)}`, `segment 4 ${segmentText(4)}`]],
      ['20:25', [`teacher ${transition(5)}`, `segment 5 ${segmentText(5)}`]],
      ['20:30', [`teacher ${dismissal()}`, 'dismissal']],
      ['20:31', members.map((m) => `closing ${m.id} session_over`)],
    ])

    // Every class event went to the whole class, numbered 1, 2, 3 ... and stamped with the time it was pushed.
    const events = classEvents(hub)
    expect(events.map((e) => e.classId)).toEqual(events.map(() => classId))
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1))
    expect(events.every((e) => e.replayed === false)).toBe(true)
    expect(events[0]!.at).toBe(at('20:00').toISOString())
    expect(events[events.length - 1]!.at).toBe(at('20:30').toISOString())
    const closing = hub.messages.find((m) => m.to === 'disconnect')!.message as Closing
    expect(closing).toEqual({ type: 'closing', reason: 'session_over', message: expect.any(String) })

    const [closed] = await sessionRows()
    expect(closed!.dismissedAt).toEqual(at('20:31'))
    expect(runtime.currentSession(classId)).toBeNull()
  })

  test('the hooks are called at their steps, and callout lines go out before the next segment', async () => {
    await insertLesson(db, { date: MON, title: '光的折射', subject: '科学', segments: SEGMENTS })
    const { classId, members } = await seedClass({ members: 1 })
    const trace: string[] = []
    const clock = createTestClock(at('19:45'))
    const hub = new TracingHub(trace)
    hub.join(classId, members[0]!.id)
    const hooks = recordingHooks(trace, (from, to) => (hhmm(to) === '20:15' ? [`纪律点名 ${hhmm(from)}-${hhmm(to)}`] : []))
    const runtime = newRuntime({ clock, hub, hooks })
    await runtime.tick()
    const sessionId = runtime.currentSession(classId)!.sessionId

    // A time stamp in front of each minute's entries.
    const timed: string[] = []
    while (clock.now().getTime() < at('20:32').getTime()) {
      clock.advance(MINUTE)
      const before = trace.length
      await runtime.tick()
      for (const entry of trace.slice(before)) timed.push(`${hhmm(clock.now())} ${entry}`)
    }

    expect(timed.filter((e) => !e.includes(' segment ') && !e.includes(' teacher '))).toEqual([
      '20:10 hook callouts 19:45-20:10',
      '20:15 hook callouts 20:10-20:15',
      '20:15 hook callOn',
      '20:20 hook callOnClose',
      '20:20 hook callouts 20:15-20:20',
      '20:25 hook callouts 20:20-20:25',
      '20:30 hook callouts 20:25-20:30',
      '20:30 dismissal',
      `20:30 hook startClosing ${classId}`,
      `20:31 hook endAll ${classId}`,
      `20:31 hook afterClass ${sessionId} live`,
      `20:31 closing ${members[0]!.id} session_over`,
    ])
    // Same instant: the callouts for segment 2, then the next segment, then the call-on that follows it.
    expect(timed.filter((e) => e.startsWith('20:15'))).toEqual([
      '20:15 hook callouts 20:10-20:15',
      '20:15 teacher 纪律点名 20:10-20:15',
      `20:15 teacher ${transition(3)}`,
      `20:15 segment 3 ${segmentText(3)}`,
      '20:15 hook callOn',
    ])
    expect(hooks.sessions.every((s) => s.sessionId === sessionId && s.classId === classId)).toBe(true)

    // A callouts step with nothing to say still counts as done, with a marker nobody is sent.
    const steps = await db.selectFrom('classEvents').select(['step', 'kind', 'seq']).where('kind', '=', 'noop').orderBy('seq', 'desc').execute()
    expect(steps.map((s) => s.step)).toEqual(['callouts-1', 'call-on', 'call-on-close', 'callouts-3', 'callouts-4', 'callouts-5'])
    expect(steps.every((s) => s.seq < 0)).toBe(true)
  })

  test('a class with no members gets no session; a suspended member is in the snapshot', async () => {
    const { classId, members } = await seedClass({ members: 1 })
    const suspended = await addStudent(classId, { status: 'suspended' })
    await addStudent(classId, { status: 'dropped' })
    const empty = await insertClass(db, { classNo: 2 })
    const morning = await seedClass({ slot: 'morning', classNo: 3, members: 1 })
    const clock = createTestClock(at('19:50'))
    const runtime = newRuntime({ clock, hub: new RecordingHub() })

    await runtime.tick()

    const rows = await sessionRows()
    expect(rows.map((r) => r.classId)).toEqual([classId])
    expect(rows[0]!.members).toEqual([
      { studentId: members[0]!.id, displayName: members[0]!.name },
      { studentId: suspended.id, displayName: suspended.name },
    ])
    expect(rows[0]!.kind).toBe('study')
    expect(runtime.currentSession(empty)).toBeNull()
    expect(runtime.currentSession(morning.classId)).toBeNull()
  })

  test('compresses the whole lesson by the timeline speed', async () => {
    await insertLesson(db, { date: MON, segments: SEGMENTS })
    const { classId, members } = await seedClass({ members: 1 })
    const clock = createTestClock(at('19:59:44'))
    const hub = new RecordingHub()
    hub.join(classId, members[0]!.id)
    const runtime = newRuntime({ clock, hub, speed: 60 })

    await runtime.tick()
    expect(await sessionRows()).toEqual([])
    clock.set(at('19:59:45')) // 15 minutes before, at 60 times the speed
    await runtime.tick()
    expect(runtime.currentSession(classId)).toMatchObject({ endsAt: at('20:00:30'), closeAt: at('20:00:31') })

    clock.set(at('20:00:10'))
    await runtime.tick()
    expect(hub.messages.map(show)).toEqual([
      expect.stringMatching(/^teacher /),
      `segment 1 ${segmentText(1)}`,
      `teacher ${transition(2)}`,
      `segment 2 ${segmentText(2)}`,
    ])
    clock.set(at('20:00:31'))
    await runtime.tick()
    expect((await sessionRows())[0]!.dismissedAt).toEqual(at('20:00:31'))
  })

  test('logs one line per step with its name, class and numbers, never what was said', async () => {
    await insertLesson(db, { date: MON, title: '光的折射', subject: '科学', segments: SEGMENTS })
    const { classId } = await seedClass({ members: 1 })
    const logs: [object, string][] = []
    const clock = createTestClock(at('19:45'))
    const runtime = newRuntime({ clock, hub: new RecordingHub(), logs })
    await runtime.tick()
    const sessionId = runtime.currentSession(classId)!.sessionId
    clock.set(at('20:10'))
    await runtime.tick()

    const steps = logs.filter(([, msg]) => msg === 'class step').map(([obj]) => obj)
    expect(steps).toEqual([
      { sessionId, classId, step: 'opening', seqs: [1] },
      { sessionId, classId, step: 'segment-1', seqs: [2] },
      { sessionId, classId, step: 'callouts-1', seqs: [] },
      { sessionId, classId, step: 'segment-2', seqs: [3, 4] },
    ])
    const text = JSON.stringify(logs)
    for (const said of ['光的折射', '老周', '同学们好', transition(2)]) expect(text).not.toContain(said)
  })
})

describe('a restart (Review Focus 2)', () => {
  test('a new runtime mid-lesson pushes nothing again, then catches up the missed steps in order, each once', async () => {
    await insertLesson(db, { date: MON, title: '光的折射', subject: '科学', segments: SEGMENTS })
    const { classId, members } = await seedClass({ members: 2 })
    const clock = createTestClock(at('19:44'))
    const firstHub = new RecordingHub()
    for (const m of members) firstHub.join(classId, m.id)
    const first = newRuntime({ clock, hub: firstHub })
    const before = await runUntil(first, clock, firstHub, at('20:07'))
    expect(before.map(([time]) => time)).toEqual(['20:00', '20:05'])

    // The service restarts at 20:07: a new runtime with no memory, and the students connect again.
    const trace: string[] = []
    const hub = new TracingHub(trace)
    for (const m of members) hub.join(classId, m.id)
    const hooks = recordingHooks(trace, (from, to) => [`纪律点名 ${hhmm(from)}-${hhmm(to)}`])
    const second = newRuntime({ clock, hub, hooks })
    await second.tick()
    expect(trace).toEqual([])
    expect(second.currentSession(classId)).toMatchObject({ classId, kind: 'lesson', startsAt: at('20:00') })

    // It is down again until 20:21; the first tick after that catches up 20:10, 20:15 and 20:20.
    clock.set(at('20:21'))
    await second.tick()
    expect(trace).toEqual([
      'hook callouts 19:45-20:10',
      'teacher 纪律点名 19:45-20:10',
      `teacher ${transition(2)}`,
      `segment 2 ${segmentText(2)}`,
      'hook callouts 20:10-20:15',
      'teacher 纪律点名 20:10-20:15',
      `teacher ${transition(3)}`,
      `segment 3 ${segmentText(3)}`,
      'hook callOn',
      'hook callOnClose',
      'hook callouts 20:15-20:20',
      'teacher 纪律点名 20:15-20:20',
      `teacher ${transition(4)}`,
      `segment 4 ${segmentText(4)}`,
    ])
    // Numbered on from the 2 events before the restart, with no gap.
    expect(classEvents(hub).map((e) => e.seq)).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11])

    const pushed = hub.messages.length
    await second.tick()
    expect(hub.messages).toHaveLength(pushed)

    // In the database every step is there once, and the events anyone sees are 1 to 11.
    const rows = await db.selectFrom('classEvents').select(['seq', 'step', 'kind']).orderBy('seq').execute()
    const steps = rows.map((r) => r.step)
    expect(new Set(steps).size).toBe(steps.length)
    expect(rows.filter((r) => r.kind !== 'noop').map((r) => r.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
    expect(rows.filter((r) => r.kind === 'noop').map((r) => r.step).sort()).toEqual(['call-on', 'call-on-close'])
  })

  test('a restart right after the call-on calls no hook of a step that already ran', async () => {
    await insertLesson(db, { date: MON, segments: SEGMENTS })
    const { classId, members } = await seedClass({ members: 1 })
    const clock = createTestClock(at('19:45'))
    const firstTrace: string[] = []
    const first = newRuntime({ clock, hub: new TracingHub(firstTrace), hooks: recordingHooks(firstTrace) })
    await first.tick()
    clock.set(at('20:16'))
    await first.tick()
    expect(firstTrace.filter((e) => e.startsWith('hook'))).toEqual([
      'hook callouts 19:45-20:10',
      'hook callouts 20:10-20:15',
      'hook callOn',
    ])

    const trace: string[] = []
    const hub = new TracingHub(trace)
    hub.join(classId, members[0]!.id)
    const second = newRuntime({ clock, hub, hooks: recordingHooks(trace) })
    await second.tick()
    expect(trace).toEqual([])

    clock.set(at('20:20'))
    await second.tick()
    expect(trace).toEqual([
      'hook callOnClose',
      'hook callouts 20:15-20:20',
      `teacher ${transition(4)}`,
      `segment 4 ${segmentText(4)}`,
    ])
  })

  test('a service that starts after the lesson began opens the session and catches up from the opening', async () => {
    await insertLesson(db, { date: MON, title: '光的折射', subject: '科学', segments: SEGMENTS })
    const { classId, members } = await seedClass({ members: 1 })
    const trace: string[] = []
    const clock = createTestClock(at('20:12'))
    const hub = new TracingHub(trace)
    hub.join(classId, members[0]!.id)
    const runtime = newRuntime({ clock, hub, hooks: recordingHooks(trace) })

    await runtime.tick()

    expect(await sessionRows()).toMatchObject([{ classId, kind: 'lesson', dismissedAt: null }])
    expect(trace).toEqual([
      `teacher ${openingLesson('老周', '科学', '光的折射')}`,
      `segment 1 ${segmentText(1)}`,
      'hook callouts 19:45-20:10',
      `teacher ${transition(2)}`,
      `segment 2 ${segmentText(2)}`,
    ])
    expect(classEvents(hub).map((e) => e.seq)).toEqual([1, 2, 3, 4])
  })

  test('two ticks at once run every step once', async () => {
    await insertLesson(db, { date: MON, segments: SEGMENTS })
    const { classId, members } = await seedClass({ members: 1 })
    const trace: string[] = []
    const clock = createTestClock(at('20:16'))
    const hub = new TracingHub(trace)
    hub.join(classId, members[0]!.id)
    const runtime = newRuntime({ clock, hub, hooks: recordingHooks(trace) })

    await Promise.all([runtime.tick(), runtime.tick(), runtime.tick()])

    expect(classEvents(hub).map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6])
    expect(trace.filter((e) => e.startsWith('hook'))).toEqual([
      'hook callouts 19:45-20:10',
      'hook callouts 20:10-20:15',
      'hook callOn',
    ])
  })

  test('a session caught up after its close finishes quietly and leaves its renames for the next opening', async () => {
    await insertLesson(db, { date: MON, title: '光的折射', subject: '科学', segments: SEGMENTS })
    const { classId, members } = await seedClass({ members: 1 })
    const student = members[0]!
    const clock = createTestClock(at('19:45'))
    const first = newRuntime({ clock, hub: new RecordingHub() })
    await first.tick()
    const monday = first.currentSession(classId)!.sessionId
    clock.set(at('20:10'))
    await first.tick()

    // The service crashes at 20:10 and is down until Tuesday 09:00, before Tuesday's doors; a rename comes in meanwhile.
    await db
      .insertInto('renameEvents')
      .values({
        studentId: student.id,
        classId,
        oldDisplayName: student.name,
        newDisplayName: '阿杰家的小鱼',
        createdAt: at('20:12'),
        announcedAt: null,
      })
      .execute()
    const trace: string[] = []
    const hub = new TracingHub(trace)
    clock.set(at('09:00', TUE))
    const second = newRuntime({ clock, hub, hooks: recordingHooks(trace) })
    await second.tick()

    expect(trace).toEqual([
      'hook callouts 20:10-20:15',
      'hook callouts 20:15-20:20',
      'hook callouts 20:20-20:25',
      'hook callouts 20:25-20:30',
      `hook afterClass ${monday} quiet`,
    ])
    expect(hub.messages).toEqual([])
    expect(await sessionRows()).toMatchObject([{ id: monday, dismissedAt: at('09:00', TUE) }])
    const mondaySteps = await db.selectFrom('classEvents').select('step').where('sessionId', '=', monday).execute()
    expect(mondaySteps.map((e) => e.step)).toEqual(expect.arrayContaining(['segment-5', 'call-on', 'call-on-close', 'dismissal']))
    expect(mondaySteps.some((e) => e.step.startsWith('rename'))).toBe(false)
    expect(await db.selectFrom('renameEvents').select('announcedAt').execute()).toEqual([{ announcedAt: null }])

    // Tuesday's opening, live, announces it once.
    clock.set(at('19:45', TUE))
    await second.tick()
    hub.join(classId, student.id)
    clock.set(at('20:00', TUE))
    await second.tick()
    expect(hub.messages.map(show)).toEqual([
      `teacher ${openingStudy('老周')}`,
      `rename ${student.id} ${student.name} -> 阿杰家的小鱼`,
      `teacher ${renameAnnouncement(student.name, '阿杰家的小鱼')}`,
    ])
    expect(await db.selectFrom('renameEvents').select('announcedAt').execute()).toEqual([{ announcedAt: at('20:00', TUE) }])
    const renames = await db.selectFrom('classEvents').select('step').where('step', 'like', 'rename-%').execute()
    expect(renames).toHaveLength(2) // the rename event and the teacher's line, both in Tuesday's session
  })

  test.each([
    ['20:31:30', true],
    ['20:31:31', false],
  ])('a close run at %s is live: %s (up to 30 seconds late)', async (time, live) => {
    await insertLesson(db, { date: MON, segments: SEGMENTS })
    const { classId, members } = await seedClass({ members: 1 })
    const trace: string[] = []
    const clock = createTestClock(at('19:45'))
    const hub = new TracingHub(trace)
    hub.join(classId, members[0]!.id)
    const runtime = newRuntime({ clock, hub, hooks: recordingHooks(trace) })
    await runtime.tick()
    const sessionId = runtime.currentSession(classId)!.sessionId
    clock.set(at('20:30'))
    await runtime.tick()
    const before = trace.length

    clock.set(at(time))
    await runtime.tick()

    // Late or not, whoever is still connected is let go: no newer session of the class has opened.
    expect(trace.slice(before)).toEqual(
      live
        ? [`hook endAll ${classId}`, `hook afterClass ${sessionId} live`, `closing ${members[0]!.id} session_over`]
        : [`hook afterClass ${sessionId} quiet`, `closing ${members[0]!.id} session_over`],
    )
    expect((await sessionRows())[0]!.dismissedAt).toEqual(at(time))
  })

  test('a close that runs quiet because the after-class work failed and was retried late still lets everyone go', async () => {
    const { classId, members } = await seedClass({ members: 1 })
    const trace: string[] = []
    const clock = createTestClock(at('19:45'))
    const hub = new TracingHub(trace)
    hub.join(classId, members[0]!.id)
    const hooks = recordingHooks(trace)
    let failing = true
    const runtime = newRuntime({
      clock,
      hub,
      hooks: {
        ...hooks,
        async afterClass(session, opts) {
          await hooks.afterClass(session, opts)
          if (failing) throw new Error('The database is unreachable')
        },
      },
    })
    await runtime.tick()
    const sessionId = runtime.currentSession(classId)!.sessionId
    clock.set(at('20:31'))
    await expect(runtime.tick()).rejects.toThrow()
    expect(hub.online(classId)).toEqual([members[0]!.id])
    const before = trace.length

    // The next tick that gets through is a minute later, past the tolerance: the close runs quiet.
    failing = false
    clock.set(at('20:32'))
    await runtime.tick()

    expect(trace.slice(before)).toEqual([`hook afterClass ${sessionId} quiet`, `closing ${members[0]!.id} session_over`])
    expect(hub.online(classId)).toEqual([])
  })

  test('a session left open from an earlier day is finished quietly once the class has a newer one', async () => {
    const { classId, members } = await seedClass({ members: 1 })
    const stale = await insertSession(db, {
      classId,
      date: SUN,
      kind: 'study',
      startsAt: at('20:00', SUN),
      endsAt: at('20:30', SUN),
      members: [{ studentId: members[0]!.id, displayName: members[0]!.name }],
    })
    const trace: string[] = []
    const clock = createTestClock(at('19:50'))
    const hub = new TracingHub(trace)
    hub.join(classId, members[0]!.id)
    const runtime = newRuntime({ clock, hub, hooks: recordingHooks(trace) })

    await runtime.tick()

    // Its steps are written down and its after-class work is done, but nothing reaches today's class.
    expect(trace).toEqual([
      'hook callouts 19:45-20:10',
      'hook callouts 20:10-20:15',
      'hook callouts 20:15-20:20',
      'hook callouts 20:20-20:25',
      'hook callouts 20:25-20:30',
      `hook afterClass ${stale} quiet`,
    ])
    expect(hub.messages).toEqual([])
    const rows = await sessionRows()
    expect(rows.map((r) => [r.id, r.date, r.dismissedAt])).toEqual([
      [stale, SUN, at('19:50')],
      [expect.any(Number), MON, null],
    ])
    const staleSteps = await db.selectFrom('classEvents').select('step').where('sessionId', '=', stale).execute()
    expect(staleSteps.map((s) => s.step)).toContain('dismissal')
    expect(runtime.currentSession(classId)).toMatchObject({ sessionId: rows[1]!.id })
  })
})

describe('the day plan', () => {
  test('all three slots of a division do the same thing: a lesson approved after the morning began is not taught that day', async () => {
    const junior = {
      morning: await seedClass({ slot: 'morning', classNo: 1, members: 1 }),
      afternoon: await seedClass({ slot: 'afternoon', classNo: 2, members: 1 }),
      evening: await seedClass({ slot: 'evening', classNo: 3, members: 1 }),
    }
    const seniorLesson = await insertLesson(db, { date: MON, division: 'senior', segments: SEGMENTS })
    const senior = {
      morning: await seedClass({ division: 'senior', slot: 'morning', classNo: 1, members: 1 }),
      evening: await seedClass({ division: 'senior', slot: 'evening', classNo: 2, members: 1 }),
    }
    const clock = createTestClock(at('09:45'))
    const hub = new RecordingHub()
    hub.join(junior.evening.classId, junior.evening.members[0]!.id)
    const runtime = newRuntime({ clock, hub })
    await runtime.tick()

    clock.set(at('12:00'))
    await runtime.tick()
    await insertLesson(db, { date: MON, division: 'junior', segments: SEGMENTS, approvedAt: at('12:00') })

    for (const time of ['14:45', '19:45', '20:00']) {
      clock.set(at(time))
      await runtime.tick()
    }

    const rows = await sessionRows()
    const kindOf = (classId: number) => {
      const r = rows.find((s) => s.classId === classId)
      return r && [r.slot, r.kind, r.lessonId]
    }
    expect(kindOf(junior.morning.classId)).toEqual(['morning', 'study', null])
    expect(kindOf(junior.afternoon.classId)).toEqual(['afternoon', 'study', null])
    expect(kindOf(junior.evening.classId)).toEqual(['evening', 'study', null])
    expect(kindOf(senior.morning.classId)).toEqual(['morning', 'lesson', seniorLesson])
    expect(kindOf(senior.evening.classId)).toEqual(['evening', 'lesson', seniorLesson])
    // The morning and afternoon sessions closed at their time.
    expect(rows.filter((r) => r.slot !== 'evening').every((r) => r.dismissedAt !== null)).toBe(true)
    // A study hall opens with the study greeting and teaches no segments.
    const eveningClass = hub.messages.filter((m) => m.to === 'class' && m.classId === junior.evening.classId)
    expect(eveningClass.map(show)).toEqual([`teacher ${openingStudy('老周')}`])
  })

  test('a lesson turned back into a draft while the doors open is not taught', async () => {
    const lessonId = await insertLesson(db, { date: MON, segments: SEGMENTS })
    const { classId } = await seedClass({ members: 1 })
    const clock = createTestClock(at('19:45'))
    const runtime = newRuntime({ clock, hub: new RecordingHub() })

    // The importer is in the middle of making the lesson a draft again: it holds its lock, not yet committed.
    let commit!: () => void
    const committed = new Promise<void>((resolve) => (commit = resolve))
    let locked!: () => void
    const lockTaken = new Promise<void>((resolve) => (locked = resolve))
    const importer = db.transaction().execute(async (trx) => {
      await lock(trx, lessonLockKey(MON, 'junior'))
      await trx.updateTable('lessons').set({ approvedAt: null }).where('id', '=', lessonId).execute()
      locked()
      await committed
    })
    await lockTaken

    // The runtime still reads the lesson as approved, then waits for the importer.
    const ticking = runtime.tick()
    try {
      await waitFor(async () => {
        const { rows } = await sql<{ n: number }>`select count(*)::int as n from pg_locks where not granted`.execute(db)
        return rows[0]!.n > 0
      })
    } finally {
      commit()
      await importer
      await ticking
    }

    expect(await sessionRows()).toMatchObject([{ classId, kind: 'study', lessonId: null }])
  })

  test('a weekend study hall opens with the titles of the week', async () => {
    const titles = ['静夜思', '勾股定理', 'My Day', '光的折射', '丝绸之路']
    for (const [i, title] of titles.entries()) {
      await insertLesson(db, { date: `2026-11-0${i + 2}`, title, segments: SEGMENTS })
    }
    const { classId, members } = await seedClass({ members: 1 })
    const clock = createTestClock(at('19:45', SAT))
    const hub = new RecordingHub()
    hub.join(classId, members[0]!.id)
    const runtime = newRuntime({ clock, hub })
    await runtime.tick()
    clock.set(at('20:00', SAT))
    await runtime.tick()

    expect(hub.messages.map(show)).toEqual([`teacher ${openingWeekend('老周', titles)}`])
  })

  test('with weekend study switched off nothing opens on Saturday or Sunday, by the days of the school time zone', async () => {
    const { classId } = await seedClass({ members: 1 })
    // In Los Angeles a Friday evening is already Saturday in UTC, and a Sunday evening already Monday.
    const holiday: SchoolConfig = {
      ...config,
      timezone: 'America/Los_Angeles',
      lesson: { ...config.lesson, weekendStudy: false },
    }
    const la = (date: string) => new Date(`${date}T19:50:00-08:00`)
    const clock = createTestClock(la('2026-11-06'))
    const runtime = newRuntime({ clock, hub: new RecordingHub(), config: holiday })

    for (const date of ['2026-11-06', '2026-11-07', '2026-11-08', '2026-11-09']) {
      clock.set(la(date))
      await runtime.tick()
    }

    expect((await sessionRows()).map((r) => r.date)).toEqual(['2026-11-06', '2026-11-09'])
    expect(runtime.currentSession(classId)).toMatchObject({ startsAt: new Date('2026-11-09T20:00:00-08:00') })
  })
})

describe('the opening', () => {
  test('announces each rename once: those made before class at the opening, later ones before the next step', async () => {
    await insertLesson(db, { date: MON, segments: SEGMENTS })
    const { classId, members } = await seedClass({ members: 2 })
    const [a, b] = members as [Member, Member]
    // A morning class: its session today is long over, so nothing announces its rename in this test.
    const other = await seedClass({ slot: 'morning', classNo: 2, members: 1 })
    const renamed = (m: Member, newName: string, createdAt: Date, inClass = classId) =>
      db
        .insertInto('renameEvents')
        .values({ studentId: m.id, classId: inClass, oldDisplayName: m.name, newDisplayName: newName, createdAt, announcedAt: null })
        .returning('id')
        .executeTakeFirstOrThrow()
    const early = await renamed(a, '阿杰家的小鱼', at('12:00'))
    const elsewhere = await renamed(other.members[0]!, '别班家的小猫', at('12:00'), other.classId)

    const clock = createTestClock(at('19:44'))
    const hub = new RecordingHub()
    for (const m of members) hub.join(classId, m.id)
    const runtime = newRuntime({ clock, hub })
    const opening = await runUntil(runtime, clock, hub, at('20:00'))
    expect(opening).toEqual([
      [
        '20:00',
        [
          expect.stringMatching(/^teacher 同学们好/),
          `rename ${a.id} ${a.name} -> 阿杰家的小鱼`,
          `teacher ${renameAnnouncement(a.name, '阿杰家的小鱼')}`,
        ],
      ],
    ])

    clock.set(at('20:07'))
    await runtime.tick()
    await renamed(b, '小明家的旺财', at('20:07'))
    const rest = await runUntil(runtime, clock, hub, at('20:32'))
    const renames = rest.flatMap(([time, lines]) => lines.filter((l) => !l.startsWith('segment')).map((l) => `${time} ${l}`))
    expect(renames.slice(0, 3)).toEqual([
      `20:10 rename ${b.id} ${b.name} -> 小明家的旺财`,
      `20:10 teacher ${renameAnnouncement(b.name, '小明家的旺财')}`,
      `20:10 teacher ${transition(2)}`,
    ])
    expect(hub.messages.map(show).filter((l) => l.startsWith('rename'))).toHaveLength(2)

    const announced = await db.selectFrom('renameEvents').select(['id', 'announcedAt']).orderBy('id').execute()
    expect(announced).toEqual([
      { id: early.id, announcedAt: at('20:00') },
      { id: elsewhere.id, announcedAt: null },
      { id: expect.any(Number), announcedAt: at('20:10') },
    ])
  })

  test('welcomes the classmates who joined since the last session; those who left are only in the roster', async () => {
    const { classId, members } = await seedClass({ members: 3 })
    const [a, b, c] = members as [Member, Member, Member]
    const last = await insertSession(db, {
      classId,
      date: SUN,
      kind: 'study',
      startsAt: at('20:00', SUN),
      endsAt: at('20:30', SUN),
      members: [a, b, c].map((m) => ({ studentId: m.id, displayName: m.name })),
    })
    await db.updateTable('classSessions').set({ dismissedAt: at('20:31', SUN) }).where('id', '=', last).execute()
    // b dropped out after that session, and d joined.
    await db.updateTable('students').set({ status: 'dropped', classId: null }).where('id', '=', b.id).execute()
    const d = await addStudent(classId)

    const clock = createTestClock(at('19:45'))
    const hub = new RecordingHub()
    hub.join(classId, a.id)
    const runtime = newRuntime({ clock, hub })
    await runtime.tick()
    clock.set(at('20:00'))
    await runtime.tick()

    expect(hub.messages.map(show)).toEqual([
      `teacher ${openingStudy('老周')}`,
      `roster +[${d.id} ${d.name}] -[${b.id} ${b.name}]`,
      `teacher ${welcomeNewcomers([d.name])}`,
    ])
  })

  test('only says the roster when someone left and nobody joined', async () => {
    const { classId, members } = await seedClass({ members: 2 })
    const [a, b] = members as [Member, Member]
    const last = await insertSession(db, {
      classId,
      date: SUN,
      kind: 'study',
      startsAt: at('20:00', SUN),
      endsAt: at('20:30', SUN),
      members: [a, b].map((m) => ({ studentId: m.id, displayName: m.name })),
    })
    await db.updateTable('classSessions').set({ dismissedAt: at('20:31', SUN) }).where('id', '=', last).execute()
    await db.updateTable('students').set({ status: 'dropped', classId: null }).where('id', '=', b.id).execute()

    const clock = createTestClock(at('20:00'))
    const hub = new RecordingHub()
    hub.join(classId, a.id)
    const runtime = newRuntime({ clock, hub })
    await runtime.tick()

    expect(hub.messages.map(show)).toEqual([`teacher ${openingStudy('老周')}`, `roster +[] -[${b.id} ${b.name}]`])
  })
})

describe('the locks', () => {
  test('a rename announced at the call-on locks the session before the renames, as every other step does', async () => {
    await insertLesson(db, { date: MON, segments: SEGMENTS })
    const { classId, members } = await seedClass({ members: 1 })
    const [a] = members as [Member]
    const clock = createTestClock(at('19:45'))
    const hub = new RecordingHub()
    hub.join(classId, a.id)
    // The call-on fails once after its renames are written, so the next tick starts the step with its renames.
    let callOnFails = true
    const runtime = newRuntime({
      clock,
      hub,
      hooks: {
        ...noopHooks,
        async callOn() {
          if (!callOnFails) return
          callOnFails = false
          throw new Error('the call-on failed')
        },
      },
    })
    await runtime.tick()
    clock.set(at('20:15'))
    await expect(runtime.tick()).rejects.toThrow(/call-on/)
    const sessionId = runtime.currentSession(classId)!.sessionId
    const rename = await db
      .insertInto('renameEvents')
      .values({ studentId: a.id, classId, oldDisplayName: a.name, newDisplayName: '阿杰家的小鱼', createdAt: at('20:15'), announcedAt: null })
      .returning('id')
      .executeTakeFirstOrThrow()

    // Another writer of the session's events holds its lock, not yet committed.
    let commit!: () => void
    const committed = new Promise<void>((resolve) => (commit = resolve))
    let locked!: () => void
    const lockTaken = new Promise<void>((resolve) => (locked = resolve))
    const writer = db.transaction().execute(async (trx) => {
      await lockSession(trx, sessionId)
      locked()
      await committed
    })
    await lockTaken

    const ticking = runtime.tick()
    let renameFree: boolean
    try {
      await waitFor(async () => {
        const { rows } = await sql<{ n: number }>`select count(*)::int as n from pg_locks where not granted`.execute(db)
        return rows[0]!.n > 0
      })
      // The call-on waits for the session and holds nothing else yet: the rename is not locked by it.
      renameFree = await db
        .transaction()
        .execute((trx) => trx.selectFrom('renameEvents').select('id').where('id', '=', rename.id).forUpdate().noWait().execute())
        .then(
          () => true,
          () => false,
        )
    } finally {
      commit()
      await writer
      await ticking
    }
    expect(renameFree).toBe(true)

    // Then it goes on as usual: the rename is announced at the call-on.
    expect(await db.selectFrom('renameEvents').select('announcedAt').execute()).toEqual([{ announcedAt: at('20:15') }])
    const steps = await db.selectFrom('classEvents').select('step').where('sessionId', '=', sessionId).orderBy('id').execute()
    expect(steps.map((s) => s.step).slice(-3)).toEqual([`rename-${rename.id}`, `rename-${rename.id}#2`, 'call-on'])
  })
})

describe('the school calendar', () => {
  type Calendar = NonNullable<SchoolConfig['calendar']>
  /** The example school with `calendar`, and with or without study halls at the weekend (as the example has them). */
  const school = (calendar: Calendar, weekendStudy = true): SchoolConfig => ({
    ...config,
    calendar,
    lesson: { ...config.lesson, weekendStudy },
  })

  /** What a class of `members` is told from the doors until 20:01 on `date`, as short lines. */
  async function toldAtOpening(p: { school: SchoolConfig; date: string; classNo?: number; members?: number }) {
    const { classId, members } = await seedClass({ classNo: p.classNo ?? 1, members: p.members ?? 1 })
    const clock = createTestClock(at('19:45', p.date))
    const hub = new RecordingHub()
    for (const m of members) hub.join(classId, m.id)
    const runtime = newRuntime({ clock, hub, config: p.school })
    await runtime.tick()
    clock.set(at('20:01', p.date))
    await runtime.tick()
    return hub.messages.map(show)
  }

  const SPEECH = ['我是{teacher}，是{className}的老师。', '{division}的这个班一共有{classSize}位同学。', '好了，第一节课马上开始。']

  describe('a break', () => {
    test('holds no class on its days, and opens again on the day the school is back', async () => {
      await seedClass({ members: 1 })
      const clock = createTestClock(at('19:45'))
      const runtime = newRuntime({
        clock,
        hub: new RecordingHub(),
        config: school({ breaks: [{ from: MON, reopensOn: '2026-11-04', name: '期中假' }] }),
      })

      for (const [date, time] of [[MON, '19:45'], [MON, '20:10'], [TUE, '19:45'], [TUE, '20:00']] as const) {
        clock.set(at(time, date))
        await runtime.tick()
      }
      expect(await sessionRows()).toEqual([])

      clock.set(at('19:45', '2026-11-04'))
      await runtime.tick()
      expect(await sessionRows()).toMatchObject([{ date: '2026-11-04' }])
    })

    test('holds no class before the opening day', async () => {
      await seedClass({ members: 1 })
      const clock = createTestClock(at('19:50'))
      const runtime = newRuntime({ clock, hub: new RecordingHub(), config: school({ openingDay: '2026-11-09', breaks: [] }) })

      await runtime.tick()
      expect(await sessionRows()).toEqual([])

      clock.set(at('19:50', '2026-11-09'))
      await runtime.tick()
      expect(await sessionRows()).toMatchObject([{ date: '2026-11-09' }])
    })
  })

  describe('the opening of a school day', () => {
    test('on the opening day the teacher gives the speech, then says what the lesson is', async () => {
      await insertLesson(db, { date: MON, title: '光的折射', subject: '科学', segments: SEGMENTS })

      const told = await toldAtOpening({
        school: school({ openingDay: MON, openingSpeech: SPEECH, breaks: [] }),
        date: MON,
        classNo: 2,
        members: 3,
      })

      expect(told).toEqual([
        'teacher 我是老周，是初中部·晚班·2 班的老师。',
        'teacher 初中部的这个班一共有3位同学。',
        'teacher 好了，第一节课马上开始。',
        `teacher ${lessonIntro('科学', '光的折射')}`,
      ])
      // Not the plain opening, which greets the class and names the teacher once more.
      expect(told.join()).not.toContain('同学们好')
    })

    test('the class size is the number of members when the doors opened', async () => {
      await insertLesson(db, { date: MON, segments: SEGMENTS })
      const { classId, members } = await seedClass({ members: 2 })
      const clock = createTestClock(at('19:45'))
      const hub = new RecordingHub()
      for (const m of members) hub.join(classId, m.id)
      const runtime = newRuntime({ clock, hub, config: school({ openingDay: MON, openingSpeech: ['一共{classSize}位同学。'], breaks: [] }) })
      await runtime.tick()

      // A third student comes into the class after the doors opened.
      await addStudent(classId)
      clock.set(at('20:01'))
      await runtime.tick()

      expect(hub.messages.map(show)[0]).toBe('teacher 一共2位同学。')
    })

    test('a study hall follows the speech with the study intro', async () => {
      const told = await toldAtOpening({
        school: school({ openingDay: MON, openingSpeech: SPEECH, breaks: [] }),
        date: MON,
      })

      expect(told).toEqual([
        'teacher 我是老周，是初中部·晚班·1 班的老师。',
        'teacher 初中部的这个班一共有1位同学。',
        'teacher 好了，第一节课马上开始。',
        `teacher ${studyIntro()}`,
      ])
    })

    test('a weekend study hall follows the speech with the titles of the week', async () => {
      const titles = ['静夜思', '勾股定理', 'My Day']
      for (const [i, title] of titles.entries()) {
        await insertLesson(db, { date: `2026-11-0${i + 2}`, title, segments: SEGMENTS })
      }

      const told = await toldAtOpening({
        school: school({ openingDay: SAT, openingSpeech: ['我是{teacher}。'], breaks: [] }),
        date: SAT,
      })

      expect(told).toEqual(['teacher 我是老周。', `teacher ${weekendIntro(titles)}`])
    })

    test('a weekend study hall that looks back on no lesson follows the speech with the study intro', async () => {
      const told = await toldAtOpening({
        school: school({ openingDay: SAT, openingSpeech: ['我是{teacher}。'], breaks: [] }),
        date: SAT,
      })

      expect(told).toEqual(['teacher 我是老周。', `teacher ${studyIntro()}`])
    })

    test('the first day back from a break has the speech of the break', async () => {
      await insertLesson(db, { date: MON, title: '光的折射', subject: '科学', segments: SEGMENTS })

      const told = await toldAtOpening({
        school: school({
          openingSpeech: ['这是开学讲话。'],
          breaks: [{ from: '2026-10-26', reopensOn: MON, name: '国庆假', speech: ['欢迎回来，我是{teacher}。', '{className}又见面啦。'] }],
        }),
        date: MON,
      })

      expect(told).toEqual([
        'teacher 欢迎回来，我是老周。',
        'teacher 初中部·晚班·1 班又见面啦。',
        `teacher ${lessonIntro('科学', '光的折射')}`,
      ])
    })

    test('the speech comes before the roster and the welcome of the students who joined', async () => {
      const { classId, members } = await seedClass({ members: 2 })
      const [a, b] = members as [Member, Member]
      const last = await insertSession(db, {
        classId,
        date: SUN,
        kind: 'study',
        startsAt: at('20:00', SUN),
        endsAt: at('20:30', SUN),
        members: [{ studentId: a.id, displayName: a.name }],
      })
      await db.updateTable('classSessions').set({ dismissedAt: at('20:31', SUN) }).where('id', '=', last).execute()
      const clock = createTestClock(at('19:45'))
      const hub = new RecordingHub()
      hub.join(classId, a.id)
      const runtime = newRuntime({ clock, hub, config: school({ openingDay: MON, openingSpeech: ['我是{teacher}。'], breaks: [] }) })
      await runtime.tick()
      clock.set(at('20:00'))
      await runtime.tick()

      expect(hub.messages.map(show)).toEqual([
        'teacher 我是老周。',
        `teacher ${studyIntro()}`,
        `roster +[${b.id} ${b.name}] -[]`,
        `teacher ${welcomeNewcomers([b.name])}`,
      ])
    })

    test('an ordinary day opens as usual, in a school that has a calendar and a speech', async () => {
      await insertLesson(db, { date: TUE, title: '光的折射', subject: '科学', segments: SEGMENTS })
      const calendar: Calendar = { openingDay: MON, openingSpeech: SPEECH, breaks: [] }

      expect(await toldAtOpening({ school: school(calendar), date: TUE })).toEqual([
        `teacher ${openingLesson('老周', '科学', '光的折射')}`,
      ])
    })

    test('an ordinary study hall opens as usual too, and so does a school with no calendar at all', async () => {
      const { calendar: _, ...noCalendar } = config
      expect(await toldAtOpening({ school: noCalendar, date: MON })).toEqual([`teacher ${openingStudy('老周')}`])
    })
  })

  describe('the dismissal', () => {
    const FRI = '2026-12-18'
    const BREAK = { from: '2026-12-21', reopensOn: '2027-01-04', name: '寒假' }

    /** What the class is told at the dismissal at 20:30 on `date`, as short lines. */
    async function toldAtDismissal(config: SchoolConfig, date: string) {
      const { classId, members } = await seedClass({ members: 1 })
      const clock = createTestClock(at('19:45', date))
      const hub = new RecordingHub()
      hub.join(classId, members[0]!.id)
      const runtime = newRuntime({ clock, hub, config })
      await runtime.tick()
      const timeline = await runUntil(runtime, clock, hub, at('20:31', date))
      return timeline.find(([time]) => time === '20:30')?.[1]
    }

    test('announces a break that starts with the next school day, between the farewell and the dismissal', async () => {
      const told = await toldAtDismissal(school({ breaks: [BREAK] }, false), FRI)

      expect(told).toEqual([
        `teacher ${dismissal()}`,
        'teacher 从12月21日开始放寒假，1月4日开学。',
        'dismissal',
      ])
    })

    test('says so when the day the school is back is not decided', async () => {
      const told = await toldAtDismissal(school({ breaks: [{ from: '2026-12-21', reopensOn: null }] }, false), FRI)

      expect(told).toEqual([
        `teacher ${dismissal()}`,
        'teacher 从12月21日开始放假，开学时间另行通知。',
        'dismissal',
      ])
    })

    test('announces nothing when the next school day is not in a break', async () => {
      // With study halls at the weekend, the day after Friday is a school day, and the break is two days off.
      expect(await toldAtDismissal(school({ breaks: [BREAK] }, true), FRI)).toEqual([`teacher ${dismissal()}`, 'dismissal'])
    })

    test('announces nothing on the Monday before a break that starts later in the week', async () => {
      const calendar: Calendar = { breaks: [{ from: '2026-11-04', reopensOn: '2026-11-09' }] }
      expect(await toldAtDismissal(school(calendar), MON)).toEqual([`teacher ${dismissal()}`, 'dismissal'])
    })

    test('writes the announcement as a class event of the dismissal step', async () => {
      await toldAtDismissal(school({ breaks: [BREAK] }, false), FRI)

      const rows = await db.selectFrom('classEvents').select(['step', 'kind']).where('step', 'like', 'dismissal%').orderBy('seq').execute()
      expect(rows).toEqual([
        { step: 'dismissal', kind: 'teacher' },
        { step: 'dismissal#2', kind: 'teacher' },
        { step: 'dismissal#3', kind: 'dismissal' },
      ])
    })
  })
})
