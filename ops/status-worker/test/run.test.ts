import { afterEach, describe, expect, it, vi } from 'vitest'
import worker, { runOnce, type Env } from '../src/index.js'

const T0 = Date.parse('2026-11-11T00:00:00Z')
const at = (min: number) => new Date(T0 + min * 60_000)

interface School {
  reg: number
  cls: number
  club: number
  mailOk: boolean
  maintenance: { message: string; expectedBackAt?: string | null } | null
  /** `GET /v1/notices`: the status code (0 throws) and the body. */
  notices: { status: number; body: unknown }
}

const NOTICE = {
  id: 1,
  title: '周六停课',
  body: '周六维护，停课一天。',
  kind: 'maintenance',
  window: { startsAt: '2026-11-28T01:00:00.000Z', endsAt: '2026-11-28T09:00:00.000Z' },
  publishedAt: '2026-11-22T08:00:00.000Z',
  updatedAt: null,
}

function setup() {
  const school: School = {
    reg: 200,
    cls: 200,
    club: 200,
    mailOk: true,
    maintenance: null,
    notices: { status: 200, body: { notices: [], more: false } },
  }
  const asked: string[] = []
  vi.stubGlobal('fetch', async (input: string | URL | Request) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const path = url.pathname
    asked.push(path + url.search)
    const j = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })
    if (path === '/healthz') return school.reg === 0 ? Promise.reject(new Error('x')) : j(school.reg, {})
    if (path === '/healthz/class') return school.cls === 0 ? Promise.reject(new Error('x')) : j(school.cls, {})
    if (path === '/healthz/club') return school.club === 0 ? Promise.reject(new Error('x')) : j(school.club, {})
    if (path === '/healthz/mail') return school.reg === 0 ? Promise.reject(new Error('x')) : j(200, { ok: school.mailOk })
    if (path === '/v1/school-calendar') return j(200, { maintenance: school.maintenance })
    if (path === '/v1/notices') {
      const n = school.notices
      return n.status === 0 ? Promise.reject(new Error('x')) : j(n.status, n.body)
    }
    return j(404, {})
  })
  const kv = new Map<string, string>()
  const ctl = { puts: [] as string[], failPuts: false, failSend: false, sent: [] as string[] }
  const env = {
    STATE: {
      get: async (k: string) => kv.get(k) ?? null,
      put: async (k: string, v: string) => {
        if (ctl.failPuts) throw new Error('limit')
        ctl.puts.push(k)
        kv.set(k, v)
      },
    },
    EMAIL: {
      send: async (m: { subject: string }) => {
        if (ctl.failSend) throw new Error('unverified')
        ctl.sent.push(m.subject)
        return { messageId: 'x' }
      },
    },
    SCHOOL_URL: 'http://school.test',
    ALERT_TO: 'a@example.com',
    ALERT_FROM: 'b@example.com',
  } as unknown as Env
  return { school, kv, ctl, env, asked }
}

const status = (kv: Map<string, string>) => JSON.parse(kv.get('state') ?? '{}').status

async function statusJson(env: Env): Promise<Record<string, unknown>> {
  const res = await worker.fetch(new Request('http://status.test/status.json'), env)
  return (await res.json()) as Record<string, unknown>
}

afterEach(() => vi.unstubAllGlobals())

