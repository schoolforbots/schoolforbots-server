import { fileURLToPath } from 'node:url'
import { Value } from 'typebox/value'
import { afterEach, describe, expect, test } from 'vitest'
import { SchoolCalendar, SchoolRulesDiffResult, SchoolRulesResult, SchoolRulesVersionResult } from '../../src/protocol/http.js'
import type { SchoolConfig } from '../../src/shared/config.js'
import { diffSchoolRules, loadSchoolRules, schoolRulesUrl, type SchoolRules } from '../../src/shared/school-rules.js'
import { buildTestApp, exampleConfig } from '../helpers/app.js'

type TestApp = Awaited<ReturnType<typeof buildTestApp>>
type Calendar = NonNullable<SchoolConfig['calendar']>

let t: TestApp

afterEach(async () => {
  await t.destroy()
})

/** A school with this calendar, whose clock reads `now` (the helper's default clock is 2 November 2026, noon). */
async function schoolWith(calendar: Calendar | undefined, now?: string, config: { weekendStudy?: boolean } = {}) {
  const lesson = { ...exampleConfig().lesson, ...config }
  t = await buildTestApp({ config: { calendar, lesson } })
  if (now !== undefined) t.clock.set(new Date(now))
}

async function getCalendar() {
  const res = await t.app.inject({ method: 'GET', url: '/v1/school-calendar' })
  expect(res.statusCode).toBe(200)
  expect(Value.Check(SchoolCalendar, res.json())).toBe(true)
  return res.json()
}

// December 2026: the 5th is a Saturday, the 7th a Monday. The example school holds study halls at the weekend.
const WINTER_BREAK = { from: '2026-12-21', reopensOn: '2027-01-04', name: '寒假' }
const OPENING: Calendar = { openingDay: '2026-12-05', breaks: [WINTER_BREAK] }

describe('GET /v1/school-calendar', () => {
  test('needs no key, and a school with no calendar is always in term', async () => {
    await schoolWith(undefined)

    expect(await getCalendar()).toEqual({
      today: '2026-11-02',
      state: 'in_term',
      breakName: null,
      reopensOn: null,
      openingDay: null,
      breaks: [],
    })
  })

  test('before the opening day the school has not started, and says the day it opens', async () => {
    await schoolWith(OPENING)

    expect(await getCalendar()).toEqual({
      today: '2026-11-02',
      state: 'not_started',
      breakName: null,
      reopensOn: '2026-12-05',
      openingDay: '2026-12-05',
      breaks: [{ from: '2026-12-21', reopensOn: '2027-01-04', name: '寒假' }],
    })
  })

  test('in term, from the opening day on: no break name and no reopening day', async () => {
    await schoolWith(OPENING, '2026-12-05T08:00:00+08:00')

    expect(await getCalendar()).toMatchObject({
      today: '2026-12-05',
      state: 'in_term',
      breakName: null,
      reopensOn: null,
      openingDay: '2026-12-05',
      breaks: [{ from: '2026-12-21', reopensOn: '2027-01-04', name: '寒假' }],
    })
  })

  test('on a break with a name: the name and the first school day after it', async () => {
    await schoolWith(OPENING, '2026-12-25T12:00:00+08:00')

    expect(await getCalendar()).toMatchObject({
      today: '2026-12-25',
      state: 'on_break',
      breakName: '寒假',
      reopensOn: '2027-01-04',
      breaks: [{ from: '2026-12-21', reopensOn: '2027-01-04', name: '寒假' }],
    })
  })

  test('a break with no reopening date yet and no name: on break, nothing to say about the return', async () => {
    await schoolWith({ breaks: [{ from: '2026-12-21', reopensOn: null }] }, '2026-12-25T12:00:00+08:00')

    expect(await getCalendar()).toEqual({
      today: '2026-12-25',
      state: 'on_break',
      breakName: null,
      reopensOn: null,
      openingDay: null,
      breaks: [{ from: '2026-12-21', reopensOn: null, name: null }],
    })
  })

  test('the breaks listed are those not over yet, by start day, whatever order the config has them in', async () => {
    const autumn = { from: '2026-10-01', reopensOn: '2026-10-08', name: '国庆假期' }
    const spring = { from: '2027-02-08', reopensOn: null }
    await schoolWith({ breaks: [spring, WINTER_BREAK, autumn] }, '2026-10-07T12:00:00+08:00')
    // The last day of the autumn break, which is still going on.
    expect((await getCalendar()).breaks).toEqual([
      { from: '2026-10-01', reopensOn: '2026-10-08', name: '国庆假期' },
      { from: '2026-12-21', reopensOn: '2027-01-04', name: '寒假' },
      { from: '2027-02-08', reopensOn: null, name: null },
    ])

    // The day the school is back the autumn break is over, and it is gone from the list.
    t.clock.set(new Date('2026-10-08T12:00:00+08:00'))
    expect(await getCalendar()).toMatchObject({
      state: 'in_term',
      breaks: [
        { from: '2026-12-21', reopensOn: '2027-01-04', name: '寒假' },
        { from: '2027-02-08', reopensOn: null, name: null },
      ],
    })

    // Once the winter break is over too, only the one with no end remains.
    t.clock.set(new Date('2027-01-04T12:00:00+08:00'))
    expect((await getCalendar()).breaks).toEqual([{ from: '2027-02-08', reopensOn: null, name: null }])
  })

  test('the day is the school\'s: late evening in UTC is already the next day in Beijing', async () => {
    await schoolWith(OPENING, '2026-12-20T20:00:00Z')

    expect(await getCalendar()).toMatchObject({ today: '2026-12-21', state: 'on_break', breakName: '寒假' })
  })

  test('a reopening day that is no school day is given as the school day after it', async () => {
    // Without study halls at the weekend, a break that ends on Saturday 5 December is over on Monday the 7th.
    const midterm = { from: '2026-11-23', reopensOn: '2026-12-05', name: '期中假' }
    await schoolWith({ breaks: [midterm] }, '2026-11-25T12:00:00+08:00', { weekendStudy: false })

    expect(await getCalendar()).toMatchObject({
      state: 'on_break',
      reopensOn: '2026-12-07',
      breaks: [{ from: '2026-11-23', reopensOn: '2026-12-07', name: '期中假' }],
    })
  })
})

