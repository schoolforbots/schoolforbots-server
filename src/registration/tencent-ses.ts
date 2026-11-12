import { createHash, createHmac } from 'node:crypto'
import { SUBJECTS, type Mailer } from './mailer.js'
import { splitSender, type TencentSesSettings } from '../shared/config.js'

/**
 * Tencent Cloud's email API (邮件推送, API version 2020-10-02), called with Node's own `fetch` and signed with
 * TC3-HMAC-SHA256 (Tencent Cloud's "签名方法 v3").
 */

const HOST = 'ses.tencentcloudapi.com'
const VERSION = '2020-10-02'
const SERVICE = 'ses'
const CONTENT_TYPE = 'application/json; charset=utf-8'
/** How long one call may take before it is given up; the registration request that sends a code waits for it. */
const TIMEOUT_MS = 10_000

/** What a call needs: the API key, and the region the sending domain was created in. */
export interface TencentSesApi {
  secretId: string
  secretKey: string
  region: string
}

export interface TencentSesDeps {
  fetch?: typeof fetch
  now?: () => Date
}

/**
 * A call that failed. `code` is Tencent Cloud's error code (`FailedOperation.ExceedSendLimit`, `AuthFailure.…`), or
 * `HTTP <status>` when the reply was not a 200, or `NoResponse` when it held no `Response`; a check of ours may add
 * its own (see the mailer). The error's `Message` is left out on purpose: it may quote the recipient's address.
 */
export class TencentSesError extends Error {
  override readonly name = 'TencentSesError'

  constructor(
    readonly action: string,
    readonly code: string,
    readonly requestId: string | null,
  ) {
    super(`Tencent Cloud SES ${action} failed: ${code}${requestId === null ? '' : ` (request ${requestId})`}`)
  }
}

const sha256 = (data: string) => createHash('sha256').update(data).digest('hex')
const hmac = (key: string | Buffer, data: string) => createHmac('sha256', key).update(data).digest()

/**
 * The `Authorization` header of a POST to `/` with body `payload`, signing `headers` (which must include content-type
 * and host, exactly as sent). `timestamp` is in seconds; the date in the credential is its UTC date.
 */
