/**
 * Whether a failed send says the mail service itself is in trouble, as opposed to one recipient address being
 * refused. Only the first is counted for the `mail_failed` alert and `GET /healthz/mail`: a few made-up addresses in a
 * row must not look like an outage.
 *
 * Goes by nodemailer's `code`, `command` (the SMTP step it failed at) and `responseCode`:
 * - Not a fault: code `EENVELOPE` at `RCPT TO` (the server refused the recipient: 550, 553, a deferral such as
 *   450/451 ...) unless the reply is 421 or 454, which speak for the whole server; and `EENVELOPE` at `API`, which
 *   nodemailer raises itself for an address that is empty or malformed.
 * - Everything else is a fault: connection refused or reset (`ECONNECTION`, `ESOCKET`), timeouts (`ETIMEDOUT`), DNS
 *   (`EDNS`), TLS and protocol errors, login failures (`EAUTH`), a refusal at `MAIL FROM` or `DATA` (`EENVELOPE` at
 *   those steps is about the sender or the server, not the recipient), and anything unrecognised.
 * An invalid sender, which nodemailer also raises as `EENVELOPE` at `API`, is ruled out at startup by the `MAIL_FROM`
 * check in `loadEnv`, so treating the `API` stage as a recipient problem stays safe.
 */
export function isMailServiceFault(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return true
  const { code, command, responseCode } = err as { code?: unknown; command?: unknown; responseCode?: unknown }
  if (code !== 'EENVELOPE') return true
  if (command === 'API') return false
  if (command === 'RCPT TO') return responseCode === 421 || responseCode === 454
  return true
}

/** What a log line may say about a failed send: the error's code, never the address or the server's reply. */
export function mailErrorKind(err: unknown): string {
  const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined
  return typeof code === 'string' ? code : 'unknown'
}