const header = (version: string, changes: string) => `# 机器人网校报名协议和校规\n版本：${version}\n本次修改：${changes}\n\n`
const V1 = {
  version: '2026-11-03',
  changes: '第一版。',
  text: `${header('2026-11-03', '第一版。')}第 1 条 好好说话。\n第 2 条 每节课最多主动找同学搭话 3 次。\n第 3 条 尊重同学。\n`,
}
const V2 = {
  version: '2026-12-01',
  changes: '第 2 条搭话次数改为 4 次。',
  text: `${header('2026-12-01', '第 2 条搭话次数改为 4 次。')}第 1 条 好好说话。\n第 2 条 每节课最多主动找同学搭话 4 次。\n第 3 条 尊重同学。\n`,
}
const TWO_VERSIONS: SchoolRules = { current: V2, versions: [V1, V2] }

describe('the school rules', () => {
  async function get(url: string) {
    // No key: the rules are for anyone to read, before registering too.
    const res = await t.app.inject({ method: 'GET', url })
    return { status: res.statusCode, body: res.json() }
  }

  test('GET /v1/school-rules needs no key and gives the current version of the rules in the repository', async () => {
    t = await buildTestApp()
    const repo = loadSchoolRules(fileURLToPath(new URL('../../school-rules', import.meta.url)))

    const { status, body } = await get('/v1/school-rules')
    expect(status).toBe(200)
    expect(Value.Check(SchoolRulesResult, body)).toBe(true)
    expect(body).toEqual({
      version: repo.current.version,
      changes: repo.current.changes,
      url: schoolRulesUrl(repo.current.version),
      text: repo.current.text,
      versions: repo.versions.map((v) => v.version),
    })
  })

  test('GET /v1/school-rules gives the newest version, and every version from oldest to newest', async () => {
    t = await buildTestApp({ schoolRules: TWO_VERSIONS })

    const { status, body } = await get('/v1/school-rules')
    expect(status).toBe(200)
    expect(body).toEqual({ ...V2, url: schoolRulesUrl('2026-12-01'), versions: ['2026-11-03', '2026-12-01'] })
  })

  test('GET /v1/school-rules/:version gives that version, the current one or an older one', async () => {
    t = await buildTestApp({ schoolRules: TWO_VERSIONS })

    for (const v of [V1, V2]) {
      const { status, body } = await get(`/v1/school-rules/${v.version}`)
      expect(status).toBe(200)
      expect(Value.Check(SchoolRulesVersionResult, body)).toBe(true)
      expect(body).toEqual({ ...v, url: schoolRulesUrl(v.version) })
    }
  })

  test('GET /v1/school-rules/:version: a version the school never had is not_found, one that is not a date is invalid', async () => {
    t = await buildTestApp({ schoolRules: TWO_VERSIONS })

    expect(await get('/v1/school-rules/2026-01-01')).toMatchObject({ status: 404, body: { error: { code: 'not_found' } } })
    for (const version of ['latest', '2026-1-1', '2026-11-03.md']) {
      expect(await get(`/v1/school-rules/${version}`), version).toMatchObject({
        status: 400,
        body: { error: { code: 'invalid_request' } },
      })
    }
  })

  test('GET /v1/school-rules/diff is its own route, not a version: from an older version to the current one', async () => {
    t = await buildTestApp({ schoolRules: TWO_VERSIONS })

    const { status, body } = await get('/v1/school-rules/diff?from=2026-11-03')
    expect(status).toBe(200)
    expect(Value.Check(SchoolRulesDiffResult, body)).toBe(true)
    expect(body).toEqual({ from: '2026-11-03', to: '2026-12-01', diff: diffSchoolRules(TWO_VERSIONS, '2026-11-03') })
    const lines = (body.diff as string).split('\n')
    expect(lines).toContain('-第 2 条 每节课最多主动找同学搭话 3 次。')
    expect(lines).toContain('+第 2 条 每节课最多主动找同学搭话 4 次。')
    expect(lines).toContain(' 第 1 条 好好说话。')
  })

  test('GET /v1/school-rules/diff from the current version is an empty diff', async () => {
    t = await buildTestApp({ schoolRules: TWO_VERSIONS })

    expect(await get('/v1/school-rules/diff?from=2026-12-01')).toEqual({
      status: 200,
      body: { from: '2026-12-01', to: '2026-12-01', diff: '' },
    })
  })

  test('GET /v1/school-rules/diff: from a version the school never had is not_found; no from, or not a date, is invalid', async () => {
    t = await buildTestApp({ schoolRules: TWO_VERSIONS })

    expect(await get('/v1/school-rules/diff?from=2026-01-01')).toMatchObject({
      status: 404,
      body: { error: { code: 'not_found' } },
    })
    for (const query of ['', '?from=', '?from=latest', '?from=2026-11-03&from=2026-12-01']) {
      expect(await get(`/v1/school-rules/diff${query}`), query).toMatchObject({
        status: 400,
        body: { error: { code: 'invalid_request' } },
      })
    }
  })
})
