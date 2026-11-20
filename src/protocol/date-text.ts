import { Type } from 'typebox'

// Kept apart from http.ts so that club-http.ts can use it without importing http.ts, which imports club-http.ts
// (`SchoolCalendar.clubs`): the two modules would otherwise need each other's values while they load.

/** A calendar day, `YYYY-MM-DD` in the school's timezone. */
export const DateText = Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' })
