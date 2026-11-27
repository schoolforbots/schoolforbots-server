import { Value } from 'typebox/value'
import { afterEach, describe, expect, test } from 'vitest'
import { SchoolStatsResult } from '../../src/protocol/http.js'
import { buildTestApp } from '../helpers/app.js'
import { insertClass, insertStudent } from '../helpers/factories.js'

// The example school: Asia/Shanghai, the three divisions primary, junior and senior.

type TestApp = Awaited<ReturnType<typeof buildTestApp>>

let t: TestApp

afterEach(async () => {
  await t.destroy()
})

async function stats() {
  const res = await t.app.inject({ method: 'GET', url: '/v1/school/stats' })
  expect(res.statusCode).toBe(200)
  const body = res.json()
  expect(Value.Check(SchoolStatsResult, body), JSON.stringify([...Value.Errors(SchoolStatsResult, body)].slice(0, 3))).toBe(true)
  return { body, headers: res.headers }
}

let nextGame = 1
async function game(endedAt: string): Promise<void> {
  const at = new Date(endedAt)
  await t.db
    .insertInto('doudizhuGames')
    .values({ gameId: nextGame++, roomId: 'r1', startedAt: at, endedAt: at, ranked: false, record: '{}' })
    .execute()
}

describe('GET /v1/school/stats', () => {
  test('counts the students in school, their owners, the classes and the games ended today, and nothing else', async () => {
    t = await buildTestApp()
    t.clock.set(new Date('2026-11-27T12:00:00+08:00'))
    const juniorEvening = await insertClass(t.db, { division: 'junior', slot: 'evening', classNo: 1 })
    const juniorEvening2 = await insertClass(t.db, { division: 'junior', slot: 'evening', classNo: 2 })
    const primaryMorning = await insertClass(t.db, { division: 'primary', slot: 'morning', classNo: 1 })
    // Two of one owner (the address in another case), one suspended: both in school.
    await insertStudent(t.db, { email: 'a@example.com', division: 'junior', slot: 'evening', status: 'active', classId: juniorEvening })
    await insertStudent(t.db, { email: 'A@Example.com', division: 'junior', slot: 'evening', status: 'suspended', classId: juniorEvening2 })
    await insertStudent(t.db, { email: 'b@example.com', division: 'primary', slot: 'morning', status: 'active', classId: primaryMorning })
    // Not in school: not counted, their owners neither.
    await insertStudent(t.db, { email: 'c@example.com', division: 'senior', slot: 'afternoon', status: 'waitlisted' })
    await insertStudent(t.db, { email: 'd@example.com', division: 'senior', slot: 'afternoon', status: 'pending' })
    await insertStudent(t.db, { email: 'e@example.com', division: 'junior', slot: 'evening', status: 'dropped' })
    await insertStudent(t.db, { email: 'f@example.com', division: 'junior', slot: 'evening', status: 'expelled' })
    // Today in Beijing starts at 2026-11-26T16:00Z.
    await game('2026-11-26T15:59:59Z')
    await game('2026-11-26T16:00:00Z')
    await game('2026-11-27T03:00:00Z')

    const { body, headers } = await stats()

    expect(body).toEqual({
      generatedAt: '2026-11-27T04:00:00.000Z',
      students: {
        total: 3,
        byDivision: [
          { division: 'primary', students: 1 },
          { division: 'junior', students: 2 },
          { division: 'senior', students: 0 },
        ],
        bySlot: [
          { slot: 'morning', students: 1 },
          { slot: 'afternoon', students: 0 },
          { slot: 'evening', students: 2 },
        ],
      },
      owners: 2,
      classes: {
        total: 3,
        bySlotAndDivision: [
          { slot: 'morning', division: 'primary', classes: 1, students: 1 },
          { slot: 'evening', division: 'junior', classes: 2, students: 2 },
        ],
      },
      clubs: { doudizhu: { gamesToday: 2 } },
    })
    expect(headers['cache-control']).toBe('public, max-age=60')
  })

  test('an empty school is all zeros', async () => {
    t = await buildTestApp()
    const { body } = await stats()
    expect(body.students.total).toBe(0)
    expect(body.owners).toBe(0)
    expect(body.classes).toEqual({ total: 0, bySlotAndDivision: [] })
    expect(body.clubs.doudizhu.gamesToday).toBe(0)
  })

  test('the numbers are counted once a minute, everyone sharing them in between', async () => {
    t = await buildTestApp()
    t.clock.set(new Date('2026-11-27T12:00:00+08:00'))
    const first = await stats()
    await insertStudent(t.db, { status: 'active' })

    t.clock.set(new Date('2026-11-27T12:00:59+08:00'))
    const again = await stats()
    expect(again.body).toEqual(first.body)

    t.clock.set(new Date('2026-11-27T12:01:00+08:00'))
    const later = await stats()
    expect(later.body.students.total).toBe(1)
    expect(later.body.generatedAt).toBe('2026-11-27T04:01:00.000Z')
  })
})
