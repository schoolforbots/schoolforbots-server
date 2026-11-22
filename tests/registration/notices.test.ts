import { Value } from 'typebox/value'
import { afterEach, describe, expect, test } from 'vitest'
import { NoticeResult, NoticesResult } from '../../src/protocol/http.js'
import { buildTestApp } from '../helpers/app.js'

type TestApp = Awaited<ReturnType<typeof buildTestApp>>

let t: TestApp

afterEach(async () => {
  await t.destroy()
})

interface NoticeRow {
  title?: string
  body?: string
  kind?: 'general' | 'maintenance'
  status?: 'draft' | 'published' | 'withdrawn'
  startsAt?: string | null
  endsAt?: string | null
  publishedAt?: string | null
  updatedAt?: string | null
}

/** Stores a notice as the admin pages would leave it (published unless `status` says otherwise); its id. */
async function addNotice(row: NoticeRow = {}): Promise<number> {
  const status = row.status ?? 'published'
  const date = (text: string | null | undefined) => (text == null ? null : new Date(text))
  const { id } = await t.db
    .insertInto('notices')
    .values({
      title: row.title ?? '公告',
      body: row.body ?? '',
      kind: row.kind ?? 'general',
      status,
      startsAt: date(row.startsAt),
      endsAt: date(row.endsAt),
      publishedAt: row.publishedAt !== undefined ? date(row.publishedAt) : status === 'draft' ? null : new Date('2026-11-01T00:00:00Z'),
      updatedAt: date(row.updatedAt),
      createdAt: new Date('2026-10-31T00:00:00Z'),
    })
    .returning('id')
    .executeTakeFirstOrThrow()
  return id
}

async function get(url: string) {
  const res = await t.app.inject({ method: 'GET', url })
  return { status: res.statusCode, headers: res.headers, body: res.json() }
}

/** The published notices, `count` of them, one a day from 1 November on, each titled by its day. */
async function addDaily(count: number): Promise<void> {
  for (let day = 1; day <= count; day++) {
    await addNotice({ title: `第 ${day} 天`, publishedAt: new Date(Date.UTC(2026, 10, day, 10)).toISOString() })
  }
}

describe('GET /v1/notices', () => {
  test('gives the published notices, newest first, each as the website shows it', async () => {
    t = await buildTestApp()
    const general = await addNotice({
      title: '欢迎',
      body: '第一段\n\n- 一\n- **二**',
      publishedAt: '2026-11-18T09:00:00Z',
      updatedAt: '2026-11-19T01:00:00Z',
    })
    const maintenance = await addNotice({
      title: '11 月 24 日凌晨维护',
      kind: 'maintenance',
      startsAt: '2026-11-23T18:00:00Z',
      endsAt: '2026-11-23T19:00:00Z',
      publishedAt: '2026-11-20T10:30:00Z',
    })

    const { status, headers, body } = await get('/v1/notices')
    expect(status).toBe(200)
    expect(Value.Check(NoticesResult, body)).toBe(true)
    expect(body).toEqual({
      notices: [
        {
          id: maintenance,
          title: '11 月 24 日凌晨维护',
          body: '',
          kind: 'maintenance',
          window: { startsAt: '2026-11-23T18:00:00.000Z', endsAt: '2026-11-23T19:00:00.000Z' },
          publishedAt: '2026-11-20T10:30:00.000Z',
          updatedAt: null,
        },
        {
          id: general,
          title: '欢迎',
          body: '第一段\n\n- 一\n- **二**',
          kind: 'general',
          window: null,
          publishedAt: '2026-11-18T09:00:00.000Z',
          updatedAt: '2026-11-19T01:00:00.000Z',
        },
      ],
      more: false,
    })
    expect(headers['cache-control']).toBe('public, max-age=60')
    expect(headers['access-control-allow-origin']).toBe('*')
  })

  test('a maintenance window may have no end, or no start yet', async () => {
    t = await buildTestApp()
    await addNotice({ kind: 'maintenance', startsAt: '2026-11-23T18:00:00Z', publishedAt: '2026-11-20T00:00:00Z' })
    await addNotice({ kind: 'maintenance', publishedAt: '2026-11-19T00:00:00Z' })

    const { body } = await get('/v1/notices')
    expect(Value.Check(NoticesResult, body)).toBe(true)
    expect(body.notices.map((n: { window: unknown }) => n.window)).toEqual([
      { startsAt: '2026-11-23T18:00:00.000Z', endsAt: null },
      { startsAt: null, endsAt: null },
    ])
  })

  test('drafts and withdrawn notices are not given', async () => {
    t = await buildTestApp()
    await addNotice({ title: '草稿', status: 'draft' })
    await addNotice({ title: '撤下的', status: 'withdrawn', publishedAt: '2026-11-21T00:00:00Z' })
    await addNotice({ title: '发布的', publishedAt: '2026-11-20T00:00:00Z' })

    const { body } = await get('/v1/notices')
    expect(body.notices.map((n: { title: string }) => n.title)).toEqual(['发布的'])
    expect(body.more).toBe(false)
  })

  test('no notice at all is an empty list', async () => {
    t = await buildTestApp()
    expect(await get('/v1/notices')).toMatchObject({ status: 200, body: { notices: [], more: false } })
  })

  test('notices published at the same moment come newest-stored first', async () => {
    t = await buildTestApp()
    const first = await addNotice({ publishedAt: '2026-11-20T00:00:00Z' })
    const second = await addNotice({ publishedAt: '2026-11-20T00:00:00Z' })

    const { body } = await get('/v1/notices')
    expect(body.notices.map((n: { id: number }) => n.id)).toEqual([second, first])
  })

  test('gives 20 by default, and says there are more', async () => {
    t = await buildTestApp()
    await addDaily(21)

    const { body } = await get('/v1/notices')
    expect(body.notices).toHaveLength(20)
    expect(body.notices[0].title).toBe('第 21 天')
    expect(body.notices[19].title).toBe('第 2 天')
    expect(body.more).toBe(true)
  })

  test('limit gives that many, from 1 up to 50; more is false when none is left', async () => {
    t = await buildTestApp()
    await addDaily(52)

    expect((await get('/v1/notices?limit=1')).body).toMatchObject({ notices: [{ title: '第 52 天' }], more: true })
    const fifty = (await get('/v1/notices?limit=50')).body
    expect(fifty.notices).toHaveLength(50)
    expect(fifty.more).toBe(true)

    await t.db.deleteFrom('notices').where('title', 'in', ['第 1 天', '第 2 天']).execute()
    const all = (await get('/v1/notices?limit=50')).body
    expect(all.notices).toHaveLength(50)
    expect(all.more).toBe(false)
  })

  test('a limit that is not a whole number from 1 to 50 is invalid, and is not cached', async () => {
    t = await buildTestApp()
    await addDaily(1)

    for (const query of ['?limit=0', '?limit=51', '?limit=-1', '?limit=1.5', '?limit=abc', '?limit=', '?limit=1&limit=2']) {
      const res = await get(`/v1/notices${query}`)
      expect(res, query).toMatchObject({ status: 400, body: { error: { code: 'invalid_request' } } })
      expect(res.headers['access-control-allow-origin'], query).toBe('*')
      expect(res.headers['cache-control'], query).toBeUndefined()
    }
  })
})