export function tc3Authorization(p: {
  secretId: string
  secretKey: string
  service: string
  timestamp: number
  headers: Record<string, string>
  payload: string
}): string {
  const signed = Object.entries(p.headers)
    .map(([name, value]) => [name.toLowerCase(), value.trim().toLowerCase()] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  const signedHeaders = signed.map(([name]) => name).join(';')
  const canonicalRequest = [
    'POST',
    '/',
    '',
    signed.map(([name, value]) => `${name}:${value}\n`).join(''),
    signedHeaders,
    sha256(p.payload),
  ].join('\n')
  const date = new Date(p.timestamp * 1000).toISOString().slice(0, 10)
  const scope = `${date}/${p.service}/tc3_request`
  const stringToSign = ['TC3-HMAC-SHA256', String(p.timestamp), scope, sha256(canonicalRequest)].join('\n')
  const signingKey = hmac(hmac(hmac(`TC3${p.secretKey}`, date), p.service), 'tc3_request')
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex')
  return `TC3-HMAC-SHA256 Credential=${p.secretId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
}

/**
 * Calls `action` with `body` and returns what its `Response` holds. Rejects with a `TencentSesError` when Tencent
 * Cloud answers with an error (which it does with HTTP 200), and with fetch's own error when the call cannot be made
 * or takes longer than 10 seconds (a `TimeoutError`).
 */
export async function callTencentSes(
  api: TencentSesApi,
  action: string,
  body: object,
  deps: TencentSesDeps = {},
): Promise<Record<string, unknown>> {
  const payload = JSON.stringify(body)
  const timestamp = Math.floor((deps.now?.() ?? new Date()).getTime() / 1000)
  const signedHeaders = { 'content-type': CONTENT_TYPE, host: HOST, 'x-tc-action': action }
  const authorization = tc3Authorization({ ...api, service: SERVICE, timestamp, headers: signedHeaders, payload })

  // A timer of our own rather than AbortSignal.timeout, so that tests can run it with fake timers.
  const controller = new AbortController()
  const timer = setTimeout(
    () => controller.abort(new DOMException(`Tencent Cloud SES ${action} took longer than ${TIMEOUT_MS} ms`, 'TimeoutError')),
    TIMEOUT_MS,
  )
  try {
    // fetch sends the host itself, the same one as signed.
    const reply = await (deps.fetch ?? fetch)(`https://${HOST}/`, {
      method: 'POST',
      headers: {
        'content-type': CONTENT_TYPE,
        'x-tc-action': action,
        'x-tc-version': VERSION,
        'x-tc-region': api.region,
        'x-tc-timestamp': String(timestamp),
        authorization,
      },
      body: payload,
      signal: controller.signal,
    })
    if (reply.status !== 200) {
      // Read nothing of it, but let the connection go.
      await reply.body?.cancel().catch(() => undefined)
      throw new TencentSesError(action, `HTTP ${reply.status}`, null)
    }
    const json = (await reply.json()) as { Response?: Record<string, unknown> & { Error?: { Code?: unknown } } }
    const response = json.Response
    if (typeof response !== 'object' || response === null) throw new TencentSesError(action, 'NoResponse', null)
    const requestId = typeof response.RequestId === 'string' ? response.RequestId : null
    if (response.Error !== undefined) {
      const code = typeof response.Error.Code === 'string' ? response.Error.Code : 'UnknownError'
      throw new TencentSesError(action, code, requestId)
    }
    return response
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Sends through Tencent Cloud's email API, which only takes approved templates: a code with the code template
 * (variables `code` and `minutes`), an alert with the alert template (`kind` and `time`), the budget notice with the
 * budget template (`month`, `spent` and `budget`); see `NoticeFields`. A notice's text is not sent. The subjects are
 * not in the templates but sent with each mail, the same ones as by SMTP. All go as triggered mails (`TriggerType` 1),
 * which Tencent Cloud sends at once. `ttlMinutes` is the validity quoted in the mail and must equal
 * `verificationCode.ttlMinutes` of the school config.
 *
 * `verify` checks that the domain of `from` is still verified for sending, which also proves the key works; it
 * rejects with code `SenderDomainNotVerified` when Tencent Cloud says the domain is not verified.
 */
export function createTencentSesMailer(
  settings: TencentSesSettings,
  from: string,
  ttlMinutes: number,
  deps: TencentSesDeps = {},
): Mailer & { verify(): Promise<void> } {
  // Tencent Cloud takes `name <address>` with one space between, or the bare address.
  const sender = splitSender(from)
  const fromAddress = sender.name === null ? sender.address : `${sender.name} <${sender.address}>`
  const domain = sender.address.slice(sender.address.lastIndexOf('@') + 1)

  const send = async (to: string, subject: string, templateId: number, data: Record<string, string>) => {
    await callTencentSes(
      settings,
      'SendEmail',
      {
        FromEmailAddress: fromAddress,
        Destination: [to],
        Subject: subject,
        Template: { TemplateID: templateId, TemplateData: JSON.stringify(data) },
        TriggerType: 1,
      },
      deps,
    )
  }

  return {
    async sendCode(to, purpose, code) {
      await send(to, SUBJECTS[purpose], settings.codeTemplateId, { code, minutes: String(ttlMinutes) })
    },
    async sendNotice(to, subject, _text, fields) {
      const { template, ...data } = fields
      const [templateId, variable] =
        template === 'alert'
          ? [settings.alertTemplateId, 'TENCENT_SES_ALERT_TEMPLATE_ID']
          : [settings.budgetTemplateId, 'TENCENT_SES_BUDGET_TEMPLATE_ID']
      // Not reached in practice: without both templates the service does not start with OPERATOR_EMAIL set.
      if (templateId === null) throw new Error(`No ${template} template: set ${variable} to mail it to the operator`)
      await send(to, subject, templateId, data)
    },
    async verify() {
      const identity = await callTencentSes(settings, 'GetEmailIdentity', { EmailIdentity: domain }, deps)
      if (identity.VerifiedForSendingStatus !== true) {
        const requestId = typeof identity.RequestId === 'string' ? identity.RequestId : null
        throw new TencentSesError('GetEmailIdentity', 'SenderDomainNotVerified', requestId)
      }
    },
  }
}
