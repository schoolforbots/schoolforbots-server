import { sql } from 'kysely'
import { Value } from 'typebox/value'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { BroadcastsResult } from '../../src/protocol/http.js'
import { buildTestApp } from '../helpers/app.js'
import { insertClass, insertStudent } from '../helpers/factories.js'

type TestApp = Awaited<ReturnType<typeof buildTestApp>>

const DAY = 24 * 60 * 60_000

let t: TestApp

beforeEach(async () => {
  t = await buildTestApp()
})

afterEach(async () => {
  await t.destroy()
})

const fetchAs = (key: string, query = '') =>
  t.app.inject({ method: 'GET', url: `/v1/me/broadcasts${query}`, headers: { authorization: `Bearer ${key}` } })

/** A published broadcast, `daysAgo` days before the clock, with the next seq. */
async function publish(
  title: string,
  p: { divisions?: string[]; slots?: string[]; classIds?: number[]; daysAgo?: number; expiresAt?: Date | null; importance?: 'normal' | 'important' } = {},
): Promise<number> {
  const publishedAt = new Date(t.clock.now().getTime() - (p.daysAgo ?? 0) * DAY)
  const row = await t.db
    .insertInto('broadcasts')
    .values({
      title,
      body: `${title}的正文`,
      importance: p.importance ?? 'normal',
      divisions: p.divisions ?? [],
      slots: p.slots ?? [],
      classIds: p.classIds ?? [],
      status: 'published',
      seq: sql<number>`nextval('broadcast_seq')`,
      publishedAt,
      expiresAt: p.expiresAt ?? null,
      createdAt: publishedAt,
    })
    .returning('id')
    .executeTakeFirstOrThrow()
  return row.id
}

const titles = (res: { json(): unknown }) => (res.json() as { broadcasts: { title: string }[] }).broadcasts.map((b) => b.title)

test('a student gets the broadcasts to the whole school, to their division and slot, and to their class', async () => {
  const mine = await insertClass(t.db, { classNo: 3, division: 'junior', slot: 'evening' })
  const other = await insertClass(t.db, { classNo: 4, division: 'junior', slot: 'evening' })
  const { key } = await insertStudent(t.db, { status: 'active', classId: mine, division: 'junior', slot: 'evening' })

  await publish('全校', { importance: 'important' })
  await publish('初中部', { divisions: ['junior'] })
  await publish('高中部', { divisions: ['senior'] })
  await publish('晚班', { slots: ['evening'] })
  await publish('初中部晚班', { divisions: ['junior', 'senior'], slots: ['evening'] })
  await publish('初中部上午班', { divisions: ['junior'], slots: ['morning'] })
  await publish('我的班', { classIds: [mine] })
  await publish('别的班', { classIds: [other] })

  const res = await fetchAs(key)
  expect(res.statusCode).toBe(200)
  expect(Value.Check(BroadcastsResult, res.json())).toBe(true)
  expect(titles(res)).toEqual(['全校', '初中部', '晚班', '初中部晚班', '我的班'])
  expect(res.json().broadcasts[0]).toEqual({
    id: expect.any(Number),
    seq: expect.any(Number),
    title: '全校',
    body: '全校的正文',
    importance: 'important',
    audience: '全校',
    publishedAt: t.clock.now().toISOString(),
    expiresAt: null,
  })
  expect(res.json().broadcasts.map((b: { audience: string }) => b.audience)).toEqual([
    '全校',
    '初中部',
    '晚班',
    '初中部、高中部 · 晚班',
    '初中部·晚班·3 班',
  ])
})

test('one waiting for a class gets all but those to a class; one who left the school gets a 409', async () => {
  const classId = await insertClass(t.db, { classNo: 1 })
  await publish('全校')
  await publish('一个班', { classIds: [classId] })
  const waiting = await insertStudent(t.db, { status: 'pending' })
  expect(titles(await fetchAs(waiting.key))).toEqual(['全校'])

  const gone = await insertStudent(t.db, { status: 'dropped' })
  const res = await fetchAs(gone.key)
  expect(res.statusCode).toBe(409)
  expect(res.json().error.code).toBe('wrong_status')
})

test('drafts, withdrawn ones, expired ones and those older than 30 days are not given out', async () => {
  const { key } = await insertStudent(t.db, { status: 'pending' })
  await publish('还在')
  await publish('明天截止', { expiresAt: new Date(t.clock.now().getTime() + DAY) })
  await publish('已经截止', { expiresAt: t.clock.now() })
  await publish('29 天前', { daysAgo: 29 })
  await publish('31 天前', { daysAgo: 31 })
  const withdrawn = await publish('撤回了')
  await t.db.updateTable('broadcasts').set({ status: 'withdrawn', withdrawnAt: t.clock.now() }).where('id', '=', withdrawn).execute()
  await t.db.insertInto('broadcasts').values({ title: '草稿', createdAt: t.clock.now() }).execute()

  expect(titles(await fetchAs(key))).toEqual(['还在', '明天截止', '29 天前'])
})

test('after and limit page through them by seq', async () => {
  const { key } = await insertStudent(t.db, { status: 'pending' })
  for (const title of ['一', '二', '三']) await publish(title)

  const first = (await fetchAs(key, '?limit=2')).json()
  expect(first.broadcasts.map((b: { title: string }) => b.title)).toEqual(['一', '二'])
  expect(first.more).toBe(true)
  const rest = (await fetchAs(key, `?after=${first.broadcasts[1].seq}&limit=2`)).json()
  expect(rest).toMatchObject({ broadcasts: [{ title: '三' }], more: false })
  expect((await fetchAs(key, `?after=${rest.broadcasts[0].seq}`)).json()).toEqual({ broadcasts: [], more: false })
  // Far past the last one there is simply nothing.
  expect((await fetchAs(key, '?after=99999999999')).json()).toEqual({ broadcasts: [], more: false })
})

test('a wrong after or limit is a 400; no key is a 401', async () => {
  const { key } = await insertStudent(t.db, { status: 'pending' })
  for (const query of ['?after=-1', '?after=01', '?after=x', '?limit=0', '?limit=51']) {
    expect((await fetchAs(key, query)).statusCode, query).toBe(400)
  }
  expect((await t.app.inject({ method: 'GET', url: '/v1/me/broadcasts' })).statusCode).toBe(401)
})
