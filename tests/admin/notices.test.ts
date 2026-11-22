import { afterEach, beforeEach, expect, test } from 'vitest'
import { buildAdminTestApp, CSRF } from '../helpers/admin.js'
import { captureLogs } from '../helpers/logs.js'

let t: Awaited<ReturnType<typeof buildAdminTestApp>>
let cookie: string
let logs: ReturnType<typeof captureLogs>

beforeEach(async () => {
  logs = captureLogs()
  t = await buildAdminTestApp({ logger: { level: 'info', stream: logs.stream } })
  cookie = await t.session()
})
afterEach(async () => {
  await t.destroy()
})

const MINUTE = 60_000
const START = '2026-11-23T18:00:00.000Z'
const END = '2026-11-23T19:00:00.000Z'

const send = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, payload?: object) =>
  t.app.inject({
    method,
    url: t.url(path),
    headers: method === 'GET' ? { cookie } : { cookie, ...CSRF },
    payload,
  })
const list = async () => (await send('GET', 'api/notices')).json().notices as Record<string, unknown>[]
const row = (id: number) => t.db.selectFrom('notices').selectAll().where('id', '=', id).executeTakeFirstOrThrow()

async function create(payload: object = { title: '一条公告', body: '正文', kind: 'general' }): Promise<number> {
  const res = await send('POST', 'api/notices', payload)
  expect(res.statusCode, res.body).toBe(200)
  return res.json().id as number
}

test('without a login every route is a 401', async () => {
  const routes: [string, string][] = [
    ['GET', 'api/notices'],
    ['POST', 'api/notices'],
    ['PUT', 'api/notices/1'],
    ['POST', 'api/notices/1/publish'],
    ['POST', 'api/notices/1/withdraw'],
    ['DELETE', 'api/notices/1'],
  ]
  for (const [method, path] of routes) {
    const res = await t.app.inject({ method: method as 'GET', url: t.url(path), headers: CSRF, payload: method === 'GET' ? undefined : {} })
    expect(res.statusCode, `${method} ${path}`).toBe(401)
    expect(res.json()).toMatchObject({ error: { code: 'admin_login_required' } })
  }
})

test('a new notice is a draft with every field the page needs, its title trimmed', async () => {
  const created = t.clock.now().toISOString()
  const res = await send('POST', 'api/notices', { title: '  维护  ', body: ' 正文 ', kind: 'maintenance', startsAt: '2026-11-24T02:00:00+08:00' })
  expect(res.statusCode).toBe(200)
  const notice = res.json()
  expect(notice).toEqual({
    id: expect.any(Number),
    title: '维护',
    body: ' 正文 ',
    kind: 'maintenance',
    startsAt: START,
    endsAt: null,
    status: 'draft',
    publishedAt: null,
    updatedAt: null,
    createdAt: created,
  })
  expect(await list()).toEqual([notice])
  // A draft is not public.
  expect((await t.app.inject({ method: 'GET', url: '/v1/notices' })).json().notices).toEqual([])
})

test('the list is newest first: a draft by when it was made, any other by when it was first published', async () => {
  const old = await create({ title: '旧的', body: '', kind: 'general' })
  t.clock.advance(MINUTE)
  const draft = await create({ title: '草稿', body: '', kind: 'general' })
  t.clock.advance(MINUTE)
  const late = await create({ title: '后写的', body: '', kind: 'general' })
  t.clock.advance(MINUTE)
  // `old` is published after the draft was made, `late` is published and then backdated to before it.
  await send('POST', `api/notices/${old}/publish`)
  await send('POST', `api/notices/${late}/publish`)
  await send('POST', `api/notices/${late}/withdraw`)
  await send('PUT', `api/notices/${late}`, {
    title: '后写的',
    body: '',
    kind: 'general',
    publishedAt: new Date(t.clock.now().getTime() - 2.5 * MINUTE).toISOString(),
  })
  expect((await list()).map((n) => n.id)).toEqual([old, draft, late])
})

test('a draft is edited in full; times go with a maintenance notice only', async () => {
  const id = await create({ title: '维护', body: '', kind: 'maintenance', startsAt: START, endsAt: END })
  const res = await send('PUT', `api/notices/${id}`, { title: ' 通知 ', body: '改了', kind: 'general' })
  expect(res.statusCode).toBe(200)
  expect(res.json()).toMatchObject({ id, title: '通知', body: '改了', kind: 'general', startsAt: null, endsAt: null, updatedAt: null })
  const back = await send('PUT', `api/notices/${id}`, { title: '维护', body: '', kind: 'maintenance', startsAt: START, endsAt: END })
  expect(back.json()).toMatchObject({ kind: 'maintenance', startsAt: START, endsAt: END, status: 'draft', updatedAt: null })
})

