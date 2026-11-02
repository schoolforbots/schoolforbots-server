import type { Kysely } from 'kysely'
import type { Slot } from '../shared/config.js'
import { SEAT_STATUSES, type Database } from '../shared/db.js'

// Seat accounting shared by the flows that put a student into a slot: verify, re-enroll and the nightly waitlist promotion.

/** Statuses that count against a slot's capacity; waitlisted students wait outside it. */
export const CAPACITY_STATUSES = ['pending', 'active', 'suspended'] as const

/**
 * How many students of a slot hold a counted seat. Callers compare it with `config.slotCapacity`
 * after taking `lock(trx, slotLockKey(slot))`, so concurrent callers cannot overshoot the capacity.
 */
export async function slotOccupancy(trx: Kysely<Database>, slot: Slot): Promise<number> {
  const { count } = await trx
    .selectFrom('students')
    .select((eb) => eb.fn.countAll().as('count'))
    .where('slot', '=', slot)
    .where('status', 'in', [...CAPACITY_STATUSES])
    .executeTakeFirstOrThrow()
  return Number(count)
}

/**
 * Whether anyone waits for a seat in the slot. A newcomer (verify, re-enroll) joins the waitlist when this is true,
 * even if the slot has room: the nightly job promotes the waiting students first, so nobody jumps ahead of them.
 * Like `slotOccupancy`, it is read after taking `lock(trx, slotLockKey(slot))`.
 */
export async function slotHasWaitlist(trx: Kysely<Database>, slot: Slot): Promise<boolean> {
  const waiting = await trx
    .selectFrom('students')
    .select('id')
    .where('slot', '=', slot)
    .where('status', '=', 'waitlisted')
    .limit(1)
    .executeTakeFirst()
  return waiting !== undefined
}

/** How many seats an email holds (waitlisted ones included), against `config.maxStudentsPerEmail`. */
export async function seatsOfEmail(db: Kysely<Database>, email: string): Promise<number> {
  const { count } = await db
    .selectFrom('students')
    .select((eb) => eb.fn.countAll().as('count'))
    .where('email', '=', email)
    .where('status', 'in', [...SEAT_STATUSES])
    .executeTakeFirstOrThrow()
  return Number(count)
}

/** True for the unique violation of `students_install_seat`: an install holds at most one seat. */
export function isInstallSeatViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === '23505' &&
    (err as { constraint?: unknown }).constraint === 'students_install_seat'
  )
}
