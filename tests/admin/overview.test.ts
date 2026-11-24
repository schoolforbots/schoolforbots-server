import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, test } from 'vitest'
import type { SchoolOverview } from '../../src/admin/overview.js'
import type { SchoolConfig } from '../../src/shared/config.js'
import { setMaintenance } from '../../src/shared/maintenance.js'
import type { StudentStatus } from '../../src/shared/schema.js'
import { buildAdminTestApp } from '../helpers/admin.js'
import { exampleConfig } from '../helpers/app.js'
import { insertClass, insertStudent } from '../helpers/factories.js'

// The school as it stands, on the school-data page (`overview` of api/stats/daily). Today is Wednesday 2026-11-04,
// noon school time (UTC+8). The example config has no opening day and no breaks, and drops a student after 30 days:
// tonight's run (on 11-05) drops the active students last seen before 10-06, the run a week from today's (on 11-11)
// those last seen before 10-12.
const NOW = new Date('2026-11-04T12:00:00+08:00')
const at = (date: string, time = '12:00:00') => new Date(`${date}T${time}+08:00`)

let t: Awaited<ReturnType<typeof buildAdminTestApp>>
let cookie: string
afterEach(async () => {
  await t.destroy()
})

async function start(config?: SchoolConfig): Promise<void> {
  t = await buildAdminTestApp({ now: NOW, config })
  cookie = await t.session()
}

async function overview(): Promise<SchoolOverview> {
  const reply = await t.app.inject({ method: 'GET', url: t.url('api/stats/daily?days=7'), headers: { cookie } })
  expect(reply.statusCode, reply.body).toBe(200)
  return reply.json().overview
}

async function student(
  status: StudentStatus,
  p: {
    email?: string
    classId?: number | null
    slot?: 'morning' | 'afternoon' | 'evening'
    lastAttendedAt?: Date | null
    assignedAt?: Date | null
    plugin?: [string, string]
  } = {},
): Promise<number> {
  const { id } = await insertStudent(t.db, {
    status,
    email: p.email ?? `s${randomUUID()}@example.com`,
    slot: p.slot ?? 'evening',
    classId: p.classId ?? null,
    createdAt: at('2026-09-01'),
    assignedAt: p.assignedAt ?? (status === 'active' ? at('2026-11-01') : null),
    lastAttendedAt: p.lastAttendedAt ?? null,
  })
  if (p.plugin !== undefined) {
    await t.db
      .updateTable('students')
      .set({ pluginType: p.plugin[0], pluginVersion: p.plugin[1] })
      .where('id', '=', id)
      .execute()
  }
  return id
}

async function registration(createdAt: Date, verifiedAt: Date | null): Promise<void> {
  await t.db
    .insertInto('registrations')
    .values({
      email: `r${randomUUID()}@example.com`,
      ownerName: '主人',
      aiName: '小鱼',
      division: 'junior',
      slot: 'evening',
      referrerId: null,
      aiId: randomUUID(),
      pluginType: 'test',
      pluginVersion: '0.0.0',
      ip: '127.0.0.1',
      codeHash: 'x',
      expiresAt: new Date(createdAt.getTime() + 600_000),
      createdAt,
      verifiedAt,
      schoolRulesVersion: null,
      schoolRulesAgreedAt: null,
    })
    .execute()
}