test('bad input is a 400 invalid_request and changes nothing', async () => {
  const bad: object[] = [
    {},
    { title: '标题', body: '' },
    { title: '', body: '', kind: 'general' },
    { title: '   ', body: '', kind: 'general' },
    { title: '字'.repeat(61), body: '', kind: 'general' },
    { title: '标题', body: '字'.repeat(4001), kind: 'general' },
    { title: '标题', body: '', kind: 'urgent' },
    { title: '标题', body: '', kind: 'general', startsAt: START },
    { title: '标题', body: '', kind: 'general', endsAt: END },
    { title: '标题', body: '', kind: 'maintenance' },
    { title: '标题', body: '', kind: 'maintenance', endsAt: END },
    { title: '标题', body: '', kind: 'maintenance', startsAt: 'next tuesday' },
    { title: '标题', body: '', kind: 'maintenance', startsAt: START, endsAt: START },
    { title: '标题', body: '', kind: 'maintenance', startsAt: END, endsAt: START },
    // No offset: it would be read in the server's own time zone.
    { title: '标题', body: '', kind: 'maintenance', startsAt: '2026-11-24T02:00' },
    { title: '标题', body: '', kind: 'maintenance', startsAt: '1' },
    // A year the database cannot hold.
    { title: '标题', body: '', kind: 'maintenance', startsAt: '-200000-01-01T00:00:00Z' },
    { title: '标题', body: '', kind: 'maintenance', startsAt: '1999-12-31T23:59:59Z' },
    // Text the database would refuse, or store changed.
    { title: 'a\u0000b', body: '', kind: 'general' },
    { title: '标题', body: 'a\u0000b', kind: 'general' },
    { title: '标题', body: 'a\ud800b', kind: 'general' },
    { title: 5, body: '', kind: 'general' },
    { title: '标题', body: '', kind: 'general', extra: true },
  ]
  for (const payload of bad) {
    const res = await send('POST', 'api/notices', payload)
    expect(res.statusCode, JSON.stringify(payload)).toBe(400)
    expect(res.json()).toMatchObject({ error: { code: 'invalid_request' } })
  }
  expect(await list()).toEqual([])

  // The limits are in code points: 60 and 4000 four-byte characters are fine.
  const id = await create({ title: '𠀀'.repeat(60), body: '𠀀'.repeat(4000), kind: 'general' })
  for (const payload of bad) {
    const res = await send('PUT', `api/notices/${id}`, payload)
    expect(res.statusCode, JSON.stringify(payload)).toBe(400)
  }
  expect((await row(id)).title).toBe('𠀀'.repeat(60))
  // A publishing time must parse, and is not in the future.
  await send('POST', `api/notices/${id}/publish`)
  for (const publishedAt of ['soon', new Date(t.clock.now().getTime() + MINUTE).toISOString()]) {
    const res = await send('PUT', `api/notices/${id}`, { title: '标题', body: '', kind: 'general', publishedAt })
    expect(res.statusCode, publishedAt).toBe(400)
  }
})

test('an unknown notice is a 404 on every route', async () => {
  const general = { title: '标题', body: '', kind: 'general' }
  for (const id of ['999', 'abc', '0', '99999999999']) {
    for (const [method, path, payload] of [
      ['PUT', `api/notices/${id}`, general],
      ['POST', `api/notices/${id}/publish`, undefined],
      ['POST', `api/notices/${id}/withdraw`, undefined],
      ['DELETE', `api/notices/${id}`, undefined],
    ] as const) {
      const res = await send(method, path, payload)
      expect(res.statusCode, `${method} ${path}`).toBe(404)
      expect(res.json()).toMatchObject({ error: { code: 'not_found' } })
    }
  }
})

test('publish, withdraw, publish again: the first publishing time stays', async () => {
  const id = await create()
  t.clock.advance(MINUTE)
  const first = t.clock.now().toISOString()
  const published = await send('POST', `api/notices/${id}/publish`)
  expect(published.statusCode).toBe(200)
  expect(published.json()).toMatchObject({ id, status: 'published', publishedAt: first, updatedAt: null })
  expect((await t.app.inject({ method: 'GET', url: '/v1/notices' })).json().notices).toHaveLength(1)

  t.clock.advance(MINUTE)
  const withdrawn = await send('POST', `api/notices/${id}/withdraw`)
  expect(withdrawn.json()).toMatchObject({ status: 'withdrawn', publishedAt: first })
  expect((await t.app.inject({ method: 'GET', url: '/v1/notices' })).json().notices).toEqual([])

  t.clock.advance(MINUTE)
  const again = await send('POST', `api/notices/${id}/publish`)
  expect(again.json()).toMatchObject({ status: 'published', publishedAt: first, updatedAt: null })
})

