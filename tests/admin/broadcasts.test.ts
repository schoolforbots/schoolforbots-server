import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { buildAdminTestApp, CSRF } from '../helpers/admin.js'
import { insertClass, insertStudent } from '../helpers/factories.js'

let t: Awaited<ReturnType<typeof buildAdminTestApp>>
let cookie: string

beforeEach(async () => {
  t = await buildAdminTestApp()
  cookie = await t.session()
})
afterEach(async () => {
  await t.destroy()
})

const send = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, payload?: object) =>
  t.app.inject({
    method,
    url: t.url(path),
    headers: method === 'GET' ? { cookie } : { cookie, ...CSRF },
    payload,
  })
const row = (id: number) => t.db.selectFrom('broadcasts').selectAll().where('id', '=', id).executeTakeFirstOrThrow()

const draft = (over: object = {}) => ({
  title: '今晚斗地主社有比赛',
  body: '晚上 9 点开始，欢迎来玩。',
  importance: 'normal',
  divisions: [],
  slots: [],
  classes: [],
  ...over,
})

async function create(payload: object = draft()): Promise<number> {
  const res = await send('POST', 'api/broadcasts', payload)
  expect(res.statusCode, res.body).toBe(200)
  return res.json().id as number
}

test('without a login every route is a 401', async () => {
  const routes: [string, string][] = [
    ['GET', 'api/broadcasts'],
    ['GET', 'api/broadcasts/classes'],
    ['POST', 'api/broadcasts'],
    ['PUT', 'api/broadcasts/1'],
    ['POST', 'api/broadcasts/1/publish'],
    ['POST', 'api/broadcasts/1/withdraw'],
    ['DELETE', 'api/broadcasts/1'],
  ]
  for (const [method, path] of routes) {
    const res = await t.app.inject({ method: method as 'GET', url: t.url(path), headers: CSRF, payload: method === 'GET' ? undefined : {} })
    expect(res.statusCode, `${method} ${path}`).toBe(401)
  }
})

describe('writing a broadcast', () => {
  test('a new broadcast is a draft, its title trimmed, its divisions and slots put in the school’s order', async () => {
    const res = await send('POST', 'api/broadcasts', draft({ title: '  提醒  ', divisions: ['senior', 'junior'], slots: ['evening'] }))
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      id: expect.any(Number),
      title: '提醒',
      body: '晚上 9 点开始，欢迎来玩。',
      importance: 'normal',
      divisions: ['junior', 'senior'],
      slots: ['evening'],
      classes: [],
      audience: '初中部、高中部 · 晚班',
      status: 'draft',
      seq: null,
      publishedAt: null,
      withdrawnAt: null,
      expiresAt: null,
      noticeId: null,
      createdAt: t.clock.now().toISOString(),
    })
  })

  test('to some classes, named by division, slot and number', async () => {
    const c3 = await insertClass(t.db, { classNo: 3, division: 'junior', slot: 'evening' })
    const res = await send('POST', 'api/broadcasts', draft({ classes: [{ division: 'junior', slot: 'evening', classNo: 3 }] }))
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      classes: [{ id: c3, division: 'junior', slot: 'evening', classNo: 3, name: '初中部·晚班·3 班' }],
      audience: '初中部·晚班·3 班',
    })
  })

  test('anything the page should not send is a 400', async () => {
    await insertClass(t.db, { classNo: 1 })
    const bad = [
      draft({ title: '   ' }),
      draft({ title: '长'.repeat(41) }),
      draft({ body: '长'.repeat(1001) }),
      draft({ importance: 'urgent' }),
      draft({ divisions: ['college'] }),
      draft({ divisions: ['junior', 'junior'] }),
      draft({ slots: ['night'] }),
      // A class that does not exist, and classes together with divisions.
      draft({ classes: [{ division: 'junior', slot: 'evening', classNo: 9 }] }),
      draft({ divisions: ['junior'], classes: [{ division: 'junior', slot: 'evening', classNo: 1 }] }),
      draft({ expiresAt: '2026-11-30 12:00' }),
      draft({ extra: true }),
    ]
    for (const payload of bad) expect((await send('POST', 'api/broadcasts', payload)).statusCode, JSON.stringify(payload)).toBe(400)
  })

  test('the class list has the classes with members, in the school’s order', async () => {
    const senior = await insertClass(t.db, { classNo: 1, division: 'senior', slot: 'morning' })
    const junior2 = await insertClass(t.db, { classNo: 2, division: 'junior', slot: 'evening' })
    const junior1 = await insertClass(t.db, { classNo: 1, division: 'junior', slot: 'evening' })
    await insertClass(t.db, { classNo: 3, division: 'junior', slot: 'evening' })
    for (const classId of [senior, junior2, junior1]) await insertStudent(t.db, { status: 'active', classId })

    const res = await send('GET', 'api/broadcasts/classes')
    expect(res.json().classes.map((c: { name: string }) => c.name)).toEqual(['初中部·晚班·1 班', '初中部·晚班·2 班', '高中部·上午班·1 班'])
  })
})

