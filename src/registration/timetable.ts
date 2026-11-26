import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { Type, type Static } from 'typebox'
import { TimetableResult } from '../protocol/http.js'
import { calendarStatus, isSchoolDay } from '../shared/calendar.js'
import type { SchoolConfig } from '../shared/config.js'
import { addDaysToDate, isoWeekday, localDate } from '../shared/local-time.js'
import type { RegistrationDeps } from './app.js'
import { DIVISIONS, plansOfDays, slotsOf } from './next-session.js'
import { wholeNumber } from './records.js'

// A query value is text; `wholeNumber` reads it.
const TimetableQuery = Type.Object({ days: Type.Optional(Type.String()) })

/** How long a browser, or a cache on the way, may keep the answer. */
const CACHE_CONTROL = 'public, max-age=60'

/** The most days, today first, one answer gives. */
export const TIMETABLE_DAYS = 14

type Day = Static<typeof TimetableResult>['days'][number]

/**
 * The whole school's timetable for the next days, to anyone: for each day, whether the school holds sessions, when,
 * and the subject and title of each division's approved lesson. (No key needed, and nothing about a student or a
 * class.)
 */
export function timetableRoutes(deps: RegistrationDeps): FastifyPluginAsyncTypebox {
  return async (app) => {
    // Any site's web page may read this, errors and the rate limit included, as it may the calendar: see
    // `schoolRoutes` for why this is enough and safe.
    app.addHook('onRequest', async (_request, reply) => {
      reply.header('access-control-allow-origin', '*')
    })

    app.get(
      '/v1/timetable',
      { schema: { querystring: TimetableQuery, response: { 200: TimetableResult } } },
      async (request, reply) => {
        const days = wholeNumber(request.query.days, { fallback: TIMETABLE_DAYS, min: 1, max: TIMETABLE_DAYS })
        const today = localDate(deps.clock.now(), deps.config.timezone)
        const result = {
          today,
          lessonsPlannedThrough: addDaysToDate(today, deps.config.lessonGeneration.horizonDays),
          days: await timetable(deps, today, days),
        }
        reply.header('cache-control', CACHE_CONTROL)
        return result
      },
    )
  }
}

/** The `count` days from `today` on, as the timetable gives them. */
async function timetable(deps: RegistrationDeps, today: string, count: number): Promise<Day[]> {
  const { config } = deps
  const dates = Array.from({ length: count }, (_, ahead) => addDaysToDate(today, ahead))
  const schoolDays = dates.filter((date) => isSchoolDay(date, config))
  const plans = await plansOfDays(deps.db, config, schoolDays, DIVISIONS)

  return dates.map((date): Day => {
    const divisions = plans.get(date)
    if (divisions === undefined) {
      return { date, kind: 'holiday', holiday: holidayOf(date, config), slots: [], divisions: [] }
    }
    return {
      date,
      kind: divisions.some((p) => p.kind === 'lesson') ? 'lesson' : 'study',
      holiday: null,
      slots: slotsOf(date, config),
      divisions,
    }
  })
}

/** Why `date`, a day the school holds no session, is a holiday. */
function holidayOf(date: string, config: SchoolConfig): NonNullable<Day['holiday']> {
  const status = calendarStatus(date, config)
  if (status.state === 'not_started') return { reason: 'not_started', name: null }
  if (status.state === 'on_break') return { reason: 'break', name: status.breakName }
  // In term and still no session: the weekend, without weekend study halls.
  if (isoWeekday(date) <= 5) throw new Error(`${date} is a weekday in term, yet not a school day`)
  return { reason: 'weekend', name: null }
}
