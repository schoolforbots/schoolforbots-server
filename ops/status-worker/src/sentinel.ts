// Pure decision logic for the sentinel: no network, no KV, no clock of its own.

export type Status = 'ok' | 'maintenance' | 'down'

export interface StoredState {
  status: Status
  message: string | null
  since: string
  updatedAt: string
  failingSince: string | null
  /** True when the current maintenance was switched on by hand (the `manual` key). */
  viaManual?: boolean
  /** When the school said, last time it answered in maintenance, it expects to be back (ISO), or null. */
  expectedBackAt?: string | null
}

export interface Probe {
  healthy: boolean
  /** The school's maintenance, as `GET /v1/school-calendar` gives it; `expectedBackAt` is ISO, absent or null if not set. */
  maintenance: { message: string; expectedBackAt?: string | null } | null
}

export interface Manual {
  maintenance: boolean
  note: string | null
}

export interface MailState {
  badSince: string | null
  notifiedAt: string | null
}

const DEFAULT_MAINTENANCE = '学校正在维护'
/** How long past its expected time a school in maintenance that does not answer counts towards down. */
export const OVERRUN_GRACE_MS = 30 * 60_000
/** With no expected time: how long after the maintenance began a school that does not answer counts towards down. */
export const MAINTENANCE_SILENCE_MS = 4 * 60 * 60_000
const DEFAULT_DOWN = '学校的服务器出了故障，正在抢修。'

export function decide(
  prev: StoredState | null,
  probe: Probe,
  manual: Manual,
  now: Date,
  downAfterMs = 5 * 60_000,
): { next: StoredState; write: boolean; mail: 'down' | 'up' | null } {
  const nowIso = now.toISOString()
  let status: Status
  let message: string | null
  let failingSince: string | null = null
  let viaManual = false
  let expectedBackAt: string | null = null
  let mail: 'down' | 'up' | null = null

  const schoolMaintenance = probe.maintenance !== null
  if (manual.maintenance || schoolMaintenance) {
    status = 'maintenance'
    message = manual.note ?? (probe.maintenance?.message || null) ?? DEFAULT_MAINTENANCE
    viaManual = manual.maintenance
    expectedBackAt = probe.maintenance?.expectedBackAt ?? null
  } else if (probe.healthy) {
    status = 'ok'
    message = null
    if (prev?.status === 'down') mail = 'up'
  } else if (
    prev?.status === 'maintenance' &&
    prev.viaManual !== true &&
    prev.failingSince === null &&
    now.getTime() < silentUntil(prev)
  ) {
    // The school was stopped on purpose; nothing to report until it answers again, or until it is well past the time
    // it said it would be back (a machine that died during maintenance, or maintenance never switched off).
    status = 'maintenance'
    message = manual.note ?? prev.message
    expectedBackAt = prev.expectedBackAt ?? null
  } else {
    // Already down, or counting towards down. Maintenance clears failingSince, so after it ends the count restarts.
    failingSince = prev?.failingSince ?? nowIso
    if (prev?.status === 'down') {
      status = 'down'
      message = manual.note ?? DEFAULT_DOWN
    } else if (now.getTime() - Date.parse(failingSince) >= downAfterMs) {
      status = 'down'
      message = manual.note ?? DEFAULT_DOWN
      mail = 'down'
    } else if (prev?.status === 'maintenance') {
      // Manual maintenance was just removed: keep showing it until the count runs out.
      status = 'maintenance'
      message = manual.note ?? prev.message
      viaManual = prev.viaManual === true
    } else {
      status = 'ok'
      message = null
    }
  }

  const changed =
    prev === null ||
    prev.status !== status ||
    prev.message !== message ||
    prev.failingSince !== failingSince ||
    (prev.viaManual === true) !== viaManual ||
    (prev.expectedBackAt ?? null) !== expectedBackAt
  if (!changed) return { next: prev, write: false, mail }

  const next: StoredState = {
    status,
    message,
    since: prev !== null && prev.status === status ? prev.since : nowIso,
    updatedAt: nowIso,
    failingSince,
    viaManual,
    expectedBackAt,
  }
  return { next, write: true, mail }
}

/** Until when a school in maintenance may stay silent: its expected time and a grace, or a while after it began. */
function silentUntil(prev: StoredState): number {
  const expected = prev.expectedBackAt == null ? NaN : Date.parse(prev.expectedBackAt)
  if (!Number.isNaN(expected)) return expected + OVERRUN_GRACE_MS
  return Date.parse(prev.since) + MAINTENANCE_SILENCE_MS
}

export function decideMail(
  prev: MailState | null,
  mailOk: boolean | null,
  inMaintenance: boolean,
  now: Date,
  repeatMs = 60 * 60_000,
): { next: MailState; write: boolean; mail: 'mail_down' | 'mail_up' | null } {
  const cur: MailState = prev ?? { badSince: null, notifiedAt: null }
  const keep = { next: cur, write: false, mail: null } as const
  if (mailOk === null || inMaintenance) return keep
  const nowIso = now.toISOString()
  if (mailOk) {
    if (cur.badSince === null) return keep
    return { next: { badSince: null, notifiedAt: null }, write: true, mail: 'mail_up' }
  }
  if (cur.badSince === null) {
    return { next: { badSince: nowIso, notifiedAt: nowIso }, write: true, mail: 'mail_down' }
  }
  const last = cur.notifiedAt === null ? 0 : Date.parse(cur.notifiedAt)
  if (now.getTime() - last >= repeatMs) {
    return { next: { badSince: cur.badSince, notifiedAt: nowIso }, write: true, mail: 'mail_down' }
  }
  return keep
}

export interface ClubState {
  badSince: string | null
  notifiedAt: string | null
}

/**
 * Whether to mail about the club service, which status.json leaves out. `clubOk` is null when the probe says nothing
 * about it (the school cannot be reached, or counts as down: the school's own mail covers that). A club service that
 * keeps failing for `downAfterMs` is mailed, and again every `repeatMs` while it stays down; a recovery is mailed only
 * after a down was. Maintenance and a null `clubOk` mail nothing, and drop a count that has not been mailed yet: a club
 * service still starting right after the school is back must not count the time the school was away.
 */
export function decideClub(
  prev: ClubState | null,
  clubOk: boolean | null,
  inMaintenance: boolean,
  now: Date,
  downAfterMs = 5 * 60_000,
  repeatMs = 60 * 60_000,
): { next: ClubState; write: boolean; mail: 'club_down' | 'club_up' | null } {
  const cur: ClubState = prev ?? { badSince: null, notifiedAt: null }
  const keep = { next: cur, write: false, mail: null } as const
  const clear = { badSince: null, notifiedAt: null }
  if (clubOk === null || inMaintenance) {
    // Not an outage of the club service on its own; one already mailed is told when it is back.
    if (cur.badSince !== null && cur.notifiedAt === null) return { next: clear, write: true, mail: null }
    return keep
  }
  const nowIso = now.toISOString()
  if (clubOk) {
    if (cur.badSince === null) return keep
    return { next: clear, write: true, mail: cur.notifiedAt === null ? null : 'club_up' }
  }
  if (cur.badSince === null) return { next: { badSince: nowIso, notifiedAt: null }, write: true, mail: null }
  const due =
    cur.notifiedAt === null
      ? now.getTime() - Date.parse(cur.badSince) >= downAfterMs
      : now.getTime() - Date.parse(cur.notifiedAt) >= repeatMs
  if (!due) return keep
  return { next: { badSince: cur.badSince, notifiedAt: nowIso }, write: true, mail: 'club_down' }
}
