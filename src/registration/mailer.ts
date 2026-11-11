import { createTransport } from 'nodemailer'

export type CodePurpose = 'register' | 'key_reset'

export interface Mailer {
  sendCode(to: string, purpose: CodePurpose, code: string): Promise<void>
  /** A plain notice to the operator, such as the monthly spending warning. */
  sendNotice(to: string, subject: string, text: string): Promise<void>
}

const SUBJECTS: Record<CodePurpose, string> = {
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
 * The mailer with `onFailure` called whenever a verification code cannot be sent; the error still goes to the caller.
 * Only `sendCode` is wrapped: a notice to the operator that fails is the alert mail's own business.
 */
export function withMailFailures(mailer: Mailer, onFailure: () => void): Mailer {
  return {
    async sendCode(to, purpose, code) {
      try {
        await mailer.sendCode(to, purpose, code)
      } catch (err) {
        onFailure()
        throw err
      }
    },
    sendNotice: (to, subject, text) => mailer.sendNotice(to, subject, text),
  }
}

/** The part of a nodemailer transport that the mailer uses. */
export interface MailTransport {
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
export function createSmtpMailer(smtpUrl: string, from: string, ttlMinutes: number): Mailer {
  return createTransportMailer(createTransport(smtpUrl), from, ttlMinutes)
}

/** For local development only, chosen with MAIL_TRANSPORT=console: prints the mail to stdout instead of sending it. */
export class ConsoleMailer implements Mailer {
  constructor(private readonly ttlMinutes: number) {}

  async sendCode(to: string, purpose: CodePurpose, code: string): Promise<void> {
    const { subject, text } = codeMessage(purpose, code, this.ttlMinutes)
    process.stdout.write(`[mail] 收件人：${to}\n[mail] 标题：${subject}\n[mail] ${text}\n`)
  }

  async sendNotice(to: string, subject: string, text: string): Promise<void> {
    process.stdout.write(`[mail] 收件人：${to}\n[mail] 标题：${subject}\n[mail] ${text}\n`)
  }
}

/** Keeps the mails in memory, for tests. */
export class MemoryMailer implements Mailer {
  readonly sent: { to: string; purpose: CodePurpose; code: string }[] = []

  readonly notices: { to: string; subject: string; text: string }[] = []

  async sendCode(to: string, purpose: CodePurpose, code: string): Promise<void> {
    this.sent.push({ to, purpose, code })
  }

  async sendNotice(to: string, subject: string, text: string): Promise<void> {
    this.notices.push({ to, subject, text })
  }
}
