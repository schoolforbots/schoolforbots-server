import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  ConsoleMailer,
  MemoryMailer,
  codeMessage,
  createSmtpMailer,
  createTransportMailer,
} from '../../src/registration/mailer.js'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('codeMessage', () => {
  test('registration mail copy', () => {
    expect(codeMessage('register', '123456', 10)).toEqual({
      subject: 'AI 学校验证码',
      text: '你的验证码是 123456，10 分钟内有效。如果不是你本人操作，请忽略这封邮件。',
    })
  })

  test('key reset mail has its own subject and the same body', () => {
    expect(codeMessage('key_reset', '654321', 15)).toEqual({
      subject: 'AI 学校 · 更换钥匙验证码',
      text: '你的验证码是 654321，15 分钟内有效。如果不是你本人操作，请忽略这封邮件。',
    })
  })
})

describe('mailers', () => {
  test('the transport mailer sends the copy from the configured address', async () => {
    const transport = { sendMail: vi.fn().mockResolvedValue({}) }
    const mailer = createTransportMailer(transport, 'AI 学校 <no-reply@example.com>', 10)

    await mailer.sendCode('a@example.com', 'register', '123456')

    expect(transport.sendMail).toHaveBeenCalledExactlyOnceWith({
      from: 'AI 学校 <no-reply@example.com>',
      to: 'a@example.com',
      subject: 'AI 学校验证码',
      text: '你的验证码是 123456，10 分钟内有效。如果不是你本人操作，请忽略这封邮件。',
    })
  })

  test('a failing transport rejects, so callers learn that the mail was not sent', async () => {
    const transport = { sendMail: vi.fn().mockRejectedValue(new Error('connection refused')) }
    await expect(createTransportMailer(transport, 'x@example.com').sendCode('a@example.com', 'register', '1')).rejects.toThrow(
      'connection refused',
    )
  })

  test('createSmtpMailer accepts an SMTP URL and does not connect until it sends', () => {
    expect(createSmtpMailer('smtp://user:pass@localhost:2525', 'x@example.com').sendCode).toBeTypeOf('function')
  })

  test('ConsoleMailer prints the mail to stdout', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    await new ConsoleMailer(10).sendCode('a@example.com', 'key_reset', '123456')
    const printed = write.mock.calls.map((c) => String(c[0])).join('')
    expect(printed).toContain('a@example.com')
    expect(printed).toContain('AI 学校 · 更换钥匙验证码')
    expect(printed).toContain('你的验证码是 123456，10 分钟内有效')
  })

  test('MemoryMailer records what was sent', async () => {
    const mailer = new MemoryMailer()
    await mailer.sendCode('a@example.com', 'register', '123456')
    await mailer.sendCode('b@example.com', 'key_reset', '654321')
    expect(mailer.sent).toEqual([
      { to: 'a@example.com', purpose: 'register', code: '123456' },
      { to: 'b@example.com', purpose: 'key_reset', code: '654321' },
    ])
  })
})
