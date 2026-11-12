/**
 * The codes of Tencent Cloud's email API that only say one recipient address was refused: a malformed or invalid
 * address, too many mails to that address in a short time, an address that unsubscribed, one on Tencent Cloud's own
 * blacklist, a recipient that refused the mail, a mailbox of a kind it does not send to.
 */
const TENCENT_RECIPIENT_REFUSED = new Set([
  'FailedOperation.IncorrectEmail',
  'InvalidParameterValue.ReceiverEmailInvalid',
  'FailedOperation.FrequencyLimit',
  'FailedOperation.ReceiverHasUnsubscribed',
  'FailedOperation.EmailAddrInBlacklist',
  'FailedOperation.RejectedByRecipients',
  'FailedOperation.UnsupportMailType',
])

/**
 * Whether a failed send says the mail service itself is in trouble, as opposed to one recipient address being
 * refused. Only the first is counted for the `mail_failed` alert and `GET /healthz/mail`: a few made-up addresses in a
 * row must not look like an outage.
 *
 * Tencent Cloud's email API (a `TencentSesError`) goes by its error code: the codes in `TENCENT_RECIPIENT_REFUSED`
 * are not a fault, every other one is. That includes the daily limit, the quota, a template or sender that is not
 * usable, too many requests, a key that does not work, and `FailedOperation.TemporaryBlocked`: a mailbox provider
 * refusing everything from this sender for about 10 minutes, which stops mail to every address there and speaks for
 * the sender's reputation. A call that cannot be made or times out (fetch's own errors) is a fault too, as is any
 * error not recognised here.
 *
 * SMTP goes by nodemailer's `code`, `command` (the SMTP step it failed at) and `responseCode`:
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
  const { name, code, command, responseCode } = err as { name?: unknown; code?: unknown; command?: unknown; responseCode?: unknown }
  // Told apart by its name, as nodemailer's errors are by their fields, so this module needs neither transport.
  if (name === 'TencentSesError') return !(typeof code === 'string' && TENCENT_RECIPIENT_REFUSED.has(code))
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
