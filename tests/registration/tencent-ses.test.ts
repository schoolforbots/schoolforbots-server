import { describe, expect, test, vi } from 'vitest'
import {
  callTencentSes,
  createTencentSesMailer,
  tc3Authorization,
  TencentSesError,
} from '../../src/registration/tencent-ses.js'
import type { TencentSesSettings } from '../../src/shared/config.js'

// The worked example of Tencent Cloud's "签名方法 v3" page. In an earlier version of the page the key was printed
// with these asterisks in it, and its signature (signing content-type and host only) is the one below. The `\u`
// escapes are six literal characters each: the payload is signed exactly as sent.
const DOC = {
  secretId: 'AKIDz8krbsJ5yKBZQpn74WFkmLPx3*******',
  secretKey: 'Gu5t9xGARNpq86cd98joQYCN3*******',
  service: 'cvm',
  timestamp: 1551113065,
  payload: '{"Limit": 1, "Filters": [{"Values": ["\\u672a\\u547d\\u540d"], "Name": "instance-name"}]}',
}
const DOC_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', Host: 'cvm.tencentcloudapi.com' }

const API = { secretId: 'AKIDtest', secretKey: 'test-secret-key', region: 'ap-example' }

/** A fetch that answers every call with `body` (as JSON) and HTTP `status`, and records the calls. */
function fakeFetch(body: unknown, status = 200) {
  return vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), { status }))
}

function sentRequest(fetchMock: ReturnType<typeof fakeFetch>) {
  const [url, init] = fetchMock.mock.calls[0]!
  return { url: String(url), init: init!, headers: new Headers(init!.headers) }
}

describe('tc3Authorization', () => {
  test("matches the signature of Tencent Cloud's documented example", () => {
    expect(tc3Authorization({ ...DOC, headers: DOC_HEADERS })).toBe(
      'TC3-HMAC-SHA256 Credential=AKIDz8krbsJ5yKBZQpn74WFkmLPx3*******/2019-02-25/cvm/tc3_request, ' +
        'SignedHeaders=content-type;host, Signature=2230eefd229f582d8b1b891af7107b91597240707d778ab3738f756258d7652c',
    )
  })

  test('signs the header values in lower case, as the current example does with X-TC-Action', () => {
    // The canonical request of the current example (its SHA-256, 7019a55b…1e84, is printed on the page) has
    // `x-tc-action:describeinstances`; signed with the key above it gives this signature.
    expect(tc3Authorization({ ...DOC, headers: { ...DOC_HEADERS, 'X-TC-Action': 'DescribeInstances' } })).toBe(
      'TC3-HMAC-SHA256 Credential=AKIDz8krbsJ5yKBZQpn74WFkmLPx3*******/2019-02-25/cvm/tc3_request, ' +
        'SignedHeaders=content-type;host;x-tc-action, Signature=be4f67d323c78ab9acb7395e43c0dbcf822a9cfac32fea2449a7bc7726b770a3',
    )
  })
})

