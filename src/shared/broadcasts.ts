import type { Kysely } from 'kysely'
import type { Division, SchoolConfig, Slot } from './config.js'
import { className } from './identity.js'
import type { Database } from './schema.js'

// What the admin pages and the students' API share about campus broadcasts: who one is addressed to, put in words.

export const DIVISION_ORDER: readonly Division[] = ['primary', 'junior', 'senior']
export const SLOT_ORDER: readonly Slot[] = ['morning', 'afternoon', 'evening']

/** How long after it is published a broadcast with no expiry of its own is still given out. */
export const BROADCAST_DAYS = 30

export interface Audience {
  divisions: readonly string[]
  slots: readonly string[]
  classIds: readonly number[]
}

/** The classes a broadcast names, by id, as the audience words need them. */
export type ClassNames = ReadonlyMap<number, string>

/** The names of the classes with these ids, for `audienceLabel`. */
export async function classNamesOf(db: Kysely<Database>, ids: readonly number[], config: SchoolConfig): Promise<ClassNames> {
  if (ids.length === 0) return new Map()
  const rows = await db
    .selectFrom('classes')
    .select(['id', 'division', 'slot', 'classNo'])
    .where('id', 'in', [...new Set(ids)])
    .execute()
  return new Map(rows.map((r) => [r.id, className(r.division, r.slot, r.classNo, config)]))
}

/**
 * Who a broadcast is addressed to, in Chinese: `全校`; the divisions and the slots, each in the school's order and
 * joined with 、, the two parts with ` · ` (`初中部 · 晚班`, `小学部、初中部`); or the classes' names joined with 、.
 */
export function audienceLabel(a: Audience, classes: ClassNames, config: SchoolConfig): string {
  if (a.classIds.length > 0) return a.classIds.map((id) => classes.get(id) ?? `${id} 号班`).join('、')
  const parts: string[] = []
  const divisions = DIVISION_ORDER.filter((d) => a.divisions.includes(d)).map((d) => config.divisions[d].label)
  const slots = SLOT_ORDER.filter((s) => a.slots.includes(s)).map((s) => config.slots[s].label)
  if (divisions.length > 0) parts.push(divisions.join('、'))
  if (slots.length > 0) parts.push(slots.join('、'))
  return parts.length === 0 ? '全校' : parts.join(' · ')
}
