import { createTransport } from 'nodemailer'
import { isMailServiceFault, mailErrorKind } from './mail-errors.js'

export type CodePurpose = 'register' | 'key_reset'

/**
 * What a notice to the operator is about, as fields. SMTP and the console send the subject and the text; a transport
 * that only sends approved templates (Tencent Cloud's API) fills its alert or budget template with these instead. An
 * alert has its kind's fixed name (`ALERT_NAMES` in ops/alerts.ts) and the time of the check in the school's time zone
 * (`YYYY-MM-DD HH:mm`); the budget notice has the month (`YYYY-MM`) and the two sums in yuan.
 */
export type NoticeFields =
  | { template: 'alert'; kind: string; time: string }
  | { template: 'budget'; month: string; spent: string; budget: string }

export interface Mailer {
  sendCode(to: string, purpose: CodePurpose, code: string): Promise<void>
  /** A notice to the operator: an alert, or the monthly spending warning. */
  sendNotice(to: string, subject: string, text: string, fields: NoticeFields): Promise<void>
}

export const SUBJECTS: Record<CodePurpose, string> = {
  register: '机器人网校验证码',
  key_reset: '机器人网校 · 更换钥匙验证码',
}

export function codeMessage(
  purpose: CodePurpose,
  code: string,
  ttlMinutes: number,
): { subject: string; text: string } {
  return {
    subject: SUBJECTS[purpose],
    text: `你的验证码是 ${code}，${ttlMinutes} 分钟内有效。如果不是你本人操作，请忽略这封邮件。`,
  }
}

/**
 * The mailer with `onFailure` called whenever a verification code cannot be sent because of the mail service (see
 * `isMailServiceFault`); a refused recipient only logs one line with the error's code, never the address. The error
 * still goes to the caller. Only `sendCode` is wrapped: a notice to the operator that fails is the alert mail's own
 * business.
 */
export function withMailFailures(
  mailer: Mailer,
  onFailure: () => void,
  log?: { info(obj: unknown, msg?: string): void },
): Mailer {
  return {
    async sendCode(to, purpose, code) {
      try {
        await mailer.sendCode(to, purpose, code)
      } catch (err) {
        if (isMailServiceFault(err)) onFailure()
        else log?.info({ code: mailErrorKind(err) }, 'a recipient address was refused')
        throw err
      }
    },
    sendNotice: (to, subject, text, fields) => mailer.sendNotice(to, subject, text, fields),
  }
}

/** The part of a nodemailer transport that the mailer uses. */
export interface MailTransport {
  /** Tries the connection to the mail server; rejects when it cannot be used. */
  verify?(): Promise<unknown>
  sendMail(message: { from: string; to: string; subject: string; text: string }): Promise<unknown>
}

/** `ttlMinutes` is the validity quoted in the mail text; pass `verificationCode.ttlMinutes` of the school config. */
export function createTransportMailer(transport: MailTransport, from: string, ttlMinutes: number): Mailer {
  return {
    async sendCode(to, purpose, code) {
      await transport.sendMail({ from, to, ...codeMessage(purpose, code, ttlMinutes) })
    },
    async sendNotice(to, subject, text) {
      await transport.sendMail({ from, to, subject, text })
    },
  }
}

/**
 * Sends through SMTP. `ttlMinutes` is the validity quoted in the mail text and
 * must equal `verificationCode.ttlMinutes` of the school config, so it has no default.
 */
export function createSmtpMailer(smtpUrl: string, from: string, ttlMinutes: number): Mailer & { verify(): Promise<void> } {
  const transport = createTransport(smtpUrl)
  return {
    ...createTransportMailer(transport, from, ttlMinutes),
    async verify() {
      await transport.verify()
    },
  }
}

/** For local development only, chosen with MAIL_TRANSPORT=console: prints the mail to stdout instead of sending it. */
export class ConsoleMailer implements Mailer {
  constructor(private readonly ttlMinutes: number) {}

  async sendCode(to: string, purpose: CodePurpose, code: string): Promise<void> {
    const { subject, text } = codeMessage(purpose, code, this.ttlMinutes)
    process.stdout.write(`[mail] 收件人：${to}\n[mail] 标题：${subject}\n[mail] ${text}\n`)
  }

  async sendNotice(to: string, subject: string, text: string, _fields: NoticeFields): Promise<void> {
    process.stdout.write(`[mail] 收件人：${to}\n[mail] 标题：${subject}\n[mail] ${text}\n`)
  }
}

/** Keeps the mails in memory, for tests. */
export class MemoryMailer implements Mailer {
  readonly sent: { to: string; purpose: CodePurpose; code: string }[] = []

  readonly notices: { to: string; subject: string; text: string; fields: NoticeFields }[] = []

  async sendCode(to: string, purpose: CodePurpose, code: string): Promise<void> {
    this.sent.push({ to, purpose, code })
  }

  async sendNotice(to: string, subject: string, text: string, fields: NoticeFields): Promise<void> {
    this.notices.push({ to, subject, text, fields })
  }
}
