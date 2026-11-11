import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { Type, type Static } from 'typebox'
import {
  DateText,
  SchoolCalendar,
  SchoolRulesDiffResult,
  SchoolRulesResult,
  SchoolRulesVersionResult,
} from '../protocol/http.js'
import { calendarStatus, nextSchoolDay } from '../shared/calendar.js'
import type { SchoolConfig } from '../shared/config.js'
import type { Maintenance } from '../shared/maintenance.js'
import { localDate } from '../shared/local-time.js'
import { diffSchoolRules, schoolRulesUrl, type SchoolRulesVersion } from '../shared/school-rules.js'
import type { RegistrationDeps } from './app.js'
import { ApiError } from './errors.js'

const SchoolRulesParams = Type.Object({ version: DateText })
const SchoolRulesDiffQuery = Type.Object({ from: DateText })

/**
 * What the school publishes about itself, to anyone: the calendar and the school rules. (No key needed, so nothing
 * about a student.)
 */
export function schoolRoutes(deps: RegistrationDeps): FastifyPluginAsyncTypebox {
  return async (app) => {
    app.get('/v1/school-calendar', { schema: { response: { 200: SchoolCalendar } } }, async () =>
      schoolCalendarOn(localDate(deps.clock.now(), deps.config.timezone), deps.config, deps.maintenance.current()),
    )

    const { schoolRules } = deps

    app.get('/v1/school-rules', { schema: { response: { 200: SchoolRulesResult } } }, async () => ({
      ...published(schoolRules.current),
      versions: schoolRules.versions.map((v) => v.version),
    }))

    // A static path, which Fastify matches before the parametric one below: `diff` is never taken for a version.
    app.get(
      '/v1/school-rules/diff',
      { schema: { querystring: SchoolRulesDiffQuery, response: { 200: SchoolRulesDiffResult } } },
      async (request) => {
        const { from } = request.query
        const diff = diffSchoolRules(schoolRules, from)
        if (diff === null) throw new ApiError(404, 'not_found')
        return { from, to: schoolRules.current.version, diff }
      },
    )

    app.get(
      '/v1/school-rules/:version',
      { schema: { params: SchoolRulesParams, response: { 200: SchoolRulesVersionResult } } },
      async (request) => {
        const found = schoolRules.versions.find((v) => v.version === request.params.version)
        if (found === undefined) throw new ApiError(404, 'not_found')
        return published(found)
      },
    )
  }
}

/** A version of the school rules as the routes give it, with where to read it on GitHub. */
function published(v: SchoolRulesVersion): Static<typeof SchoolRulesVersionResult> {
  return { version: v.version, changes: v.changes, url: schoolRulesUrl(v.version), text: v.text }
}

/** The calendar as it stands on the school day `today`: the state of the school, and the breaks not over yet. */
function schoolCalendarOn(
  today: string,
  config: SchoolConfig,
  maintenance: Maintenance | null,
): Static<typeof SchoolCalendar> {
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
  return { today, state, breakName, reopensOn, openingDay: config.calendar?.openingDay ?? null,
    breaks,
    maintenance:
      maintenance === null
        ? null
        : {
            message: maintenance.message,
            since: maintenance.since.toISOString(),
            expectedBackAt: maintenance.expectedBackAt?.toISOString() ?? null,
          },
  }
}
