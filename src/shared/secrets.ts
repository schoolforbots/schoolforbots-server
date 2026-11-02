import { createHash, randomBytes, randomInt } from 'node:crypto'

/** A student's API key: `ais_` plus 32 random bytes in base64url (43 characters). */
export function generateStudentKey(): string {
  return `ais_${randomBytes(32).toString('base64url')}`
}

/** SHA-256 as lowercase hex. Keys and verification codes are stored only in this form. */
export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex')
}

/** A six-digit verification code, zero-padded. */
export function generateCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, '0')
}