describe('runOnce', () => {
  it('writes down even when the mail cannot be sent, and retries without a write per minute', async () => {
    const { school, kv, ctl, env } = setup()
    ctl.failSend = true
    await runOnce(env, at(0))
    school.reg = 503
    for (let m = 1; m <= 8; m++) await runOnce(env, at(m))
    expect(status(kv)).toBe('down')
    expect(JSON.parse(kv.get('pending')!)).toEqual(['down'])
    const putsBefore = ctl.puts.length
    await runOnce(env, at(9))
    await runOnce(env, at(10))
    expect(ctl.puts.length).toBe(putsBefore)
    ctl.failSend = false
    await runOnce(env, at(11))
    expect(ctl.sent).toEqual(['【机器人网校】连不上学校了'])
    expect(JSON.parse(kv.get('pending')!)).toEqual([])
    await runOnce(env, at(12))
    expect(ctl.sent.length).toBe(1)
  })

  it('a failed mail does not keep status.json at down after recovery', async () => {
    const { school, kv, ctl, env } = setup()
    ctl.failSend = true
    school.reg = 503
    await runOnce(env, at(0))
    await runOnce(env, at(5))
    school.reg = 200
    await runOnce(env, at(6))
    expect(status(kv)).toBe('ok')
  })

  it('a throwing put does not resend a mail every minute and does not skip the mail check', async () => {
    const { school, kv, ctl, env } = setup()
    await runOnce(env, at(0))
    school.reg = 503
    await runOnce(env, at(1))
    ctl.failPuts = true
    for (let m = 6; m <= 12; m++) await runOnce(env, at(m))
    expect(ctl.sent).toEqual([])
    expect(status(kv)).toBe('ok')
    ctl.failPuts = false
    school.reg = 200
    await runOnce(env, at(13))
    expect(ctl.sent).toEqual([])
  })

  it('a failing state put still lets the mail-health step run', async () => {
    const { school, kv, ctl, env } = setup()
    school.mailOk = false
    school.maintenance = null
    const realPut = env.STATE.put.bind(env.STATE)
    env.STATE.put = (async (k: string, v: string) => {
      if (k === 'state') throw new Error('boom')
      return realPut(k, v)
    }) as typeof env.STATE.put
    await runOnce(env, at(0))
    expect(kv.has('mail')).toBe(true)
    expect(ctl.sent).toEqual(['【机器人网校】验证码发不出去了'])
    expect(kv.has('state')).toBe(false)
  })

  it('reads mail health when only the class service is down', async () => {
    const { school, ctl, env } = setup()
    school.cls = 503
    school.mailOk = false
    await runOnce(env, at(0))
    expect(ctl.sent).toEqual(['【机器人网校】验证码发不出去了'])
  })

  it('does not read mail health when the registration service cannot be reached', async () => {
    const { school, ctl, env } = setup()
    school.reg = 0
    school.mailOk = false
    await runOnce(env, at(0))
    expect(ctl.sent).toEqual([])
  })

  it('mails when the club service is down, and leaves status.json at ok', async () => {
    const { school, kv, ctl, env } = setup()
    await runOnce(env, at(0))
    school.club = 502
    for (let m = 1; m <= 5; m++) await runOnce(env, at(m))
    expect(ctl.sent).toEqual([])
    await runOnce(env, at(6))
    expect(ctl.sent).toEqual(['【机器人网校】连不上社团服务了'])
    expect(status(kv)).toBe('ok')
    for (let m = 7; m <= 20; m++) await runOnce(env, at(m))
    expect(ctl.sent.length).toBe(1)
    school.club = 200
    await runOnce(env, at(21))
    expect(ctl.sent).toEqual(['【机器人网校】连不上社团服务了', '【机器人网校】社团服务已恢复'])
    expect(status(kv)).toBe('ok')
  })

  it('counts a club service that does not answer at all as down', async () => {
    const { school, ctl, env } = setup()
    school.club = 0
    for (let m = 0; m <= 5; m++) await runOnce(env, at(m))
    expect(ctl.sent).toEqual(['【机器人网校】连不上社团服务了'])
  })

  it('mails that the school is down when it is past its expected time in maintenance and does not answer', async () => {
    const { school, kv, ctl, env } = setup()
    school.maintenance = { message: '升级中', expectedBackAt: at(60).toISOString() }
    await runOnce(env, at(0))
    expect(status(kv)).toBe('maintenance')
    school.reg = 0
    school.cls = 0
    school.club = 0
    for (let m = 1; m <= 94; m++) await runOnce(env, at(m))
    expect(status(kv)).toBe('maintenance')
    expect(ctl.sent).toEqual([])
    await runOnce(env, at(95))
    expect(status(kv)).toBe('down')
    expect(ctl.sent).toEqual(['【机器人网校】连不上学校了'])
  })

  it('mails nothing about the club service in maintenance', async () => {
    const { school, kv, ctl, env } = setup()
    school.maintenance = { message: '维护' }
    school.club = 502
    for (let m = 0; m <= 30; m++) await runOnce(env, at(m))
    expect(status(kv)).toBe('maintenance')
    expect(ctl.sent).toEqual([])
  })

  it('sends only the school mail when the whole school is down', async () => {
    const { school, ctl, env } = setup()
    await runOnce(env, at(0))
    school.reg = 503
    school.club = 503
    for (let m = 1; m <= 30; m++) await runOnce(env, at(m))
    expect(ctl.sent).toEqual(['【机器人网校】连不上学校了'])
    school.reg = 200
    school.club = 200
    for (let m = 31; m <= 40; m++) await runOnce(env, at(m))
    expect(ctl.sent).toEqual(['【机器人网校】连不上学校了', '【机器人网校】学校已恢复'])
  })

  it('does not count the time the school was down against a club service that starts a minute after it', async () => {
    const { school, kv, ctl, env } = setup()
    await runOnce(env, at(0))
    school.reg = 503
    school.cls = 503
    school.club = 503
    for (let m = 1; m <= 20; m++) await runOnce(env, at(m))
    school.reg = 200
    school.cls = 200
    school.club = 502
    await runOnce(env, at(21))
    school.club = 200
    for (let m = 22; m <= 40; m++) await runOnce(env, at(m))
    expect(status(kv)).toBe('ok')
    expect(ctl.sent).toEqual(['【机器人网校】连不上学校了', '【机器人网校】学校已恢复'])
  })
})

