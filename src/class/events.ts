import type { Kysely, Transaction } from 'kysely'
import type { Database } from '../shared/schema.js'

// The class event log: what the teacher did in a session, in order. Every event comes from one timeline step, and
// the unique (session, step) key lets a step run once even across a restart. A step that writes several events gives
// the first one the step's own name and the rest `<step>#2`, `<step>#3` ..., so the step's name marks it as done.

/** The kind of a marker that records a step which had nothing to say. It is never sent and never replayed. */
export const NOOP = 'noop'

export interface StoredEvent {
  seq: number
  step: string
  kind: string
  /** The `event` object of the `class.event` message. */
  payload: Record<string, unknown>
  at: Date
}

/** Locks the session's row until the transaction ends: its events are written and numbered by one writer at a time. */
async function lockSession(trx: Transaction<Database>, sessionId: number): Promise<void> {
  await trx.selectFrom('classSessions').select('id').where('id', '=', sessionId).forUpdate().executeTakeFirstOrThrow()
}

/**
 * Locks the session (as `appendClassEvent` does) and says whether `step` has already written an event. A step that
 * writes several events checks this first, so that it either writes all of them or, run a second time, none.
 */
export async function stepWritten(trx: Transaction<Database>, sessionId: number, step: string): Promise<boolean> {
  await lockSession(trx, sessionId)
  const row = await trx
    .selectFrom('classEvents')
    .select('id')
    .where('sessionId', '=', sessionId)
    .where('step', '=', step)
    .executeTakeFirst()
  return row !== undefined
}

/**
 * Writes one event of a session and returns its number, or null when `step` has already written one.
 *
 * The events the class sees are numbered 1, 2, 3 ... within the session, with no gaps, so a plugin can tell from
 * `seq` alone whether it missed one. A `noop` marker is numbered -1, -2 ... instead: it keeps the step from running
 * again without taking a number from the events the class sees.
 */
export async function appendClassEvent(
  trx: Transaction<Database>,
  p: { sessionId: number; step: string; kind: string; payload: object; at: Date },
): Promise<{ seq: number } | null> {
  if (await stepWritten(trx, p.sessionId, p.step)) return null

  const { top, bottom } = await trx
    .selectFrom('classEvents')
    .select((eb) => [eb.fn.max('seq').as('top'), eb.fn.min('seq').as('bottom')])
    .where('sessionId', '=', p.sessionId)
    .executeTakeFirstOrThrow()
  const seq = p.kind === NOOP ? Math.min(bottom ?? 0, 0) - 1 : Math.max(top ?? 0, 0) + 1

  await trx
    .insertInto('classEvents')
    .values({
      sessionId: p.sessionId,
      seq,
      step: p.step,
      kind: p.kind,
      payload: JSON.stringify(p.payload),
      createdAt: p.at,
    })
    .execute()
  return { seq }
}

/** The events of a session numbered after `lastSeq`, in order; the `noop` markers are not among them. */
export async function eventsAfter(db: Kysely<Database>, sessionId: number, lastSeq: number): Promise<StoredEvent[]> {
  const rows = await db
    .selectFrom('classEvents')
    .select(['seq', 'step', 'kind', 'payload', 'createdAt'])
    .where('sessionId', '=', sessionId)
    .where('seq', '>', Math.max(lastSeq, 0))
    .where('kind', '<>', NOOP)
    .orderBy('seq')
    .execute()
  return rows.map((r) => ({ seq: r.seq, step: r.step, kind: r.kind, payload: r.payload, at: r.createdAt }))
}

/** The `class.event` message for a stored event; `replayed` marks one sent again after a reconnect. */
export function classEventMessage(event: StoredEvent, replayed: boolean) {
  return { type: 'class.event', seq: event.seq, replayed, at: event.at.toISOString(), event: event.payload } as const
}
