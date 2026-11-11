import type { Kysely } from 'kysely'
import type { Database, OpsEventKind } from '../shared/schema.js'

export type OpsService = 'registration' | 'class'
export type { OpsEventKind }

/** Notes that a service has started, for the alert about a service that keeps restarting. */
export async function recordStart(db: Kysely<Database>, service: OpsService, at: Date): Promise<void> {
  await db.insertInto('serviceStarts').values({ service, startedAt: at }).execute()
}

/**
 * Notes something that went wrong, for the alert mails. Does not wait for the write and never throws: when the write
 * fails (the database is the very thing that is down, say) one log line says so, with the kind of error only.
 */
export function recordOpsEvent(
  db: Kysely<Database>,
  event: { service: OpsService; kind: OpsEventKind; at: Date },
  log?: { error(obj: unknown, msg?: string): void },
): void {
  try {
    db.insertInto('opsEvents')
      .values(event)
      .execute()
      .catch((err: unknown) => logFailure(log, event.kind, err))
  } catch (err) {
    logFailure(log, event.kind, err)
  }
}

function logFailure(log: { error(obj: unknown, msg?: string): void } | undefined, kind: OpsEventKind, err: unknown): void {
  try {
    log?.error({ kind, err: err instanceof Error ? err.name : 'unknown' }, 'could not record an ops event')
  } catch {
    // A logger that throws must not take the caller down either.
  }
}