describe('notices in status.json', () => {
  it('reads the latest 5 notices and serves them', async () => {
    const { school, env, asked } = setup()
    school.notices.body = { notices: [NOTICE], more: false }
    await runOnce(env, at(0))
    expect(asked).toContain('/v1/notices?limit=5')
    const body = await statusJson(env)
    expect(body.notices).toEqual({ fetchedAt: at(0).toISOString(), items: [NOTICE] })
    expect(body.status).toBe('ok')
    expect(Object.keys(body)).toEqual(['status', 'message', 'since', 'updatedAt', 'notices'])
  })

  it('serves null when the notices were never read', async () => {
    const { school, env, ctl } = setup()
    school.notices.status = 404
    await runOnce(env, at(0))
    expect((await statusJson(env)).notices).toBeNull()
    expect(ctl.puts).not.toContain('notices')
  })

  it.each([
    ['unreachable', 0, { notices: [] }],
    ['an error answer', 500, { error: 'x' }],
    ['a malformed answer', 200, { notices: [{ ...NOTICE, kind: 'urgent' }] }],
  ])('keeps the last copy when the school gives %s', async (_name, code, answer) => {
    const { school, kv, env } = setup()
    school.notices.body = { notices: [NOTICE], more: false }
    await runOnce(env, at(0))
    const stored = kv.get('notices')
    school.notices = { status: code, body: answer }
    await runOnce(env, at(1))
    expect(kv.get('notices')).toBe(stored)
    expect((await statusJson(env)).notices).toEqual({ fetchedAt: at(0).toISOString(), items: [NOTICE] })
  })

  it('keeps the last copy when the body is not JSON', async () => {
    const { school, env } = setup()
    school.notices.body = { notices: [NOTICE], more: false }
    await runOnce(env, at(0))
    vi.stubGlobal('fetch', async () => new Response('<html>', { status: 200 }))
    await runOnce(env, at(1))
    expect((await statusJson(env)).notices).toEqual({ fetchedAt: at(0).toISOString(), items: [NOTICE] })
  })

  it('does not write KV while the items stay the same, and refreshes fetchedAt hourly', async () => {
    const { school, env, ctl } = setup()
    school.notices.body = { notices: [NOTICE], more: false }
    await runOnce(env, at(0))
    for (let m = 1; m <= 59; m++) await runOnce(env, at(m))
    expect(ctl.puts.filter((k) => k === 'notices').length).toBe(1)
    await runOnce(env, at(60))
    expect(ctl.puts.filter((k) => k === 'notices').length).toBe(2)
    school.notices.body = { notices: [{ ...NOTICE, title: '改期' }], more: false }
    await runOnce(env, at(61))
    expect(ctl.puts.filter((k) => k === 'notices').length).toBe(3)
  })

  it('a notices failure changes neither the status nor the mails', async () => {
    const { school, kv, ctl, env } = setup()
    school.notices.status = 0
    school.mailOk = false
    await runOnce(env, at(0))
    expect(status(kv)).toBe('ok')
    expect(ctl.sent).toEqual(['【机器人网校】验证码发不出去了'])
  })

  it('a failing notices put still lets the other steps run', async () => {
    const { school, kv, ctl, env } = setup()
    school.notices.body = { notices: [NOTICE], more: false }
    school.mailOk = false
    const realPut = env.STATE.put.bind(env.STATE)
    env.STATE.put = (async (k: string, v: string) => {
      if (k === 'notices') throw new Error('boom')
      return realPut(k, v)
    }) as typeof env.STATE.put
    await runOnce(env, at(0))
    expect(status(kv)).toBe('ok')
    expect(ctl.sent).toEqual(['【机器人网校】验证码发不出去了'])
    expect((await statusJson(env)).notices).toBeNull()
  })
})