test('a wrong state is a 409 wrong_status', async () => {
  const id = await create()
  const withdrawDraft = await send('POST', `api/notices/${id}/withdraw`)
  expect(withdrawDraft.statusCode).toBe(409)
  expect(withdrawDraft.json()).toMatchObject({ error: { code: 'wrong_status' } })
  // A draft has no publishing time to correct.
  const backdate = await send('PUT', `api/notices/${id}`, { title: '标题', body: '', kind: 'general', publishedAt: '2026-11-01T00:00:00Z' })
  expect(backdate.statusCode).toBe(409)
  expect((await row(id)).publishedAt).toBeNull()

  await send('POST', `api/notices/${id}/publish`)
  expect((await send('POST', `api/notices/${id}/publish`)).statusCode).toBe(409)
  await send('POST', `api/notices/${id}/withdraw`)
  expect((await send('POST', `api/notices/${id}/withdraw`)).statusCode).toBe(409)
})

test('once out, a notice is marked updated only when its title, body, kind or times change', async () => {
  const id = await create({ title: '维护', body: '正文', kind: 'maintenance', startsAt: START })
  const same = { title: '维护', body: '正文', kind: 'maintenance', startsAt: START }
  await send('POST', `api/notices/${id}/publish`)
  const publishedAt = (await row(id)).publishedAt

  t.clock.advance(MINUTE)
  // Unchanged (the title trimmed to the same, the time written another way): not updated.
  const unchanged = await send('PUT', `api/notices/${id}`, { ...same, title: ' 维护 ', startsAt: '2026-11-24T02:00:00+08:00' })
  expect(unchanged.statusCode).toBe(200)
  expect(unchanged.json().updatedAt).toBeNull()

  // Only the publishing time corrected: not updated either.
  const earlier = '2026-11-02T03:00:00.000Z'
  const corrected = await send('PUT', `api/notices/${id}`, { ...same, publishedAt: earlier })
  expect(corrected.json()).toMatchObject({ publishedAt: earlier, updatedAt: null })
  expect(publishedAt).not.toEqual(new Date(earlier))

  for (const change of [{ title: '维护延后' }, { body: '新正文' }, { endsAt: END }, { kind: 'general', startsAt: undefined }]) {
    t.clock.advance(MINUTE)
    const res = await send('PUT', `api/notices/${id}`, { ...same, ...change })
    expect(res.statusCode, JSON.stringify(change)).toBe(200)
    expect(res.json().updatedAt, JSON.stringify(change)).toBe(t.clock.now().toISOString())
    await send('PUT', `api/notices/${id}`, same)
  }

  // A withdrawn notice too, and publishing it again keeps the mark.
  await send('POST', `api/notices/${id}/withdraw`)
  t.clock.advance(MINUTE)
  const edited = (await send('PUT', `api/notices/${id}`, { ...same, body: '撤下后改的' })).json()
  expect(edited.updatedAt).toBe(t.clock.now().toISOString())
  t.clock.advance(MINUTE)
  expect((await send('POST', `api/notices/${id}/publish`)).json()).toMatchObject({ updatedAt: edited.updatedAt, publishedAt: earlier })
})

test('only a draft can be deleted', async () => {
  const draft = await create()
  const res = await send('DELETE', `api/notices/${draft}`)
  expect(res.statusCode).toBe(200)
  expect(res.json()).toEqual({ ok: true })
  expect(await list()).toEqual([])

  const out = await create()
  await send('POST', `api/notices/${out}/publish`)
  for (const step of ['published', 'withdrawn']) {
    const refused = await send('DELETE', `api/notices/${out}`)
    expect(refused.statusCode, step).toBe(409)
    expect(refused.json()).toMatchObject({ error: { code: 'wrong_status' } })
    await send('POST', `api/notices/${out}/withdraw`)
  }
  expect(await list()).toHaveLength(1)
})

test('each action is logged with the notice number and the action, never its text', async () => {
  const id = await create({ title: '秘密标题', body: '秘密正文', kind: 'general' })
  await send('PUT', `api/notices/${id}`, { title: '秘密标题二', body: '秘密正文二', kind: 'general' })
  await send('POST', `api/notices/${id}/publish`)
  await send('POST', `api/notices/${id}/withdraw`)
  const draft = await create({ title: '秘密标题三', body: '', kind: 'general' })
  await send('DELETE', `api/notices/${draft}`)

  const mine = logs.entries().filter((e) => e.msg === 'notice')
  expect(mine.map((e) => [e.noticeId, e.action])).toEqual([
    [id, 'create'],
    [id, 'edit'],
    [id, 'publish'],
    [id, 'withdraw'],
    [draft, 'create'],
    [draft, 'delete'],
  ])
  expect(JSON.stringify(mine)).not.toContain('秘密')
})
