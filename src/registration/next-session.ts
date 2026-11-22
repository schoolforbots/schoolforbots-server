import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import type { Kysely } from 'kysely'
import type { Static } from 'typebox'
import { lessonSteps, type StepName } from '../class/timeline.js'
import { NextSessionResult } from '../protocol/http.js'
import { isLessonDay, isSchoolDay } from '../shared/calendar.js'
import type { Division, SchoolConfig, Slot } from '../shared/config.js'
import { addDaysToDate, atLocalTime, localDate } from '../shared/local-time.js'
import { maintenanceBetween, type Maintenance } from '../shared/maintenance.js'
import { MEMBER_STATUSES, type Database } from '../shared/schema.js'
import type { RegistrationDeps } from './app.js'

/** How long a browser, or a cache on the way, may keep the answer. */
const CACHE_CONTROL = 'public, max-age=60'

/** How many days, today first, are looked through for a session. */
const DAYS_AHEAD = 30

const SLOTS: readonly Slot[] = ['morning', 'afternoon', 'evening']
const DIVISIONS: readonly Division[] = ['primary', 'junior', 'senior']

type NextSession = NonNullable<Static<typeof NextSessionResult>['session']>

/** When the session going on now, or the next one, is, to anyone. (No key needed, and nothing about a student.) */
export function nextSessionRoutes(deps: RegistrationDeps): FastifyPluginAsyncTypebox {
  return async (app) => {
    // Any site's web page may read this, errors and the rate limit included, as it may the calendar: see
    // `schoolRoutes` for why this is enough and safe.
    app.addHook('onRequest', async (_request, reply) => {
      reply.header('access-control-allow-origin', '*')
    })

    app.get('/v1/next-session', { schema: { response: { 200: NextSessionResult } } }, async (_request, reply) => {
      const session = await nextSession(deps.db, deps.config, deps.clock.now(), deps.maintenance.current())
      reply.header('cache-control', CACHE_CONTROL)
      return { session }
    })
  }
}

/**
 * The session going on at `now` (from its doors opening to its dismissal), or else the first one after it, within the
 * `DAYS_AHEAD` days from today: on a school day, in a slot with a class that has students in it. The class service
 * does not hold a slot the school was under maintenance for at any moment from its doors to its close (see
 * `openDueSlots`), so under maintenance none is going on: the first session whose doors open once the maintenance is
 * expected to end (or after now, when that is not known, or past) is given. A session whose doors have opened is
 * skipped too when a maintenance since over touched it.
 */
async function nextSession(
  db: Kysely<Database>,
  config: SchoolConfig,
  now: Date,
  maintenance: Maintenance | null,
): Promise<NextSession | null> {
  const divisionsBySlot = await memberDivisions(db)
  const today = localDate(now, config.timezone)

  for (let ahead = 0; ahead < DAYS_AHEAD; ahead++) {
    const date = addDaysToDate(today, ahead)
    if (!isSchoolDay(date, config)) continue
    for (const slot of SLOTS) {
      const divisions = divisionsBySlot.get(slot) ?? []
      if (divisions.length === 0) continue
      const startsAt = atLocalTime(date, config.slots[slot].start, config.timezone)
      const { doorsAt, endsAt, closeAt } = timesOf(startsAt, config)
      if (maintenance !== null) {
        const back = maintenance.expectedBackAt
        if (doorsAt <= now || (back !== null && doorsAt < back)) continue
      } else {
        if (endsAt <= now) continue
        // Only a slot whose doors have opened can have met a maintenance that is over.
        if (doorsAt <= now && (await maintenanceBetween(db, doorsAt, closeAt))) continue
      }
      return {
        date,
        slot,
        startsAt: startsAt.toISOString(),
        endsAt: endsAt.toISOString(),
        doorsOpenAt: doorsAt.toISOString(),
        inProgress: maintenance === null && doorsAt <= now,
        ...(await whatIsTaught(db, config, date, divisions)),
      }
    }
  }
  return null
}

/**
 * When a session starting at `startsAt` opens its doors, is dismissed and closes, as the class service times it. These
 * do not depend on the kind of session.
 */
function timesOf(startsAt: Date, config: SchoolConfig): { doorsAt: Date; endsAt: Date; closeAt: Date } {
  const steps = lessonSteps(startsAt, 'lesson', config.lesson, 1, config.teacherAi.answerLeadSeconds)
  const atOf = (name: StepName): Date => {
    const found = steps.find((s) => s.step === name)
    if (found === undefined) throw new Error(`The timeline has no ${name} step`)
    return found.at
  }
  return { doorsAt: atOf('doors'), endsAt: atOf('dismissal'), closeAt: atOf('close') }
}

/** The divisions of each slot that have a class with a student in it, in the order primary, junior, senior. */
async function memberDivisions(db: Kysely<Database>): Promise<Map<Slot, Division[]>> {
  const rows = await db
    .selectFrom('classes as c')
    .select(['c.slot', 'c.division'])
    .where((eb) =>
      eb.exists(
        eb
          .selectFrom('students as s')
          .select('s.id')
          .whereRef('s.classId', '=', 'c.id')
          .where('s.status', 'in', MEMBER_STATUSES),
      ),
    )
    .distinct()
    .execute()
  const bySlot = new Map<Slot, Division[]>()
  for (const slot of SLOTS) {
    bySlot.set(
      slot,
      DIVISIONS.filter((division) => rows.some((r) => r.slot === slot && r.division === division)),
    )
  }
  return bySlot
}

/**
 * Whether the divisions have a lesson or a study hall on `date`, and the subject and title of each one's lesson, as
 * `planSession` decides it. The first session a class of the division has opened that day decides; before any has, a
 * lesson day (a weekday) is a lesson, its subject and title unknown until it is approved (the class service makes it a
 * study hall if it is still not approved when the doors open), and any other day a study hall. The session is a
 * lesson when any division has one.
 */
async function whatIsTaught(
  db: Kysely<Database>,
  config: SchoolConfig,
  date: string,
  divisions: readonly Division[],
): Promise<Pick<NextSession, 'kind' | 'divisions'>> {
  const opened = await db
    .selectFrom('classSessions as s')
    .innerJoin('classes as c', 'c.id', 's.classId')
    .leftJoin('lessons as l', 'l.id', 's.lessonId')
    .select(['c.division', 's.kind', 'l.subject', 'l.title'])
    .where('s.date', '=', date)
    .where('c.division', 'in', divisions)
    .orderBy('s.startsAt')
    .orderBy('s.id')
    .execute()
  const approved = isLessonDay(date, config)
    ? await db
        .selectFrom('lessons')
        .select(['division', 'subject', 'title'])
        .where('date', '=', date)
        .where('division', 'in', divisions)
        .where('approvedAt', 'is not', null)
        .execute()
    : []

  const plans = divisions.map((division) => {
    // The rows are in the order the sessions began, so the first of the division is the one that decided.
    const decided = opened.find((r) => r.division === division)
    if (decided !== undefined) {
      return decided.kind === 'lesson'
        ? { division, lesson: true, subject: decided.subject, title: decided.title }
        : { division, lesson: false, subject: null, title: null }
    }
    if (!isLessonDay(date, config)) return { division, lesson: false, subject: null, title: null }
    const lesson = approved.find((r) => r.division === division)
    return { division, lesson: true, subject: lesson?.subject ?? null, title: lesson?.title ?? null }
  })
  return {
    kind: plans.some((p) => p.lesson) ? 'lesson' : 'study',
    divisions: plans.map(({ division, subject, title }) => ({ division, subject, title })),
  }
}