describe('GET /v1/notices/:id', () => {
  test('gives one published notice', async () => {
    t = await buildTestApp()
    const id = await addNotice({
      title: '维护',
      body: '维护期间暂停。',
      kind: 'maintenance',
      startsAt: '2026-11-23T18:00:00Z',
      endsAt: '2026-11-23T19:00:00Z',
      publishedAt: '2026-11-20T10:30:00Z',
      updatedAt: '2026-11-21T10:30:00Z',
    })

    const { status, headers, body } = await get(`/v1/notices/${id}`)
    expect(status).toBe(200)
    expect(Value.Check(NoticeResult, body)).toBe(true)
    expect(body).toEqual({
      notice: {
        id,
        title: '维护',
        body: '维护期间暂停。',
        kind: 'maintenance',
        window: { startsAt: '2026-11-23T18:00:00.000Z', endsAt: '2026-11-23T19:00:00.000Z' },
        publishedAt: '2026-11-20T10:30:00.000Z',
        updatedAt: '2026-11-21T10:30:00.000Z',
      },
    })
    expect(headers['cache-control']).toBe('public, max-age=60')
    expect(headers['access-control-allow-origin']).toBe('*')
  })

  test('a notice that does not exist, or is not published, is not_found, and is not cached', async () => {
    t = await buildTestApp()
    const draft = await addNotice({ status: 'draft' })
    const withdrawn = await addNotice({ status: 'withdrawn' })
    const published = await addNotice()

    for (const id of [draft, withdrawn, published + 1, 2_147_483_647, 99_999_999_999]) {
      const res = await get(`/v1/notices/${id}`)
      expect(res, String(id)).toMatchObject({ status: 404, body: { error: { code: 'not_found' } } })
      expect(res.headers['access-control-allow-origin'], String(id)).toBe('*')
      expect(res.headers['cache-control'], String(id)).toBeUndefined()
    }
  })

  test('an id that is not a positive whole number is invalid', async () => {
    t = await buildTestApp()
    await addNotice()

    for (const id of ['0', '-1', '01', '1.5', '1e3', 'abc']) {
      const res = await get(`/v1/notices/${id}`)
      expect(res, id).toMatchObject({ status: 400, body: { error: { code: 'invalid_request' } } })
      expect(res.headers['access-control-allow-origin'], id).toBe('*')
      expect(res.headers['cache-control'], id).toBeUndefined()
    }
  })
})
