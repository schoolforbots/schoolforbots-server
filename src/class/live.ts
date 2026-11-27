import type { Kysely } from 'kysely'
import type { Static } from 'typebox'
import type { ClassLiveResult, LiveStep } from '../protocol/http.js'
import type { Clock } from '../shared/clock.js'
import { AnonIds, byShownOrder, livePeople } from '../shared/live.js'
import type { Database } from '../shared/schema.js'
import type { Hub } from './hub.js'
import type { ClassRuntime } from './runtime.js'
import type { StepName } from './timeline.js'

// The class service's half of the live campus (`GET /v1/class/live`): each class whose doors are open, how far its
// session has got, and who of it is connected. Nothing anyone said, no questions and no answers.

type Snapshot = Static<typeof ClassLiveResult>
type Step = Static<typeof LiveStep>

const SLOT_ORDER = { morning: 0, afternoon: 1, evening: 2 } as const
const DIVISION_ORDER = { primary: 0, junior: 1, senior: 2 } as const

/**
 * How far a session has got, from the steps it has run: the last one a visitor can see. The callouts and the close of a
 * call-on fall on the boundary of a segment and do not change what is going on, and the close step ends the session.
 */
export function liveStep(stepsRun: readonly StepName[], segments: number): Step {
  let step: Step = { name: 'doors', segment: null, segments }
  for (const name of stepsRun) {
    const numbered = /^(segment|qa|call-on)-(\d+)$/.exec(name)
    if (name === 'opening') step = { name: 'opening', segment: null, segments }
    else if (name === 'dismissal') step = { name: 'dismissal', segment: null, segments }
    else if (numbered !== null) {
      const kind = numbered[1] === 'call-on' ? 'call_on' : (numbered[1] as 'segment' | 'qa')
      step = { name: kind, segment: Number(numbered[2]), segments }
    }
  }
  return step
}

/** Takes the class service's snapshots; one `AnonIds` for all of them. */
export function classLive(deps: {
  db: Kysely<Database>
  clock: Clock
  runtime: Pick<ClassRuntime, 'openSessions'>
  hub: Pick<Hub, 'online'>
}): (now: number) => Promise<Snapshot> {
  const anonIds = new AnonIds()
  return async (now) => {
    const open = deps.runtime.openSessions()
    const classIds = open.map((o) => o.session.classId)
    const lessonIds = open.flatMap((o) => (o.lessonId === null ? [] : [o.lessonId]))
    const classes =
      classIds.length === 0
        ? []
        : await deps.db.selectFrom('classes').select(['id', 'classNo']).where('id', 'in', classIds).execute()
    const lessons =
      lessonIds.length === 0
        ? []
        : await deps.db.selectFrom('lessons').select(['id', 'title']).where('id', 'in', lessonIds).execute()
    const online = new Map(open.map((o) => [o.session.classId, deps.hub.online(o.session.classId)]))
    const people = await livePeople(deps.db, [...online.values()].flat(), anonIds, now)

    const classrooms = open.map((o) => {
      const { session } = o
      return {
        division: session.division,
        slot: session.slot,
        classNo: classes.find((c) => c.id === session.classId)?.classNo ?? 0,
        startsAt: session.startsAt.toISOString(),
        endsAt: session.endsAt.toISOString(),
        teacher: { name: o.teacher },
        kind: session.kind,
        title: session.kind === 'lesson' ? (lessons.find((l) => l.id === o.lessonId)?.title ?? null) : null,
        step: liveStep(o.stepsRun, o.segments),
        students: (online.get(session.classId) ?? []).flatMap((id) => people.get(id) ?? []).sort(byShownOrder),
      }
    })
    classrooms.sort(
      (a, b) =>
        SLOT_ORDER[a.slot] - SLOT_ORDER[b.slot] ||
        DIVISION_ORDER[a.division] - DIVISION_ORDER[b.division] ||
        a.classNo - b.classNo,
    )
    return { generatedAt: new Date(now).toISOString(), classrooms }
  }
}
