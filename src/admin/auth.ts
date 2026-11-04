import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
const TOTP_STEP_SECONDS = 30

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31]
  return out
}

/** RFC 4648 base32, case-insensitive, spaces and `=` padding ignored. Anything else throws. */
export function base32Decode(text: string): Buffer {
  const clean = text.replace(/[\s=]/g, '').toUpperCase()
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const ch of clean) {
    const index = BASE32.indexOf(ch)
    if (index < 0) throw new Error('not base32')
    value = (value << 5) | index
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

function hotp(key: Buffer, counter: number, digits: number): string {
  const message = Buffer.alloc(8)
  message.writeBigUInt64BE(BigInt(counter))
  const mac = createHmac('sha1', key).update(message).digest()
  const offset = (mac[19] ?? 0) & 0x0f
  const binary = mac.readUInt32BE(offset) & 0x7fffffff
  return String(binary % 10 ** digits).padStart(digits, '0')
}

const stepOf = (at: Date) => Math.floor(at.getTime() / 1000 / TOTP_STEP_SECONDS)

/** The one-time code for `at` (RFC 6238: HMAC-SHA-1, 30-second steps). `digits` is 6 except in the RFC's test vectors. */
export function totpNow(secretBase32: string, at: Date, digits = 6): string {
  return hotp(base32Decode(secretBase32), stepOf(at), digits)
}

/** Whether `code` is the code of the step at `at` or of the one before or after it. Every candidate is compared. */
export function verifyTotp(secretBase32: string, code: string, at: Date): boolean {
  let key: Buffer
  try {
    key = base32Decode(secretBase32)
  } catch {
    return false
  }
  const given = Buffer.from(code)
  let ok = false
  for (const offset of [-1, 0, 1]) {
    const expected = Buffer.from(hotp(key, stepOf(at) + offset, 6))
    if (given.length === expected.length && timingSafeEqual(given, expected)) ok = true
  }
  return ok
}

const SCRYPT = { N: 16384, r: 8, p: 1, keyLength: 32, saltLength: 16 }
// Parameters read from the stored hash are bounded, so a mangled value cannot make a login allocate gigabytes.
const SCRYPT_MAX_N = 2 ** 20

/** scrypt, stored as `scrypt$N$r$p$salt$hash` with the salt and the hash in base64. */
export function hashPassword(password: string): string {
  const salt = randomBytes(SCRYPT.saltLength)
  const hash = scryptSync(password, salt, SCRYPT.keyLength, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    maxmem: 256 * SCRYPT.N * SCRYPT.r,
  })
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), hash.toString('base64')].join('$')
}

/** False for a wrong password and for a stored value that is not a hash this file made. */
export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  const [N, r, p] = [Number(parts[1]), Number(parts[2]), Number(parts[3])]
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false
  if (N < 2 || N > SCRYPT_MAX_N || (N & (N - 1)) !== 0 || r < 1 || r > 32 || p < 1 || p > 16) return false
  const salt = Buffer.from(parts[4] ?? '', 'base64')
  const expected = Buffer.from(parts[5] ?? '', 'base64')
  if (salt.length === 0 || expected.length === 0) return false
  try {
    const actual = scryptSync(password, salt, expected.length, { N, r, p, maxmem: 256 * N * r })
    return timingSafeEqual(actual, expected)
  } catch {
    return false
  }
}

/** A fresh session token and what the database keeps of it: only the hash, so a leaked table logs nobody in. */
export function newSessionToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url')
  return { token, hash: hashSessionToken(token) }
}

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}
