import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import type { Static } from 'typebox'
import { SchoolCalendar } from '../protocol/http.js'
import { calendarStatus, nextSchoolDay } from '../shared/calendar.js'
import type { SchoolConfig } from '../shared/config.js'
import { localDate } from '../shared/local-time.js'
import type { RegistrationDeps } from './app.js'

/** What the school publishes about itself, to anyone: the calendar. (No key needed, so nothing about a student.) */
export function schoolRoutes(deps: RegistrationDeps): FastifyPluginAsyncTypebox {
  return async (app) => {
    app.get('/v1/school-calendar', { schema: { response: { 200: SchoolCalendar } } }, async () =>
      schoolCalendarOn(localDate(deps.clock.now(), deps.config.timezone), deps.config),
    )
  }
}

/** The calendar as it stands on the school day `today`: the state of the school, and the breaks not over yet. */
function schoolCalendarOn(today: string, config: SchoolConfig): Static<typeof SchoolCalendar> {
  const { state, breakName, reopensOn } = calendarStatus(today, config)
  // A break is over from the day the school is back; the one that is on now is not.
  const breaks = (config.calendar?.breaks ?? [])
    .filter((b) => b.reopensOn === null || today < b.reopensOn)
    .map((b) => ({
      from: b.from,
      reopensOn: b.reopensOn === null ? null : nextSchoolDay(b.reopensOn, config),
      name: b.name ?? null,
    }))
    .sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0))
  return { today, state, breakName, reopensOn, openingDay: config.calendar?.openingDay ?? null, breaks }
}
