import { isIP } from 'node:net'

/**
 * A client's address as an `inet` column takes it: without an IPv6 zone id (`fe80::1%en0` is `fe80::1`), which
 * Postgres refuses. Null when there is no address, or what is left is not one.
 */
export function inetAddress(raw: string | undefined): string | null {
  if (raw === undefined) return null
  const ip = raw.split('%')[0] ?? raw
  return isIP(ip) === 0 ? null : ip
}
