import { timingSafeEqual } from 'node:crypto'
import type { SchoolConfig } from '../shared/config.js'
import { hashSecret } from '../shared/secrets.js'
import { ApiError, type ErrorCode } from './errors.js'

// Helpers shared by the two flows that email a six-digit code: registration and key reset.

/** Emails are compared and stored trimmed and lower-cased. */
export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase()
}

/**
 * Route options for the four routes that send or check a code: a per-IP limit of their own, one counter per route,
 * stricter than the global one. @fastify/rate-limit counts a route with its own limit against that limit only.
 */
export function codeRouteConfig(config: SchoolConfig) {
  return { rateLimit: { max: config.codeRouteRateLimitPerMinute, timeWindow: '1 minute' } }
}

/** Compares a submitted code with the stored hash in constant time. */
export function codeMatches(storedHash: string, code: string): boolean {
  const stored = Buffer.from(storedHash, 'hex')
  const given = Buffer.from(hashSecret(code), 'hex')
  return stored.length === given.length && timingSafeEqual(stored, given)
}

/**
 * What a verification transaction hands back. A failure is a value rather than
 * a throw so the transaction still commits (a wrong code keeps its attempts + 1);
 * the caller throws `error` once the transaction is over.
 */
export type Outcome<T> = { ok: true; result: T } | { ok: false; error: ApiError }

export function fail(
  status: number,
  code: ErrorCode,
  extra: Record<string, unknown> = {},
): { ok: false; error: ApiError } {
  return { ok: false, error: new ApiError(status, code, extra) }
}
