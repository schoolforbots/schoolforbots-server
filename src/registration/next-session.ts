import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import type { Kysely } from 'kysely'
import type { Static } from 'typebox'
import { planSession } from '../class/planning.js'
import { NextSessionResult } from '../protocol/http.js'
import { isLessonDay, isSchoolDay } from '../shared/calendar.js'
import type { Division, SchoolConfig, Slot } from '../shared/config.js'
import { addDaysToDate, atLocalTime, localDate } from '../shared/local-time.js'
import type { Maintenance } from '../shared/maintenance.js'
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
 * The session going on at `now` (from its doors opening to its end), or else the first one after it, within the
 * `DAYS_AHEAD` days from today: on a school day, in a slot with a class that has students in it. Under maintenance
 * none is going on: the first session to start once the maintenance is expected to end (or from now, when that is not
 * known, or past) is given instead.
 */
async function nextSession(
  db: Kysely<Database>,
  config: SchoolConfig,
  now: Date,
  maintenance: Maintenance | null,
): Promise<NextSession | null> {
  const divisionsBySlot = await memberDivisions(db)
  const back =
    maintenance === null ? null : new Date(Math.max(now.getTime(), maintenance.expectedBackAt?.getTime() ?? 0))
  const today = localDate(now, config.timezone)

  for (let ahead = 0; ahead < DAYS_AHEAD; ahead++) {
    const date = addDaysToDate(today, ahead)
    if (!isSchoolDay(date, config)) continue
    for (const slot of SLOTS) {
      const divisions = divisionsBySlot.get(slot) ?? []
      if (divisions.length === 0) continue
      const startsAt = atLocalTime(date, config.slots[slot].start, config.timezone)
      // The session's end is its slot's: the classes are dismissed then (the closing grace after it is not counted).
      const endsAt = atLocalTime(date, config.slots[slot].end, config.timezone)
      const doorsOpenAt = new Date(startsAt.getTime() - config.lesson.doorsOpenMinutesBefore * 60_000)
      if (back !== null ? startsAt < back : endsAt <= now) continue
      return {
        date,
        slot,
        startsAt: startsAt.toISOString(),
        endsAt: endsAt.toISOString(),
        doorsOpenAt: doorsOpenAt.toISOString(),
        inProgress: back === null && doorsOpenAt <= now,
        ...(await whatIsTaught(db, config, date, divisions)),
      }
    }
  }
  return null
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
 * Whether the divisions have a lesson or a study hall on `date`, and the subject and title of each one's lesson. The
 * class service decides with `planSession` when a class opens; until then a lesson day (a weekday) is a lesson, its
 * subject and title unknown until it is approved, and a study hall when the class service has made it one. The session
 * is a lesson when any division has one.
 */
async function whatIsTaught(
  db: Kysely<Database>,
  config: SchoolConfig,
  date: string,
  divisions: readonly Division[],
): Promise<Pick<NextSession, 'kind' | 'divisions'>> {
  const plans = await Promise.all(
    divisions.map(async (division) => {
      const plan = await planSession(db, config, { date, division })
      if (plan.kind === 'lesson') return { division, lesson: true, subject: plan.subject, title: plan.title }
      // No approved lesson: a lesson still being prepared, unless a class has opened the day as a study hall.
      const lesson = isLessonDay(date, config) && !(await sessionOpened(db, date, division))
      return { division, lesson, subject: null, title: null }
    }),
  )
  return {
    kind: plans.some((p) => p.lesson) ? 'lesson' : 'study',
    divisions: plans.map(({ division, subject, title }) => ({ division, subject, title })),
  }
}

/** Whether a class of `division` has opened a session on `date`, which decided the day for the division. */
async function sessionOpened(db: Kysely<Database>, date: string, division: Division): Promise<boolean> {
  const row = await db
    .selectFrom('classSessions as s')
    .innerJoin('classes as c', 'c.id', 's.classId')
    .select('s.id')
    .where('s.date', '=', date)
    .where('c.division', '=', division)
    .limit(1)
    .executeTakeFirst()
  return row !== undefined
}
