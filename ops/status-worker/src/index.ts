import {
  decide,
  decideMail,
  type MailState,
  type Manual,
  type Probe,
  type StoredState,
} from './sentinel.js'

export interface Env {
  STATE: KVNamespace
  EMAIL: SendEmail
  SCHOOL_URL: string
  ALERT_TO: string
  ALERT_FROM: string
}

const PROBE_TIMEOUT_MS = 10_000

const MAILS = {
  down: {
    subject: '【机器人网校】连不上学校了',
    text: '从外面连不上学校，已经连续好几分钟了。请去看一下服务器。',
  },
  up: { subject: '【机器人网校】学校已恢复', text: '学校又能连上了。' },
  mail_down: {
    subject: '【机器人网校】验证码发不出去了',
    text: '学校发不出邮件，新同学收不到验证码。请检查发信的设置。',
  },
  mail_up: { subject: '【机器人网校】发信已恢复', text: '学校又能发邮件了。' },
} as const

async function get(url: string): Promise<Response | null> {
  try {
    return await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
  } catch {
    return null
  }
}

async function readOk(url: string): Promise<boolean | null> {
  const res = await get(url)
  if (res === null) return null
  return res.status === 200
}

export async function probeSchool(base: string): Promise<{ probe: Probe; mailOk: boolean | null }> {
  const root = base.replace(/\/+$/, '')
  const [reg, cls] = await Promise.all([readOk(`${root}/healthz`), readOk(`${root}/healthz/class`)])
  const healthy = reg === true && cls === true

  let maintenance: Probe['maintenance'] = null
  let mailOk: boolean | null = null
  if (reg !== null) {
    try {
      const res = await get(`${root}/v1/school-calendar`)
      if (res?.ok) {
        const body = (await res.json()) as { maintenance?: { message?: unknown } | null }
        if (body.maintenance) {
          const m = body.maintenance.message
          maintenance = { message: typeof m === 'string' ? m : '' }
        }
      }
    } catch {
      maintenance = null
    }
    try {
      const res = await get(`${root}/healthz/mail`)
      if (res?.status === 200) {
        const body = (await res.json()) as { ok?: unknown }
        if (typeof body.ok === 'boolean') mailOk = body.ok
      }
    } catch {
      mailOk = null
    }
  }
  return { probe: { healthy, maintenance }, mailOk }
}

async function readJson<T>(kv: KVNamespace, key: string): Promise<T | null> {
  const raw = await kv.get(key)
  if (raw === null) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

async function send(env: Env, kind: keyof typeof MAILS): Promise<boolean> {
  try {
    await env.EMAIL.send({
      to: env.ALERT_TO,
      from: env.ALERT_FROM,
      subject: MAILS[kind].subject,
      text: MAILS[kind].text,
    })
    return true
  } catch (err) {
    console.error('sentinel: sending mail failed', kind, err instanceof Error ? err.message : '')
    return false
  }
}

export async function runOnce(env: Env, now: Date): Promise<void> {
  const [prev, prevMail, manualRaw, note] = await Promise.all([
    readJson<StoredState>(env.STATE, 'state'),
    readJson<MailState>(env.STATE, 'mail'),
    env.STATE.get('manual'),
    env.STATE.get('note'),
  ])
  const manual: Manual = {
    maintenance: manualRaw?.trim() === 'maintenance',
    note: note?.trim() ? note.trim() : null,
  }
  const { probe, mailOk } = await probeSchool(env.SCHOOL_URL)

  const state = decide(prev, probe, manual, now)
  // If the mail fails to go out, skip the write so the next minute tries again.
  const stateSent = state.mail === null || (await send(env, state.mail))
  if (state.write && stateSent) await env.STATE.put('state', JSON.stringify(state.next))

  const inMaintenance = state.next.status === 'maintenance'
  const mail = decideMail(prevMail, probe.healthy ? mailOk : null, inMaintenance, now)
  const mailSent = mail.mail === null || (await send(env, mail.mail))
  if (mail.write && mailSent) await env.STATE.put('mail', JSON.stringify(mail.next))
}

const HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'access-control-allow-origin': '*',
  'cache-control': 'max-age=30',
}

export default {
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    await runOnce(env, new Date())
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname !== '/status.json' || (request.method !== 'GET' && request.method !== 'HEAD')) {
      return new Response('Not found', { status: 404 })
    }
    const state = await readJson<StoredState>(env.STATE, 'state')
    if (state === null) {
      return new Response(JSON.stringify({ error: 'not ready' }), {
        status: 503,
        headers: { ...HEADERS, 'cache-control': 'no-store' },
      })
    }
    const body = {
      status: state.status,
      message: state.message,
      since: state.since,
      updatedAt: state.updatedAt,
    }
    return new Response(JSON.stringify(body), { headers: HEADERS })
  },
}