describe('the life of a broadcast', () => {
  test('a draft is edited, published with the next seq, then withdrawn for good', async () => {
    const first = await create()
    const second = await create()
    expect((await send('PUT', `api/broadcasts/${first}`, draft({ title: '改过的', importance: 'important' }))).json()).toMatchObject({
      title: '改过的',
      importance: 'important',
    })

    // Published in the other order than written: the seq follows the publishing.
    const a = (await send('POST', `api/broadcasts/${second}/publish`)).json()
    const b = (await send('POST', `api/broadcasts/${first}/publish`)).json()
    expect(a).toMatchObject({ status: 'published', publishedAt: t.clock.now().toISOString() })
    expect(b.seq).toBeGreaterThan(a.seq)

    const edit = await send('PUT', `api/broadcasts/${first}`, draft())
    expect(edit.statusCode).toBe(409)
    expect((await send('DELETE', `api/broadcasts/${first}`)).statusCode).toBe(409)
    expect((await send('POST', `api/broadcasts/${first}/publish`)).statusCode).toBe(409)

    const withdrawn = (await send('POST', `api/broadcasts/${first}/withdraw`)).json()
    expect(withdrawn).toMatchObject({ status: 'withdrawn', withdrawnAt: t.clock.now().toISOString(), seq: b.seq })
    expect((await send('POST', `api/broadcasts/${first}/publish`)).statusCode).toBe(409)
    expect((await send('POST', `api/broadcasts/${first}/withdraw`)).statusCode).toBe(409)
  })

  test('only a draft is deleted', async () => {
    const id = await create()
    expect((await send('DELETE', `api/broadcasts/${id}`)).json()).toEqual({ ok: true })
    expect(await t.db.selectFrom('broadcasts').select('id').execute()).toEqual([])
    expect((await send('DELETE', `api/broadcasts/${id}`)).statusCode).toBe(404)
  })

  test('a draft whose expiry has passed is not published', async () => {
    const id = await create(draft({ expiresAt: new Date(t.clock.now().getTime() - 60_000).toISOString() }))
    const res = await send('POST', `api/broadcasts/${id}/publish`)
    expect(res.statusCode).toBe(409)
    expect((await row(id)).status).toBe('draft')
  })

  test('the list has the newest first: drafts by when they were made, the others by when they were published', async () => {
    const old = await create(draft({ title: '早写的' }))
    t.clock.advance(60_000)
    await create(draft({ title: '后写的草稿' }))
    t.clock.advance(60_000)
    await send('POST', `api/broadcasts/${old}/publish`)
    const titles = (await send('GET', 'api/broadcasts')).json().broadcasts.map((b: { title: string }) => b.title)
    expect(titles).toEqual(['早写的', '后写的草稿'])
  })
})

describe('broadcasting a notice as it is published', () => {
  async function notice(): Promise<number> {
    const res = await send('POST', 'api/notices', { title: '周六凌晨维护', body: '两小时。', kind: 'general' })
    return res.json().id as number
  }

  test('with a broadcast importance, the notice goes out to the whole school as a broadcast too', async () => {
    const id = await notice()
    const res = await send('POST', `api/notices/${id}/publish`, { broadcast: 'important' })
    expect(res.statusCode, res.body).toBe(200)
    const broadcasts = (await send('GET', 'api/broadcasts')).json().broadcasts
    expect(broadcasts).toEqual([
      expect.objectContaining({
        title: '周六凌晨维护',
        body: '两小时。',
        importance: 'important',
        audience: '全校',
        status: 'published',
        noticeId: id,
      }),
    ])
  })

  test('with no body, or none asked for, the notice is published alone; a wrong value is a 400 and publishes nothing', async () => {
    const alone = await notice()
    expect((await send('POST', `api/notices/${alone}/publish`)).statusCode).toBe(200)
    const asked = await notice()
    expect((await send('POST', `api/notices/${asked}/publish`, { broadcast: null })).statusCode).toBe(200)
    const wrong = await notice()
    expect((await send('POST', `api/notices/${wrong}/publish`, { broadcast: 'loud' })).statusCode).toBe(400)
    expect((await t.db.selectFrom('notices').select('status').where('id', '=', wrong).executeTakeFirstOrThrow()).status).toBe('draft')
    expect(await t.db.selectFrom('broadcasts').select('id').execute()).toEqual([])
  })
})