describe('the school overview', () => {
  test('counts the students by status, and the owners by email, in school and all', async () => {
    await start()
    const classId = await insertClass(t.db, { classNo: 1 })
    // One owner with two students in school (the address in another case), one with one in school and one gone.
    await student('active', { email: 'mum@example.com', classId })
    await student('suspended', { email: 'Mum@Example.com', classId })
    await student('active', { email: 'dad@example.com', classId })
    await student('dropped', { email: 'dad@example.com' })
    await student('pending', { email: 'new@example.com' })
    await student('waitlisted')
    await student('expelled')

    const o = await overview()
    expect(o.students).toEqual({ total: 7, pending: 1, waitlisted: 1, active: 2, suspended: 1, dropped: 1, expelled: 1 })
    expect(o.owners).toEqual({ inSchool: 2, all: 5 })
  })

  test("counts today's sign-ups: the codes sent and the students verified", async () => {
    await start()
    await registration(at('2026-11-04', '00:00:00'), null)
    await registration(at('2026-11-04', '09:00:00'), at('2026-11-04', '09:05:00'))
    // Started yesterday, verified today; and one of yesterday's alone.
    await registration(at('2026-11-03', '23:58:00'), at('2026-11-04', '00:01:00'))
    await registration(at('2026-11-03', '10:00:00'), at('2026-11-03', '10:01:00'))
    expect((await overview()).signupsToday).toEqual({ started: 2, verified: 2 })
  })

  test("gives each slot's seats against the capacity, its waitlist, and its classes by division", async () => {
    await start()
    const junior1 = await insertClass(t.db, { division: 'junior', slot: 'evening', classNo: 1 })
    const junior2 = await insertClass(t.db, { division: 'junior', slot: 'evening', classNo: 2 })
    const senior = await insertClass(t.db, { division: 'senior', slot: 'morning', classNo: 1 })
    await student('active', { slot: 'evening', classId: junior1 })
    await student('suspended', { slot: 'evening', classId: junior1 })
    await student('active', { slot: 'evening', classId: junior2 })
    await student('pending', { slot: 'evening' })
    await student('waitlisted', { slot: 'evening' })
    await student('dropped', { slot: 'evening' })
    await student('active', { slot: 'morning', classId: senior })

    const o = await overview()
    expect(o.classSize).toEqual({ standard: exampleConfig().classSize.standard, max: exampleConfig().classSize.max })
    const capacity = exampleConfig().slotCapacity
    expect(o.slots).toEqual([
      { slot: 'morning', seated: 1, capacity, waitlisted: 0, classes: [{ division: 'senior', classes: 1, students: 1 }] },
      { slot: 'afternoon', seated: 0, capacity, waitlisted: 0, classes: [] },
      { slot: 'evening', seated: 4, capacity, waitlisted: 1, classes: [{ division: 'junior', classes: 2, students: 3 }] },
    ])
  })

  test('counts who came this week and who the nightly job is about to drop', async () => {
    await start()
    const classId = await insertClass(t.db, { classNo: 1 })
    // Came this week: from Thursday 10-29 00:00 on.
    await student('active', { classId, lastAttendedAt: at('2026-10-29', '00:00:00') })
    await student('active', { classId, lastAttendedAt: at('2026-10-28', '23:59:00') })
    // Dropped tonight: last seen before 10-06; within the week: before 10-12.
    await student('active', { classId, lastAttendedAt: at('2026-10-05', '20:00:00') })
    await student('active', { classId, lastAttendedAt: null, assignedAt: at('2026-10-11') })
    await student('active', { classId, lastAttendedAt: at('2026-10-12', '00:00:00') })
    // Not active: not counted.
    await student('suspended', { classId, lastAttendedAt: at('2026-09-01') })

    expect((await overview()).activity).toEqual({ active: 5, cameThisWeek: 1, droppedTonight: 1, droppedWithinWeek: 2 })
  })

  test('skips the days on a break and under maintenance, and drops nobody before the school was open long enough', async () => {
    const config = exampleConfig()
    await start({ ...config, calendar: { ...config.calendar!, openingDay: '2026-10-20', breaks: [] } })
    await student('active', { lastAttendedAt: at('2026-09-01') })
    expect((await overview()).activity).toMatchObject({ droppedTonight: null, droppedWithinWeek: null })

    await t.destroy()
    // A break of 3 days and a day under maintenance push tonight's cutoff from 10-06 back to 10-02.
    await start({
      ...config,
      calendar: { ...config.calendar!, breaks: [{ name: '秋假', from: '2026-10-20', reopensOn: '2026-10-23' }] },
    })
    await setMaintenance(t.db, { message: '维护', expectedBackAt: null }, at('2026-10-25', '10:00:00'))
    await setMaintenance(t.db, null, at('2026-10-25', '11:00:00'))
    await student('active', { lastAttendedAt: at('2026-10-03') })
    await student('active', { lastAttendedAt: at('2026-10-01') })
    expect((await overview()).activity).toMatchObject({ droppedTonight: 1 })
  })

  test('lists the plugins of the students in school, the most used first', async () => {
    await start()
    const classId = await insertClass(t.db, { classNo: 1 })
    await student('active', { classId, plugin: ['openclaw', '1.2.0'] })
    await student('active', { classId, plugin: ['openclaw', '1.2.0'] })
    await student('suspended', { classId, plugin: ['openclaw', '1.1.0'] })
    await student('active', { classId, plugin: ['hermes', '0.3.0'] })
    await student('dropped', { plugin: ['openclaw', '0.9.0'] })
    await student('pending', { plugin: ['openclaw', '0.9.0'] })

    expect((await overview()).plugins).toEqual([
      { pluginType: 'openclaw', pluginVersion: '1.2.0', students: 2 },
      { pluginType: 'hermes', pluginVersion: '0.3.0', students: 1 },
      { pluginType: 'openclaw', pluginVersion: '1.1.0', students: 1 },
    ])
  })
})
