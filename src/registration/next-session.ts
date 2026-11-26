import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import type { Kysely } from 'kysely'
import type { Static } from 'typebox'
import { lessonSteps, type StepName } from '../class/timeline.js'
import { NextSchoolDayResult, NextSessionResult } from '../protocol/http.js'
import { isLessonDay, isSchoolDay, nextSchoolDay } from '../shared/calendar.js'
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
export const DIVISIONS: readonly Division[] = ['primary', 'junior', 'senior']

type NextSession = NonNullable<Static<typeof NextSessionResult>['session']>
type NextDay = NonNullable<Static<typeof NextSchoolDayResult>['day']>
export type DaySlots = NextDay['slots']
export type Plan = NextDay['divisions'][number]

/**
 * When the session going on now, or the next one, is, and what the next school day holds, to anyone. (No key needed,
 * and nothing about a student.)
 */
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

    app.get('/v1/next-school-day', { schema: { response: { 200: NextSchoolDayResult } } }, async (_request, reply) => {
      const day = await nextDay(deps.db, deps.config, deps.clock.now())
      reply.header('cache-control', CACHE_CONTROL)
      return { day }
    })
  }
}

/**
 * Today while it is a school day and its last slot has not been dismissed, or else the next school day: its slots'
 * times and what each of the three divisions has, whether or not any class has students. Null when the school is on a
 * break with no reopening day yet. A maintenance does not change the day.
 */
async function nextDay(db: Kysely<Database>, config: SchoolConfig, now: Date): Promise<NextDay | null> {
  const today = localDate(now, config.timezone)
  let date = nextSchoolDay(today, config)
  if (date === today) {
    const dismissed = slotsOf(today, config).every((s) => Date.parse(s.endsAt) <= now.getTime())
    if (dismissed) date = nextSchoolDay(addDaysToDate(today, 1), config)
  }
  if (date === null) return null

  const plans = await plansOf(db, config, date, DIVISIONS)
  return {
    date,
    kind: plans.some((p) => p.kind === 'lesson') ? 'lesson' : 'study',
    slots: slotsOf(date, config),
    divisions: plans,
  }
}

/** The three slots of `date`, morning, afternoon, evening: when each starts, is dismissed and opens its doors. */
export function slotsOf(date: string, config: SchoolConfig): DaySlots {
  return SLOTS.map((slot) => {
    const startsAt = atLocalTime(date, config.slots[slot].start, config.timezone)
    const { doorsAt, endsAt } = timesOf(startsAt, config)
    return { slot, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(), doorsOpenAt: doorsAt.toISOString() }
  })
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

/** Whether the divisions have a lesson or a study hall on `date`, and each one's subject and title: see `plansOf`. */
async function whatIsTaught(
  db: Kysely<Database>,
  config: SchoolConfig,
  date: string,
  divisions: readonly Division[],
): Promise<Pick<NextSession, 'kind' | 'divisions'>> {
  const plans = await plansOf(db, config, date, divisions)
  return {
    kind: plans.some((p) => p.kind === 'lesson') ? 'lesson' : 'study',
    divisions: plans.map(({ division, subject, title }) => ({ division, subject, title })),
  }
}

/**
 * Whether each of the divisions has a lesson or a study hall on `date`, and the subject and title of its lesson, as
 * `planSession` decides it. The first session a class of the division has opened that day decides; before any has, a
 * lesson day (a weekday) is a lesson, its subject and title unknown until it is approved (the class service makes it a
 * study hall if it is still not approved when the doors open), and any other day a study hall.
 */
async function plansOf(
  db: Kysely<Database>,
  config: SchoolConfig,
  date: string,
  divisions: readonly Division[],
): Promise<Plan[]> {
  const plans = await plansOfDays(db, config, [date], divisions)
  return plans.get(date) ?? []
}

/** `plansOf` for each of `dates` at once, in two queries whatever their number. */
export async function plansOfDays(
  db: Kysely<Database>,
  config: SchoolConfig,
  dates: readonly string[],
  divisions: readonly Division[],
): Promise<Map<string, Plan[]>> {
  const plans = new Map<string, Plan[]>()
  if (dates.length === 0 || divisions.length === 0) {
    for (const date of dates) plans.set(date, [])
    return plans
  }
  const opened = await db
    .selectFrom('classSessions as s')
    .innerJoin('classes as c', 'c.id', 's.classId')
    .leftJoin('lessons as l', 'l.id', 's.lessonId')
    .select(['s.date', 'c.division', 's.kind', 'l.subject', 'l.title'])
    .where('s.date', 'in', dates)
    .where('c.division', 'in', divisions)
    .orderBy('s.startsAt')
    .orderBy('s.id')
    .execute()
  const lessonDays = dates.filter((date) => isLessonDay(date, config))
  // Only an approved lesson is read: what one not approved yet says must not get out.
  const approved =
    lessonDays.length > 0
      ? await db
          .selectFrom('lessons')
          .select(['date', 'division', 'subject', 'title'])
          .where('date', 'in', lessonDays)
          .where('division', 'in', divisions)
          .where('approvedAt', 'is not', null)
          .execute()
      : []

  for (const date of dates) {
    plans.set(
      date,
      divisions.map((division): Plan => {
        // The rows are in the order the sessions began, so the first of the division is the one that decided.
        const decided = opened.find((r) => r.date === date && r.division === division)
        if (decided !== undefined) {
          return decided.kind === 'lesson'
            ? { division, kind: 'lesson', subject: decided.subject, title: decided.title }
            : { division, kind: 'study', subject: null, title: null }
        }
        if (!isLessonDay(date, config)) return { division, kind: 'study', subject: null, title: null }
        const lesson = approved.find((r) => r.date === date && r.division === division)
        return { division, kind: 'lesson', subject: lesson?.subject ?? null, title: lesson?.title ?? null }
      }),
    )
  }
  return plans
}