describe('callTencentSes', () => {
  test('posts the body as JSON with the action, version, region and time in signed headers, and returns the response', async () => {
    const fetchMock = fakeFetch({ Response: { MessageId: 'm1', RequestId: 'r1' } })
    const now = () => new Date('2026-11-12T08:00:00Z')

    const result = await callTencentSes(API, 'SendEmail', { Subject: '主题' }, { fetch: fetchMock, now })

    expect(result).toEqual({ MessageId: 'm1', RequestId: 'r1' })
    const { url, init, headers } = sentRequest(fetchMock)
    expect(url).toBe('https://ses.tencentcloudapi.com/')
    expect(init.method).toBe('POST')
    expect(init.body).toBe('{"Subject":"主题"}')
    expect(headers.get('content-type')).toBe('application/json; charset=utf-8')
    expect(headers.get('x-tc-action')).toBe('SendEmail')
    expect(headers.get('x-tc-version')).toBe('2020-10-02')
    expect(headers.get('x-tc-region')).toBe('ap-example')
    expect(headers.get('x-tc-timestamp')).toBe(String(Date.parse('2026-11-12T08:00:00Z') / 1000))
    expect(headers.get('authorization')).toBe(
      tc3Authorization({
        secretId: 'AKIDtest',
        secretKey: 'test-secret-key',
        service: 'ses',
        timestamp: Date.parse('2026-11-12T08:00:00Z') / 1000,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          host: 'ses.tencentcloudapi.com',
          'x-tc-action': 'SendEmail',
        },
        payload: '{"Subject":"主题"}',
      }),
    )
  })

  test('the date in the credential is the UTC date, not the local one', async () => {
    const fetchMock = fakeFetch({ Response: { RequestId: 'r1' } })
    // 07:30 the next morning in Beijing.
    await callTencentSes(API, 'SendEmail', {}, { fetch: fetchMock, now: () => new Date('2026-11-12T23:30:00Z') })
    expect(sentRequest(fetchMock).headers.get('authorization')).toContain('Credential=AKIDtest/2026-11-12/ses/tc3_request,')
  })

  test('an error in the response is thrown with its code and request id, but never its message', async () => {
    const fetchMock = fakeFetch({
      Response: { Error: { Code: 'FailedOperation.IncorrectEmail', Message: '邮箱 a@b.c 格式错误' }, RequestId: 'r9' },
    })
    const sent = callTencentSes(API, 'SendEmail', {}, { fetch: fetchMock })
    await expect(sent).rejects.toBeInstanceOf(TencentSesError)
    const err = (await sent.catch((e: unknown) => e)) as TencentSesError
    expect(err).toMatchObject({ name: 'TencentSesError', action: 'SendEmail', code: 'FailedOperation.IncorrectEmail', requestId: 'r9' })
    expect(err.message).toBe('Tencent Cloud SES SendEmail failed: FailedOperation.IncorrectEmail (request r9)')
    expect(JSON.stringify({ ...err, message: err.message, stack: err.stack })).not.toContain('a@b.c')
  })

  test('an HTTP status other than 200 is an error with that status as its code', async () => {
    const sent = callTencentSes(API, 'SendEmail', {}, { fetch: fakeFetch({}, 502) })
    await expect(sent).rejects.toMatchObject({ name: 'TencentSesError', code: 'HTTP 502', requestId: null })
  })

  test('a reply without a Response is an error', async () => {
    await expect(callTencentSes(API, 'SendEmail', {}, { fetch: fakeFetch({ nothing: true }) })).rejects.toMatchObject({
      code: 'NoResponse',
    })
  })

  test('a request that takes too long is given up', async () => {
    const hanging = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason))
        }),
    )
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const sent = callTencentSes(API, 'SendEmail', {}, { fetch: hanging })
      const settled = expect(sent).rejects.toMatchObject({ name: 'TimeoutError' })
      await vi.advanceTimersByTimeAsync(10_000)
      await settled
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('createTencentSesMailer', () => {
  const SETTINGS: TencentSesSettings = { ...API, codeTemplateId: 101, alertTemplateId: 102, budgetTemplateId: 103 }
  const FROM = '机器人网校 <no-reply@mail.example.com>'
  const sentBody = (fetchMock: ReturnType<typeof fakeFetch>, call = 0) =>
    JSON.parse(String(fetchMock.mock.calls[call]![1]!.body)) as Record<string, unknown>
  const sentAction = (fetchMock: ReturnType<typeof fakeFetch>, call = 0) =>
    new Headers(fetchMock.mock.calls[call]![1]!.headers).get('x-tc-action')
  const sent = () => fakeFetch({ Response: { MessageId: 'm1', RequestId: 'r1' } })

  test('a code goes out with the code template, its own subject, the configured validity, and as a triggered mail', async () => {
    const fetchMock = sent()
    await createTencentSesMailer(SETTINGS, FROM, 15, { fetch: fetchMock }).sendCode('a@example.com', 'key_reset', '123456')
    expect(sentAction(fetchMock)).toBe('SendEmail')
    expect(sentBody(fetchMock)).toEqual({
      FromEmailAddress: '机器人网校 <no-reply@mail.example.com>',
      Destination: ['a@example.com'],
      Subject: '机器人网校 · 更换钥匙验证码',
      Template: { TemplateID: 101, TemplateData: '{"code":"123456","minutes":"15"}' },
      TriggerType: 1,
    })
  })

  test('a registration code has the registration subject', async () => {
    const fetchMock = sent()
    await createTencentSesMailer(SETTINGS, FROM, 10, { fetch: fetchMock }).sendCode('a@example.com', 'register', '654321')
    expect(sentBody(fetchMock)).toMatchObject({ Subject: '机器人网校验证码' })
  })

  test('an alert goes out with the alert template, the given subject, its kind and its time, and no text', async () => {
    const fetchMock = sent()
    await createTencentSesMailer(SETTINGS, FROM, 10, { fetch: fetchMock }).sendNotice('o@example.com', '【机器人网校】磁盘快满了，已用 85%', '服务器的磁盘已经用了 85%。', {
      template: 'alert',
      kind: '磁盘快满了',
      time: '2026-11-12 21:30',
    })
    expect(sentBody(fetchMock)).toEqual({
      FromEmailAddress: '机器人网校 <no-reply@mail.example.com>',
      Destination: ['o@example.com'],
      Subject: '【机器人网校】磁盘快满了，已用 85%',
      Template: { TemplateID: 102, TemplateData: '{"kind":"磁盘快满了","time":"2026-11-12 21:30"}' },
      TriggerType: 1,
    })
  })

  test('the budget notice goes out with the budget template, the month and the two sums', async () => {
    const fetchMock = sent()
    await createTencentSesMailer(SETTINGS, FROM, 10, { fetch: fetchMock }).sendNotice('o@example.com', '标题', '正文', {
      template: 'budget',
      month: '2026-11',
      spent: '123.45',
      budget: '500',
    })
    expect(sentBody(fetchMock)).toMatchObject({
      Subject: '标题',
      Template: { TemplateID: 103, TemplateData: '{"month":"2026-11","spent":"123.45","budget":"500"}' },
      TriggerType: 1,
    })
  })

  test('without the template a notice needs, it is refused and nothing is sent', async () => {
    const fetchMock = sent()
    const mailer = createTencentSesMailer({ ...SETTINGS, alertTemplateId: null, budgetTemplateId: null }, FROM, 10, { fetch: fetchMock })
    await expect(mailer.sendNotice('o@example.com', 's', 't', { template: 'alert', kind: 'k', time: 't' })).rejects.toThrow(
      /TENCENT_SES_ALERT_TEMPLATE_ID/,
    )
    await expect(
      mailer.sendNotice('o@example.com', 's', 't', { template: 'budget', month: 'm', spent: '1', budget: '1' }),
    ).rejects.toThrow(/TENCENT_SES_BUDGET_TEMPLATE_ID/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test.each([
    ['a quoted name with extra spaces', '"机器人网校"   <no-reply@mail.example.com>', '机器人网校 <no-reply@mail.example.com>'],
    ['a bare address', 'no-reply@mail.example.com', 'no-reply@mail.example.com'],
    ['an empty name', ' <no-reply@mail.example.com>', 'no-reply@mail.example.com'],
  ])('the sender is written as Tencent Cloud wants it: %s', async (_name, from, expected) => {
    const fetchMock = sent()
    await createTencentSesMailer(SETTINGS, from, 10, { fetch: fetchMock }).sendCode('a@example.com', 'register', '1')
    expect(sentBody(fetchMock).FromEmailAddress).toBe(expected)
  })

  test('a failed send rejects with the error code', async () => {
    const fetchMock = fakeFetch({ Response: { Error: { Code: 'FailedOperation.ExceedSendLimit', Message: 'x' }, RequestId: 'r2' } })
    await expect(
      createTencentSesMailer(SETTINGS, FROM, 10, { fetch: fetchMock }).sendCode('a@example.com', 'register', '1'),
    ).rejects.toMatchObject({ code: 'FailedOperation.ExceedSendLimit' })
  })

  test('the check asks whether the domain of the sender is verified, and passes when it is', async () => {
    const fetchMock = fakeFetch({ Response: { VerifiedForSendingStatus: true, IdentityType: 'DOMAIN', RequestId: 'r3' } })
    await createTencentSesMailer(SETTINGS, FROM, 10, { fetch: fetchMock }).verify()
    expect(sentAction(fetchMock)).toBe('GetEmailIdentity')
    expect(sentBody(fetchMock)).toEqual({ EmailIdentity: 'mail.example.com' })
  })

  test('the check fails when the domain is not verified', async () => {
    const fetchMock = fakeFetch({ Response: { VerifiedForSendingStatus: false, RequestId: 'r4' } })
    await expect(createTencentSesMailer(SETTINGS, FROM, 10, { fetch: fetchMock }).verify()).rejects.toMatchObject({
      name: 'TencentSesError',
      action: 'GetEmailIdentity',
      code: 'SenderDomainNotVerified',
      requestId: 'r4',
    })
  })

  test('the check fails with the error code when the key or the domain is wrong', async () => {
    const fetchMock = fakeFetch({ Response: { Error: { Code: 'AuthFailure.SecretIdNotFound', Message: 'x' }, RequestId: 'r5' } })
    await expect(createTencentSesMailer(SETTINGS, FROM, 10, { fetch: fetchMock }).verify()).rejects.toMatchObject({
      code: 'AuthFailure.SecretIdNotFound',
    })
  })
})
