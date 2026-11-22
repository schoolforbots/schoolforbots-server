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
  /** When the school in maintenance stopped answering (ISO), or null while it answers. */
  silentSince?: string | null
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
/**
 * However late it is, how long a school in maintenance may stop answering before it counts towards down: the services
 * are stopped for work only after the maintenance has been on a while, perhaps past its expected time already.
 */
export const MIN_SILENCE_MS = 30 * 60_000
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
  let silentSince: string | null = null
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
    now.getTime() < silentUntil(prev, prev.silentSince ?? nowIso)
  ) {
    // The school was stopped on purpose; nothing to report until it answers again, or until it is well past the time
    // it said it would be back (a machine that died during maintenance, or maintenance never switched off).
    status = 'maintenance'
    message = manual.note ?? prev.message
    expectedBackAt = prev.expectedBackAt ?? null
    silentSince = prev.silentSince ?? nowIso
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
    (prev.expectedBackAt ?? null) !== expectedBackAt ||
    (prev.silentSince ?? null) !== silentSince
  if (!changed) return { next: prev, write: false, mail }

  const next: StoredState = {
    status,
    message,
    since: prev !== null && prev.status === status ? prev.since : nowIso,
    updatedAt: nowIso,
    failingSince,
    viaManual,
    expectedBackAt,
    silentSince,
  }
  return { next, write: true, mail }
}

/**
 * Until when a school in maintenance may stay silent: its expected time and a grace, or a while after the maintenance
 * began; at least a while after it stopped answering.
 */
function silentUntil(prev: StoredState, silentSince: string): number {
  const expected = prev.expectedBackAt == null ? NaN : Date.parse(prev.expectedBackAt)
  const planned = Number.isNaN(expected) ? Date.parse(prev.since) + MAINTENANCE_SILENCE_MS : expected + OVERRUN_GRACE_MS
  return Math.max(planned, Date.parse(silentSince) + MIN_SILENCE_MS)
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

/** One notice as `GET /v1/notices` gives it (times are UTC ISO). */
export interface NoticeItem {
  id: number
  title: string
  body: string
  kind: 'general' | 'maintenance'
  window: { startsAt: string; endsAt: string | null } | null
  publishedAt: string
  updatedAt: string | null
}

/** The last good read of the school's notices, as stored in KV `notices` and served in status.json. */
export interface NoticesCopy {
  /** When the school last gave these items (ISO); refreshed at most every `refreshMs` while they stay the same. */
  fetchedAt: string
  items: NoticeItem[]
}

export const MAX_NOTICES = 5

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isNullableString = (v: unknown): v is string | null => v === null || typeof v === 'string'

function parseNotice(v: unknown): NoticeItem | null {
  if (!isObject(v)) return null
  const { id, title, body, kind, window, publishedAt, updatedAt } = v
  if (typeof id !== 'number' || !Number.isInteger(id) || id < 1) return null
  if (typeof title !== 'string' || typeof body !== 'string') return null
  if (kind !== 'general' && kind !== 'maintenance') return null
  let win: NoticeItem['window'] = null
  if (window !== null) {
    if (!isObject(window) || typeof window.startsAt !== 'string' || !isNullableString(window.endsAt)) return null
    win = { startsAt: window.startsAt, endsAt: window.endsAt }
  }
  if (typeof publishedAt !== 'string' || !isNullableString(updatedAt)) return null
  return { id, title, body, kind, window: win, publishedAt, updatedAt }
}

/**
 * The items of a `GET /v1/notices` answer, or null when it does not have the right shape. One bad item rejects the
 * whole answer; at most `MAX_NOTICES` are kept, with only the known fields.
 */
export function parseNotices(body: unknown): NoticeItem[] | null {
  if (!isObject(body) || !Array.isArray(body.notices)) return null
  const items: NoticeItem[] = []
  for (const raw of body.notices.slice(0, MAX_NOTICES)) {
    const item = parseNotice(raw)
    if (item === null) return null
    items.push(item)
  }
  return items
}

/**
 * Whether to store a read of the notices. `items` is null when the read failed: the last copy stays as it is. New
 * items are written at once; the same items again only once the copy is `refreshMs` old, so `fetchedAt` says how
 * fresh the copy is to within that interval while KV is written at most about 24 times a day for it.
 */
export function decideNotices(
  prev: NoticesCopy | null,
  items: NoticeItem[] | null,
  now: Date,
  refreshMs = 60 * 60_000,
): { next: NoticesCopy | null; write: boolean } {
  if (items === null) return { next: prev, write: false }
  const same = prev !== null && JSON.stringify(prev.items) === JSON.stringify(items)
  if (same && now.getTime() - Date.parse(prev.fetchedAt) < refreshMs) return { next: prev, write: false }
  return { next: { fetchedAt: now.toISOString(), items }, write: true }
}
