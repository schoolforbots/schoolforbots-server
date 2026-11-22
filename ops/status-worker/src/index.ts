import {
  type ClubState,
  decide,
  decideClub,
  decideMail,
  decideNotices,
  type MailState,
  type Manual,
  MAX_NOTICES,
  type NoticeItem,
  type NoticesCopy,
  parseNotices,
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
  club_down: {
    subject: '【机器人网校】连不上社团服务了',
    text: '从外面连不上社团服务，已经连续好几分钟了。请去看一下服务器上的社团服务。',
  },
  club_up: { subject: '【机器人网校】社团服务已恢复', text: '社团服务又能连上了。' },
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

export async function probeSchool(
  base: string,
): Promise<{ probe: Probe; mailOk: boolean | null; clubOk: boolean | null }> {
  const root = base.replace(/\/+$/, '')
  const [reg, cls, club] = await Promise.all([
    readOk(`${root}/healthz`),
    readOk(`${root}/healthz/class`),
    readOk(`${root}/healthz/club`),
  ])
  // The club service is not part of the school's health: status.json does not depend on it.
  const healthy = reg === true && cls === true
  // A school that cannot be reached at all says nothing about the club service.
  const clubOk = reg === null ? null : club === true

  let maintenance: Probe['maintenance'] = null
  let mailOk: boolean | null = null
  if (reg !== null) {
    try {
      const res = await get(`${root}/v1/school-calendar`)
      if (res?.ok) {
        const body = (await res.json()) as { maintenance?: { message?: unknown; expectedBackAt?: unknown } | null }
        if (body.maintenance) {
          const m = body.maintenance.message
          const back = body.maintenance.expectedBackAt
          maintenance = {
            message: typeof m === 'string' ? m : '',
            expectedBackAt: typeof back === 'string' && !Number.isNaN(Date.parse(back)) ? back : null,
          }
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
  return { probe: { healthy, maintenance }, mailOk, clubOk }
}

/** The school's latest notices, or null when they cannot be read or the answer has the wrong shape. */
export async function probeNotices(base: string): Promise<NoticeItem[] | null> {
  const root = base.replace(/\/+$/, '')
  try {
    const res = await get(`${root}/v1/notices?limit=${MAX_NOTICES}`)
    if (res?.status !== 200) return null
    return parseNotices(await res.json())
  } catch {
    return null
  }
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

type MailKind = keyof typeof MAILS

async function put(env: Env, key: string, value: unknown): Promise<boolean> {
  try {
    await env.STATE.put(key, JSON.stringify(value))
    return true
  } catch (err) {
    console.error('sentinel: KV write failed', key, err instanceof Error ? err.message : '')
    return false
  }
}

// Publishing never waits on sending: the new state is written first. A mail is queued in the
// `pending` key only after the write that caused it succeeded, then sent; the queue is written
// only when its content changes (so a mail that keeps failing costs no KV write per minute).
// Trade-off when KV itself is down: nothing is written, so no mail is queued or sent (the same
// decision comes back every minute, and sending would repeat it every minute); status.json keeps
// its last content. Each check is independent: one failure never stops the other.
// The notices are only copied for status.json: they never touch the status or the mails, and a failed read keeps the
// last copy.
export async function runOnce(env: Env, now: Date): Promise<void> {
  const [prev, prevMail, prevClub, manualRaw, note, pendingRaw, prevNotices] = await Promise.all([
    readJson<StoredState>(env.STATE, 'state'),
    readJson<MailState>(env.STATE, 'mail'),
    readJson<ClubState>(env.STATE, 'club'),
    env.STATE.get('manual'),
    env.STATE.get('note'),
    readJson<MailKind[]>(env.STATE, 'pending'),
    readJson<NoticesCopy>(env.STATE, 'notices'),
  ])
  const pending: MailKind[] = Array.isArray(pendingRaw) ? pendingRaw.filter((k) => k in MAILS) : []
  const manual: Manual = {
    maintenance: manualRaw?.trim() === 'maintenance',
    note: note?.trim() ? note.trim() : null,
  }
  const [{ probe, mailOk, clubOk }, noticeItems] = await Promise.all([
    probeSchool(env.SCHOOL_URL),
    probeNotices(env.SCHOOL_URL),
  ])

  const queue = [...pending]

  const state = decide(prev, probe, manual, now)
  if (state.write && (await put(env, 'state', state.next)) && state.mail) queue.push(state.mail)

  // mailOk is null when the registration service could not be read at all.
  const mail = decideMail(prevMail, mailOk, state.next.status === 'maintenance', now)
  if (mail.write && (await put(env, 'mail', mail.next)) && mail.mail) queue.push(mail.mail)

  // Mails only: status.json leaves the club service out. While the whole school is down its own mail says enough: a
  // club count not yet mailed is dropped, and starts again once the school is back.
  const club = decideClub(
    prevClub,
    state.next.status === 'down' ? null : clubOk,
    state.next.status === 'maintenance',
    now,
  )
  if (club.write && (await put(env, 'club', club.next)) && club.mail) queue.push(club.mail)

  const notices = decideNotices(prevNotices, noticeItems, now)
  if (notices.write) await put(env, 'notices', notices.next)

  const left: MailKind[] = []
  for (const kind of queue) {
    if (!(await send(env, kind))) left.push(kind)
  }
  if (JSON.stringify(left) !== JSON.stringify(pending)) await put(env, 'pending', left)
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
    const [state, notices] = await Promise.all([
      readJson<StoredState>(env.STATE, 'state'),
      readJson<NoticesCopy>(env.STATE, 'notices'),
    ])
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
      // The last good copy of the school's notices, or null if they were never read.
      notices: notices ?? null,
    }
    return new Response(JSON.stringify(body), { headers: HEADERS })
  },
}
