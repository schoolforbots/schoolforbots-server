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
}

export interface Probe {
  healthy: boolean
  maintenance: { message: string } | null
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
  let mail: 'down' | 'up' | null = null

  const schoolMaintenance = probe.maintenance !== null
  if (manual.maintenance || schoolMaintenance) {
    status = 'maintenance'
    message = manual.note ?? (probe.maintenance?.message || null) ?? DEFAULT_MAINTENANCE
    viaManual = manual.maintenance
  } else if (probe.healthy) {
    status = 'ok'
    message = null
    if (prev?.status === 'down') mail = 'up'
  } else if (prev?.status === 'maintenance' && prev.viaManual !== true && prev.failingSince === null) {
    // The school was stopped on purpose; nothing to report until it answers again.
    status = 'maintenance'
    message = prev.message
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
      message = prev.message
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
    (prev.viaManual === true) !== viaManual
  if (!changed) return { next: prev, write: false, mail }

  const next: StoredState = {
    status,
    message,
    since: prev !== null && prev.status === status ? prev.since : nowIso,
    updatedAt: nowIso,
    failingSince,
    viaManual,
  }
  return { next, write: true, mail }
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
